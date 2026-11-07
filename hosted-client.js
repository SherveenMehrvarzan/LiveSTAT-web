'use strict';

(function (root) {
  const api = root.LiveStatAPI;
  const heart = root.LiveStatLiveHeart;
  if (!api || !heart) return;
  let activeEpoch = -1;
  let pollTimer = null;
  let pollBusy = false;
  let publishTimer = null;
  let publishBusy = false;
  let latest = null;
  let lastPublishAt = 0;
  let pausedUntil = 0;
  let publisherId = '';
  function sharing(text) { const element = document.getElementById('live-heart-sharing-status'); if (element) { element.textContent = text; element.hidden = !text; } }
  function owner() { return api.session.hosted && api.session.authenticated && api.session.role === 'owner'; }
  function stopTimers() { clearTimeout(pollTimer); clearTimeout(publishTimer); pollTimer = null; publishTimer = null; }
  function publisherToken() { return root.crypto && typeof root.crypto.randomUUID === 'function' ? root.crypto.randomUUID() : 'tab-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
  async function poll() {
    clearTimeout(pollTimer);
    if (!api.session.hosted || !api.session.authenticated || document.hidden || pollBusy) return;
    pollBusy = true;
    const epoch = api.epoch;
    try {
      const response = await api.fetch('/api/live');
      if (!response.ok) throw new Error('Shared feed unavailable.');
      const snapshot = await response.json();
      if (epoch === api.epoch && api.session.authenticated) heart.applyRemote(snapshot);
    } catch (_) {
      // The view expires an old reading after 15 seconds even when polling fails.
      // Local Bluetooth readings stay independent from the sharing connection.
    } finally {
      pollBusy = false;
      if (api.session.authenticated && !document.hidden) pollTimer = setTimeout(poll, epoch === api.epoch ? 2000 : 0);
    }
  }
  function schedulePublish() {
    if (!owner() || !latest || publishBusy) return;
    clearTimeout(publishTimer);
    const delay = Math.max(0, lastPublishAt + 1000 - Date.now(), pausedUntil - Date.now());
    publishTimer = setTimeout(flush, delay);
  }
  async function flush() {
    publishTimer = null;
    if (!owner() || publishBusy || !latest) return;
    const update = latest;
    latest = null;
    if (update.state === 'live' && Date.now() - update.timestamp >= 15000) return;
    publishBusy = true;
    lastPublishAt = Date.now();
    const epoch = api.epoch;
    const body = { state: update.state, sessionId: publisherId, deviceName: update.deviceName || '' };
    if (update.state === 'live') { body.bpm = update.bpm; body.measuredAt = update.measuredAt; }
    try {
      const response = await api.fetch('/api/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: update.state === 'disconnected' });
      if (epoch !== api.epoch) return;
      if (!response.ok) {
        if (response.status === 409) { pausedUntil = Date.now() + 21000; throw new Error('Sharing paused: another owner window is broadcasting.'); }
        if (response.status === 429) { pausedUntil = Date.now() + 5000; throw new Error('Sharing paused briefly. Waiting to send the next fresh reading.'); }
        throw new Error('Sharing paused: the hosted service could not receive this update.');
      }
      if (epoch === api.epoch && owner()) sharing(update.state === 'live' ? 'Sharing live with signed-in viewers.' : update.state === 'disconnected' ? 'Shared broadcast disconnected.' : 'Sharing connected. Waiting for a watch reading.');
    } catch (error) {
      if (epoch === api.epoch && owner()) sharing(error.message || 'Sharing paused: check your internet connection.');
    } finally {
      publishBusy = false;
      if (owner()) schedulePublish();
    }
  }
  function queue(detail, state) {
    if (!owner() || !detail || detail.local !== true) return;
    if (state === 'live' && (!Number.isInteger(detail.bpm) || detail.bpm <= 0)) return;
    latest = { state, bpm: detail.bpm, deviceName: typeof detail.deviceName === 'string' ? detail.deviceName : '', timestamp: Number.isFinite(detail.timestamp) ? detail.timestamp : Date.now(), measuredAt: typeof detail.measuredAt === 'string' ? detail.measuredAt : new Date().toISOString() };
    schedulePublish();
  }
  function activate() {
    if (activeEpoch === api.epoch) return;
    activeEpoch = api.epoch;
    stopTimers(); latest = null; pausedUntil = 0; lastPublishAt = 0; publisherId = publisherToken();
    heart.configureAccess(api.session);
    sharing('');
    if (api.session.hosted && api.session.authenticated) poll();
  }
  document.addEventListener('livestat:heart-rate', (event) => queue(event.detail, 'live'));
  document.addEventListener('livestat:heart-state', (event) => queue(event.detail, event.detail?.state));
  document.addEventListener('livestat:session', activate);
  document.addEventListener('visibilitychange', () => { clearTimeout(pollTimer); if (!document.hidden && api.session.authenticated) poll(); });
  activate();
  api.ready.then(activate);
})(window);
