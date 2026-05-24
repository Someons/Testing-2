'use strict';

/* ─────────────────────────────────────────────
   PillCare Service Worker  —  sw.js
   Place this file in the SAME folder as index.html
   It handles background notifications even when
   the browser tab is closed or in the background.
───────────────────────────────────────────────── */

const SW_VERSION = 'pillcare-sw-v3';

// ── Helpers ──────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function getDoses(pill) {
  if (!pill || pill.archived) return [];
  if (pill.freq === 'once') return [pill.time || '08:00'];
  if (pill.freq === 'custom') {
    const iv   = Math.max(Math.round((parseFloat(pill.intervalHours) || 6) * 60), 10);
    const [sh, sm] = (pill.time || '08:00').split(':').map(Number);
    const doses = [];
    for (let t = sh * 60 + sm; t < 1440 && doses.length < 24; t += iv)
      doses.push(pad(Math.floor(t / 60)) + ':' + pad(t % 60));
    return doses;
  }
  if (pill.freq === 'weekly') {
    const dow = new Date().getDay();
    return (pill.weekDays || []).map(Number).includes(dow) ? [pill.time || '08:00'] : [];
  }
  if (pill.freq === 'monthly') {
    const now = new Date();
    const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return Math.min(pill.monthDay || 1, dim) === now.getDate() ? [pill.time || '08:00'] : [];
  }
  return [pill.time || '08:00'];
}

// ── Alarm scheduler ──────────────────────────
let _timers   = [];
let _snapshot = null;

function cancelAll() {
  _timers.forEach(t => clearTimeout(t));
  _timers = [];
}

function scheduleAll(snapshot) {
  cancelAll();
  if (!snapshot) return;

  const { pills = [], taken = {}, snoozed = [], firedKeys = [] } = snapshot;
  const now   = Date.now();
  const today = todayStr();

  pills.forEach(pill => {
    if (pill.archived) return;
    getDoses(pill).forEach((doseTime, idx) => {
      // Skip already taken
      if (taken[pill.id + '_dose' + idx]) return;

      const [h, m]  = doseTime.split(':').map(Number);
      const fireMs  = new Date().setHours(h, m, 0, 0);
      const delay   = fireMs - now;

      // Only schedule future doses within next 12 hours
      if (delay < 0 || delay > 12 * 3600 * 1000) return;

      const key = pill.id + '_' + today + '_' + doseTime + '_' + idx;
      if (firedKeys.includes(key)) return; // already notified

      _timers.push(setTimeout(() => {
        self.registration.showNotification('💊 ' + pill.name, {
          body:                [pill.dose, 'Tap to mark as taken'].filter(Boolean).join(' · '),
          icon:                'icons/icon-192.png',
          badge:               'icons/icon-72.png',
          tag:                 'pillcare-dose-' + key,
          renotify:            false,
          requireInteraction:  pill.priority === 'critical' || pill.priority === 'high',
          actions: [
            { action: 'taken', title: '✓  Mark taken' },
            { action: 'snooze', title: '⏰  +5 min' }
          ],
          data: { pillId: pill.id, doseTime, date: today, name: pill.name, dose: pill.dose || '' }
        }).catch(() => {});

        // Notify the open page that this dose was fired so it marks firedKeys
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
          .then(cs => cs.forEach(c => c.postMessage({ type: 'DOSE_FIRED', key, pillId: pill.id, doseTime })));
      }, delay));
    });
  });

  // Snoozed doses
  snoozed.forEach(sv => {
    const delay = sv.fireAt - now;
    if (delay < 0 || delay > 8 * 3600 * 1000) return;

    _timers.push(setTimeout(() => {
      self.registration.showNotification('⏰ ' + sv.name, {
        body:    (sv.dose ? sv.dose + ' · ' : '') + 'Snoozed reminder',
        icon:    'icons/icon-192.png',
        badge:   'icons/icon-72.png',
        tag:     'pillcare-snooze-' + sv.id,
        actions: [
          { action: 'taken', title: '✓  Mark taken' },
          { action: 'snooze', title: '⏰  +5 min' }
        ],
        data: { pillId: sv.pillId, doseTime: sv.time, date: today, name: sv.name, dose: sv.dose || '', isSnooze: true }
      }).catch(() => {});
    }, delay));
  });
}

// ── Lifecycle ────────────────────────────────
self.addEventListener('install', () => {
  console.log('[PillCare SW] Installed', SW_VERSION);
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  console.log('[PillCare SW] Activated');
  e.waitUntil(self.clients.claim());
});

// ── Messages from page ───────────────────────
self.addEventListener('message', e => {
  if (!e.data) return;
  switch (e.data.type) {
    case 'UPDATE_SNAPSHOT':
      _snapshot = e.data.snapshot;
      scheduleAll(_snapshot);
      break;
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
    case 'PING':
      // Keep-alive — reschedule to handle any timer drift
      if (_snapshot) scheduleAll(_snapshot);
      break;
  }
});

// ── Notification actions ─────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {};

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      const target = cs.find(c => c.visibilityState === 'visible') || cs[0];

      if (e.action === 'taken') {
        if (target) {
          target.focus();
          target.postMessage({ type: 'MARK_TAKEN', pillId: d.pillId, doseTime: d.doseTime, date: d.date });
        } else {
          self.clients.openWindow('./');
        }
      } else if (e.action === 'snooze') {
        const fireAt = Date.now() + 5 * 60 * 1000;
        if (target) {
          target.focus();
          target.postMessage({ type: 'STORE_SNOOZE', pillId: d.pillId, name: d.name, dose: d.dose, time: d.doseTime, fireAt });
        } else {
          self.clients.openWindow('./');
        }
      } else {
        // Just tapped — open the app
        if (target) target.focus();
        else self.clients.openWindow('./');
      }
    })
  );
});

// ── Fetch — serve cached app shell ───────────
self.addEventListener('fetch', e => {
  // Only cache GET requests for our own origin
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.open(SW_VERSION).then(cache =>
      cache.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(resp => {
          if (resp.ok) cache.put(e.request, resp.clone());
          return resp;
        }).catch(() => cached);
      })
    )
  );
});
   
