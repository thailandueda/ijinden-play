/* オフライン対応（Service Worker）
   - 通信できるときは常に最新のファイルを取りに行き（ネットワーク優先）、取れたものを保存しておく
   - 通信できないときは、保存しておいたファイルで動かす
   そのため、更新はオンラインで開けばすぐ反映される。CACHE の名前を変えると古い保存分を消す */
const CACHE = 'ijinden-play-v1';
const CORE = [
  './', 'index.html', 'manifest.json',
  'css/style.css', 'css/vs.css',
  'js/version.js', 'js/cards-data.js', 'js/preset-decks.js', 'js/summon-rules.js', 'js/glossary.js',
  'js/app.js', 'js/hand-checker.js', 'js/vs-engine.js', 'js/vs-ui.js',
  'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;   // 外部（Googleフォントなど）はブラウザに任せる
  e.respondWith(
    fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined)))
  );
});
