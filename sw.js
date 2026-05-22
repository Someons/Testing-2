/* PillCare Service Worker v12.0
   Handles: caching, background sync, notification actions, keep-alive PING */
'use strict';

const CACHE    = 'pillcare-v12';
const SHELL    = ['./','./index.html','./manifest.json'];

// ── Install: pre-cache shell ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: remove old caches ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: cache-first for shell, network-first for others ──
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Don't intercept cross-origin (fonts etc.)
  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});

// ── In-memory snapshot from main thread ──
let _snapshot = { pills: [], taken: {}, lastNotif: {} };

self.addEventListener('message', e => {
  const msg = e.data;
  if (!msg?.type) return;

  if (msg.type === 'UPDATE_SNAPSHOT') {
    _snapshot = msg.snapshot || _snapshot;
    return;
  }
  if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (msg.type === 'PING') {
    e.source?.postMessage({ type: 'PONG' });
    return;
  }
});

// ── Notification action handler ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const { action, notification } = e;
  const data = notification.data || {};

  if (action === 'taken') {
    // Tell all clients to mark the dose
    e.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'MARK_TAKEN', pillId: data.pillId, doseTime: data.doseTime }));
        if (!clients.length) return self.clients.openWindow('./');
      })
    );
  } else if (action === 'snooze') {
    const fireAt = Date.now() + 5 * 60 * 1000;
    e.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        clients.forEach(c => c.postMessage({
          type: 'STORE_SNOOZE', pillId: data.pillId,
          name: data.name, dose: data.dose, time: data.doseTime, fireAt
        }));
        // Re-fire after 5 min via SW alarm (best-effort)
        setTimeout(() => {
          self.registration.showNotification(`⏰ ${data.name}`, {
            body: [data.dose, 'Time to take your dose'].filter(Boolean).join(' · '),
            icon: 'icons/icon-192.png',
            badge: 'icons/icon-72.png',
            vibrate: [180, 50, 180],
            data,
            actions: [
              { action: 'taken',  title: '✓ Mark taken' },
              { action: 'snooze', title: '⏰ Snooze again' },
            ]
          });
        }, 5 * 60 * 1000);
      })
    );
  } else {
    // Default: focus or open the app
    e.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        const focused = clients.find(c => c.focused);
        if (focused) return focused.focus();
        if (clients.length) return clients[0].focus();
        return self.clients.openWindow('./');
      })
    );
  }
});

// ── Periodic background sync (when granted) ──
self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-reminders') {
    e.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        // If app is open, it handles its own reminders — do nothing
        if (clients.length) return;
        // App is closed — basic time check from snapshot
        _checkSnapshotReminders();
      })
    );
  }
});

function _checkSnapshotReminders() {
  const now  = new Date();
  const hm   = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

  (_snapshot.pills || []).forEach(pill => {
    if (pill.archived) return;
    const doses = _getDoses(pill);
    doses.forEach((doseTime, idx) => {
      if (doseTime !== hm) return;
      if (_snapshot.taken?.[pill.id + '_dose' + idx]) return;
      self.registration.showNotification(`💊 ${pill.name}`, {
        body: [pill.dose, `Scheduled: ${doseTime}`].filter(Boolean).join(' · '),
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-72.png',
        vibrate: [180, 50, 180],
        data: { pillId: pill.id, doseTime, date: today, name: pill.name, dose: pill.dose },
        actions: [
          { action: 'taken',  title: '✓ Mark taken' },
          { action: 'snooze', title: '⏰ Snooze 5 min' },
        ]
      });
    });
  });
}

function _getDoses(pill) {
  if (!pill) return [];
  if (pill.freq === 'once') return [pill.time];
  if (pill.freq === 'custom') {
    const ivMins = Math.max(Math.round((parseFloat(pill.intervalHours) || 6) * 60), 10);
    const start  = _hmToMins(pill.time || '08:00');
    const doses  = [];
    for (let t = start; t < 1440 && doses.length < 24; t += ivMins) doses.push(_minsToHm(t));
    return doses;
  }
  if (pill.freq === 'weekly') {
    const dow = new Date().getDay();
    return (pill.weekDays || []).map(Number).includes(dow) ? [pill.time] : [];
  }
  if (pill.freq === 'monthly') return pill.monthDay === new Date().getDate() ? [pill.time] : [];
  return [pill.time || '08:00'];
}

function _hmToMins(hm) { const [h, m] = hm.split(':').map(Number); return h * 60 + m; }
function _minsToHm(m)  { return `${String(Math.floor(m / 60) % 24).padStart(2,'0')}:${String(Math.round(m) % 60).padStart(2,'0')}`; }
