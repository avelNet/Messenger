self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Новое сообщение', {
      body: data.body || '',
      icon: '/icon.png',
      badge: '/icon.png',
      vibrate: [200, 100, 200],
      data: { url: self.location.origin },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
