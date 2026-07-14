/* ═══════════════════════════════════════════════════════════════
   OG REVISE — CLOUD CONFIGURATION
   ═══════════════════════════════════════════════════════════════
   This is the ONLY file you edit after deploying the backend.
   Everything here is PUBLIC-SAFE by design:
     • WORKER_URL is just an address — the Worker refuses anyone
       whose Supabase login email isn't yours.
     • The Supabase anon key is designed to be public; row-level
       security + the Worker's email check do the real guarding.
   No Google client IDs, secrets or Drive folder IDs live in the
   browser any more — they all sit inside the Cloudflare Worker.

   Until you fill these in, the app runs in LEGACY MODE (the old
   client-side OAuth flow) so nothing breaks during migration.
   ═══════════════════════════════════════════════════════════════ */
window.OG_CONFIG = {

  /* Cloudflare Worker URL — no trailing slash.
     e.g. "https://og-revise-broker.YOUR-SUBDOMAIN.workers.dev"   */
  WORKER_URL: "https://og-revise-broker.ayeshmantha.workers.dev",

  /* Supabase project — Dashboard → Settings → API                */
  SUPABASE_URL: "https://txlneththpyhyvvgstkc.supabase.co",        // e.g. "https://abcdefgh.supabase.co"
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4bG5ldGh0aHB5aHl2dmdzdGtjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwNDUxMDQsImV4cCI6MjA5OTYyMTEwNH0.-AC9YTQ6JHPtBOzyFKbRhMyNz98Jf0SyqEMR-dpxHNQ",   // the public "anon" key

  /* Shown on the login screen as a hint (enforcement is server-side
     in the Worker via its ALLOWED_EMAIL secret).                  */
  OWNER_EMAIL: "ayeshmantha@gmail.com",

  /* Show a "Continue with Google" button on the login screen.
     Requires enabling the Google provider inside Supabase Auth.
     The 6-digit email code always works and needs no extra setup. */
  ENABLE_GOOGLE_LOGIN: false,

  /* Force the old in-browser OAuth flow even if the above is set. */
  LEGACY_MODE: false
};
