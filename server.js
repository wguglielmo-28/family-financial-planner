/* ============================================================================
 * Family YNAB — backend
 * Express (static + API) + ws (realtime sync) + Google Sign-In + Postgres.
 *
 * Holds ONE shared household budget document. Both spouses connect over a
 * WebSocket; any edit is persisted and broadcast to the other in real time.
 *
 * Env vars (set these on Railway):
 *   GOOGLE_CLIENT_ID  - OAuth Web client id from Google Cloud Console
 *   ALLOWED_EMAILS    - comma-separated Gmail addresses allowed to sign in
 *   SESSION_SECRET    - any long random string (signs the session cookie)
 *   DATABASE_URL      - auto-provided by the Railway Postgres plugin
 *   PORT              - auto-provided by Railway
 *
 * Local dev: if GOOGLE_CLIENT_ID is unset and NODE_ENV !== production, a
 * "dev login" is enabled (no Google needed) and state persists to ./data.json.
 * ========================================================================== */

const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { OAuth2Client } = require('google-auth-library');

const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
const IS_PROD = process.env.NODE_ENV === 'production';
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
// Dev login is only available locally: no Google client, not prod, and no real DB.
// As soon as a database is attached (production), dev login is off automatically.
const DEV_LOGIN = !GOOGLE_CLIENT_ID && !IS_PROD && !process.env.DATABASE_URL;

const COOKIE_NAME = 'fy_session';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

/* ---------------------------------------------------------------------------
 * Persistence layer — Postgres in prod, local data.json in dev.
 * Exposes loadState() and saveState(data, version, updatedBy).
 * ------------------------------------------------------------------------- */
const DATA_FILE = path.join(__dirname, 'data.json');
const EMPTY_STATE = { data: {}, version: 0, updatedBy: '', updatedAt: null };
let pgPool = null;

