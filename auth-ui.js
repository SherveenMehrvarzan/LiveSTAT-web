'use strict';

(function (root) {
  const document = root.document;
  const config = root.LiveStatConfig || { apiBase: '', hosted: false };
  const hosted = config.hosted === true;
  const tokenKey = 'livestat-session-token';
  const serviceUnavailable = 'The hosted data service is unavailable. Please try again shortly.';
  let token = '';
  let epoch = 0;
  let authAttempt = 0;
  let session = { hosted, authenticated: !hosted, role: hosted ? null : 'owner' };
  let gate, resolveGate;
  function resetGate() { gate = new Promise((resolve) => { resolveGate = resolve; }); }
  resetGate();
  let base = text(config.apiBase).replace(/\/+$/, '');
  let configurationError = '';
  try {
    if (base || hosted) {
      const url = new URL(base || root.location.origin, root.location.href);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('The hosted data address needs HTTPS.');
      if (base) base = url.href.replace(/\/+$/, '');
    }
  } catch (error) { configurationError = error.message; }
  function text(value) { return typeof value === 'string' ? value : ''; }
  function storeToken(value) {
    token = text(value);
    try { if (token) root.sessionStorage.setItem(tokenKey, token); else root.sessionStorage.removeItem(tokenKey); } catch (_) { /* Memory-only sessions still work. */ }
  }
  if (hosted) { try { token = text(root.sessionStorage.getItem(tokenKey)); } catch (_) { /* Storage may be blocked. */ } }
  function isOwner() { return session.authenticated && session.role === 'owner'; }
  function route(path) {
    if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('://') || path.includes('\\')) throw new Error('Invalid API path.');
    return base + path;
  }
  async function rawFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (hosted && token && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
    const target = route(path);
    const crossOrigin = new URL(target, root.location.href).origin !== root.location.origin;
    return root.fetch(target, { cache: 'no-store', ...options, headers, credentials: hosted ? crossOrigin ? 'omit' : 'same-origin' : options.credentials || 'same-origin' });
  }
  function notify() {
    applyRole();
    document.dispatchEvent(new CustomEvent('livestat:session', { detail: { ...session } }));
  }
  function accept(result) {
    if (!result.authenticated || !['owner', 'viewer'].includes(result.role)) return false;
    if (text(result.token)) storeToken(result.token);
    session = { hosted, authenticated: true, role: result.role, expiresAt: result.expiresAt || null };
    epoch += 1;
    notify();
    resolveGate(session);
    return true;
  }
  function signedOut(message = '') {
    authAttempt += 1;
    const hadAccess = session.authenticated;
    epoch += 1;
    storeToken('');
    session = { hosted, authenticated: false, role: null };
    if (hadAccess) resetGate();
    notify();
    const error = document.getElementById('auth-message');
    if (error) error.textContent = message;
  }
  async function apiFetch(path, options = {}) {
    if (!hosted) return rawFetch(path, options);
    while (!session.authenticated) await gate;
    if (!isOwner() && (path.startsWith('/api/coach') || (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase()) && !path.startsWith('/api/auth/')))) {
      return new Response(JSON.stringify({ error: 'This shared view is read-only.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    const requestEpoch = epoch;
    const response = await rawFetch(path, options);
    if (requestEpoch !== epoch || !session.authenticated) throw new Error('Access changed while this request was loading. Please try again.');
    if (response.status === 401 && requestEpoch === epoch) signedOut('Your viewing session ended. Sign in again to continue.');
    return response;
  }
  root.LiveStatAPI = Object.freeze({
    fetch: apiFetch,
    get ready() { return gate; },
    get session() { return { ...session }; },
    get epoch() { return epoch; },
    isOwner,
  });

  function applyRole() {
    const html = document.documentElement;
    html.dataset.hosted = String(hosted);
    html.dataset.authenticated = String(session.authenticated);
    html.dataset.role = session.role || 'signed-out';
    const screen = document.getElementById('auth-screen');
    if (screen) screen.hidden = !hosted || session.authenticated;
    for (const region of document.querySelectorAll('.workspace, .sidebar')) {
      const locked = hosted && !session.authenticated;
      region.inert = locked;
      if (locked) region.setAttribute('aria-hidden', 'true'); else region.removeAttribute('aria-hidden');
    }
    const logout = document.getElementById('auth-logout');
    if (logout) logout.hidden = !hosted || !session.authenticated;
    const role = document.getElementById('auth-role');
    if (role) { role.hidden = !hosted || !session.authenticated; role.textContent = isOwner() ? 'Owner' : 'Read-only view'; }
    if (hosted) {
      const storage = document.getElementById('storage-description');
      if (storage) storage.textContent = 'Hosted health data';
      const footer = document.getElementById('storage-footer');
      if (footer) footer.textContent = 'Your health, together. Hosted health data.';
      const badge = document.querySelector('.local-badge');
      if (badge) badge.textContent = 'HOSTED';
      for (const note of document.querySelectorAll('.coach-save-note')) note.textContent = 'Saved with your hosted health data.';
      const importStatus = document.getElementById('apple-import-status');
      if (importStatus && importStatus.textContent.startsWith('Files stay')) importStatus.textContent = 'Files are processed by the hosted service. Maximum file size: 150 MB.';
      const footnote = document.querySelector('.live-heart-footnote');
      if (footnote) footnote.textContent = 'Live heart rate is shared with signed-in viewers while the owner broadcasts.';
      const viewerNote = document.getElementById('viewer-sources-note');
      if (viewerNote) viewerNote.hidden = isOwner();
      const chartRetention = document.getElementById('live-heart-retention');
      if (chartRetention) chartRetention.textContent = 'Last 120 shared readings';
    }
  }
  function message(value) { const element = document.getElementById('auth-message'); if (element) element.textContent = value; }
  function retrySeconds(response) {
    const value = response.headers.get('Retry-After');
    const numeric = Number(value);
    if (value && Number.isFinite(numeric)) return Math.max(1, Math.ceil(numeric));
    const date = Date.parse(value || '');
    return Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1000)) : 60;
  }
  async function login(event, owner) {
    event.preventDefault();
    const field = document.getElementById(owner ? 'auth-owner-key' : 'auth-passcode');
    const button = document.getElementById(owner ? 'auth-owner-submit' : 'auth-viewer-submit');
    if (!field.value || button.disabled) return;
    const credential = field.value;
    const attempt = ++authAttempt;
    button.disabled = true;
    message(owner ? 'Opening owner access…' : 'Opening your shared view…');
    let delay = 0;
    try {
      if (configurationError) throw new Error(configurationError);
      let response;
      try {
        response = await rawFetch(owner ? '/api/auth/owner-login' : '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(owner ? { ownerKey: credential } : { passcode: credential }) });
      } catch (_) { throw new Error(serviceUnavailable); }
      let result = {};
      let validJson = false;
      try {
        const value = await response.json();
        if (value && typeof value === 'object' && !Array.isArray(value)) { result = value; validJson = true; }
      } catch (_) { /* A tunnel/gateway page is not a credential rejection. */ }
      if (attempt !== authAttempt) {
        // A superseded same-origin login may still have set an HttpOnly cookie.
        // Revoke its distinct session without changing the current view/token.
        if (response.ok && result.authenticated && text(result.token) && result.token !== token) {
          rawFetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + result.token } }).catch(() => {});
        }
        return;
      }
      if (response.status === 429) { delay = retrySeconds(response); throw new Error(`Too many attempts. Try again in ${delay} seconds.`); }
      if (!validJson || response.status >= 500 || (!response.ok && ![400, 401, 403].includes(response.status))) throw new Error(serviceUnavailable);
      if (!response.ok) throw new Error(text(result.error) || text(result.message) || 'That credential was not accepted. Please try again.');
      if (!accept(result)) throw new Error(serviceUnavailable);
      message('');
    } catch (error) { if (attempt === authAttempt) message(error.message || 'Sign-in could not finish. Please try again.'); }
    finally {
      field.value = '';
      if (delay) root.setTimeout(() => { button.disabled = false; }, Math.min(delay, 3600) * 1000);
      else button.disabled = false;
    }
  }
  async function logout() {
    const previousToken = token;
    signedOut();
    document.getElementById('auth-passcode')?.focus();
    const headers = previousToken ? { Authorization: 'Bearer ' + previousToken } : {};
    try { await rawFetch('/api/auth/logout', { method: 'POST', headers }); } catch (_) { /* The local view is already locked. */ }
  }
  function bind() {
    document.getElementById('auth-viewer-form')?.addEventListener('submit', (event) => login(event, false));
    document.getElementById('auth-owner-form')?.addEventListener('submit', (event) => login(event, true));
    document.getElementById('auth-manage')?.addEventListener('click', () => {
      const details = document.getElementById('auth-owner-details');
      details.hidden = !details.hidden;
      document.getElementById('auth-manage').setAttribute('aria-expanded', String(!details.hidden));
      if (!details.hidden) document.getElementById('auth-owner-key').focus();
    });
    document.getElementById('auth-logout')?.addEventListener('click', logout);
    const exportLink = document.querySelector('.main-footer a[download]');
    exportLink?.addEventListener('click', async (event) => {
      if (!hosted) return;
      event.preventDefault();
      const exportEpoch = epoch;
      const exportRole = session.role;
      try {
        const response = await apiFetch('/api/export');
        if (!response.ok) throw new Error('The data export could not be downloaded.');
        const blob = await response.blob();
        if (exportEpoch !== epoch || !session.authenticated || session.role !== exportRole) throw new Error('Access changed before the export finished. Start a new export from your current session.');
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a'); link.href = url; link.download = 'LiveSTAT-data.json'; link.click();
        root.setTimeout(() => URL.revokeObjectURL(url), 30000);
      } catch (error) { const status = document.getElementById('error-message'); if (status) { status.textContent = error.message; status.hidden = false; } }
    });
    applyRole();
  }
  bind();
  if (!hosted) { notify(); resolveGate(session); return; }
  (async () => {
    if (configurationError) { message(configurationError); return; }
    const probeEpoch = epoch;
    const probeAttempt = authAttempt;
    try {
      const response = await rawFetch('/api/auth/session');
      if (!response.ok) throw new Error(serviceUnavailable);
      const result = await response.json();
      if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.authenticated !== 'boolean' || (result.authenticated && !['owner', 'viewer'].includes(result.role))) throw new Error(serviceUnavailable);
      if (probeEpoch !== epoch || probeAttempt !== authAttempt) return;
      if (!accept(result)) signedOut();
    } catch (_) {
      // An outage is not proof that a cached token was rejected. Stay locked,
      // retaining it for a later valid session check rather than granting access.
      if (probeEpoch === epoch && probeAttempt === authAttempt) message(serviceUnavailable);
    }
  })();
})(window);
