/* ============================================================================
 * Family YNAB — multi-tenant backend
 * Express (static + API) + ws (realtime sync) + Google Sign-In + Postgres.
 *
 * Each HOUSEHOLD has its own private budget document. A user belongs to exactly
 * one household; a WebSocket connection is bound to that user's household, so
 * data is fully isolated between accounts. Sign-up is invite-only.
 *
 * Env vars (Railway):
 *   GOOGLE_CLIENT_ID  - OAuth Web client id
 *   ADMIN_EMAILS      - comma-separated emails allowed to mint "new household" invites
 *   ALLOWED_EMAILS    - (one-time) members to seed onto the migrated legacy budget
 *   SESSION_SECRET    - long random string (signs the session cookie)
 *   DATABASE_URL      - Railway Postgres (auto)
 *   PORT              - auto
 *
 * Local dev: no GOOGLE_CLIENT_ID + non-prod + no DB => "dev login" (no Google),
 * state in ./data.json. The dev user (dev@local) is treated as an admin.
 * ========================================================================== */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { OAuth2Client } = require('google-auth-library');

const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
const IS_PROD = process.env.NODE_ENV === 'production';
const splitEmails = v => (v || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const ALLOWED_EMAILS = splitEmails(process.env.ALLOWED_EMAILS); // legacy-migration seed only
const ADMIN_EMAILS = splitEmails(process.env.ADMIN_EMAILS);
const DEV_LOGIN = !GOOGLE_CLIENT_ID && !IS_PROD && !process.env.DATABASE_URL;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const EXTRACT_MODEL = process.env.EXTRACT_MODEL || 'claude-opus-4-8';

const COOKIE_NAME = 'fy_session';
const INVITE_TTL_DAYS = 30;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

function isAdminEmail(email) {
  email = (email || '').toLowerCase();
  if (ADMIN_EMAILS.includes(email)) return true;
  return DEV_LOGIN && email === 'dev@local'; // bootstrap admin for local dev
}
function newId() { return crypto.randomUUID(); }
function newCode() { return crypto.randomBytes(6).toString('hex'); } // 12-char invite code

/* ===========================================================================
 * STORE — two implementations (Postgres in prod, ./data.json in dev) behind a
 * single `store` interface. All budget/user/invite access goes through here.
 * ========================================================================= */
const DATA_FILE = path.join(__dirname, 'data.json');
let pgPool = null;
let fileDB = { households: {}, users: {}, invites: {} };

function saveFile() { fs.writeFileSync(DATA_FILE, JSON.stringify(fileDB, null, 2)); }

async function initStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const cs = process.env.DATABASE_URL;
    const needsSSL = !/\.railway\.internal|localhost|127\.0\.0\.1/.test(cs);
    pgPool = new Pool({ connectionString: cs, ssl: needsSSL ? { rejectUnauthorized: false } : false });
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS households (
        id TEXT PRIMARY KEY, name TEXT, data JSONB NOT NULL DEFAULT '{}',
        version INT NOT NULL DEFAULT 0, updated_by TEXT, updated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT now());`);
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        email TEXT PRIMARY KEY, name TEXT, household_id TEXT REFERENCES households(id),
        is_admin BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now());`);
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS invites (
        code TEXT PRIMARY KEY, kind TEXT, household_id TEXT, created_by TEXT,
        used_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());`);
    console.log('[store] Using Postgres');
    await migrateLegacyPg();
  } else {
    if (fs.existsSync(DATA_FILE)) {
      try {
        const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (raw.households) fileDB = raw;
        else if (raw.data && Object.keys(raw.data).length) {
          // migrate old single-budget dev file into a default dev household
          const id = newId();
          fileDB.households[id] = { id, name: 'Dev Household', data: raw.data,
            version: raw.version || 0, updatedBy: raw.updatedBy || '', updatedAt: raw.updatedAt || null };
          fileDB.users['dev@local'] = { email: 'dev@local', name: 'Dev', householdId: id, isAdmin: true };
        }
      } catch { /* start fresh */ }
    }
    saveFile();
    console.log('[store] Using local file (dev):', DATA_FILE);
  }
}

// One-time, idempotent, non-destructive migration of the legacy single-budget row.
async function migrateLegacyPg() {
  const n = (await pgPool.query('SELECT count(*)::int AS n FROM households')).rows[0].n;
  if (n > 0) return; // already multi-tenant
  const reg = (await pgPool.query("SELECT to_regclass('public.household') AS t")).rows[0].t;
  if (!reg) return; // no legacy table
  const legacy = (await pgPool.query('SELECT data, version FROM household WHERE id = 1')).rows[0];
  if (!legacy || !legacy.data || !Object.keys(legacy.data).length) return; // nothing to migrate
  const f = legacy.data.fields || {};
  const name = [f.name1, f.name2].filter(Boolean).join(' & ') || 'My Household';
  const id = newId();
  await pgPool.query(
    `INSERT INTO households (id, name, data, version, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,'migration',now())`, [id, name, legacy.data, legacy.version || 0]);
  const seed = ALLOWED_EMAILS.length ? ALLOWED_EMAILS : ADMIN_EMAILS;
  for (let i = 0; i < seed.length; i++) {
    const email = seed[i];
    // The first seeded member (the original owner, William) admins the migrated
    // household even if ADMIN_EMAILS isn't set yet — so you can't get locked out.
    const admin = isAdminEmail(email) || i === 0;
    await pgPool.query(
      `INSERT INTO app_users (email, name, household_id, is_admin) VALUES ($1,'',$2,$3)
       ON CONFLICT (email) DO NOTHING`, [email, id, admin]);
  }
  console.log(`[migrate] legacy budget -> household "${name}" (${id}); members:`, seed.join(', '));
}

const store = {
  async getHousehold(id) {
    if (pgPool) {
      const r = await pgPool.query('SELECT * FROM households WHERE id = $1', [id]);
      if (!r.rows.length) return null;
      const x = r.rows[0];
      return { id: x.id, name: x.name, data: x.data || {}, version: x.version || 0, updatedBy: x.updated_by, updatedAt: x.updated_at };
    }
    return fileDB.households[id] || null;
  },
  async createHousehold(name, data = {}, version = 0) {
    const id = newId();
    if (pgPool) await pgPool.query('INSERT INTO households (id,name,data,version,updated_at) VALUES ($1,$2,$3,$4,now())', [id, name, data, version]);
    else { fileDB.households[id] = { id, name, data, version, updatedBy: '', updatedAt: null }; saveFile(); }
    return id;
  },
  async saveHousehold(id, data, version, updatedBy) {
    const updatedAt = new Date().toISOString();
    if (pgPool) await pgPool.query('UPDATE households SET data=$1,version=$2,updated_by=$3,updated_at=$4 WHERE id=$5', [data, version, updatedBy, updatedAt, id]);
    else { const h = fileDB.households[id]; if (h) { Object.assign(h, { data, version, updatedBy, updatedAt }); saveFile(); } }
    return updatedAt;
  },
  async renameHousehold(id, name) {
    if (pgPool) await pgPool.query('UPDATE households SET name=$1 WHERE id=$2', [name, id]);
    else if (fileDB.households[id]) { fileDB.households[id].name = name; saveFile(); }
  },
  async getUser(email) {
    email = (email || '').toLowerCase();
    if (pgPool) {
      const r = await pgPool.query('SELECT * FROM app_users WHERE email = $1', [email]);
      if (!r.rows.length) return null;
      const x = r.rows[0];
      return { email: x.email, name: x.name, householdId: x.household_id, isAdmin: x.is_admin };
    }
    return fileDB.users[email] || null;
  },
  async createUser(email, name, householdId, isAdmin) {
    email = (email || '').toLowerCase();
    if (pgPool) await pgPool.query('INSERT INTO app_users (email,name,household_id,is_admin) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO UPDATE SET household_id=EXCLUDED.household_id, name=EXCLUDED.name', [email, name, householdId, !!isAdmin]);
    else { fileDB.users[email] = { email, name, householdId, isAdmin: !!isAdmin }; saveFile(); }
  },
  async listMembers(householdId) {
    if (pgPool) return (await pgPool.query('SELECT email,name FROM app_users WHERE household_id=$1', [householdId])).rows;
    return Object.values(fileDB.users).filter(u => u.householdId === householdId).map(u => ({ email: u.email, name: u.name }));
  },
  async createInvite(inv) {
    const expires = new Date(Date.now() + INVITE_TTL_DAYS * 864e5).toISOString();
    if (pgPool) await pgPool.query('INSERT INTO invites (code,kind,household_id,created_by,expires_at) VALUES ($1,$2,$3,$4,$5)', [inv.code, inv.kind, inv.householdId || null, inv.createdBy, expires]);
    else { fileDB.invites[inv.code] = { ...inv, household_id: inv.householdId || null, used_at: null, expires_at: expires }; saveFile(); }
  },
  async getInvite(code) {
    if (pgPool) { const r = await pgPool.query('SELECT * FROM invites WHERE code=$1', [code]); return r.rows[0] || null; }
    return fileDB.invites[code] || null;
  },
  async markInviteUsed(code) {
    if (pgPool) await pgPool.query('UPDATE invites SET used_at=now() WHERE code=$1', [code]);
    else if (fileDB.invites[code]) { fileDB.invites[code].used_at = new Date().toISOString(); saveFile(); }
  },
  async listHouseholds() {
    if (pgPool) return (await pgPool.query('SELECT id,name FROM households ORDER BY created_at')).rows;
    return Object.values(fileDB.households).map(h => ({ id: h.id, name: h.name }));
  },
};

// Resolve (or create on invite/bootstrap) the household for a signed-in identity.
// Throws { status, error } when a new user lacks a valid invite.
async function resolveHousehold(email, name, inviteCode) {
  email = (email || '').toLowerCase();
  const existing = await store.getUser(email);
  if (existing && existing.householdId) return existing;

  if (isAdminEmail(email)) { // bootstrap: an admin always gets their own household
    const id = await store.createHousehold((name || 'My') + "'s Household");
    await store.createUser(email, name, id, true);
    return { email, name, householdId: id, isAdmin: true };
  }
  if (!inviteCode) throw { status: 403, error: 'invite_required' };
  const inv = await store.getInvite(inviteCode);
  const expired = inv && inv.expires_at && new Date(inv.expires_at) < new Date();
  if (!inv || expired || (inv.kind === 'new' && inv.used_at)) throw { status: 403, error: 'invalid_invite' };

  let householdId;
  if (inv.kind === 'join') {
    householdId = inv.household_id;
  } else { // 'new'
    householdId = await store.createHousehold((name || 'New') + "'s Household");
    await store.markInviteUsed(inv.code);
  }
  await store.createUser(email, name, householdId, false);
  return { email, name, householdId, isAdmin: false };
}

/* ===========================================================================
 * Sessions (signed JWT in an httpOnly cookie)
 * ========================================================================= */
function isSecure(req) {
  return req.secure || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function issueSession(req, res, user) {
  const token = jwt.sign({ email: user.email, name: user.name }, SESSION_SECRET, { expiresIn: '60d' });
  res.setHeader('Set-Cookie', cookie.serialize(COOKIE_NAME, token, {
    httpOnly: true, secure: isSecure(req), sameSite: 'lax', maxAge: 60 * 60 * 24 * 60, path: '/' }));
}
function clearSession(req, res) {
  res.setHeader('Set-Cookie', cookie.serialize(COOKIE_NAME, '', {
    httpOnly: true, secure: isSecure(req), sameSite: 'lax', maxAge: 0, path: '/' }));
}
function sessionFrom(reqOrHeader) {
  try {
    const header = typeof reqOrHeader === 'string' ? reqOrHeader : (reqOrHeader.headers.cookie || '');
    const token = cookie.parse(header || '')[COOKIE_NAME];
    return token ? jwt.verify(token, SESSION_SECRET) : null; // { email, name }
  } catch { return null; }
}

/* ===========================================================================
 * HTTP / Express
 * ========================================================================= */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '15mb' })); // paystub images can be a few MB (base64)

// Resolve the authenticated user (with household) for an API request, or null.
async function authedUser(req) {
  const sess = sessionFrom(req);
  if (!sess) return null;
  const u = await store.getUser(sess.email);
  if (u && u.householdId) return { ...u, name: u.name || sess.name };
  return null;
}

app.get('/api/config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID, devLogin: DEV_LOGIN }));

app.get('/api/me', async (req, res) => {
  const u = await authedUser(req);
  if (!u) return res.status(401).json({ error: 'unauthenticated' });
  const h = await store.getHousehold(u.householdId);
  res.json({ user: { email: u.email, name: u.name }, household: { name: h ? h.name : '', isAdmin: !!u.isAdmin } });
});

app.post('/api/auth', async (req, res) => {
  try {
    let email, name;
    if (DEV_LOGIN && req.body && req.body.devName) {
      email = (req.body.devEmail || 'dev@local').toLowerCase();
      name = String(req.body.devName).slice(0, 40);
    } else {
      const credential = req.body && req.body.credential;
      if (!credential || !googleClient) return res.status(400).json({ error: 'missing credential' });
      const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
      const p = ticket.getPayload();
      if (!p.email_verified) return res.status(403).json({ error: 'email not verified' });
      email = (p.email || '').toLowerCase();
      name = p.given_name || p.name || email;
    }
    const invite = req.body && (req.body.invite || '').trim();
    const user = await resolveHousehold(email, name, invite || null);
    issueSession(req, res, { email: user.email, name });
    res.json({ user: { email: user.email, name } });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.error });
    console.error('[auth] error', e.message);
    res.status(401).json({ error: 'auth_failed' });
  }
});

app.post('/api/logout', (req, res) => { clearSession(req, res); res.json({ ok: true }); });

// Validate an invite code (for the login screen) without leaking household details.
app.get('/api/invite/:code', async (req, res) => {
  const inv = await store.getInvite(req.params.code);
  const expired = inv && inv.expires_at && new Date(inv.expires_at) < new Date();
  const valid = !!inv && !expired && !(inv.kind === 'new' && inv.used_at);
  res.json({ valid, kind: valid ? inv.kind : null });
});

// Create an invite. kind='join' (any member, for their own household) or 'new' (admin only).
app.post('/api/invites', async (req, res) => {
  const u = await authedUser(req);
  if (!u) return res.status(401).json({ error: 'unauthenticated' });
  const kind = req.body && req.body.kind === 'new' ? 'new' : 'join';
  if (kind === 'new' && !u.isAdmin) return res.status(403).json({ error: 'admin_only' });
  const code = newCode();
  await store.createInvite({ code, kind, householdId: kind === 'join' ? u.householdId : null, createdBy: u.email });
  const url = `${req.protocol}://${req.get('host')}/?invite=${code}`;
  res.json({ code, url, kind });
});

