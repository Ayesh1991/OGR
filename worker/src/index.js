/**
 * ═══════════════════════════════════════════════════════════════════
 *  OG REVISE — CLOUD BROKER (Cloudflare Worker)
 * ═══════════════════════════════════════════════════════════════════
 *  This Worker is the app's secrets vault + Google Drive token broker.
 *  Nothing sensitive ever lives in the browser any more:
 *
 *    • Google OAuth Client ID + Client Secret   → Worker secrets
 *    • Google refresh token (never expires*)    → Worker KV
 *    • Drive root folder ID                     → Worker secret/var
 *    • Who is allowed in (your email)           → Worker secret/var
 *
 *  The PWA logs the user in with Supabase (magic link / Google).
 *  It then calls  POST /api/drive-token  with the Supabase access
 *  token. The Worker:
 *    1. Verifies the Supabase session server-side.
 *    2. Checks the email is ALLOWED_EMAIL (ayeshmantha@gmail.com).
 *    3. Mints a fresh Google Drive access token from the stored
 *       refresh token (cached in KV until ~5 min before expiry).
 *    4. Returns { access_token, expires_at, folder_id }.
 *
 *  The PWA silently re-calls this before expiry → no more hourly
 *  redirect, no more "stuck syncing" mid-study.
 *
 *  ─── ENDPOINTS ─────────────────────────────────────────────────
 *   GET  /                    tiny status page (no secrets shown)
 *   GET  /setup?key=SETUP_KEY one-time: start Google consent flow
 *   GET  /setup/callback      one-time: stores the refresh token in KV
 *   POST /api/session         verify Supabase login → { ok, email }
 *   POST /api/drive-token     → { access_token, expires_at, folder_id }
 *   GET  /api/health          unauthenticated liveness probe
 *
 *  ─── REQUIRED BINDINGS / SECRETS (Cloudflare dashboard) ────────
 *   KV namespace binding:  OG_KV
 *   Secrets:
 *     GOOGLE_CLIENT_ID      xxxx.apps.googleusercontent.com
 *     GOOGLE_CLIENT_SECRET  GOCSPX-…
 *     DRIVE_FOLDER_ID       your OG-Revise root folder ID
 *     ALLOWED_EMAIL         ayeshmantha@gmail.com
 *     SETUP_KEY             any long random string (guards /setup)
 *     SUPABASE_URL          https://<project>.supabase.co
 *     SUPABASE_ANON_KEY     the public anon key of the same project
 *   Vars (plain text is fine):
 *     ALLOWED_ORIGINS       comma list, e.g.
 *                           https://ayesh1991.github.io
 * ═══════════════════════════════════════════════════════════════════
 */

const GOOGLE_AUTH  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const DRIVE_SCOPE  = 'https://www.googleapis.com/auth/drive';

/* In-isolate micro-cache so we do not hit Supabase on every call. */
const sessionCache = new Map(); // sha256(jwt) -> { email, until }

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      switch (url.pathname) {
        case '/':                return statusPage(env);
        case '/setup':           return setupStart(url, env);
        case '/setup/callback':  return setupCallback(url, env);
        case '/api/health':      return json({ ok: true, t: Date.now() }, 200, cors);
        case '/api/session':     return apiSession(request, env, cors);
        case '/api/drive-token': return apiDriveToken(request, env, cors);
        default:                 return json({ error: 'not_found' }, 404, cors);
      }
    } catch (err) {
      return json({ error: 'server_error', message: String(err && err.message || err) }, 500, cors);
    }
  }
};

/* ─────────────────────────── CORS ─────────────────────────── */
function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  // Also allow localhost for development previews.
  if (allowed.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
  }
  return h;
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }
  });
}

/* ──────────────────── Supabase verification ──────────────────── */
async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verifies the Bearer token is a live Supabase session belonging to
 * ALLOWED_EMAIL. Returns the email, or throws {code,status}.
 */
