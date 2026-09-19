// ソワレ Service Worker — Web Push（軽量プッシュ方式）
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let title = 'ソワレ';
    let body = '新しい通知があります';
    try {
      const r = await fetch('/api/unread', { credentials: 'include' });
      if (r.ok) {
        const u = await r.json();
        const parts = [];
        if (u.messages) parts.push('メッセージ' + u.messages + '件');
        if (u.likes) parts.push('いいね' + u.likes + '件');
        if (u.footprints) parts.push('足あと' + u.footprints + '件');
        if (parts.length) body = parts.join('・') + 'があります';
      }
    } catch (e) {}
    await self.registration.showNotification(title, {
      body,
      tag: 'soiree-notify',
      renotify: true,
      data: { url: '/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