app.get('/api/household', async (req, res) => {
  const u = await authedUser(req);
  if (!u) return res.status(401).json({ error: 'unauthenticated' });
  const h = await store.getHousehold(u.householdId);
  res.json({ name: h ? h.name : '', isAdmin: !!u.isAdmin, members: await store.listMembers(u.householdId) });
});

app.post('/api/household/rename', async (req, res) => {
  const u = await authedUser(req);
  if (!u) return res.status(401).json({ error: 'unauthenticated' });
  const name = (req.body && req.body.name || '').toString().slice(0, 60).trim();
  if (name) await store.renameHousehold(u.householdId, name);
  res.json({ ok: true, name });
});

app.get('/api/admin/overview', async (req, res) => {
  const u = await authedUser(req);
  if (!u || !u.isAdmin) return res.status(403).json({ error: 'admin_only' });
  const households = await store.listHouseholds();
  const out = [];
  for (const h of households) out.push({ name: h.name, members: (await store.listMembers(h.id)).length });
  res.json({ households: out });
});

// ── Paystub extraction (Claude vision → structured fields) ──
const PAYSTUB_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    payDate:        { type: ['string', 'null'], description: 'Pay/check date as YYYY-MM-DD' },
    grossPay:       { type: ['number', 'null'], description: 'Gross pay this check, dollars' },
    netPay:         { type: ['number', 'null'], description: 'Net/take-home this check, dollars' },
    regHours:       { type: ['number', 'null'], description: 'Regular hours' },
    otHours:        { type: ['number', 'null'], description: 'Overtime hours' },
    callHours:      { type: ['number', 'null'], description: 'On-call hours' },
    callbackHours:  { type: ['number', 'null'], description: 'Callback hours' },
    incentiveHours: { type: ['number', 'null'], description: 'Incentive/bonus hours' },
    bonus:          { type: ['number', 'null'], description: 'Bonus amount, dollars' },
    taxes:          { type: ['number', 'null'], description: 'Total taxes withheld, dollars' },
    retirement:     { type: ['number', 'null'], description: '401k/retirement contribution, dollars' },
    employer:       { type: ['string', 'null'], description: 'Employer name' },
  },
  required: ['payDate', 'grossPay', 'netPay', 'regHours', 'otHours', 'callHours',
    'callbackHours', 'incentiveHours', 'bonus', 'taxes', 'retirement', 'employer'],
};

