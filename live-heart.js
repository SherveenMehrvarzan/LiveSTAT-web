'use strict';

(function (root) {
  /** Parse the Bluetooth SIG Heart Rate Measurement characteristic (0x2A37).
   * Contact detection is optional; a supported sensor reporting no contact is
   * returned explicitly so the UI never treats that sample as a live reading.
   * Invalid/truncated fields reject the whole packet, including optional fields.
   */
  function parseHeartRateMeasurement(view) {
    if (!view || Object.prototype.toString.call(view) !== '[object DataView]') {
      throw new TypeError('Heart rate measurement must be a DataView.');
    }
    if (view.byteLength < 2) throw new RangeError('Truncated heart rate measurement.');
    const flags = view.getUint8(0);
    const wide = Boolean(flags & 1);
    let offset = 1;
    if (view.byteLength < offset + (wide ? 2 : 1)) throw new RangeError('Truncated heart rate value.');
    const bpm = wide ? view.getUint16(offset, true) : view.getUint8(offset);
    offset += wide ? 2 : 1;
    const contactSupported = Boolean(flags & 4);
    const contactDetected = contactSupported ? Boolean(flags & 2) : null;
    let energyExpended = null;
    if (flags & 8) {
      if (view.byteLength < offset + 2) throw new RangeError('Truncated energy expended field.');
      energyExpended = view.getUint16(offset, true);
      offset += 2;
    }
    const rrIntervals = [];
    if (flags & 16) {
      if (view.byteLength < offset + 2 || (view.byteLength - offset) % 2 !== 0) throw new RangeError('Truncated RR interval field.');
      while (offset < view.byteLength) {
        rrIntervals.push(view.getUint16(offset, true) / 1024);
        offset += 2;
      }
    }
    return { bpm, contactSupported, contactDetected, energyExpended, rrIntervals };
  }

  // A small pure API also permits protocol tests without a browser or hardware.
  root.DaymarkLiveHeart = Object.freeze({ parseHeartRateMeasurement });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.DaymarkLiveHeart;
  if (!root.document) return;

  const document = root.document;
  const byId = (id) => document.getElementById('live-heart-' + id);
  if (!byId('panel')) return;
  const STALE_MS = 15000;
  const MAX_SAMPLES = 120;
  let generation = 0;
  let connecting = false;
  let session = null;
  let samples = [];
  let lastPacketAt = 0;
  let waitingSince = 0;
  let state = 'idle';
  let message = 'Turn on heart rate broadcasting on your watch, then connect it here.';
  let deviceName = '';
  let staleTimer = null;
  let access = { hosted: false, authenticated: true, role: 'owner' };
  let remoteActive = false;
  let remoteFreshAt = 0;
  let remoteLastReadingAt = 0;
  let remoteBpm = null;
  let remoteTimer = null;
  const available = Boolean(root.isSecureContext && root.navigator && root.navigator.bluetooth);
  const stateLabels = { idle: 'Not connected', connecting: 'Connecting…', waiting: 'Waiting for reading', live: 'Live', contactlost: 'No skin contact', stale: 'No recent reading', disconnected: 'Disconnected', unsupported: 'Use Chrome', error: 'Connection issue' };
  const time = (timestamp) => new Date(timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const node = (name, text, className) => {
    const element = document.createElement(name);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const svgNode = (name, attributes = {}) => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
  };

  function renderReadings() {
    if (!samples.length) {
      byId('chart').replaceChildren(node('div', 'Your live readings will appear here.', 'live-heart-chart-empty'));
      const row = node('tr'); const cell = node('td', 'No readings in this session.'); cell.colSpan = 2; row.append(cell);
      byId('data-body').replaceChildren(row);
      byId('sample-count').textContent = '0 readings';
      return;
    }
    const width = 600, height = 120, left = 30, right = 8, top = 12, bottom = 22;
    const values = samples.map((sample) => sample.bpm);
    const low = Math.max(0, Math.floor((Math.min(...values) - 8) / 10) * 10);
    const high = Math.max(low + 20, Math.ceil((Math.max(...values) + 8) / 10) * 10);
    const firstTime = samples[0].timestamp, lastTime = samples[samples.length - 1].timestamp;
    const duration = Math.max(1000, lastTime - firstTime);
    const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `Live heart rate session. ${samples.length} readings, from ${time(firstTime)} to ${time(lastTime)}. Values are available below the chart.` });
    const title = svgNode('title'); title.textContent = 'Heart rate during this browser session'; svg.append(title);
    for (let i = 0; i < 3; i++) {
      const y = top + i / 2 * (height - top - bottom);
      svg.append(svgNode('line', { x1: left, x2: width - right, y1: y, y2: y, stroke: 'var(--chart-grid)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
      const label = svgNode('text', { x: left - 7, y: y + 3, 'text-anchor': 'end', fill: 'var(--chart-label)', 'font-size': 9, 'font-family': 'system-ui, sans-serif' });
      label.textContent = String(Math.round(high - i / 2 * (high - low))); svg.append(label);
    }
    const points = samples.map((sample) => ({ ...sample, x: left + (sample.timestamp - firstTime) / duration * (width - left - right), y: top + (high - sample.bpm) / (high - low) * (height - top - bottom) }));
    let segment = [];
    const flush = () => {
      if (segment.length > 1) svg.append(svgNode('polyline', { points: segment.map((p) => `${p.x},${p.y}`).join(' '), fill: 'none', stroke: 'var(--chart-series)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
      segment.forEach((point) => {
        const circle = svgNode('circle', { cx: point.x, cy: point.y, r: points.length > 50 ? 1.3 : 2.3, fill: 'var(--chart-series)' });
        const caption = svgNode('title'); caption.textContent = `${time(point.timestamp)}: ${point.bpm} bpm`; circle.append(caption); svg.append(circle);
      });
      segment = [];
    };
    points.forEach((point, index) => {
      if (index > 0 && point.timestamp - points[index - 1].timestamp > STALE_MS) flush();
      segment.push(point);
    }); flush();
    [[left, firstTime, 'start'], [width - right, lastTime, 'end']].forEach(([x, timestamp, anchor]) => {
      const label = svgNode('text', { x, y: height - 3, 'text-anchor': anchor, fill: 'var(--chart-label)', 'font-size': 9, 'font-family': 'system-ui, sans-serif' }); label.textContent = time(timestamp); svg.append(label);
    });
    byId('chart').replaceChildren(svg);
    const rows = document.createDocumentFragment();
    samples.slice().reverse().forEach((sample) => { const row = node('tr'); row.append(node('td', time(sample.timestamp)), node('td', String(sample.bpm))); rows.append(row); });
    byId('data-body').replaceChildren(rows);
    byId('sample-count').textContent = `${samples.length} ${samples.length === 1 ? 'reading' : 'readings'}`;
  }

  function render() {
    const localConnected = Boolean(session && session.server && session.server.connected && !session.disposed);
    const connected = localConnected || (remoteActive && access.authenticated && Date.now() - remoteFreshAt < STALE_MS);
    const latest = samples[samples.length - 1];
    byId('status').textContent = stateLabels[state];
    byId('status').classList.toggle('is-live', state === 'live' && connected);
    byId('status').classList.toggle('is-issue', state === 'error');
    const currentBpm = remoteActive ? remoteBpm : latest?.bpm;
    const readingTime = remoteActive ? remoteLastReadingAt : latest?.timestamp;
    byId('bpm').textContent = state === 'live' && connected && currentBpm ? String(currentBpm) : '—';
    byId('time').textContent = readingTime ? `${state === 'live' && connected ? 'Updated' : 'Last reading'} ${time(readingTime)}` : 'No live reading yet';
    byId('message').textContent = message;
    byId('device').textContent = deviceName || 'Bluetooth heart rate';
    byId('connect').disabled = !available || !access.authenticated || access.role !== 'owner' || connecting || localConnected;
    byId('connect').textContent = connecting ? 'Connecting…' : localConnected ? 'Watch connected' : 'Connect watch';
    byId('disconnect').hidden = !connecting && !localConnected;
    byId('disconnect').textContent = connecting ? 'Cancel connection' : 'Disconnect';
  }
  function setState(next, nextMessage) {
    state = next; message = nextMessage; render();
    if (!remoteActive && ['waiting', 'contactlost', 'disconnected', 'stale'].includes(next)) {
      document.dispatchEvent(new CustomEvent('livestat:heart-state', { detail: { state: next === 'stale' ? 'waiting' : next, deviceName, local: true } }));
    }
  }

  function clearStaleTimer() { if (staleTimer !== null) { root.clearInterval(staleTimer); staleTimer = null; } }
  function startStaleTimer() {
    clearStaleTimer();
    staleTimer = root.setInterval(() => {
      if (!session || session.disposed || !session.server || !session.server.connected) return;
      if (Date.now() - (lastPacketAt || waitingSince) >= STALE_MS && state !== 'stale') {
        setState('stale', 'No updates for 15 seconds. Keep broadcasting active and your watch near your computer.');
      }
    }, 1000);
  }

  function cleanup(target, disconnectGatt = true) {
    if (!target || target.disposed) return;
    target.disposed = true;
    if (target.characteristic && target.onMeasurement) target.characteristic.removeEventListener('characteristicvaluechanged', target.onMeasurement);
    if (target.device && target.onDisconnected) target.device.removeEventListener('gattserverdisconnected', target.onDisconnected);
    if (target.characteristic && target.notifications && typeof target.characteristic.stopNotifications === 'function') {
      try { Promise.resolve(target.characteristic.stopNotifications()).catch(() => {}); } catch (_) { /* Device may have gone away. */ }
    }
    if (disconnectGatt && target.server && target.server.connected) {
      try { target.server.disconnect(); } catch (_) { /* Already disconnected. */ }
    }
  }
  function disconnect() {
    generation += 1;
    connecting = false;
    clearStaleTimer();
    const previous = session; session = null; cleanup(previous);
    remoteActive = false;
    setState('disconnected', 'Disconnected. Your session chart stays here until you reconnect or close this tab.');
  }
  function failureMessage(error, chooserCancelled) {
    if (error && error.name === 'NotFoundError' && chooserCancelled) return ['idle', 'No watch selected. Turn on heart rate broadcasting, then choose Connect watch when you are ready.'];
    if (error && (error.name === 'SecurityError' || error.name === 'NotAllowedError')) return ['error', 'Bluetooth access was not allowed. Open this dashboard in Chrome on your Mac and allow access when you choose your watch.'];
    if (error && (error.name === 'NotSupportedError' || error.name === 'NotFoundError')) return ['error', 'This device did not offer the heart rate service. Enable Broadcast Heart Rate on your watch, then try connecting again.'];
    return ['error', 'The watch connection could not finish. Keep Broadcast Heart Rate active, move the watch nearby, and choose Connect watch to try again.'];
  }

  async function connect() {
    if (!available || !access.authenticated || access.role !== 'owner' || connecting || (session && session.server && session.server.connected)) return;
    const attempt = ++generation;
    connecting = true;
    remoteActive = false;
    setState('connecting', 'Choose your watch in the Bluetooth device window.');
    let target = null;
    const current = () => attempt === generation && target && session === target && !target.disposed;
    const stopLateConnection = () => {
      if (target && target.server && target.server.connected) {
        try { target.server.disconnect(); } catch (_) { /* Late connection was cancelled. */ }
      }
    };
    try {
      // requestDevice stays directly inside a user gesture; no automatic chooser.
      const device = await root.navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
      if (attempt !== generation) return;
      target = { device, server: null, characteristic: null, notifications: false, disposed: false, onMeasurement: null, onDisconnected: null };
      session = target;
      deviceName = device.name || 'Heart rate monitor';
      target.onDisconnected = () => {
        if (!current()) return;
        generation += 1; connecting = false; clearStaleTimer(); session = null;
        cleanup(target, false);
        setState('disconnected', 'The watch disconnected. Keep broadcasting active, then choose Connect watch to reconnect.');
      };
      device.addEventListener('gattserverdisconnected', target.onDisconnected);
      if (!device.gatt) throw new Error('No Bluetooth GATT server.');
      target.server = await device.gatt.connect();
      if (!current()) { stopLateConnection(); return; }
      const service = await target.server.getPrimaryService('heart_rate');
      if (!current()) { stopLateConnection(); return; }
      target.characteristic = await service.getCharacteristic('heart_rate_measurement');
      if (!current()) { stopLateConnection(); return; }
      samples = []; lastPacketAt = 0; waitingSince = Date.now(); renderReadings();
      target.onMeasurement = (event) => {
        if (!current() || !target.server.connected) return;
        let measurement;
        try { measurement = parseHeartRateMeasurement(event.target.value); }
        catch (_) { setState('waiting', 'The latest measurement could not be read. Waiting for a valid watch update.'); return; }
        lastPacketAt = Date.now();
        if (measurement.contactSupported && !measurement.contactDetected) {
          setState('contactlost', 'Your watch reports no skin contact. Adjust its fit and wait for a new reading.'); return;
        }
        if (measurement.bpm === 0) { setState('waiting', 'Your watch has not reported a heart rate yet. Wear it snugly and keep broadcasting active.'); return; }
        samples.push({ timestamp: lastPacketAt, bpm: measurement.bpm });
        if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
        setState('live', 'Receiving heart rate directly from your watch.'); renderReadings();
        document.dispatchEvent(new CustomEvent('livestat:heart-rate', { detail: { bpm: measurement.bpm, deviceName, measuredAt: new Date(lastPacketAt).toISOString(), timestamp: lastPacketAt, local: true } }));
      };
      // Some devices notify immediately; attach the listener before subscribing.
      target.characteristic.addEventListener('characteristicvaluechanged', target.onMeasurement);
      await target.characteristic.startNotifications();
      target.notifications = true;
      if (!current()) {
        // A cancellation may have disposed the session while this call awaited.
        // Stop a late subscription as well as dropping its GATT connection.
        try { Promise.resolve(target.characteristic.stopNotifications()).catch(() => {}); } catch (_) { /* Already gone. */ }
        cleanup(target); stopLateConnection(); return;
      }
      connecting = false;
      if (!samples.length && state !== 'contactlost') setState('waiting', 'Watch connected. Waiting for its first heart rate reading…');
      else render();
      startStaleTimer();
    } catch (error) {
      if (attempt !== generation) { cleanup(target); stopLateConnection(); return; }
      generation += 1; connecting = false; clearStaleTimer(); session = null; cleanup(target);
      const [next, explanation] = failureMessage(error, !target); setState(next, explanation);
    }
  }

  byId('connect').addEventListener('click', connect);
  byId('disconnect').addEventListener('click', disconnect);
  byId('help-button').addEventListener('click', () => {
    const sources = document.querySelector('[data-page="sources"]');
    if (sources) sources.click();
    byId('help').scrollIntoView({ behavior: root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  });
  byId('open-overview').addEventListener('click', () => {
    const overview = document.querySelector('[data-page="overview"]');
    if (overview) overview.click();
    byId('panel').scrollIntoView({ behavior: root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  });
  root.addEventListener('pagehide', disconnect);
  function hasLocalSession() { return connecting || Boolean(session && session.server && session.server.connected && !session.disposed); }
  function configureAccess(next) {
    access = { ...access, ...next };
    if ((!access.authenticated || access.role !== 'owner') && hasLocalSession()) disconnect();
    if (remoteTimer !== null) { root.clearInterval(remoteTimer); remoteTimer = null; }
    if (access.hosted && !hasLocalSession()) {
      remoteActive = true; remoteFreshAt = 0; remoteBpm = null;
      state = 'waiting'; message = access.role === 'owner' ? 'Connect your watch to share live heart rate, or view an active owner broadcast.' : 'Waiting for a shared broadcast from the owner.';
      if (!access.authenticated) { samples = []; remoteLastReadingAt = 0; renderReadings(); }
      render();
    }
    if (access.hosted) remoteTimer = root.setInterval(() => {
      if (!remoteActive || hasLocalSession() || state !== 'live') return;
      if (Date.now() - remoteFreshAt >= STALE_MS) { state = 'stale'; message = 'No fresh shared reading. Waiting for the owner’s broadcast to update.'; render(); }
    }, 1000);
    render();
  }
  function applyRemote(snapshot) {
    if (!access.hosted || !access.authenticated || hasLocalSession() || !snapshot) return;
    remoteActive = true;
    const readingAt = Date.parse(snapshot.lastReadingAt || snapshot.receivedAt || '');
    const reportedAge = typeof snapshot.ageSeconds === 'number' && Number.isFinite(snapshot.ageSeconds) ? Math.max(0, snapshot.ageSeconds * 1000) : Infinity;
    const clockAge = Number.isFinite(readingAt) ? Math.max(0, Date.now() - readingAt) : Infinity;
    remoteFreshAt = Date.now() - Math.max(reportedAge, clockAge);
    remoteLastReadingAt = Number.isFinite(readingAt) ? readingAt : 0;
    remoteBpm = Number.isInteger(snapshot.bpm) && snapshot.bpm > 0 ? snapshot.bpm : null;
    deviceName = typeof snapshot.deviceName === 'string' ? snapshot.deviceName : 'Owner’s watch';
    const states = ['live', 'stale', 'disconnected', 'waiting', 'contactlost'];
    state = states.includes(snapshot.state) ? snapshot.state : 'waiting';
    if (state === 'live' && (!remoteBpm || Date.now() - remoteFreshAt >= STALE_MS)) state = 'stale';
    const messages = { live: 'Receiving the owner’s shared heart rate broadcast.', stale: 'No fresh shared reading. Waiting for the owner’s broadcast to update.', disconnected: 'The owner’s watch is not broadcasting right now.', waiting: 'Waiting for a shared heart rate reading from the owner.', contactlost: 'The broadcasting watch reports no skin contact. Waiting for a new reading.' };
    message = messages[state];
    samples = Array.isArray(snapshot.samples) ? snapshot.samples.filter((sample) => Number.isInteger(sample.bpm) && sample.bpm > 0 && Number.isFinite(sample.timestamp) && sample.timestamp > 0 && sample.timestamp <= Date.now() + 60000).slice(-MAX_SAMPLES).map((sample) => ({ bpm: sample.bpm, timestamp: sample.timestamp })).sort((a, b) => a.timestamp - b.timestamp) : [];
    renderReadings(); render();
  }
  root.LiveStatLiveHeart = Object.freeze({ configureAccess, applyRemote, hasLocalSession });
  if (!available) {
    setState('unsupported', root.isSecureContext ? 'This browser does not offer Bluetooth heart rate access. Open this local dashboard address in Chrome on your Mac, then connect your watch.' : 'Bluetooth needs a secure page. Open the local dashboard at http://127.0.0.1:8765 in Chrome on your Mac.');
  } else render();
})(typeof globalThis !== 'undefined' ? globalThis : this);
