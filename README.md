<p align="center">
  <img src="icon-192.png" width="96" alt="OG Revise logo">
</p>

<h1 align="center">OG Revise</h1>

<p align="center">
  <b>A private, offline-first O&amp;G revision universe.</b><br>
  Infographics · Documents · Flashcards (SM-2) · SBA/EMQ papers · OSCE simulator · Essays<br>
  <sub>Built for PGIM MD (O&amp;G) and MRCOG revision</sub>
</p>

---

## What it is

OG Revise is an installable PWA that turns a Google Drive folder into a
structured revision library. Study data (infographics, DOCX notes, flashcard
decks, past papers) lives in **your own Google Drive**; the app caches
everything locally (IndexedDB) so revision is instant and works offline.

**This version adds a zero-secrets-in-browser cloud backend:**

- 🔐 **Private access** — an animated login gate (Supabase auth); the
  Cloudflare Worker only admits the owner's email.
- 🛰️ **Cloudflare Worker token broker** — Google client secret, refresh
  token and folder ID live server-side. Drive tokens renew silently; the
  hourly reconnect and mid-study "stuck syncing" are gone.
- 🎨 **Modern identity** — new orbital logo, GSAP-animated interface,
  Three.js particle entry experience.
- 🛠️ **Uploader built in** — the OGR uploader runs inside the app (and
  standalone) sharing the same session.

## Files

| File | Role |
|---|---|
| `index.html` | the entire PWA app |
| `og-revise-uploader-v2.html` | uploader tools (embedded + standalone) |
| `og-config.js` | **the only file you edit** — Worker/Supabase addresses |
| `og-cloud.js` | login gate + Drive token broker (client side) |
| `og-modern.css` | modern visual skin (purely presentational) |
| `worker/` | Cloudflare Worker (secrets vault + token broker) |
| `sw.js`, `manifest.webmanifest` | PWA plumbing |
| `logo.svg`, `icon-*.png` | brand + icons |

## Setup

Follow **[SETUP.md](SETUP.md)** — four free services, ~20 minutes:
Google Cloud (Drive API) → Supabase (identity) → Cloudflare Worker
(secrets + tokens) → GitHub Pages (hosting).

Until `og-config.js` is filled in, the app runs in **legacy mode** — the
original client-side OAuth flow — so nothing breaks while you migrate.
