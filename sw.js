'use strict';

/* ═══════════════════════════════════════════════════════
   PILLCARE SERVICE WORKER  —  v9.0
   Handles: caching, offline, push notifications,
            notification actions (Taken / Snooze),
            periodic background sync, SW lifecycle.
═══════════════════════════════════════════════════════ */

const CACHE_NAME  = 'pillcare-v9';
const STATIC_URLS = [
  './',
  './index.html',
  './manifest.json',
];

// In-memory snapshot synced from the main page
let snapshot = { pills: [], taken: {}, lastNotif: {} };

/* ── Install ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_URLS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Cache install partial:', err))
  );
});

/* ── Activate ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch (cache-first for static, network-first for others) ── */
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle same-origin GET requests
  if (request.method !== 'GET') return;
  if (!request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request)
        .then(response => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => null);

      // For HTML pages: network-first so updates are picked up
      if (request.headers.get('accept')?.includes('text/html')) {
        return networkFetch.then(r => r || cached) || cached;
      }
      // Everything else: cache-first
      return cached || networkFetch;
    })
  );
});

/* ── Message handler (from main page) ── */
self.addEventListener('message', event => {
  const msg = event.data;
  if (!msg?.type) return;

  switch (msg.type) {

    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'UPDATE_SNAPSHOT':
      if (msg.snapshot) {
        snapshot = { ...snapshot, ...msg.snapshot };
      }
      // Reply so the page can confirm SW is alive
      event.source?.postMessage({ type: 'PONG' });
      break;

    case 'PING':
      event.source?.postMessage({ type: 'PONG' });
      break;

    default:
      break;
  }
});

/* ── Periodic Background Sync ── */
self.addEventListener('periodicsync', event => {
  if (event.tag === 'check-reminders') {
    event.waitUntil(checkScheduledReminders());
  }
});

/* ── Push ── */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch (e) { /* ignore */ }

  const title   = data.title   || '💊 PillCare';
  const options = {
    body:               data.body    || 'Time to take your medication.',
    icon:               data.icon    || 'icons/icon-192.png',
    badge:              data.badge   || 'icons/icon-72.png',
    vibrate:            data.vibrate || [200, 50, 200],
    tag:                data.tag     || 'pillcare-push',
    requireInteraction: data.requireInteraction || false,
    data:               data.data    || {},
    actions: [
      { action: 'taken',  title: '✅ Mark Taken' },
      { action: 'snooze', title: '⏰ Snooze 5 min' },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/* ── Notification click ── */
self.addEventListener('notificationclick', event => {
  const notif   = event.notification;
  const action  = event.action;
  const data    = notif.data || {};

  notif.close();

  if (action === 'taken') {
    event.waitUntil(
      broadcastToClients({ type: 'MARK_TAKEN', pillId: data.pillId, doseTime: data.doseTime, date: data.date })
        .then(delivered => {
          if (!delivered) markTakenInStorage(data.pillId, data.doseTime);
        })
    );
    return;
  }

  if (action === 'snooze') {
    const fireAt = Date.now() + 5 * 60 * 1000;
    event.waitUntil(
      broadcastToClients({
        type:   'STORE_SNOOZE',
        pillId: data.pillId,
        name:   data.name,
        dose:   data.dose,
        time:   data.doseTime,
        fireAt,
      }).then(delivered => {
        if (!delivered) storeSnoozeFallback(data.pillId, data.name, data.dose, data.doseTime, fireAt);
      })
    );
    return;
  }

  // Default: open / focus the app
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if ('focus' in client) {
          client.focus();
          client.postMessage({ type: 'FOCUS_PILL', pillId: data.pillId });
          return;
        }
      }
      return self.clients.openWindow('./');
    })
  );
});

/* ── Notification close ── */
self.addEventListener('notificationclose', event => {
  broadcastToClients({ type: 'NOTIFICATION_DISMISSED', data: event.notification.data });
});

/* ══════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════ */

/**
 * Send a message to all connected window clients.
 * Returns true if at least one client received it.
 */
async function broadcastToClients(msg) {
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(c => c.postMessage(msg));
    return clients.length > 0;
  } catch (e) {
    return false;
  }
}

/** Simple date key helper: YYYY-MM-DD */
function todayKey() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Fallback: write "taken" to localStorage when the main page is closed.
 * Relies on the snapshot injected via UPDATE_SNAPSHOT.
 */