app.post('/api/extract-paystub', async (req, res) => {
  const u = await authedUser(req);
  if (!u) return res.status(401).json({ error: 'unauthenticated' });
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: 'extract_unconfigured' });
  const { data, mediaType, kind } = req.body || {};
  if (!data || !mediaType) return res.status(400).json({ error: 'missing_file' });
  try {
    const Mod = require('@anthropic-ai/sdk');
    const Anthropic = Mod.default || Mod;
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const docBlock = kind === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    const msg = await client.messages.create({
      model: EXTRACT_MODEL,
      max_tokens: 1024,
      output_config: { format: { type: 'json_schema', schema: PAYSTUB_SCHEMA } },
      messages: [{ role: 'user', content: [
        docBlock,
        { type: 'text', text: 'This is a pay stub. Extract the fields into the required JSON. Money as plain numbers in dollars (no symbols); payDate as YYYY-MM-DD (the pay/check date). On healthcare paychecks, "Call"/"On-Call" and "Callback" are separate pay lines — keep them distinct. If a field is absent, use null.' },
      ] }],
    });
    if (msg.stop_reason === 'refusal') return res.status(422).json({ error: 'refused' });
    const textBlock = (msg.content || []).find(b => b.type === 'text');
    let fields = null;
    try { fields = JSON.parse(textBlock.text); }
    catch { const m = textBlock && textBlock.text.match(/\{[\s\S]*\}/); if (m) fields = JSON.parse(m[0]); }
    if (!fields) return res.status(502).json({ error: 'parse_failed' });
    res.json({ fields });
  } catch (e) {
    console.error('[extract] error', e.message);
    res.status(502).json({ error: 'extract_failed', detail: e.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ===========================================================================
 * WebSocket realtime sync — scoped per household
 * ========================================================================= */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const hcache = new Map(); // householdId -> { data, version, updatedBy, updatedAt }

async function getHouseholdState(id) {
  if (hcache.has(id)) return hcache.get(id);
  const h = await store.getHousehold(id);
  const st = h ? { data: h.data, version: h.version, updatedBy: h.updatedBy, updatedAt: h.updatedAt }
               : { data: {}, version: 0, updatedBy: '', updatedAt: null };
  hcache.set(id, st);
  return st;
}
function broadcast(householdId, obj, exceptWs) {
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (c !== exceptWs && c.readyState === 1 && c.householdId === householdId) c.send(msg);
  }
}

wss.on('connection', async (ws, req) => {
  const sess = sessionFrom(req);
  const user = sess ? await store.getUser(sess.email) : null;
  if (!user || !user.householdId) {
    ws.send(JSON.stringify({ type: 'error', error: 'unauthenticated' }));
    ws.close();
    return;
  }
  ws.user = { email: user.email, name: user.name || (sess && sess.name) || user.email };
  ws.householdId = user.householdId;
  const st = await getHouseholdState(ws.householdId);
  ws.send(JSON.stringify({ type: 'state', data: st.data, version: st.version, updatedBy: st.updatedBy, updatedAt: st.updatedAt }));

  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== 'update') return;
    const cur = await getHouseholdState(ws.householdId);
    if (msg.baseVersion != null && msg.baseVersion !== cur.version) {
      ws.send(JSON.stringify({ type: 'conflict', data: cur.data, version: cur.version, updatedBy: cur.updatedBy, updatedAt: cur.updatedAt }));
      return;
    }
    cur.version += 1;
    cur.data = msg.data || {};
    cur.updatedBy = ws.user.name;
    try { cur.updatedAt = await store.saveHousehold(ws.householdId, cur.data, cur.version, cur.updatedBy); }
    catch (e) { console.error('[save] error', e.message); }
    ws.send(JSON.stringify({ type: 'ack', version: cur.version, updatedAt: cur.updatedAt }));
    broadcast(ws.householdId, { type: 'state', data: cur.data, version: cur.version, updatedBy: cur.updatedBy, updatedAt: cur.updatedAt }, ws);
  });
});

/* --------------------------------------------------------------------------- */
(async () => {
  await initStore();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Family YNAB (multi-tenant) running on :${PORT}`);
    console.log(`  Google sign-in: ${GOOGLE_CLIENT_ID ? 'configured' : 'NOT configured'}`);
    console.log(`  Dev login:      ${DEV_LOGIN ? 'ENABLED (dev@local = admin)' : 'disabled'}`);
    console.log(`  Admin emails:   ${ADMIN_EMAILS.length ? ADMIN_EMAILS.join(', ') : '(none set)'}`);
  });
})();