async function initStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const cs = process.env.DATABASE_URL;
    // Railway's private network (postgres.railway.internal) is plaintext; the
    // public proxy needs SSL. Only enable SSL when it's not an internal/local host.
    const needsSSL = !/\.railway\.internal|localhost|127\.0\.0\.1/.test(cs);
    pgPool = new Pool({
      connectionString: cs,
      ssl: needsSSL ? { rejectUnauthorized: false } : false,
    });
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS household (
        id          INT PRIMARY KEY,
        data        JSONB NOT NULL DEFAULT '{}',
        version     INT   NOT NULL DEFAULT 0,
        updated_by  TEXT,
        updated_at  TIMESTAMPTZ
      );`);
    await pgPool.query(
      `INSERT INTO household (id, data, version) VALUES (1, '{}', 0)
       ON CONFLICT (id) DO NOTHING;`);
    console.log('[store] Using Postgres');
  } else {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(EMPTY_STATE, null, 2));
    }
    console.log('[store] Using local file (dev):', DATA_FILE);
  }
}

async function loadState() {
  if (pgPool) {
    const r = await pgPool.query(
      'SELECT data, version, updated_by, updated_at FROM household WHERE id = 1');
    if (!r.rows.length) return { ...EMPTY_STATE };
    const row = r.rows[0];
    return {
      data: row.data || {},
      version: row.version || 0,
      updatedBy: row.updated_by || '',
      updatedAt: row.updated_at || null,
    };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { ...EMPTY_STATE };
  }
}

async function saveState(data, version, updatedBy) {
  const updatedAt = new Date().toISOString();
  if (pgPool) {
    await pgPool.query(
      `UPDATE household SET data = $1, version = $2, updated_by = $3, updated_at = $4 WHERE id = 1`,
      [data, version, updatedBy, updatedAt]);
  } else {
    fs.writeFileSync(DATA_FILE,
      JSON.stringify({ data, version, updatedBy, updatedAt }, null, 2));
  }
  return updatedAt;
}

/* ---------------------------------------------------------------------------
 * Sessions (signed JWT in an httpOnly cookie)
 * ------------------------------------------------------------------------- */
// True when the request arrived over HTTPS (directly or via Railway's TLS proxy).
function isSecure(req) {
  return req.secure || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function issueSession(req, res, user) {
  const token = jwt.sign(
    { email: user.email, name: user.name }, SESSION_SECRET, { expiresIn: '60d' });
  res.setHeader('Set-Cookie', cookie.serialize(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isSecure(req),
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 60,
    path: '/',
  }));
}

function clearSession(req, res) {
  res.setHeader('Set-Cookie', cookie.serialize(COOKIE_NAME, '', {
    httpOnly: true, secure: isSecure(req), sameSite: 'lax', maxAge: 0, path: '/',
  }));
}

function userFromCookieHeader(cookieHeader) {
  try {
    const cookies = cookie.parse(cookieHeader || '');
    const token = cookies[COOKIE_NAME];
    if (!token) return null;
    return jwt.verify(token, SESSION_SECRET); // { email, name }
  } catch {
    return null;
  }
}

function emailAllowed(email) {
  if (!ALLOWED_EMAILS.length) return true; // not configured yet -> allow (dev)
  return ALLOWED_EMAILS.includes((email || '').toLowerCase());
}

/* ---------------------------------------------------------------------------
 * HTTP / Express
 * ------------------------------------------------------------------------- */
const app = express();
app.set('trust proxy', 1); // behind Railway's TLS-terminating proxy
app.use(express.json({ limit: '5mb' }));

app.get('/api/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID, devLogin: DEV_LOGIN });
});

app.get('/api/me', (req, res) => {
  const user = userFromCookieHeader(req.headers.cookie);
  if (!user || !emailAllowed(user.email)) return res.status(401).json({ error: 'unauthenticated' });
  res.json({ user: { email: user.email, name: user.name } });
});

app.post('/api/auth', async (req, res) => {
  try {
    // Dev login path (no Google configured, non-prod)
    if (DEV_LOGIN && req.body && req.body.devName) {
      const user = { email: 'dev@local', name: String(req.body.devName).slice(0, 40) };
      issueSession(req, res, user);
      return res.json({ user });
    }
    // Google Sign-In path
    const credential = req.body && req.body.credential;
    if (!credential || !googleClient) return res.status(400).json({ error: 'missing credential' });
    const ticket = await googleClient.verifyIdToken({
      idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const email = (payload.email || '').toLowerCase();
    if (!payload.email_verified) return res.status(403).json({ error: 'email not verified' });
    if (!emailAllowed(email)) return res.status(403).json({ error: 'not authorized' });
    const user = { email, name: payload.given_name || payload.name || email };
    issueSession(req, res, user);
    res.json({ user });
  } catch (e) {
    console.error('[auth] error', e.message);
    res.status(401).json({ error: 'auth failed' });
  }
});

app.post('/api/logout', (req, res) => { clearSession(req, res); res.json({ ok: true }); });

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ---------------------------------------------------------------------------
 * WebSocket realtime sync
 *   client -> { type:'update', data, baseVersion }
 *   server -> { type:'state'|'ack'|'conflict', data?, version, updatedBy?, updatedAt? }
 * In-memory `current` is the live copy; Postgres/file is durability.
 * ------------------------------------------------------------------------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
let current = { ...EMPTY_STATE };

function broadcast(obj, exceptWs) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client !== exceptWs && client.readyState === 1) client.send(msg);
  }
}

wss.on('connection', (ws, req) => {
  const user = userFromCookieHeader(req.headers.cookie);
  if (!user || !emailAllowed(user.email)) {
    ws.send(JSON.stringify({ type: 'error', error: 'unauthenticated' }));
    ws.close();
    return;
  }
  ws.user = user;
  // Send the current authoritative state on connect.
  ws.send(JSON.stringify({
    type: 'state', data: current.data, version: current.version,
    updatedBy: current.updatedBy, updatedAt: current.updatedAt,
  }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== 'update') return;

    // Optimistic concurrency: reject stale writes so we don't clobber the
    // other spouse's edit; the client will merge and resend.
    if (msg.baseVersion != null && msg.baseVersion !== current.version) {
      ws.send(JSON.stringify({
        type: 'conflict', data: current.data, version: current.version,
        updatedBy: current.updatedBy, updatedAt: current.updatedAt,
      }));
      return;
    }

    current.version += 1;
    current.data = msg.data || {};
    current.updatedBy = ws.user.name;
    try {
      current.updatedAt = await saveState(current.data, current.version, current.updatedBy);
    } catch (e) {
      console.error('[save] error', e.message);
    }
    // Ack the writer, broadcast the new state to everyone else.
    ws.send(JSON.stringify({ type: 'ack', version: current.version, updatedAt: current.updatedAt }));
    broadcast({
      type: 'state', data: current.data, version: current.version,
      updatedBy: current.updatedBy, updatedAt: current.updatedAt,
    }, ws);
  });
});

/* --------------------------------------------------------------------------- */
(async () => {
  await initStore();
  current = await loadState();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Family YNAB running on :${PORT}`);
    console.log(`  Google sign-in: ${GOOGLE_CLIENT_ID ? 'configured' : 'NOT configured'}`);
    console.log(`  Dev login:      ${DEV_LOGIN ? 'ENABLED (no Google needed)' : 'disabled'}`);
    console.log(`  Allowed emails: ${ALLOWED_EMAILS.length ? ALLOWED_EMAILS.join(', ') : '(any — set ALLOWED_EMAILS!)'}`);
  });
})();
