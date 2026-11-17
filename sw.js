// Leidžia programai atsidaryti ir be interneto + rodo pranešimus (push).
const CACHE = 'rutina-v3';
const BADGE = 'rutina-badge';
// Skaičiukas ant ikonos: kiek naujų pranešimų nuo paskutinio atidarymo
const badgeKey = () => new Request(self.registration.scope + '__badge');
async function getN() { try { const r = await (await caches.open(BADGE)).match(badgeKey()); return r ? +(await r.text()) || 0 : 0; } catch (_) { return 0; } }
async function setN(n) { try { await (await caches.open(BADGE)).put(badgeKey(), new Response(String(n))); } catch (_) {} }
self.addEventListener('message', e => {
  if (e.data === 'clearBadge') e.waitUntil(setN(0)); // rodomą skaičių nustato pati programa
});
const FILES = ['./', 'index.html', 'manifest.json', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== BADGE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  // 🏄 3D biblioteka (Three.js iš cdnjs): pirma iš talpyklos, kad surfo scena veiktų ir be interneto
  if (e.request.method === 'GET' && u.href === 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js') {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); } return r; })));
    return;
  }
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // duomenų bazės užklausų neliečiam
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});

// 🔔 Pranešimai
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Rutina', body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Mūsų rutina', {
      body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag,
      icon: 'icon-192.png', badge: 'icon-192.png', data: { url: d.url || './' },
    });
    const n = (await getN()) + 1; await setN(n);
    try { await self.navigator.setAppBadge?.(n); } catch (_) {}
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope)) return c.focus().then(w => w && w.navigate ? w.navigate(url) : w);
    return self.clients.openWindow(url);
  }));
});
