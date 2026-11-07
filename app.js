'use strict';

const $ = (id) => document.getElementById(id);
const number = (value) => typeof value === 'number' && Number.isFinite(value);
const whole = (value) => number(value) ? Math.round(value).toLocaleString() : '—';
const dateKey = (value) => typeof value === 'string' ? value.slice(0, 10) : '';
const parseDate = (value) => new Date(dateKey(value) + 'T12:00:00');
const shortDate = (value) => value ? parseDate(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';
const longDate = (value) => value ? parseDate(value).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '—';
const duration = (seconds) => {
  if (!number(seconds)) return '—';
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
};
const distance = (meters) => number(meters) ? `${(meters / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km` : '—';
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const sumValues = (items, key) => {
  const values = items.map((item) => item[key]).filter(number);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
};
function metricValue(day, key) {
  const value = day?.[key];
  if (!number(value) || value < 0) return null;
  if (['sleepSeconds', 'hrv', 'restingHeartRate'].includes(key) && value <= 0) return null;
  if (['bodyBatteryHigh', 'bodyBatteryLow'].includes(key) && (value < 5 || value > 100)) return null;
  return value;
}
function metricValues(days, key) { return days.map((day) => metricValue(day, key)).filter(number); }
const metrics = [
  { key: 'sleepSeconds', label: 'Sleep', title: 'Sleep duration', unit: '', chartUnit: 'Hours per night', format: duration, axis: (v) => (v / 3600).toFixed(1), zero: true },
  { key: 'hrv', label: 'Overnight HRV', title: 'Heart rate variability', unit: 'ms', chartUnit: 'Milliseconds', format: whole, axis: whole },
  { key: 'restingHeartRate', label: 'Resting heart rate', title: 'Resting heart rate', unit: 'bpm', chartUnit: 'Beats per minute', format: whole, axis: whole },
  { key: 'bodyBatteryHigh', label: 'Body Battery high', title: 'Body Battery · daily high', unit: '/ 100', chartUnit: 'Daily high · 5–100', format: whole, axis: whole, minimum: 5, maximum: 100 },
  { key: 'steps', label: 'Steps', title: 'Daily steps', unit: '', chartUnit: 'Steps per day', format: whole, axis: (v) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : whole(v), zero: true },
  { key: 'stress', label: 'Average stress', title: 'Daily stress', unit: '/ 100', chartUnit: 'Garmin stress · 0–100', format: whole, axis: whole, zero: true, maximum: 100 },
];
const healthMetrics = {
  steps: ['Steps', 'steps', whole], sleepSeconds: ['Sleep', '', duration], heartRate: ['Heart rate', 'bpm', whole],
  restingHeartRate: ['Resting heart rate', 'bpm', whole], hrvSdnn: ['HRV · SDNN', 'ms', whole],
  weightKg: ['Weight', 'kg', decimal], systolic: ['Blood pressure · systolic', 'mmHg', whole],
  diastolic: ['Blood pressure · diastolic', 'mmHg', whole], glucoseMgDl: ['Blood glucose', 'mg/dL', whole],
  spo2: ['Blood oxygen', '%', decimal], temperatureC: ['Body temperature', '°C', decimal],
  activeCalories: ['Active energy', 'kcal', whole], exerciseMinutes: ['Exercise', 'min', whole],
  bodyFatPct: ['Body fat', '%', decimal], bmi: ['BMI', '', decimal], leanMassKg: ['Lean body mass', 'kg', decimal],
};
function decimal(value) { return number(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—'; }

let data = { connected: false, lastSync: null, days: [], activities: [], healthRecords: [], sources: [], errors: [] };
let range = 28;
let page = 'overview';
let workoutSource = 'Garmin Connect';
let selectedMetric = metrics[0];
let loaded = false;
let syncing = false;
let pollTimer;
let previousSources = '';
let bootEpoch = -1;
const canManage = () => !window.LiveStatAPI?.session.hosted || window.LiveStatAPI.isOwner();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function svgElement(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
}
function latestDate() {
  const dates = [...data.days, ...data.activities, ...data.healthRecords].map((item) => dateKey(item.date)).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
  return dates.sort().pop() || data.today || new Date().toLocaleDateString('en-CA');
}
function windowDates() {
  const end = latestDate();
  const startDate = parseDate(end);
  startDate.setDate(startDate.getDate() - range + 1);
  const start = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
  return { start, end };
}
function inWindow(item) {
  const { start, end } = windowDates();
  const date = dateKey(item.date);
  return date >= start && date <= end;
}
function currentDays() { return data.days.filter(inWindow).sort((a, b) => a.date.localeCompare(b.date)); }
function currentActivities() { return data.activities.filter(inWindow).filter((activity) => !workoutSource || (activity.source || 'Garmin Connect') === workoutSource).sort((a, b) => (b.date || '').localeCompare(a.date || '')); }
function latestReading(days, key) { return days.slice().reverse().find((day) => metricValue(day, key) !== null); }
function hasData() {
  return data.days.some((day) => metrics.some((metric) => metricValue(day, metric.key) !== null)) || data.activities.length > 0 || data.healthRecords.length > 0;
}
function showError(message) {
  $('error-message').textContent = message;
  $('error-message').hidden = !message;
}
function chartPoints(days, key, width, height, padding = 3) {
  const values = metricValues(days, key);
  if (!values.length) return [];
  const min = Math.min(...values), max = Math.max(...values);
  const spread = max - min || Math.max(max * 0.1, 1);
  return days.map((day, index) => {
    const value = metricValue(day, key);
    return { x: padding + index / Math.max(days.length - 1, 1) * (width - padding * 2), y: value === null ? null : padding + (max + spread * .15 - value) / (spread * 1.3) * (height - padding * 2), value };
  });
}
function sparkline(days, key, active) {
  const svg = svgElement('svg', { viewBox: '0 0 120 28', preserveAspectRatio: 'none', 'aria-hidden': 'true', class: 'sparkline' });
  let segment = [];
  const flush = () => {
    if (segment.length) svg.append(svgElement('polyline', { points: segment.join(' '), fill: 'none', stroke: active ? 'var(--chart-series)' : 'var(--chart-secondary)', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
    segment = [];
  };
  chartPoints(days, key, 120, 28).forEach((point) => { if (number(point.value)) segment.push(`${point.x},${point.y}`); else flush(); });
  flush();
  return svg;
}
function renderMetrics(days) {
  const fragment = document.createDocumentFragment();
  metrics.forEach((metric) => {
    const reading = latestReading(days, metric.key);
    const card = element('button', 'metric-card' + (selectedMetric.key === metric.key ? ' selected' : ''));
    card.type = 'button';
    card.setAttribute('aria-pressed', String(selectedMetric.key === metric.key));
    card.setAttribute('aria-label', `View ${metric.label} trend`);
    card.append(element('span', 'metric-label', metric.label));
    const value = element('span', 'metric-value', metric.format(metricValue(reading, metric.key)));
    if (metric.unit && reading) value.append(element('span', 'metric-unit', metric.unit));
    card.append(value);
    let detail = reading ? shortDate(reading.date) : 'No reading in this window';
    if (metric.key === 'sleepSeconds' && number(reading?.sleepScore)) detail += ` · score ${reading.sleepScore}`;
    if (metric.key === 'bodyBatteryHigh' && metricValue(reading, 'bodyBatteryLow') !== null) detail += ` · low ${reading.bodyBatteryLow}`;
    card.append(element('span', 'metric-detail', detail), sparkline(days, metric.key, selectedMetric.key === metric.key));
    card.addEventListener('click', () => { selectedMetric = metric; renderMetrics(days); renderTrend(days); });
    fragment.append(card);
  });
  $('metric-grid').replaceChildren(fragment);
  $('snapshot-date').textContent = 'Latest readings · Garmin Connect';
}
function renderTrend(days) {
  const metric = selectedMetric;
  const values = metricValues(days, metric.key);
  $('trend-title').textContent = metric.title;
  $('chart-unit').textContent = metric.chartUnit;
  $('trend-average').textContent = metric.format(mean(values)) + (metric.unit && values.length ? ' ' + metric.unit : '');
  $('trend-coverage').textContent = values.length ? ` · ${values.length} ${values.length === 1 ? 'day' : 'days'}` : '';
  $('trend-legend').textContent = metric.label;
  const { start, end } = windowDates();
  $('trend-range').textContent = `${shortDate(start)} – ${shortDate(end)}`;
  $('data-value-heading').textContent = metric.label + (metric.unit ? ` (${metric.unit})` : '');
  const table = document.createDocumentFragment();
  days.slice().reverse().forEach((day) => {
    const row = element('tr');
    row.append(element('td', '', longDate(day.date)), element('td', '', metric.format(metricValue(day, metric.key))));
    table.append(row);
  });
  $('chart-data-body').replaceChildren(table);
  if (!values.length) {
    $('trend-chart').replaceChildren(element('div', 'chart-empty', 'No readings for this metric in this window.'));
    return;
  }
  const width = 680, height = 210, left = 38, right = 12, top = 16, bottom = 28;
  let min = number(metric.minimum) ? metric.minimum : metric.zero ? 0 : Math.min(...values);
  let max = metric.maximum || Math.max(...values);
  const spread = max - min || Math.max(max * .12, 1);
  if (!metric.zero && !number(metric.minimum)) min = Math.max(0, min - spread * .2);
  if (!metric.maximum) max += spread * .15;
  if (max <= min) max = min + 1;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `${metric.title}, ${shortDate(start)} to ${shortDate(end)}. ${values.length} days with readings. Daily values are available below the chart.` });
  const title = svgElement('title'); title.textContent = metric.title; svg.append(title);
  for (let i = 0; i < 4; i++) {
    const y = top + i / 3 * plotHeight;
    svg.append(svgElement('line', { x1: left, y1: y, x2: width - right, y2: y, stroke: 'var(--chart-grid)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
    const text = svgElement('text', { x: left - 9, y: y + 3, 'text-anchor': 'end', fill: 'var(--chart-label)', 'font-size': 10, 'font-family': 'system-ui, sans-serif' });
    text.textContent = metric.axis(max - i / 3 * (max - min)); svg.append(text);
  }
  const fullRange = Math.max(1, Math.round((parseDate(end) - parseDate(start)) / 86400000));
  const points = days.map((day) => {
    const value = metricValue(day, metric.key);
    return { date: day.date, value, x: left + ((parseDate(day.date) - parseDate(start)) / 86400000) / fullRange * plotWidth, y: value === null ? null : top + (max - value) / (max - min) * plotHeight };
  });
  let segment = [];
  const flush = () => {
    if (!segment.length) return;
    const path = segment.map((p) => `${p.x},${p.y}`).join(' ');
    if (segment.length > 1) {
      svg.append(svgElement('polygon', { points: `${segment[0].x},${top + plotHeight} ${path} ${segment[segment.length - 1].x},${top + plotHeight}`, fill: 'var(--soft-blue)' }));
      svg.append(svgElement('polyline', { points: path, stroke: 'var(--chart-series)', 'stroke-width': 2.4, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
    }
    segment.forEach((point) => {
      const dot = svgElement('circle', { cx: point.x, cy: point.y, r: range > 28 ? 2 : 3.2, fill: 'var(--chart-series)', stroke: 'var(--surface)', 'stroke-width': 1.4, 'vector-effect': 'non-scaling-stroke' });
      const dotTitle = svgElement('title'); dotTitle.textContent = `${longDate(point.date)}: ${metric.format(point.value)} ${metric.unit}`; dot.append(dotTitle); svg.append(dot);
    });
    segment = [];
  };
  points.forEach((point, index) => {
    if (!number(point.value)) { flush(); return; }
    if (index && parseDate(point.date) - parseDate(points[index - 1].date) > 86400000 * 1.5) flush();
    segment.push(point);
  }); flush();
  const mid = parseDate(start); mid.setDate(mid.getDate() + Math.floor(fullRange / 2));
  const midString = `${mid.getFullYear()}-${String(mid.getMonth() + 1).padStart(2, '0')}-${String(mid.getDate()).padStart(2, '0')}`;
  [[start, left, 'start'], [midString, left + plotWidth / 2, 'middle'], [end, width - right, 'end']].forEach(([date, x, anchor]) => {
    const text = svgElement('text', { x, y: height - 5, 'text-anchor': anchor, fill: 'var(--chart-label)', 'font-size': 10, 'font-family': 'system-ui, sans-serif' });
    text.textContent = shortDate(date); svg.append(text);
  });
  $('trend-chart').replaceChildren(svg);
}
function renderWindow(days, activities) {
  const { start, end } = windowDates();
  $('window-range').textContent = `${shortDate(start)} – ${shortDate(end)}`;
  const items = [
    ['Average sleep', duration(mean(metricValues(days, 'sleepSeconds')))],
    ['Daily steps', whole(mean(metricValues(days, 'steps')))],
    ['Workouts', whole(activities.length)],
    ['Distance covered', distance(sumValues(activities, 'distanceMeters'))],
  ];
  const fragment = document.createDocumentFragment();
  items.forEach(([label, value]) => { const row = element('div', 'window-stat'); row.append(element('dt', '', label), element('dd', '', value)); fragment.append(row); });
  $('window-stats').replaceChildren(fragment);
}
function activityIcon() {
  const wrapper = element('span', 'activity-glyph');
  wrapper.setAttribute('aria-hidden', 'true');
  const svg = svgElement('svg', { viewBox: '0 0 24 24' });
  svg.append(svgElement('path', { d: 'M3 14h4l3-7 4 11 3-5h4' })); wrapper.append(svg); return wrapper;
}
function renderWorkoutRows(target, activities, includeCalories) {
  const fragment = document.createDocumentFragment();
  activities.forEach((activity) => {
    const row = element('tr');
    const nameCell = element('td');
    const content = element('div', 'activity-cell');
    const text = element('div');
    text.append(element('strong', '', activity.name || 'Untitled activity'), element('small', '', `${String(activity.type || 'Workout').replace(/_/g, ' ')} · ${activity.source || 'Garmin Connect'}`));
    content.append(activityIcon(), text); nameCell.append(content);
    row.append(nameCell, element('td', '', shortDate(activity.date)), element('td', '', distance(activity.distanceMeters)), element('td', '', duration(activity.durationSeconds)), element('td', '', number(activity.averageHR) ? `${whole(activity.averageHR)} bpm` : '—'));
    if (includeCalories) row.append(element('td', '', number(activity.calories) ? `${whole(activity.calories)} kcal` : '—'));
    fragment.append(row);
  });
  $(target).replaceChildren(fragment);
}
function renderWorkouts(activities) {
  renderWorkoutRows('recent-body', activities.slice(0, 4), false);
  renderWorkoutRows('workouts-body', activities, true);
  $('recent-empty').hidden = activities.length > 0;
  $('workouts-empty').hidden = activities.length > 0;
  $('workout-count').textContent = `${activities.length} ${activities.length === 1 ? 'workout' : 'workouts'}`;
  $('workouts-source-note').textContent = workoutSource ? `Showing ${workoutSource} recordings. Imported recordings stay separate from Garmin.` : 'Totals include all recordings. A hike recorded in Garmin and AllTrails will be counted twice; choose one source to avoid duplicates.';
  $('recent-title').textContent = workoutSource ? `Recent workouts · ${workoutSource === 'Garmin Connect' ? 'Garmin' : workoutSource}` : 'Recent workouts · all sources';
  const totals = [['Workouts', whole(activities.length)], ['Total distance', distance(sumValues(activities, 'distanceMeters'))], ['Recorded time', duration(sumValues(activities, 'durationSeconds'))], ['Activity calories', whole(sumValues(activities, 'calories'))]];
  const fragment = document.createDocumentFragment();
  totals.forEach(([label, value]) => { const box = element('div', 'summary-item'); box.append(element('span', 'metric-label', label), element('span', 'metric-value', value)); fragment.append(box); });
  $('workout-summary').replaceChildren(fragment);
}
function latestHealthRecords(filterSource = '') {
  const latest = new Map();
  data.healthRecords.filter(inWindow).filter((record) => number(record.value) && (!filterSource || String(record.source || 'Apple Health') === filterSource)).forEach((record) => {
    const key = `${record.metric}\u0000${record.source || 'Apple Health'}`;
    if (!latest.has(key) || record.date >= latest.get(key).date) latest.set(key, record);
  });
  return [...latest.values()].sort((a, b) => a.metric.localeCompare(b.metric) || String(a.source).localeCompare(String(b.source)));
}
function healthInfo(record) {
  return healthMetrics[record.metric] || [record.metric, record.unit || '', decimal];
}
function renderHealth() {
  const sourceNames = [...new Set(data.healthRecords.map((record) => String(record.source || 'Apple Health')))].sort();
  const serialized = JSON.stringify(sourceNames);
  if (serialized !== previousSources) {
    const previous = $('health-source-filter').value;
    $('health-source-filter').replaceChildren(element('option', '', 'All sources'));
    $('health-source-filter').firstChild.value = '';
    sourceNames.forEach((name) => { const option = element('option', '', name); option.value = name; $('health-source-filter').append(option); });
    if (sourceNames.includes(previous)) $('health-source-filter').value = previous;
    previousSources = serialized;
  }
  const rows = latestHealthRecords($('health-source-filter').value);
  const table = document.createDocumentFragment();
  rows.forEach((record) => {
    const [label, unit, format] = healthInfo(record);
    const row = element('tr');
    row.append(element('td', '', label), element('td', 'source-name', record.source || 'Apple Health'), element('td', '', shortDate(record.date)), element('td', '', `${format(record.value)}${unit ? ' ' + unit : ''}`)); table.append(row);
  });
  $('health-records-body').replaceChildren(table);
  $('health-records-empty').hidden = rows.length > 0;
  const overview = document.createDocumentFragment();
  const priorities = ['weightKg', 'bodyFatPct', 'bmi', 'leanMassKg', 'systolic', 'diastolic', 'glucoseMgDl', 'spo2', 'temperatureC', 'hrvSdnn'];
  latestHealthRecords().sort((a, b) => {
    const ai = priorities.indexOf(a.metric), bi = priorities.indexOf(b.metric);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  }).slice(0, 8).forEach((record) => {
    const [label, unit, format] = healthInfo(record);
    const box = element('div', 'additional-metric');
    box.append(element('span', 'metric-label', label));
    const value = element('strong', 'metric-value', format(record.value));
    if (unit) value.append(element('span', 'metric-unit', unit));
    box.append(value, element('span', 'metric-detail', `${record.source || 'Apple Health'} · ${shortDate(record.date)}`)); overview.append(box);
  });
  $('additional-metrics').replaceChildren(overview);
  $('additional-empty').hidden = $('additional-metrics').children.length > 0;
  const sharedViewer = window.LiveStatAPI?.session.hosted && !window.LiveStatAPI.isOwner();
  $('additional-empty').textContent = sharedViewer ? 'No additional health readings have been shared in this date range.' : 'Import Apple Health data to see your Wyze scale readings and other health metrics here.';
  $('health-records-empty').textContent = sharedViewer ? 'No health readings have been shared in this date range.' : 'No imported readings in this date range.';
  if ($('manage-sources').firstChild?.nodeType === Node.TEXT_NODE) $('manage-sources').firstChild.nodeValue = sharedViewer ? 'View sources ' : 'Manage sources ';
  $('garmin-source-status').textContent = data.connected ? 'Connected' : 'Not connected';
  $('garmin-source-status').classList.toggle('neutral', !data.connected);
  $('apple-source-status').textContent = data.healthRecords.length ? `${data.healthRecords.length.toLocaleString()} imported readings` : 'Export import';
}
function render() {
  if (!canManage() && page === 'coach') page = 'overview';
  const available = hasData();
  $('loading-state').hidden = loaded;
  $('empty-state').hidden = !loaded || available || page === 'sources' || page === 'coach';
  $('overview-page').hidden = !loaded || !available || page !== 'overview';
  $('workouts-page').hidden = !loaded || !available || page !== 'workouts';
  $('sources-page').hidden = !loaded || page !== 'sources';
  $('coach-page').hidden = !loaded || page !== 'coach';
  document.querySelector('.range-control').hidden = page === 'coach';
  const titles = { overview: ['Overview', 'A clearer picture of your days, nights, and everything in between.'], coach: ['Your coaching', 'Evidence-based guidance, with your goals and your actual data in view.'], workouts: ['Workouts', 'Every effort, in one place. Explore your recent activity.'], sources: ['Your sources', 'Bring your watch, scale, and other health readings together.'] };
  $('page-title').textContent = titles[page][0];
  $('page-description').textContent = titles[page][1];
  $('heading-date').textContent = page === 'coach' ? `YOUR HEALTH, TOGETHER${document.documentElement.dataset.coachAsOf ? ' · THROUGH ' + shortDate(document.documentElement.dataset.coachAsOf).toUpperCase() : ' · COMPLETE DAYS'}` : available ? `YOUR HEALTH, TOGETHER · THROUGH ${shortDate(latestDate()).toUpperCase()}` : 'YOUR HEALTH, TOGETHER';
  document.querySelectorAll('[data-page]').forEach((button) => { const active = button.dataset.page === page; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  document.querySelectorAll('[data-range]').forEach((button) => { const active = Number(button.dataset.range) === range; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active)); });
  $('device-name').textContent = data.device || 'Forerunner 255 Music';
  const days = currentDays(), activities = currentActivities();
  renderMetrics(days); renderTrend(days); renderWindow(days, activities); renderWorkouts(activities); renderHealth();
  if (!syncing) showError((data.errors || []).filter(Boolean).join(' · '));
}
function setPage(next) { page = next === 'coach' && !canManage() ? 'overview' : next; render(); document.dispatchEvent(new CustomEvent('daymark:page-changed', { detail: { page } })); }
function applyStatus(status) {
  syncing = Boolean(status.syncing);
  const connected = status.connected === undefined ? data.connected : Boolean(status.connected);
  $('connection-label').textContent = connected ? 'Connected to Garmin' : 'Garmin not connected';
  $('connection-label').classList.toggle('connected', connected);
  document.querySelector('.status-dot').classList.toggle('connected', connected);
  $('sync-button').disabled = syncing;
  $('empty-sync').disabled = syncing;
  $('sync-button').classList.toggle('syncing', syncing);
  $('sync-button').querySelector('span').textContent = syncing ? 'Syncing…' : 'Sync Garmin';
  $('notice').hidden = !syncing;
  if (syncing) {
    $('notice').textContent = status.progress || 'Syncing your Garmin history. You can keep browsing while it updates.';
    $('sync-caption').textContent = 'Bringing your data up to date';
  } else {
    const lastSync = status.lastSync || data.lastSync;
    const timestamp = lastSync ? new Date(lastSync) : null;
    $('sync-caption').textContent = timestamp && !Number.isNaN(timestamp.getTime()) ? `Synced ${timestamp.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${timestamp.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : 'Ready for your first sync';
  }
  if (status.error) showError(status.error);
}
async function api(path, options) {
  const response = await (window.LiveStatAPI ? window.LiveStatAPI.fetch(path, { cache: 'no-store', ...options }) : fetch(path, { cache: 'no-store', ...options }));
  let body;
  try { body = await response.json(); } catch (_) { throw new Error('The dashboard could not read the server response.'); }
  if (!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status}).`);
  return body;
}
async function loadData() {
  const requestEpoch = window.LiveStatAPI?.epoch;
  const result = await api('/api/dashboard');
  if (window.LiveStatAPI && (requestEpoch !== window.LiveStatAPI.epoch || !window.LiveStatAPI.session.authenticated)) return;
  data = { ...data, ...result, days: Array.isArray(result.days) ? result.days : [], activities: Array.isArray(result.activities) ? result.activities : [], healthRecords: Array.isArray(result.healthRecords) ? result.healthRecords : [], sources: Array.isArray(result.sources) ? result.sources : [] };
  loaded = true; render();
  document.dispatchEvent(new CustomEvent('daymark:data-updated'));
}
async function pollStatus() {
  clearTimeout(pollTimer);
  try {
    const wasSyncing = syncing;
    const requestEpoch = window.LiveStatAPI?.epoch;
    const status = await api('/api/status');
    if (window.LiveStatAPI && (requestEpoch !== window.LiveStatAPI.epoch || !window.LiveStatAPI.session.authenticated)) return;
    applyStatus(status);
    if (syncing) pollTimer = setTimeout(pollStatus, 1600);
    else if (wasSyncing) { await loadData(); applyStatus(status); }
  } catch (error) {
    syncing = false;
    applyStatus({ syncing: false, connected: data.connected });
    showError(error.message + (window.LiveStatAPI?.session.hosted ? ' The hosted data service may be unavailable.' : ' Check that the local dashboard server is running.'));
  }
}
async function startSync() {
  if (syncing || !canManage()) return;
  showError('');
  applyStatus({ syncing: true, connected: data.connected, progress: 'Connecting to Garmin…' });
  try {
    const result = await api('/api/sync', { method: 'POST' });
    applyStatus({ ...result, syncing: result.syncing !== false });
    await pollStatus();
  } catch (error) {
    applyStatus({ syncing: false, connected: data.connected });
    showError(error.message);
  }
}
async function importFile(kind, input) {
  if (!canManage()) return;
  const file = input.files?.[0];
  if (!file) return;
  const status = $(`${kind}-import-status`);
  const limit = kind === 'alltrails' ? 16 : 150;
  if (file.size > limit * 1024 * 1024) { status.textContent = `Choose a file smaller than ${limit} MB.`; input.value = ''; return; }
  input.disabled = true;
  input.closest('label').classList.add('importing');
  status.textContent = `Importing ${file.name}…`;
  try {
    const path = kind === 'apple' ? '/api/import/apple-health' : kind === 'alltrails' ? '/api/import/alltrails' : '/api/import/csv';
    const result = await api(path, { method: 'POST', headers: { 'Content-Type': kind === 'csv' ? 'text/csv' : file.name.toLowerCase().endsWith('.zip') ? 'application/zip' : 'application/xml' }, body: file });
    status.textContent = kind === 'alltrails' ? `Imported ${whole(result.activitiesImported)} recorded activities. View them under Workouts → AllTrails import.` : `Imported ${whole(result.recordsImported)} readings across ${whole(result.daysImported)} days.`;
    await loadData();
  } catch (error) { status.textContent = 'Import failed. ' + error.message; }
  finally { input.disabled = false; input.value = ''; input.closest('label').classList.remove('importing'); }
}

document.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => setPage(button.dataset.page)));
document.querySelectorAll('[data-range]').forEach((button) => button.addEventListener('click', () => { range = Number(button.dataset.range); render(); }));
$('sync-button').addEventListener('click', startSync);
$('empty-sync').addEventListener('click', startSync);
$('view-workouts').addEventListener('click', () => setPage('workouts'));
$('manage-sources').addEventListener('click', () => setPage('sources'));
$('review-coaching').addEventListener('click', () => setPage('coach'));
$('health-source-filter').addEventListener('change', renderHealth);
$('workout-source-filter').addEventListener('change', (event) => { workoutSource = event.target.value; render(); });
$('apple-file').addEventListener('change', (event) => importFile('apple', event.target));
$('csv-file').addEventListener('change', (event) => importFile('csv', event.target));
$('alltrails-file').addEventListener('change', (event) => importFile('alltrails', event.target));
async function bootDashboard() {
  if (window.LiveStatAPI) await window.LiveStatAPI.ready;
  const epoch = window.LiveStatAPI?.epoch ?? 0;
  if (bootEpoch === epoch) return;
  bootEpoch = epoch;
  try { await loadData(); await pollStatus(); }
  catch (error) { loaded = true; render(); showError(error.message + (window.LiveStatAPI?.session.hosted ? ' The hosted data service may be unavailable.' : ' Check that the local dashboard server is running.')); }
}
document.addEventListener('livestat:session', (event) => {
  clearTimeout(pollTimer);
  if (!event.detail.authenticated) {
    data = { connected: false, lastSync: null, days: [], activities: [], healthRecords: [], sources: [], errors: [] };
    loaded = false; syncing = false; bootEpoch = -1; page = 'overview'; render();
  } else { render(); bootDashboard(); }
});
bootDashboard();