async function requireUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!jwt) throw httpErr(401, 'missing_token', 'No Supabase session token supplied');

  const key = await sha256hex(jwt);
  const hit = sessionCache.get(key);
  if (hit && hit.until > Date.now()) return hit.email;

  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${jwt}` }
  });
  if (!r.ok) throw httpErr(401, 'bad_session', 'Supabase session is invalid or expired');
  const user = await r.json();
  const email = String(user.email || '').toLowerCase();

  if (!email || email !== String(env.ALLOWED_EMAIL || '').toLowerCase()) {
    throw httpErr(403, 'forbidden', 'This account is not authorised to use OG Revise');
  }
  sessionCache.set(key, { email, until: Date.now() + 60_000 });
  return email;
}

function httpErr(status, code, message) {
  const e = new Error(message);
  e.status = status; e.code = code;
  return e;
}

/* ─────────────────────────── API ─────────────────────────── */
async function apiSession(request, env, cors) {
  try {
    const email = await requireUser(request, env);
    return json({ ok: true, email }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: e.code || 'error', message: e.message }, e.status || 500, cors);
  }
}

async function apiDriveToken(request, env, cors) {
  try {
    await requireUser(request, env);
  } catch (e) {
    return json({ error: e.code || 'error', message: e.message }, e.status || 500, cors);
  }

  // 1) Serve the cached access token if it still has ≥ 5 minutes left.
  const cachedRaw = await env.OG_KV.get('gd_access');
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw);
      if (cached.expires_at - Date.now() > 5 * 60_000) {
        return json({
          access_token: cached.token,
          expires_at: cached.expires_at,
          folder_id: env.DRIVE_FOLDER_ID || ''
        }, 200, cors);
      }
    } catch (_) { /* fall through to refresh */ }
  }

  // 2) Mint a fresh one from the stored refresh token.
  const refreshToken = await env.OG_KV.get('gd_refresh');
  if (!refreshToken) {
    return json({
      error: 'setup_required',
      message: 'No Google refresh token stored yet. Open /setup?key=YOUR_SETUP_KEY once.'
    }, 503, cors);
  }

  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  const r = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await r.json();

  if (!r.ok || !data.access_token) {
    // invalid_grant → the refresh token was revoked; setup must be re-run.
    const revoked = data.error === 'invalid_grant';
    if (revoked) await env.OG_KV.delete('gd_refresh');
    return json({
      error: revoked ? 'reauth_needed' : 'google_error',
      message: revoked
        ? 'Google access was revoked. Re-run /setup?key=YOUR_SETUP_KEY once.'
        : `Google token refresh failed: ${data.error || r.status}`
    }, 503, cors);
  }

  const expires_at = Date.now() + (data.expires_in || 3600) * 1000;
  await env.OG_KV.put('gd_access', JSON.stringify({ token: data.access_token, expires_at }), {
    expirationTtl: Math.max(60, data.expires_in || 3600)
  });

  return json({
    access_token: data.access_token,
    expires_at,
    folder_id: env.DRIVE_FOLDER_ID || ''
  }, 200, cors);
}

/* ─────────────────── One-time Google consent ─────────────────── */
function setupStart(url, env) {
  if (url.searchParams.get('key') !== env.SETUP_KEY) {
    return new Response('Forbidden', { status: 403 });
  }
  const redirectUri = `${url.origin}/setup/callback`;
  const consent = new URL(GOOGLE_AUTH);
  consent.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  consent.searchParams.set('redirect_uri', redirectUri);
  consent.searchParams.set('response_type', 'code');
  consent.searchParams.set('scope', DRIVE_SCOPE);
  consent.searchParams.set('access_type', 'offline');   // ← gives us a refresh token
  consent.searchParams.set('prompt', 'consent');        // ← forces a NEW refresh token
  consent.searchParams.set('state', env.SETUP_KEY);
  return Response.redirect(consent.toString(), 302);
}

async function setupCallback(url, env) {
  if (url.searchParams.get('state') !== env.SETUP_KEY) {
    return new Response('Forbidden', { status: 403 });
  }
  const code = url.searchParams.get('code');
  if (!code) return setupPage(false, 'Google did not return a code. Try again.');

  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: `${url.origin}/setup/callback`,
    grant_type: 'authorization_code'
  });
  const r = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await r.json();

  if (!data.refresh_token) {
    return setupPage(false,
      `No refresh token returned (${data.error || 'unknown'}). ` +
      'Remove the app at myaccount.google.com/permissions, then run /setup again.');
  }
  await env.OG_KV.put('gd_refresh', data.refresh_token);
  await env.OG_KV.delete('gd_access');
  return setupPage(true, 'Google Drive is now linked. You can close this tab — the PWA will connect silently from now on.');
}

function setupPage(ok, msg) {
  return new Response(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OG Revise · Broker setup</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#04080f;font-family:system-ui,sans-serif">
<div style="max-width:420px;padding:40px;border-radius:24px;background:#0d1529;border:1px solid #1a2545;text-align:center">
<div style="font-size:44px">${ok ? '✅' : '⚠️'}</div>
<h1 style="color:${ok ? '#00e5c0' : '#f59e0b'};font-size:20px;margin:14px 0 8px">${ok ? 'Setup complete' : 'Setup problem'}</h1>
<p style="color:#a8b8d8;font-size:14px;line-height:1.6">${msg}</p>
</div></body>`, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
}

function statusPage(env) {
  const ready = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SUPABASE_URL);
  return new Response(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OG Revise · Cloud broker</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#04080f;font-family:system-ui,sans-serif">
<div style="text-align:center">
<div style="width:52px;height:52px;margin:0 auto 16px;border-radius:16px;background:linear-gradient(135deg,#00d4ff,#00e5c0);display:flex;align-items:center;justify-content:center;font-weight:800;color:#04080f;font-size:18px">OG</div>
<div style="color:#f0f4ff;font-weight:700">OG Revise cloud broker</div>
<div style="color:#6478a0;font-size:13px;margin-top:6px">${ready ? 'configured · online' : 'awaiting configuration'}</div>
</div></body>`, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
}
