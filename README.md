# Family YNAB 💰

A private, real-time budgeting app for **two people**. Built on your existing
financial planner (variable Call / Callback / OT paycheck logging, debts, payoff,
goals, net worth) **plus** true YNAB-style zero-based budgeting — and now it syncs
live across both your phones and computers.

- **Real-time sync** — an edit on one device shows up on the other in ~1 second.
- **Private** — locked to your two Google accounts.
- **Always available** — runs on Railway with a Postgres database.
- **Offline-safe** — keeps working if the network drops, reconciles on reconnect.

---

## Run it locally first (no accounts needed)

```bash
npm install
npm start
```

Open http://localhost:3000 → click **Dev sign-in**, type any name, and you're in.
Locally there's no Google requirement and data is stored in `./data.json`.

To see live sync locally, open the same URL in two browser windows and edit in one.

---

## Deploy for real (Google Sign-In + Railway)

You only do this once. Two services are involved: **Google Cloud** (for sign-in)
and **Railway** (for hosting + database).

### Step 1 — Deploy to Railway (to get your URL)

1. Push this folder to a GitHub repo.
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → pick this repo.
3. In the project, click **+ New** → **Database** → **Add PostgreSQL**.
   (Railway automatically exposes `DATABASE_URL` to your app — you don't copy it.)
4. Open your app service → **Settings** → **Networking** → **Generate Domain**.
   Copy the URL (e.g. `https://family-ynab-production.up.railway.app`).

### Step 2 — Create the Google Sign-In client

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create/select a project.
2. **APIs & Services** → **OAuth consent screen** → choose **External** → fill in app
   name + your email → add both of your Gmail addresses under **Test users** → Save.
3. **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**
   → Application type **Web application**.
4. Under **Authorized JavaScript origins**, add:
   - your Railway URL (from Step 1.4)
   - `http://localhost:3000`
5. Click **Create** and copy the **Client ID**.

### Step 3 — Set Railway variables

In your Railway app service → **Variables**, add:

| Variable           | Value                                                        |
|--------------------|-------------------------------------------------------------|
| `GOOGLE_CLIENT_ID` | the Client ID from Step 2.5                                  |
| `ALLOWED_EMAILS`   | `you@gmail.com,spouse@gmail.com` (your two real Gmails)      |
| `SESSION_SECRET`   | a long random string (see below)                            |

Generate a secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Railway redeploys automatically. Open your URL, **Sign in with Google**, and you're live.

### Step 4 — Put it on both phones

Open the Railway URL in each phone's browser → **Share → Add to Home Screen**.
It behaves like an app and stays in sync.

---

## How sync works (plain English)

The Railway server holds one shared copy of your budget. When either of you makes a
change, your browser sends it to the server, the server saves it and pushes it to the
other person's screen. If you both happen to edit at the exact same second, the server
keeps the first save and the second device merges the latest in before saving — so
nobody's change silently disappears. The field you're actively typing in is never
overwritten mid-keystroke.

---

## Tech

Single-file frontend (`public/index.html`) + Node backend (`server.js`:
Express, `ws`, `google-auth-library`, `pg`). State is one JSON document.
