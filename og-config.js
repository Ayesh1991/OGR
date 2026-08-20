/* ═══════════════════════════════════════════════════════════════
   OG REVISE — CLOUD CONFIGURATION
   ═══════════════════════════════════════════════════════════════
   This is the ONLY file you edit after deploying the backend.
   Everything here is PUBLIC-SAFE by design: WORKER_URL is just an
   address — the Worker refuses anyone whose login email isn't yours.
   No Google client IDs, secrets or Drive folder IDs live in the
   browser — they all sit inside the Cloudflare Worker.

   Until WORKER_URL is filled in, the app runs in LEGACY MODE (the old
   client-side OAuth flow) so nothing breaks during migration.
   ═══════════════════════════════════════════════════════════════ */
window.OG_CONFIG = {

  /* Cloudflare Worker URL — no trailing slash.
     e.g. "https://og-revise-broker.YOUR-SUBDOMAIN.workers.dev"   */
  WORKER_URL: "https://og-revise-broker.ayeshmantha.workers.dev",

  /* ── LOGIN ────────────────────────────────────────────────────
     Leave these two BLANK to use worker-native login: the sign-in
     code is generated and emailed by your own Cloudflare Worker
     (via Resend), and the session is a token the Worker signs.
     No third-party identity service, no database, no monthly cost —
     and supabase-js is never even downloaded, so the app boots faster.

     They only exist for the legacy Supabase login. Filling them in
     switches back to it, which is handy for a no-downtime migration:
     deploy the new Worker first, then blank these, then delete the
     Supabase project.                                              */
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",

  /* Prefilled on the login screen. The real enforcement is the
     Worker's ALLOWED_EMAIL secret, server-side.                    */
  OWNER_EMAIL: "ayeshmantha@gmail.com",

  /* "Continue with Google" button — legacy Supabase mode only.     */
  ENABLE_GOOGLE_LOGIN: false,

  /* Force the old in-browser OAuth flow even if the above is set.  */
  LEGACY_MODE: false
};
