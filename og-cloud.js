/* ═══════════════════════════════════════════════════════════════════
   OG REVISE — CLOUD LAYER  (og-cloud.js)
   ═══════════════════════════════════════════════════════════════════
   What this file does:

   1. PRIVATE ACCESS GATE
      A full-screen, animated (Three.js + GSAP) sign-in experience.
      Login is Supabase (6-digit email code, optional Google), and the
      Cloudflare Worker enforces that ONLY the owner's email gets in.

   2. DRIVE TOKEN BROKER (kills the hourly reconnect)
      Fetches short-lived Google Drive access tokens from the Worker
      and silently renews them ~5 minutes before they expire, plus on
      tab-resume and on coming back online. The main app keeps using
      `S.token` exactly as before — it just never goes stale.

   3. GRACEFUL FALLBACK
      If og-config.js is not filled in (or LEGACY_MODE is true) this
      file does NOTHING and the classic client-side OAuth flow keeps
      working. Zero risk during migration.

   Host-page contract (index.html / uploader define these):
     window.ogCloudApplyToken(token, expiresAtMs, folderId)
       → push a fresh Drive token into the app's state.
     OGCloud.appReady()
       → host app finished booting; deliver any pending token.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var CFG = window.OG_CONFIG || {};
  var IS_EMBED = /[?&]embed=1/.test(location.search);      // uploader inside PWA iframe
  var IS_POPUP = !!(window.opener && location.hash.indexOf('access_token') >= 0);

  /* AUTH MODE
     'worker'   — login lives entirely in your Cloudflare Worker (default).
                  No third-party identity service, no extra cost, and the
                  supabase-js library is never even downloaded.
     'supabase' — legacy: used only while SUPABASE_URL + SUPABASE_ANON_KEY
                  are still filled in, so you can migrate with no downtime. */
  var MODE = (CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY) ? 'supabase' : 'worker';

  var enabled = !!CFG.WORKER_URL && !CFG.LEGACY_MODE && !IS_EMBED && !IS_POPUP;

  var SESS_KEY = 'og_sess_v1';
  var sb = null;               // supabase client (legacy mode only)
  var userEmail = '';
  var pendingToken = null;     // token that arrived before host app was ready
  var appIsReady = false;
  var refreshTimer = null;
  var inflight = null;         // de-duped refresh promise
  var tokenState = { token: null, exp: 0, folderId: '' };
  var three = { renderer: null, raf: 0 };
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── public API (always present, even when disabled) ───────────── */
  window.OGCloud = {
    enabled: enabled,
    mode: MODE,
    email: function () { return userEmail || localStorage.getItem('og_cloud_email') || ''; },
    refreshToken: refreshToken,
    signOut: signOut,
    appReady: function () {
      appIsReady = true;
      if (pendingToken) { deliverToken(pendingToken); pendingToken = null; }
    },
    renderSettings: renderSettings
  };

  if (!enabled) return;

  /* Mark the document so CSS can hide legacy setup UI. */
  document.documentElement.classList.add('og-cloud', 'og-gate-hold');

  /* Hide the app until access is verified (no flash of content). */
  var holdStyle = document.createElement('style');
  holdStyle.textContent = 'html.og-gate-hold #app,html.og-gate-hold #toast{visibility:hidden!important}';
  document.head.appendChild(holdStyle);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* ═══════════════════════ script loading ═══════════════════════ */
  var loaded = {};
  function loadScript(src) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('load failed: ' + src)); };
      document.head.appendChild(s);
    });
    return loaded[src];
  }
  function ensureSupabase() {
    if (window.supabase && window.supabase.createClient) return Promise.resolve();
    return loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js');
  }
  function ensureGsap() {
    if (window.gsap) return Promise.resolve();
    return loadScript('https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js').catch(function(){});
  }
  function ensureThree() {
    if (window.THREE) return Promise.resolve();
    return loadScript('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js');
  }

  /* ═══════════════════ session token (both modes) ═══════════════════ */
  function storedSession() {
    try { return JSON.parse(localStorage.getItem(SESS_KEY) || 'null'); } catch (e) { return null; }
  }
  function saveSession(token, expiresAt, email) {
    try {
      localStorage.setItem(SESS_KEY, JSON.stringify({ t: token, x: expiresAt || 0, e: email || userEmail || '' }));
    } catch (e) {}
  }
  function clearSession() { try { localStorage.removeItem(SESS_KEY); } catch (e) {} }

  /** Resolves to the bearer token to present to the Worker, or null. */
  function currentJwt() {
    if (MODE === 'worker') {
      var s = storedSession();
      if (!s || !s.t) return Promise.resolve(null);
      if (s.x && s.x < Date.now()) { clearSession(); return Promise.resolve(null); }
      return Promise.resolve(s.t);
    }
    return ensureSupabase().then(function () {
      if (!sb) sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
      return sb.auth.getSession();
    }).then(function (r) {
      var session = r && r.data && r.data.session;
      return session ? session.access_token : null;
    });
  }

  /* ═══════════════════════════ boot ═══════════════════════════ */
  function boot() {
    injectGate();
    setState('checking');
    ensureGsap().then(introAnimation);
    if (!REDUCED) { ensureThree().then(startScene).catch(function(){}); }

    if (MODE === 'worker') { resumeSession(); return; }

    /* ── legacy Supabase mode ── */
    ensureSupabase().then(function () {
      sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      sb.auth.onAuthStateChange(function (event) {
        if (event === 'SIGNED_IN') { cleanAuthHash(); resumeSession(); }
        if (event === 'SIGNED_OUT') { location.reload(); }
      });
      resumeSession();
    }).catch(function () {
      /* Supabase JS could not load (probably offline). If this device
         signed in before, let the cached app run — study must go on. */
      if (localStorage.getItem('og_cloud_email')) revealApp();
      else setState('error', 'You appear to be offline and this device has not signed in before. Connect to the internet once to activate.');
    });
  }

  /* Supabase magic-link redirects leave tokens in the URL hash —
     remove them so the app's own OAuth handler never sees them. */
  function cleanAuthHash() {
    if (/access_token|refresh_token|type=magiclink|type=recovery/.test(location.hash)) {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    }
  }

  function resumeSession() {
    currentJwt().then(function (jwt) {
      if (!jwt) {
        /* No stored login. If this device signed in before and is plainly
           offline, open the cached library rather than blocking study. */
        if (!navigator.onLine && localStorage.getItem('og_cloud_email')) { revealApp(); armReconnect(); return; }
        setState('signin');
        return;
      }
      /* We have a login → always ATTEMPT to verify and fetch a Drive token.
         navigator.onLine is an unreliable signal (captive portals, webviews,
         installed PWAs), so we never let it stop us from trying: if the
         network really is down the request fails fast and the catch below
         opens the cached library and arms a retry. */
      verifyAndEnter(jwt, false);
    }).catch(function () {
      if (localStorage.getItem('og_cloud_email')) { revealApp(); armReconnect(); }
      else setState('signin');
    });
  }

  /* Keep trying to get a Drive token after a failed start — on the next
     'online' event, and on a timer, so a bad first attempt never leaves
     the app permanently disconnected. */
  var reconnectArmed = false;
  function armReconnect() {
    if (reconnectArmed) return;
    reconnectArmed = true;
    var tries = 0;
    var attempt = function () {
      if (tokenState.token && tokenState.exp > Date.now()) { disarm(); return; }
      tries++;
      refreshToken(true).then(function (t) {
        if (t) disarm();
        else if (tries < 6) setTimeout(attempt, Math.min(60000, 8000 * tries));
        else disarm();
      });
    };
    var onOnline = function () { attempt(); };
    function disarm() { reconnectArmed = false; window.removeEventListener('online', onOnline); }
    window.addEventListener('online', onOnline);
    setTimeout(attempt, 8000);
  }

  function verifyAndEnter(jwt, silent) {
    workerFetch('/api/session', jwt).then(function (res) {
      if (res.status === 403) { setState('denied'); return; }
      if (res.status === 401) { clearSession(); setState('signin'); return; }
      if (!res.ok) throw new Error('broker ' + res.status);
      return res.json().then(function (d) {
        userEmail = d.email || '';
        try { localStorage.setItem('og_cloud_email', userEmail); } catch (e) {}
        /* The Worker reissues long-lived sessions before they lapse. */
        if (d.token) saveSession(d.token, d.expires_at, userEmail);
        decorateEmail();
        return fetchDriveToken(d.token || jwt).then(function () {
          if (!silent) revealApp();
        });
      });
    }).catch(function (err) {
      if (silent) return;
      /* Broker unreachable but login is valid → run from cache and keep
         trying in the background so Drive comes back on its own. */
      if (localStorage.getItem('og_cloud_email')) { revealApp(); gateToastLate(err); armReconnect(); }
      else setState('error', brokerErrText(err));
    });
  }

  function brokerErrText(err) {
    var m = (err && err.message) || '';
    if (m.indexOf('setup_required') >= 0) return 'The cloud broker is deployed but Google Drive is not linked yet. Open the Worker’s /setup URL once (see SETUP.md step 5).';
    if (m.indexOf('reauth_needed') >= 0) return 'Google access was revoked. Re-run the Worker’s /setup URL once to relink Drive.';
    return 'Could not reach the cloud broker. Check WORKER_URL in og-config.js and that the Worker is deployed. (' + m + ')';
  }
  function gateToastLate(err) {
    console.warn('OGCloud: broker unavailable, running from cache —', err && err.message);
  }

  /* ═══════════════════ worker / token broker ═══════════════════ */
  function workerFetch(path, jwt, opts) {
    opts = opts || {};
    opts.method = opts.method || 'POST';
    opts.headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + jwt });
    return fetch(CFG.WORKER_URL.replace(/\/$/, '') + path, opts);
  }

  function fetchDriveToken(jwt) {
    return workerFetch('/api/drive-token', jwt).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok || !d.access_token) {
          var e = new Error(d.error || ('broker ' + r.status));
          e.code = d.error; throw e;
        }
        tokenState = { token: d.access_token, exp: d.expires_at, folderId: d.folder_id || '' };
        /* Worker rolls the login session forward as it nears expiry. */
        if (d.session_token) saveSession(d.session_token, d.session_expires_at, userEmail);
        try {
          sessionStorage.setItem('og_tok', d.access_token);
          sessionStorage.setItem('og_exp', String(d.expires_at));
          if (d.folder_id) localStorage.setItem('og_fid', d.folder_id);
        } catch (e2) {}
        deliverToken(tokenState);
        scheduleRefresh();
        return d.access_token;
      });
    });
  }

  function deliverToken(t) {
    if (!appIsReady && typeof window.ogCloudApplyToken !== 'function') { pendingToken = t; return; }
    if (typeof window.ogCloudApplyToken === 'function') {
      try { window.ogCloudApplyToken(t.token, t.exp, t.folderId); } catch (e) { console.warn('OGCloud apply:', e); }
    }
    try { window.dispatchEvent(new CustomEvent('og-cloud-token', { detail: t })); } catch (e) {}
  }

  /**
   * Public: get a fresh Drive token. De-duplicates concurrent calls.
   * Returns a Promise<string|null>. With force=false it reuses the
   * current token when it still has >10 minutes of life.
   */
  function refreshToken(force) {
    if (!enabled) return Promise.resolve(null);
    if (!force && tokenState.token && tokenState.exp - Date.now() > 10 * 60000) {
      return Promise.resolve(tokenState.token);
    }
    if (inflight) return inflight;
    inflight = currentJwt().then(function (jwt) {
      if (!jwt) { setStateIfGate('signin'); return null; }
      return fetchDriveToken(jwt);
    }).catch(function (err) {
      console.warn('OGCloud refresh failed:', err && err.message);
      if (err && (err.code === 'setup_required' || err.code === 'reauth_needed')) {
        notifyBrokerProblem(brokerErrText(err));
      }
      return null;
    }).finally(function () { inflight = null; });
    return inflight;
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    var ms = Math.max(60000, tokenState.exp - Date.now() - 5 * 60000);
    refreshTimer = setTimeout(function () { refreshToken(true); }, ms);
  }

  /* Renew eagerly when the PWA is resumed or connectivity returns —
     this is exactly the moment the old app used to get stuck syncing. */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    /* Refresh when the token is near expiry OR when we never got one
       (e.g. the app opened from cache while the network was down). */
    if (tokenState.exp - Date.now() < 10 * 60000 && localStorage.getItem('og_cloud_email')) {
      refreshToken(true);
    }
  });
  window.addEventListener('online', function () {
    if (tokenState.exp - Date.now() < 10 * 60000) refreshToken(true);
  });

  function notifyBrokerProblem(text) {
    if (typeof window.toast === 'function') { try { window.toast(text, 'err'); return; } catch (e) {} }
    console.error('OGCloud:', text);
  }

  /* ═══════════════════════ auth actions ═══════════════════════ */
  var lastEmailSentTo = '';

  /** POST JSON to the Worker without a bearer token (login endpoints). */
  function workerPost(path, body) {
    return fetch(CFG.WORKER_URL.replace(/\/$/, '') + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        return { ok: r.ok, status: r.status, data: d };
      });
    });
  }

  function sendCode() {
    var input = document.getElementById('ogg-email');
    var email = (input && input.value || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { gateError('Enter a valid email address'); return; }
    gateBusy(true);

    if (MODE === 'worker') {
      workerPost('/api/auth/start', { email: email }).then(function (r) {
        gateBusy(false);
        if (!r.ok) { gateError(r.data.message || 'Could not send the code (' + r.status + ')'); return; }
        lastEmailSentTo = email;
        setState('code');
      }).catch(function (e) {
        gateBusy(false);
        gateError('Could not reach the cloud broker — check your connection.');
        console.warn('OGCloud auth/start:', e);
      });
      return;
    }

    sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.origin + location.pathname } })
      .then(function (r) {
        gateBusy(false);
        if (r.error) { gateError(r.error.message); return; }
        lastEmailSentTo = email;
        setState('code');
      });
  }

  function verifyCode() {
    var el = document.getElementById('ogg-code');
    var code = (el && el.value || '').replace(/\D/g, '');
    if (code.length < 4) { gateError('Enter the code from your email'); return; }
    gateBusy(true);

    if (MODE === 'worker') {
      workerPost('/api/auth/verify', { email: lastEmailSentTo, code: code }).then(function (r) {
        gateBusy(false);
        if (!r.ok || !r.data.token) { gateError(r.data.message || 'Code not accepted — check it and try again'); return; }
        userEmail = r.data.email || lastEmailSentTo;
        saveSession(r.data.token, r.data.expires_at, userEmail);
        try { localStorage.setItem('og_cloud_email', userEmail); } catch (e) {}
        setState('checking');
        verifyAndEnter(r.data.token, false);
      }).catch(function (e) {
        gateBusy(false);
        gateError('Could not reach the cloud broker — check your connection.');
        console.warn('OGCloud auth/verify:', e);
      });
      return;
    }

    sb.auth.verifyOtp({ email: lastEmailSentTo, token: code, type: 'email' })
      .then(function (r) {
        gateBusy(false);
        if (r.error) { gateError('Code not accepted — check it and try again'); return; }
        setState('checking'); /* onAuthStateChange(SIGNED_IN) takes it from here */
      });
  }

  function googleLogin() {
    gateBusy(true);
    sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + location.pathname }
    }).then(function (r) { if (r.error) { gateBusy(false); gateError(r.error.message); } });
  }

  function signOut() {
    try { localStorage.removeItem('og_cloud_email'); } catch (e) {}
    try { sessionStorage.removeItem('og_tok'); sessionStorage.removeItem('og_exp'); } catch (e) {}
    clearSession();
    if (MODE === 'supabase' && sb) sb.auth.signOut(); else location.reload();
  }

  /* ═══════════════════════ settings panel ═══════════════════════ */
  function renderSettings(el) {
    if (!el) return;
    var email = window.OGCloud.email();
    var live = tokenState.token && tokenState.exp > Date.now();
    var mins = live ? Math.max(0, Math.round((tokenState.exp - Date.now()) / 60000)) : 0;
    el.innerHTML =
      '<div class="ogc-acct">' +
        '<div class="ogc-acct-row">' +
          '<div class="ogc-avatar">' + (email ? email[0].toUpperCase() : '?') + '</div>' +
          '<div class="ogc-acct-info">' +
            '<div class="ogc-acct-mail">' + escHtml(email || 'Not signed in') + '</div>' +
            '<div class="ogc-acct-sub">' + (live
              ? '<span class="ogc-dot ok"></span>Drive linked via cloud broker · auto-renews (' + mins + ' min left)'
              : '<span class="ogc-dot no"></span>Waiting for Drive token…') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="ogc-acct-btns">' +
          '<button class="ogc-btn" id="ogc-refresh-btn">↻ Refresh token</button>' +
          '<button class="ogc-btn danger" id="ogc-signout-btn">Sign out</button>' +
        '</div>' +
        '<div class="ogc-acct-note">Secrets (client ID, folder ID) live in your Cloudflare Worker — nothing sensitive is stored in this browser. Sign-in is handled by ' +
          (MODE === 'worker' ? 'the Worker itself' : 'Supabase') + '.</div>' +
      '</div>';
    var rb = el.querySelector('#ogc-refresh-btn');
    var sob = el.querySelector('#ogc-signout-btn');
    if (rb) rb.onclick = function () {
      rb.textContent = '↻ Refreshing…';
      refreshToken(true).then(function (t) {
        rb.textContent = t ? '✓ Refreshed' : '⚠ Failed';
        setTimeout(function () { renderSettings(el); }, 1200);
      });
    };
    if (sob) sob.onclick = function () { if (confirm('Sign out of OG Revise on this device?')) signOut(); };
  }

  function decorateEmail() {
    var email = window.OGCloud.email();
    document.querySelectorAll('[data-og-email]').forEach(function (n) { n.textContent = email; });
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ═══════════════════════ the gate (UI) ═══════════════════════ */
  function injectGate() {
    var css = document.createElement('style');
    css.textContent = GATE_CSS;
    document.head.appendChild(css);
    var el = document.createElement('div');
    el.id = 'og-gate';
    el.innerHTML = GATE_HTML();
    document.body.appendChild(el);

    /* wire events */
    on('ogg-send-btn', sendCode);
    on('ogg-verify-btn', verifyCode);
    on('ogg-google-btn', googleLogin);
    on('ogg-back-btn', function () { setState('signin'); });
    on('ogg-resend-btn', function () { setState('signin'); });
    on('ogg-denied-out', signOut);
    on('ogg-retry-btn', function () { location.reload(); });
    var em = document.getElementById('ogg-email');
    if (em) em.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendCode(); });
    var cd = document.getElementById('ogg-code');
    if (cd) cd.addEventListener('keydown', function (e) { if (e.key === 'Enter') verifyCode(); });
    if (cd) cd.addEventListener('input', function () {
      /* Supabase's OTP length is configurable per-project (6-10 digits) —
         accept whatever arrives rather than assuming 6. */
      cd.value = cd.value.replace(/\D/g, '').slice(0, 10);
    });
  }
  function on(id, fn) { var n = document.getElementById(id); if (n) n.addEventListener('click', fn); }

  function GATE_HTML() {
    var hint = CFG.OWNER_EMAIL || '';
    return '' +
    '<canvas id="ogg-3d"></canvas>' +
    '<div class="ogg-grad"></div>' +
    '<div class="ogg-noise"></div>' +
    '<div class="ogg-wrap">' +
      '<div class="ogg-card" id="ogg-card">' +
        '<div class="ogg-logo">' + LOGO_SVG + '</div>' +
        '<div class="ogg-word">OG&nbsp;<span>REVISE</span></div>' +
        '<div class="ogg-tag">Obstetrics &amp; Gynaecology · your private revision universe</div>' +

        '<div class="ogg-state" id="ogg-s-checking">' +
          '<div class="ogg-orbit"><span></span><span></span><span></span></div>' +
          '<div class="ogg-sub">Verifying private access…</div>' +
        '</div>' +

        '<div class="ogg-state" id="ogg-s-signin" style="display:none">' +
          '<label class="ogg-lbl" for="ogg-email">Owner email</label>' +
          '<input id="ogg-email" class="ogg-input" type="email" inputmode="email" autocomplete="email" ' +
            'value="' + escHtml(hint) + '" placeholder="you@example.com">' +
          '<button class="ogg-btn primary" id="ogg-send-btn">Email me a sign-in code&nbsp;→</button>' +
          (CFG.ENABLE_GOOGLE_LOGIN && MODE === 'supabase'
            ? '<div class="ogg-or"><i></i><em>or</em><i></i></div>' +
              '<button class="ogg-btn ghost" id="ogg-google-btn"><svg width="15" height="15" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C41.4 34.9 44 29.9 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>&nbsp;Continue with Google</button>'
            : '') +
          '<div class="ogg-err" id="ogg-error"></div>' +
          '<div class="ogg-note">🔒 Access is restricted to the owner’s account.<br>Anyone else is refused by the cloud broker.</div>' +
        '</div>' +

        '<div class="ogg-state" id="ogg-s-code" style="display:none">' +
          '<div class="ogg-sub" style="margin-bottom:14px">A sign-in code is on its way to<br><b id="ogg-sent-to"></b></div>' +
          '<input id="ogg-code" class="ogg-input code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="········" maxlength="10">' +
          '<button class="ogg-btn primary" id="ogg-verify-btn">Unlock&nbsp;→</button>' +
          '<div class="ogg-err" id="ogg-error2"></div>' +
          '<button class="ogg-link" id="ogg-resend-btn">Use a different email / resend</button>' +
        '</div>' +

        '<div class="ogg-state" id="ogg-s-denied" style="display:none">' +
          '<div class="ogg-deny-ico">⛔</div>' +
          '<div class="ogg-sub"><b>This account is not authorised.</b><br>OG Revise is a private application. Sign in with the owner’s account to continue.</div>' +
          '<button class="ogg-btn ghost" id="ogg-denied-out">Sign out &amp; try another account</button>' +
        '</div>' +

        '<div class="ogg-state" id="ogg-s-error" style="display:none">' +
          '<div class="ogg-deny-ico">🛰️</div>' +
          '<div class="ogg-sub" id="ogg-error-text"></div>' +
          '<button class="ogg-btn ghost" id="ogg-retry-btn">↻ Retry</button>' +
        '</div>' +
      '</div>' +
      '<div class="ogg-foot"><span>Drive-powered library</span><i>·</i><span>Secured by Cloudflare + Supabase</span><i>·</i><span>Offline-first PWA</span></div>' +
    '</div>';
  }

  var LOGO_SVG =
    '<svg viewBox="0 0 120 120" width="86" height="86" fill="none" aria-label="OG Revise logo">' +
      '<defs>' +
        '<linearGradient id="oglg1" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0" stop-color="#00d4ff"/><stop offset="1" stop-color="#00e5c0"/>' +
        '</linearGradient>' +
        '<linearGradient id="oglg2" x1="1" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#00d4ff"/>' +
        '</linearGradient>' +
        '<filter id="oglf" x="-40%" y="-40%" width="180%" height="180%">' +
          '<feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>' +
        '</filter>' +
      '</defs>' +
      '<circle class="ogl-ring1" cx="60" cy="60" r="44" stroke="url(#oglg1)" stroke-width="5" stroke-linecap="round" stroke-dasharray="276" stroke-dashoffset="52" transform="rotate(-58 60 60)"/>' +
      '<circle class="ogl-ring2" cx="60" cy="60" r="33" stroke="url(#oglg2)" stroke-width="3" stroke-linecap="round" stroke-dasharray="207" stroke-dashoffset="120" transform="rotate(112 60 60)" opacity="0.9"/>' +
      '<circle class="ogl-core" cx="60" cy="60" r="10.5" fill="url(#oglg1)" filter="url(#oglf)"/>' +
      '<circle class="ogl-sat" cx="60" cy="16" r="5" fill="#8b5cf6" filter="url(#oglf)"/>' +
    '</svg>';

  var GATE_CSS = [
    '#og-gate{position:fixed;inset:0;z-index:99999;background:#04080f;overflow:hidden;',
      'font-family:"Sora",system-ui,sans-serif;color:#f0f4ff;display:flex}',
    '#ogg-3d{position:absolute;inset:0;width:100%;height:100%}',
    '.ogg-grad{position:absolute;inset:0;pointer-events:none;background:',
      'radial-gradient(60% 50% at 50% 0%,rgba(0,212,255,0.10),transparent 60%),',
      'radial-gradient(50% 40% at 80% 100%,rgba(139,92,246,0.12),transparent 60%),',
      'radial-gradient(40% 40% at 15% 85%,rgba(0,229,192,0.08),transparent 60%)}',
    '.ogg-noise{position:absolute;inset:0;pointer-events:none;opacity:0.35;mix-blend-mode:overlay;',
      'background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'120\' height=\'120\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence baseFrequency=\'0.8\' numOctaves=\'2\'/%3E%3CfeColorMatrix values=\'0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.05 0\'/%3E%3C/filter%3E%3Crect width=\'120\' height=\'120\' filter=\'url(%23n)\'/%3E%3C/svg%3E")}',
    '.ogg-wrap{position:relative;margin:auto;display:flex;flex-direction:column;align-items:center;',
      'padding:24px;width:100%;max-width:460px}',
    '.ogg-card{position:relative;width:100%;padding:44px 38px 34px;border-radius:28px;text-align:center;',
      'background:rgba(10,17,33,0.72);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);',
      'border:1px solid rgba(120,160,255,0.14);',
      'box-shadow:0 30px 80px rgba(0,0,0,0.55),0 0 0 1px rgba(0,212,255,0.05),inset 0 1px 0 rgba(255,255,255,0.06)}',
    '.ogg-card::before{content:"";position:absolute;inset:-1px;border-radius:29px;padding:1px;pointer-events:none;',
      'background:conic-gradient(from var(--ogg-a,0deg),transparent 0 70%,rgba(0,212,255,0.55) 82%,rgba(0,229,192,0.55) 88%,transparent 96%);',
      '-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);',
      '-webkit-mask-composite:xor;mask-composite:exclude;animation:oggspin 7s linear infinite}',
    '@property --ogg-a{syntax:"<angle>";initial-value:0deg;inherits:false}',
    '@keyframes oggspin{to{--ogg-a:360deg}}',
    '@media (prefers-reduced-motion:reduce){.ogg-card::before{animation:none}}',
    '.ogg-logo{display:flex;justify-content:center;margin-bottom:6px}',
    '.ogl-sat{transform-origin:60px 60px;animation:oggorbit 9s linear infinite}',
    '@keyframes oggorbit{to{transform:rotate(360deg)}}',
    '.ogg-word{font-size:30px;font-weight:800;letter-spacing:0.06em;margin-top:4px;',
      'background:linear-gradient(92deg,#00d4ff 10%,#00e5c0 55%,#8b5cf6 100%);',
      '-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}',
    '.ogg-word span{font-weight:300}',
    '.ogg-tag{font-size:11.5px;color:#6478a0;letter-spacing:0.04em;margin:8px 0 28px}',
    '.ogg-lbl{display:block;text-align:left;font-size:10.5px;font-weight:700;letter-spacing:0.12em;',
      'text-transform:uppercase;color:#6478a0;margin:0 2px 7px}',
    '.ogg-input{width:100%;box-sizing:border-box;background:rgba(4,8,15,0.8);color:#f0f4ff;',
      'border:1.5px solid #1e2d50;border-radius:14px;padding:14px 16px;font-size:15px;',
      'font-family:inherit;outline:none;transition:border-color .2s,box-shadow .2s;margin-bottom:12px}',
    '.ogg-input:focus{border-color:#00d4ff;box-shadow:0 0 0 4px rgba(0,212,255,0.12)}',
    '.ogg-input.code{text-align:center;font-size:25px;letter-spacing:0.3em;font-family:"JetBrains Mono",monospace;padding:12px 8px 12px 16px}',
    '.ogg-btn{width:100%;border:none;border-radius:14px;padding:15px 18px;font-size:14.5px;font-weight:700;',
      'font-family:inherit;cursor:pointer;transition:transform .15s,box-shadow .2s,filter .2s;',
      'display:flex;align-items:center;justify-content:center;gap:6px;-webkit-tap-highlight-color:transparent}',
    '.ogg-btn.primary{color:#04121d;background:linear-gradient(93deg,#00d4ff,#00e5c0);',
      'box-shadow:0 10px 30px rgba(0,212,255,0.28)}',
    '.ogg-btn.primary:hover{transform:translateY(-1px);filter:brightness(1.07);box-shadow:0 14px 36px rgba(0,212,255,0.4)}',
    '.ogg-btn.primary:active{transform:translateY(0) scale(0.99)}',
    '.ogg-btn.ghost{background:rgba(255,255,255,0.05);color:#c8d4ec;border:1px solid rgba(120,160,255,0.18)}',
    '.ogg-btn.ghost:hover{background:rgba(255,255,255,0.09)}',
    '.ogg-btn[disabled]{opacity:0.55;pointer-events:none}',
    '.ogg-or{display:flex;align-items:center;gap:10px;margin:14px 0}',
    '.ogg-or i{flex:1;height:1px;background:rgba(120,160,255,0.15)}',
    '.ogg-or em{font-style:normal;font-size:11px;color:#3a4e78}',
    '.ogg-link{background:none;border:none;color:#6478a0;font-size:12px;font-family:inherit;',
      'cursor:pointer;margin-top:14px;text-decoration:underline;text-underline-offset:3px}',
    '.ogg-link:hover{color:#00d4ff}',
    '.ogg-err{min-height:16px;font-size:12px;color:#f43f5e;margin-top:10px}',
    '.ogg-note{font-size:11px;color:#3a4e78;line-height:1.7;margin-top:18px}',
    '.ogg-sub{font-size:13px;color:#a8b8d8;line-height:1.7}',
    '.ogg-deny-ico{font-size:38px;margin-bottom:12px}',
    '.ogg-state #ogg-denied-out,.ogg-state #ogg-retry-btn{margin-top:20px}',
    '.ogg-orbit{position:relative;width:58px;height:58px;margin:6px auto 18px}',
    '.ogg-orbit span{position:absolute;inset:0;border-radius:50%;border:2px solid transparent;',
      'border-top-color:#00d4ff;animation:oggrot 1.1s linear infinite}',
    '.ogg-orbit span:nth-child(2){inset:8px;border-top-color:#00e5c0;animation-duration:0.9s;animation-direction:reverse}',
    '.ogg-orbit span:nth-child(3){inset:16px;border-top-color:#8b5cf6;animation-duration:1.4s}',
    '@keyframes oggrot{to{transform:rotate(360deg)}}',
    '.ogg-foot{display:flex;gap:10px;align-items:center;margin-top:26px;font-size:10.5px;color:#3a4e78;letter-spacing:0.05em}',
    '.ogg-foot i{opacity:0.5}',
    '@media (max-width:520px){.ogg-card{padding:36px 22px 26px;border-radius:24px}.ogg-word{font-size:25px}}'
  ].join('\n');

  /* ─────────── gate state machine ─────────── */
  var gateGone = false;
  function setState(name, errText) {
    if (gateGone) return;
    ['checking', 'signin', 'code', 'denied', 'error'].forEach(function (s) {
      var n = document.getElementById('ogg-s-' + s);
      if (n) n.style.display = (s === name) ? 'block' : 'none';
    });
    if (name === 'code') {
      var st = document.getElementById('ogg-sent-to');
      if (st) st.textContent = lastEmailSentTo;
      var cd = document.getElementById('ogg-code');
      if (cd) { cd.value = ''; setTimeout(function () { cd.focus(); }, 150); }
    }
    if (name === 'error') {
      var et = document.getElementById('ogg-error-text');
      if (et) et.textContent = errText || 'Something went wrong.';
    }
    if (window.gsap && !REDUCED) {
      var vis = document.getElementById('ogg-s-' + name);
      if (vis) window.gsap.fromTo(vis, { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: 'power2.out' });
    }
  }
  function setStateIfGate(name) { if (!gateGone) setState(name); }

  function gateError(msg) {
    var n = document.getElementById('ogg-error');
    var n2 = document.getElementById('ogg-error2');
    if (n) n.textContent = msg || '';
    if (n2) n2.textContent = msg || '';
    if (window.gsap && msg) {
      var card = document.getElementById('ogg-card');
      if (card) window.gsap.fromTo(card, { x: -7 }, { x: 0, duration: 0.5, ease: 'elastic.out(1,0.35)' });
    }
  }
  function gateBusy(busy) {
    ['ogg-send-btn', 'ogg-verify-btn', 'ogg-google-btn'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) { if (busy) b.setAttribute('disabled', ''); else b.removeAttribute('disabled'); }
    });
    gateError('');
  }

  function introAnimation() {
    if (!window.gsap || REDUCED) return;
    var g = window.gsap;
    g.fromTo('#ogg-card', { y: 34, opacity: 0, scale: 0.96 }, { y: 0, opacity: 1, scale: 1, duration: 0.9, ease: 'power3.out', delay: 0.1 });
    g.fromTo('.ogg-foot', { opacity: 0 }, { opacity: 1, duration: 1, delay: 0.8 });
    g.fromTo('.ogl-ring1', { strokeDashoffset: 276 }, { strokeDashoffset: 52, duration: 1.4, ease: 'power2.inOut', delay: 0.25 });
    g.fromTo('.ogl-ring2', { strokeDashoffset: 207 }, { strokeDashoffset: 120, duration: 1.4, ease: 'power2.inOut', delay: 0.4 });
    g.fromTo('.ogl-core', { scale: 0, transformOrigin: '60px 60px' }, { scale: 1, duration: 0.7, ease: 'back.out(2.5)', delay: 0.9 });
  }

  /* ─────────── reveal the app / drop the gate ─────────── */
  function revealApp() {
    if (gateGone) return;
    gateGone = true;
    decorateEmail();
    var gate = document.getElementById('og-gate');
    var drop = function () {
      document.documentElement.classList.remove('og-gate-hold');
      if (gate && gate.parentNode) gate.parentNode.removeChild(gate);
      stopScene();
      try { window.dispatchEvent(new CustomEvent('og-cloud-open')); } catch (e) {}
    };
    if (window.gsap && gate && !REDUCED) {
      document.documentElement.classList.remove('og-gate-hold');
      window.gsap.to('#ogg-card', { y: -26, opacity: 0, scale: 1.04, duration: 0.5, ease: 'power2.in' });
      window.gsap.to(gate, { opacity: 0, duration: 0.65, delay: 0.25, ease: 'power2.inOut', onComplete: drop });
    } else {
      drop();
    }
  }

  /* ═══════════════ Three.js ambient scene ═══════════════ */
  function startScene() {
    var canvas = document.getElementById('ogg-3d');
    if (!canvas || !window.THREE || gateGone) return;
    var T = window.THREE;
    var renderer;
    try {
      renderer = new T.WebGLRenderer({ canvas: canvas, alpha: true, antialias: false, powerPreference: 'low-power' });
    } catch (e) { return; }
    var DPR = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(DPR);
    renderer.setSize(window.innerWidth, window.innerHeight, false);

    var scene = new T.Scene();
    scene.fog = new T.FogExp2(0x04080f, 0.016);
    var camera = new T.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 200);
    camera.position.z = 46;

    var palette = [new T.Color(0x00d4ff), new T.Color(0x00e5c0), new T.Color(0x8b5cf6), new T.Color(0x3b82f6)];

    function makePoints(count, gen, size, opacity) {
      var pos = new Float32Array(count * 3);
      var col = new Float32Array(count * 3);
      for (var i = 0; i < count; i++) {
        var p = gen(i, count);
        pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
        var c = palette[(Math.random() * palette.length) | 0];
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      var geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(pos, 3));
      geo.setAttribute('color', new T.BufferAttribute(col, 3));
      var mat = new T.PointsMaterial({
        size: size, vertexColors: true, transparent: true, opacity: opacity,
        blending: T.AdditiveBlending, depthWrite: false, sizeAttenuation: true
      });
      return new T.Points(geo, mat);
    }

    /* Sphere shell — the "cell" */
    var sphere = makePoints(1200, function () {
      var r = 17 + Math.random() * 2.2;
      var t = Math.random() * Math.PI * 2, u = Math.acos(2 * Math.random() - 1);
      return [r * Math.sin(u) * Math.cos(t), r * Math.sin(u) * Math.sin(t), r * Math.cos(u)];
    }, 0.34, 0.75);

    /* Orbit ring — knowledge in motion */
    var ring = makePoints(700, function () {
      var a = Math.random() * Math.PI * 2;
      var rr = 27 + (Math.random() - 0.5) * 2.4;
      return [Math.cos(a) * rr, (Math.random() - 0.5) * 1.6, Math.sin(a) * rr];
    }, 0.3, 0.6);
    ring.rotation.x = -0.62; ring.rotation.z = 0.18;

    /* Distant dust */
    var dust = makePoints(900, function () {
      return [(Math.random() - 0.5) * 160, (Math.random() - 0.5) * 110, -20 - Math.random() * 70];
    }, 0.5, 0.32);

    scene.add(sphere, ring, dust);

    var mx = 0, my = 0, tx = 0, ty = 0;
    function onMove(e) {
      var x = (e.touches ? e.touches[0].clientX : e.clientX) / window.innerWidth - 0.5;
      var y = (e.touches ? e.touches[0].clientY : e.clientY) / window.innerHeight - 0.5;
      tx = x * 4; ty = -y * 3;
    }
    window.addEventListener('pointermove', onMove, { passive: true });

    function onResize() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight, false);
    }
    window.addEventListener('resize', onResize);

    var clock = new T.Clock();
    function frame() {
      three.raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      var t = clock.getElapsedTime();
      sphere.rotation.y = t * 0.055;
      sphere.rotation.x = Math.sin(t * 0.12) * 0.14;
      ring.rotation.y = -t * 0.085;
      dust.rotation.y = t * 0.008;
      mx += (tx - mx) * 0.04; my += (ty - my) * 0.04;
      camera.position.x = mx; camera.position.y = my;
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    }
    frame();

    three.renderer = renderer;
    three.cleanup = function () {
      cancelAnimationFrame(three.raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('resize', onResize);
      try { renderer.dispose(); } catch (e) {}
    };
  }
  function stopScene() { if (three.cleanup) { three.cleanup(); three.cleanup = null; } }

})();
