/* 离线缓存：装到桌面后没网也能打。
   版本号跟着 BUILD 走，换版本会整包替换旧缓存。 */
const VER = 'rhythmlab-v49';
const CORE = [
  './', './index.html', './manifest.webmanifest',
  './css/style.css?v=49',
  './js/rng.js?v=49', './js/generator.js?v=49', './js/bgm.js?v=49',
  './js/bgmuser.js?v=49', './js/audio.js?v=49', './js/game.js?v=49', './js/ui.js?v=49',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VER).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VER).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // 音频按需缓存：第一次听过之后就离线可用
  if (url.pathname.endsWith('.ogg')) {
    e.respondWith(caches.open(VER + '-audio').then((c) =>
      c.match(req).then((hit) => hit || fetch(req).then((r) => {
        if (r.ok) c.put(req, r.clone());
        return r;
      }))));
    return;
  }
  // 其余走「网络优先、失败回缓存」，保证版本更新能立刻生效
  e.respondWith(fetch(req).then((r) => {
    if (r.ok) { const cp = r.clone(); caches.open(VER).then((c) => c.put(req, cp)); }
    return r;
  }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))));
});
