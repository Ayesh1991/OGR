# OG Revise — Cloud Setup Guide

This upgrade moves every secret **out of the browser** and into a Cloudflare
Worker, adds a **private login** (only `ayeshmantha@gmail.com` can enter), and
kills the hourly "reconnect Drive" interruption for good.

```
┌────────────┐   login    ┌────────────┐  verify jwt  ┌───────────────────┐
│  You (PWA) │──────────▶│  Supabase   │◀────────────│ Cloudflare Worker  │
│ GitHub Pages│           │  (identity) │              │  · client secret   │
│  (static)  │◀──────────┴────────────┘              │  · refresh token   │
│            │   Drive access token (auto-renewed)    │  · folder ID       │
│            │◀───────────────────────────────────────│  · allowed email   │
└─────┬──────┘                                        └─────────┬─────────┘
      │  Bearer token (silently refreshed ~every 55 min)        │
      ▼                                                         ▼
┌─────────────────────────┐                     ┌──────────────────────────┐
│  Google Drive           │◀────────────────────│  Google OAuth (server-   │
│  (your study data)      │                     │  side refresh grant)     │
└─────────────────────────┘                     └──────────────────────────┘
```

**Who stores what**

| Place            | Stores                                                        |
|------------------|---------------------------------------------------------------|
| GitHub Pages     | the app itself (static files only — nothing secret)           |
| Cloudflare Worker| Google client ID + secret, refresh token, folder ID, your email |
| Supabase         | your login identity (who is allowed in)                       |
| Google Drive     | all study data — infographics, docx, flashcards, papers       |
| Browser          | only cached study content + a short-lived access token        |

Total cost: **$0** (free tiers of all three services are far more than enough).

---

## Step 1 — Google Cloud (5 min)

You probably already have this from the old app. You need one extra thing:
a **client secret** (the old app used the "implicit" flow which has none).

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → your
   existing project (or create one) → **APIs & Services**.
2. Make sure **Google Drive API** is enabled.
3. **Credentials → Create Credentials → OAuth client ID → Web application.**
   - Name: `OG Revise Broker`
   - **Authorized redirect URIs** — add (you'll know the exact Worker URL
     after Step 3; come back and fill it then):
     `https://og-revise-broker.<your-subdomain>.workers.dev/setup/callback`
4. Save the **Client ID** and **Client Secret** somewhere temporary.

> The OAuth consent screen can stay in "Testing" mode — add
> `ayeshmantha@gmail.com` as a test user. Note: Google expires refresh tokens
> after 7 days in Testing mode, so either publish the consent screen
> (Production, no verification needed for Drive scope with <100 users)
> or expect to re-run /setup weekly. **Publishing it is strongly recommended.**

## Step 2 — Supabase (5 min)

Supabase is only used to answer one question: *"is this really Ayesh?"*

