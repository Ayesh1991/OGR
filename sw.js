/* OG Revise — service worker
 * -------------------------------------------------------------
 * Goals:
 *   1. Make the app installable and launchable offline (app shell).
 *   2. Serve the big single-file app + CDN libraries fast, from cache.
 *   3. NEVER touch Google / Drive / OAuth traffic — always network,
 *      never cached (auth-sensitive and must be fresh).
 *
 * Strategy:
 *   - App shell (this app's own files): stale-while-revalidate.
 *   - CDN libraries (fonts, pdf.js, docx-preview, jszip, mammoth):
 *       cache-first (they are versioned and immutable).
 *   - Everything Google: bypass the SW entirely.
 *   - Navigation offline fallback: the cached app HTML.
 *
 * Bump CACHE_VERSION whenever you deploy a new app build so old
 * caches are cleared.
 */
const CACHE_VERSION = 'og-revise-v15';
const SHELL_CACHE   = CACHE_VERSION + '-shell';
const LIB_CACHE     = CACHE_VERSION + '-libs';

/* The app's own files. The app itself is now index.html (renamed from
 * OG-Revise-PWA-v2.html), so it lives at the folder root. Relative paths
 * resolve against the SW scope, so this works at /OGinfo/ or elsewhere. */
const SHELL = [
  './',
  './index.html',
  './og-revise-uploader-v2.html',
  './manifest.webmanifest',
  './og-config.js',
  './og-cloud.js',
  './og-next.js',
  './og-modern.css',
  './logo.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png'
];

/* CDN libraries the app loads — cache-first once fetched. */
const LIB_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com'
];

/* Hosts we must NEVER cache or intercept (auth / live data).
 * Now also covers the cloud backend: the Supabase auth API and the
 * Cloudflare Worker token broker must always hit the network fresh.
 * (If you later put the Worker on a custom domain, add it here.) */
function isGoogleApi(url) {
  return /(^|\.)googleapis\.com$/.test(url.hostname)
      || /(^|\.)google\.com$/.test(url.hostname)
      || url.hostname === 'accounts.google.com'
      || url.hostname === 'apis.google.com'
      || url.hostname.endsWith('.googleusercontent.com')
      || url.hostname.endsWith('.supabase.co')
      || url.hostname.endsWith('.supabase.in')
      || url.hostname.endsWith('.workers.dev');
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(c => c.addAll(SHELL).catch(() => {/* tolerate a missing file */}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !k.startsWith(CACHE_VERSION)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // never touch writes/sync
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // 1) Google / Drive / OAuth → let the network handle it, always fresh.
  if (isGoogleApi(url)) return;

  // 2) CDN libraries → cache-first (immutable, versioned URLs).
  if (LIB_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(LIB_CACHE).then(cache =>
        cache.match(req).then(hit =>
          hit || fetch(req).then(res => {
            if (res && res.status === 200) cache.put(req, res.clone());
            return res;
          }).catch(() => hit)
        )
      )
    );
    return;
  }

  // 3) App shell (same-origin) → stale-while-revalidate.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(cache =>
        cache.match(req).then(hit => {
          const network = fetch(req).then(res => {
            if (res && res.status === 200) cache.put(req, res.clone());
            return res;
          }).catch(() => null);
          // Serve cache immediately if we have it; otherwise wait for network.
          return hit || network.then(res =>
            res || (req.mode === 'navigate'
              ? caches.match('./index.html')
              : undefined)
          );
        })
      )
    );
    return;
  }

  // 4) Anything else → network, fall back to cache if present.
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