function markTakenInStorage(pillId, doseTime) {
  try {
    const pill    = (snapshot.pills || []).find(p => p.id === pillId);
    if (!pill) return;

    const taken   = JSON.parse(self.localStorage?.getItem('pc_taken') || '{}');
    const doses   = getDoseTimes(pill);
    let idx       = doses.indexOf(doseTime);
    if (idx < 0) idx = 0;
    taken[pillId + '_dose' + idx] = new Date().toISOString();
    self.localStorage?.setItem('pc_taken', JSON.stringify(taken));
  } catch (e) { /* localStorage not accessible in SW context */ }
}

/**
 * Fallback snooze write when the main page is closed.
 */
function storeSnoozeFallback(pillId, name, dose, time, fireAt) {
  try {
    const snoozed = JSON.parse(self.localStorage?.getItem('pc_snoozed') || '[]');
    const entry   = { id: pillId + '-' + fireAt, pillId, name, dose, time, fireAt };
    if (!snoozed.find(s => s.id === entry.id)) {
      snoozed.push(entry);
      self.localStorage?.setItem('pc_snoozed', JSON.stringify(snoozed));
    }
  } catch (e) { /* localStorage not accessible in SW context */ }
}

/**
 * Lightweight dose-time calculator (mirrors main-page logic).
 */
function getDoseTimes(pill) {
  const pad      = n => String(n).padStart(2, '0');
  const hmStr    = (h, m) => `${pad(h)}:${pad(m)}`;
  const hmToMins = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
  const clamp    = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  if (pill.freq === 'once') return [pill.time];

  if (pill.freq === 'custom') {
    const count        = clamp(parseInt(pill.count) || 1, 1, 12);
    const intervalMins = Math.round(1440 / count);
    const startMins    = hmToMins(pill.time || '08:00');
    const doses        = [];
    for (let i = 0; i < count; i++) {
      const mins = (startMins + i * intervalMins) % 1440;
      doses.push(hmStr(Math.floor(mins / 60), Math.round(mins) % 60));
    }
    return doses;
  }

  if (pill.freq === 'weekly') {
    const today = new Date().getDay();
    const days  = (pill.weekDays || []).map(Number);
    return days.includes(today) ? [pill.time] : [];
  }

  if (pill.freq === 'monthly') {
    return pill.monthDay === new Date().getDate() ? [pill.time] : [];
  }

  return [pill.time || '08:00'];
}

/**
 * Called by periodic background sync to fire any overdue reminders.
 * Only runs when no window clients are open (otherwise the page handles it).
 */
async function checkScheduledReminders() {
  try {
    const clients = await self.clients.matchAll({ type: 'window' });
    if (clients.length > 0) return; // page is open — it manages reminders

    const pills   = snapshot.pills || [];
    const taken   = snapshot.taken || {};
    const now     = new Date();
    const hm      = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

    for (const pill of pills) {
      if (pill.archived) continue;
      const doses = getDoseTimes(pill);

      doses.forEach((doseTime, idx) => {
        const takenKey = pill.id + '_dose' + idx;
        if (taken[takenKey]) return;
        if (doseTime !== hm)  return;

        const label = doses.length > 1
          ? `${pill.name} (${idx + 1}/${doses.length})`
          : pill.name;

        const tag = `pc-${pill.id}-${doseTime.replace(':','')}-${todayKey()}`;

        self.registration.showNotification(`💊 ${label}`, {
          body:               [pill.dose || '', `Scheduled: ${doseTime}`].filter(Boolean).join(' · '),
          icon:               'icons/icon-192.png',
          badge:              'icons/icon-72.png',
          vibrate:            [200, 50, 200],
          requireInteraction: pill.priority === 'critical' || pill.priority === 'high',
          tag,
          actions: [
            { action: 'taken',  title: '✅ Mark Taken' },
            { action: 'snooze', title: '⏰ Snooze 5 min' },
          ],
          data: {
            pillId:   pill.id,
            doseTime,
            date:     todayKey(),
            name:     label,
            dose:     pill.dose,
            priority: pill.priority,
          },
        }).catch(() => {});
      });
    }
  } catch (e) {
    broadcastToClients({ type: 'SW_ERROR', message: String(e) });
  }
                          }
