const CACHE = 'dexter-v3';
const ASSETS = [
  '/', '/index.html', '/avatar.png', '/manifest.json',
  // face loops: one WebM per state plus the animated-WebP fallback, so the wall animates offline
  '/avatar-idle.webm', '/avatar-listening.webm', '/avatar-thinking.webm', '/avatar-speaking.webm',
  '/avatar-idle.webp', '/avatar-listening.webp', '/avatar-thinking.webp', '/avatar-speaking.webp',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// A <video> asks for byte ranges; answer them from the cached body (206) rather than handing a
// 200 full body to a Range request, which some Chromium builds refuse to play.
async function fromCache(req) {
  const cached = await caches.match(req);
  if (!cached) return fetch(req);
  const range = req.headers.get('range');
  if (!range) return cached;
  const buf = await cached.arrayBuffer();
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const start = m && m[1] ? +m[1] : 0;
  const end = m && m[2] ? Math.min(+m[2], buf.byteLength - 1) : buf.byteLength - 1;
  if (start > end || start >= buf.byteLength) {
    return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + buf.byteLength } });
  }
  const h = new Headers(cached.headers);
  h.set('Content-Range', 'bytes ' + start + '-' + end + '/' + buf.byteLength);
  h.set('Content-Length', String(end - start + 1));
  h.set('Accept-Ranges', 'bytes');
  return new Response(buf.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers: h });
}

self.addEventListener('fetch', e => {
  // API calls (/api/chat, /api/tts, /api/stt) — always network, never cached
  if (new URL(e.request.url).pathname.startsWith('/api/') || e.request.url.includes('anthropic.com')) return;
  e.respondWith(fromCache(e.request));
});