1. Create a free project at [supabase.com](https://supabase.com).
2. **Authentication → Providers**: keep **Email** enabled.
   Turn OFF "Confirm email" is not needed; defaults are fine.
3. **Authentication → Email Templates → Magic Link**: make sure the template
   contains the `{{ .Token }}` variable so the email includes the **6-digit
   code** (add a line like `Your code: {{ .Token }}` if it's not there).
   The 6-digit code is what makes login work perfectly inside the installed
   PWA (no browser redirect needed).
4. *(Optional hardening)* **Authentication → Settings**: after you've signed
   in once, disable **"Allow new users to sign up"**. Then no one else can
   even create an account. (The Worker rejects other emails regardless.)
5. **Settings → API**: copy the **Project URL** and the **anon public key**.

## Step 3 — Cloudflare Worker (10 min)

1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com).
2. **Workers & Pages → Create → Worker**. Name it `og-revise-broker`.
   Replace the starter code with the contents of **`worker/src/index.js`**
   from this repo → **Deploy**. Note your Worker URL:
   `https://og-revise-broker.<your-subdomain>.workers.dev`
3. **Storage & Databases → KV → Create namespace**: name it `OG_KV`.
   Then in the Worker → **Settings → Bindings → Add → KV namespace**:
   variable name `OG_KV`, select the namespace.
4. Worker → **Settings → Variables and Secrets** — add these as **Secrets**:

   | Name                   | Value                                             |
   |------------------------|---------------------------------------------------|
   | `GOOGLE_CLIENT_ID`     | from Step 1                                       |
   | `GOOGLE_CLIENT_SECRET` | from Step 1                                       |
   | `DRIVE_FOLDER_ID`      | your OG-Revise root folder ID (from the Drive URL)|
   | `ALLOWED_EMAIL`        | `ayeshmantha@gmail.com`                           |
   | `SETUP_KEY`            | any long random string, e.g. from a password generator |
   | `SUPABASE_URL`         | from Step 2                                       |
   | `SUPABASE_ANON_KEY`    | from Step 2                                       |

   And this as a plain **Variable**:

   | Name              | Value                                                  |
   |-------------------|--------------------------------------------------------|
   | `ALLOWED_ORIGINS` | `https://<your-github-username>.github.io` (no trailing slash) |

5. Go back to **Google Cloud → Credentials** and set the redirect URI to your
   real Worker URL: `https://og-revise-broker.<sub>.workers.dev/setup/callback`

*(CLI alternative: `cd worker && npx wrangler deploy`, then
`npx wrangler kv namespace create OG_KV` and `npx wrangler secret put …` —
`worker/wrangler.toml` is ready.)*

## Step 4 — Configure the app (1 min)

Edit **`og-config.js`** in the repo:

```js
WORKER_URL:        "https://og-revise-broker.<sub>.workers.dev",
SUPABASE_URL:      "https://<project-ref>.supabase.co",
SUPABASE_ANON_KEY: "eyJ…",
```

These three values are public-safe by design — leave everything else as is.
Commit + push (or upload the files via the GitHub web UI). GitHub Pages
(Settings → Pages → deploy from branch) serves the app.

## Step 5 — Link Google Drive (one time, 1 min)

Open in a browser:

```
https://og-revise-broker.<sub>.workers.dev/setup?key=YOUR_SETUP_KEY
```

Approve the Google consent screen **with the Google account that owns the
Drive folder**. You'll see "✅ Setup complete". The Worker now holds a
long-lived refresh token — the app never asks you to reconnect again.

## Step 6 — First login

1. Open your GitHub Pages URL.
2. The gate asks for your email → you get a **6-digit code** → enter it.
3. Done. The device stays signed in (Supabase sessions auto-renew), Drive
   tokens renew silently in the background, and the whole library works
   offline from cache as before.

> **Reinstall note:** the manifest identity changed from `/OGinfo/` to relative
> paths (so it works at any URL). Remove the old home-screen icon and
> re-install the PWA once from the new URL.

---

## How the old problems are actually fixed

| Old problem | What happens now |
|---|---|
| OAuth client ID + folder ID stored in browser | Both live only in the Worker; the browser never sees the client secret at all |
| Hourly reconnect redirect that lost your place | Worker mints a fresh token from its refresh token; app renews it silently ~5 min before expiry, on tab-resume, and on reconnect |
| "Stuck syncing" mid-study | Every Drive call that hits a 401 now transparently refreshes the token and retries once |
| App URL was public | Full-screen private gate; the Worker refuses any Supabase login that isn't `ayeshmantha@gmail.com` |

## Troubleshooting

- **Gate says "cloud broker unreachable"** → check `WORKER_URL` in
  og-config.js and that `ALLOWED_ORIGINS` exactly matches your Pages origin.
- **"Drive is not linked yet"** → run Step 5 (`/setup?key=…`).
- **"Google access was revoked"** → you removed the grant at
  myaccount.google.com/permissions; run Step 5 again.
- **No code in the email** → Step 2.3 (add `{{ .Token }}` to the template).
- **Want the old behaviour temporarily** → set `LEGACY_MODE: true` in
  og-config.js; the classic client-side OAuth flow is fully preserved.
