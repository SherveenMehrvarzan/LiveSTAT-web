'use strict';

(function () {
  const get = (id) => document.getElementById('coach-' + id);
  if (!get('page')) return;
  let review = null;
  let loading = false;
  let queuedRefresh = false;
  let profileDirty = false;
  let checkinDirty = false;
  let profileVersion = 0;
  let checkinVersion = 0;
  let savingProfile = false;
  let savingCheckin = false;
  let refreshTimer;
  let revision = 0;
  const asArray = (value) => Array.isArray(value) ? value : [];
  const text = (value) => typeof value === 'string' ? value : '';
  const number = (value) => typeof value === 'number' && Number.isFinite(value);
  const date = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return 'Not available';
    const parsed = new Date(value.slice(0, 10) + 'T12:00:00');
    return Number.isNaN(parsed.getTime()) ? 'Not available' : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };
  function node(tag, content, className) {
    const element = document.createElement(tag);
    if (content !== undefined) element.textContent = content;
    if (className) element.className = className;
    return element;
  }
  function safeUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch (_) { return null; }
  }
  function evidenceByIds(ids) {
    const wanted = new Set(asArray(ids));
    return asArray(review?.evidence).filter((source) => wanted.has(source.id) && safeUrl(source.url));
  }
  function sourceLink(source) {
    const link = node('a', text(source.title) || 'Read the evidence');
    link.href = safeUrl(source.url);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }
  function evidenceLinks(ids) {
    const container = node('div', undefined, 'coach-inline-evidence');
    evidenceByIds(ids).forEach((source) => container.append(sourceLink(source)));
    return container;
  }
  function labelledParagraph(label, content) {
    if (!text(content)) return null;
    const section = node('div', undefined, 'coach-card-paragraph');
    section.append(node('span', label, 'coach-card-label'), node('p', content));
    return section;
  }
  function renderCard(card) {
    const article = node('article', undefined, 'coach-journal-card');
    const heading = node('div', undefined, 'coach-card-heading');
    heading.append(node('h3', text(card.title) || 'Recorded observation'));
    const confidence = { limited: 'Limited data', moderate: 'Some coverage', 'well-covered': 'Well covered' }[card.confidence];
    if (confidence) heading.append(node('span', confidence, 'coach-confidence'));
    article.append(heading);
    [['Observed', card.observation], ['What it means', card.meaning], ['Try next', card.action]].forEach(([label, value]) => {
      const paragraph = labelledParagraph(label, value);
      if (paragraph) article.append(paragraph);
    });
    const evidence = evidenceLinks(card.evidenceIds);
    if (evidence.children.length) article.append(evidence);
    const context = [text(card.source), text(card.coverage)].filter(Boolean);
    if (context.length) article.append(node('p', context.join(' · '), 'coach-card-context'));
    return article;
  }
  function renderCards(id, cards, emptyMessage) {
    const fragment = document.createDocumentFragment();
    asArray(cards).forEach((card) => fragment.append(renderCard(card)));
    if (!fragment.childNodes.length) fragment.append(node('p', emptyMessage, 'coach-empty-note'));
    get(id).replaceChildren(fragment);
  }
  function renderNextSteps() {
    const fragment = document.createDocumentFragment();
    asArray(review.nextSteps).slice(0, 3).forEach((action, index) => {
      const item = node('li', undefined, 'coach-next-step');
      item.append(node('span', String(index + 1).padStart(2, '0'), 'coach-step-number'));
      const content = node('div');
      content.append(node('h3', text(action.title) || 'Your next action'));
      if (text(action.detail)) content.append(node('p', action.detail));
      const evidence = evidenceLinks(action.evidenceIds);
      if (evidence.children.length) content.append(evidence);
      item.append(content); fragment.append(item);
    });
    get('next-steps').replaceChildren(fragment);
    get('next-empty').hidden = get('next-steps').children.length > 0;
  }
  function renderCoverage() {
    const fragment = document.createDocumentFragment();
    asArray(review.coverage).forEach((coverage) => {
      const item = node('div', undefined, 'coach-coverage-row');
      const title = node('div');
      title.append(node('strong', text(coverage.label) || text(coverage.metric) || 'Recorded metric'), node('span', text(coverage.source) || 'Source not available'));
      const detail = node('div', undefined, 'coach-coverage-detail');
      const counts = number(coverage.observedDays) && number(coverage.windowDays) ? `${coverage.observedDays} of ${coverage.windowDays} days` : 'Coverage not available';
      detail.append(node('strong', counts), node('span', coverage.latestDate ? `Latest ${date(coverage.latestDate)}` : 'No dated reading'));
      item.append(title, detail); fragment.append(item);
    });
    if (!fragment.childNodes.length) fragment.append(node('p', 'Coverage details are not available for this review yet.', 'coach-empty-note'));
    get('coverage').replaceChildren(fragment);
    renderCards('data-gaps', review.dataGaps, 'No additional data gaps were returned for this review.');
    const gapCount = asArray(review.dataGaps).length;
    get('gap-summary').textContent = `Coverage details and limitations${gapCount ? ` · ${gapCount} ${gapCount === 1 ? 'item' : 'items'}` : ''}`;
  }
  function renderEvidence() {
    const fragment = document.createDocumentFragment();
    asArray(review.evidence).filter((source) => safeUrl(source.url)).forEach((source) => {
      const entry = node('div', undefined, 'coach-evidence-entry');
      entry.append(sourceLink(source));
      const appliesTo = Array.isArray(source.appliesTo) ? source.appliesTo.filter((value) => typeof value === 'string').join(', ') : text(source.appliesTo);
      if (appliesTo) entry.append(node('span', appliesTo));
      fragment.append(entry);
    });
    if (!fragment.childNodes.length) fragment.append(node('p', 'Evidence links are not available for this review yet.', 'coach-empty-note'));
    get('evidence').replaceChildren(fragment);
    const talkTest = evidenceLinks(['cdc_intensity']);
    get('activity-evidence').replaceChildren(talkTest);
    get('methods-note').textContent = text(review.heuristicsNote);
    get('methods-note').hidden = !text(review.heuristicsNote);
    const research = review.researchReview || {};
    const pending = research.status === 'in_progress' && !research.completedAt;
    const complete = Boolean(research.completedAt) && research.status !== 'in_progress';
    get('review-status').textContent = pending ? 'Evidence review in progress' : complete ? `Evidence reviewed ${date(research.completedAt)}` : '';
    get('review-status').hidden = !pending && !complete;
    get('research-note').textContent = pending ? 'The requested evidence review is still in progress. This coaching preview may change as that review is completed.' : complete ? `Evidence review completed ${date(research.completedAt)}.` : '';
    get('research-note').hidden = !pending && !complete;
    const principles = [
      ['Endurance', 'An activity routine is easier to sustain when it fits your current ability and includes movement you enjoy. Progression can be gradual and individual.', ['niddk_progression']],
      [review.profile?.ageGroup === 'under18' ? 'Healthy routines' : 'Body recomposition', review.profile?.ageGroup === 'under18' ? 'Activity guidance for younger people is age-specific. Fitness, strength, and recovery provide a more appropriate direction than an adult fat-loss goal.' : 'One consistent scale source and similar measuring conditions make weight readings easier to compare. Body-fat and lean-mass estimates provide context, rather than proof of tissue change.', review.profile?.ageGroup === 'under18' ? ['who_activity'] : ['wyze_measurement', 'scale_accuracy']],
      ['Muscle', review.profile?.ageGroup === 'under18' ? 'Strength-training guidance should fit your age and experience. Your check-in records training days without assigning an adult activity target.' : 'For adults, resistance training is a separate part of physical activity guidance. Your weekly check-in can track strength-training days alongside endurance activity.', review.profile?.ageGroup === 'under18' ? ['who_activity'] : ['acsm_strength', 'who_activity']],
    ];
    const principlesFragment = document.createDocumentFragment();
    principles.forEach(([title, detail, ids]) => {
      if (!evidenceByIds(ids).length) return;
      const item = node('article'); item.append(node('h3', title), node('p', detail), evidenceLinks(ids)); principlesFragment.append(item);
    });
    get('principles').replaceChildren(principlesFragment);
    get('principles-panel').hidden = !get('principles').children.length;
  }
  function fillProfile() {
    if (profileDirty) return;
    const profile = review.profile || {};
    const allowedAges = ['unknown', '18_60', '61_64', '65_plus', 'under18'];
    get('age-group').value = allowedAges.includes(profile.ageGroup) ? profile.ageGroup : 'unknown';
    get('limitations').value = text(profile.limitations);
    const options = asArray(review.bodyComposition?.weightSourceOptions);
    const autoSource = options.find((source) => source.id === review.bodyComposition?.selectedSourceId);
    const first = node('option', autoSource ? `Automatic · ${text(autoSource.name)}` : options.length ? 'Automatic · one consistent source' : 'Automatic · no weight data yet');
    first.value = '';
    const fragment = document.createDocumentFragment(); fragment.append(first);
    options.forEach((source) => {
      const option = node('option', `${text(source.name) || 'Weight source'}${number(source.days) ? ` · ${source.days} days` : ''}`);
      option.value = text(source.id); fragment.append(option);
    });
    get('scale-source').replaceChildren(fragment);
    get('scale-source').value = text(profile.scaleSourceId);
    if (get('scale-source').selectedIndex < 0) get('scale-source').value = '';
  }
  function fillCheckin() {
    if (checkinDirty) return;
    const checkin = review.checkin || {};
    [['strength-days', 'strengthDays'], ['moderate-minutes', 'moderateMinutes'], ['vigorous-minutes', 'vigorousMinutes'], ['energy', 'energy']].forEach(([id, key]) => {
      get(id).value = number(checkin[key]) ? String(checkin[key]) : '';
    });
    get('checkin-note').value = text(checkin.note);
  }
  function renderPreviousCheckin() {
    const context = review.checkinContext;
    const container = get('previous-checkin');
    const show = context && context.isCurrent === false && context.report && text(context.periodStart) && text(context.periodEnd);
    container.hidden = !show;
    if (!show) { container.replaceChildren(); return; }
    const report = context.report;
    const currentStart = new Date(review.asOf.slice(0, 10) + 'T12:00:00');
    currentStart.setDate(currentStart.getDate() - 6);
    const startKey = `${currentStart.getFullYear()}-${String(currentStart.getMonth() + 1).padStart(2, '0')}-${String(currentStart.getDate()).padStart(2, '0')}`;
    const latest = node('p', `Latest saved check-in: ${date(context.periodStart)}–${date(context.periodEnd)}.`, 'coach-previous-period');
    const explanation = node('p', `This form covers ${date(startKey)}–${date(review.asOf)}. Earlier activity totals stay attached to the week they describe.`);
    const details = node('details');
    details.append(node('summary', 'View saved answers'));
    const answers = node('dl', undefined, 'coach-previous-answers');
    [['Strength-training days', 'strengthDays'], ['Moderate activity · minutes', 'moderateMinutes'], ['Vigorous activity · minutes', 'vigorousMinutes'], ['Energy · 1–5', 'energy']].forEach(([label, key]) => {
      if (!number(report[key])) return;
      const pair = node('div'); pair.append(node('dt', label), node('dd', String(report[key]))); answers.append(pair);
    });
    if (answers.children.length) details.append(answers);
    if (text(report.note)) {
      details.append(node('span', 'Saved note', 'coach-card-label'), node('p', report.note, 'coach-previous-note'));
    }
    if (!answers.children.length && !text(report.note)) details.append(node('p', 'No answers were recorded.'));
    container.replaceChildren(latest, explanation, details);
  }
  function updatePageEyebrow() {
    if (!review) return;
    document.documentElement.dataset.coachAsOf = review.asOf;
    if (document.querySelector('[data-page="coach"][aria-current="page"]')) {
      document.getElementById('heading-date').textContent = `YOUR HEALTH, TOGETHER · THROUGH ${date(review.asOf).toUpperCase()}`;
    }
  }
  function render() {
    if (!review) return;
    get('loading').hidden = true;
    get('content').hidden = false;
    get('summary').textContent = text(review.summary);
    const under18 = review.profile?.ageGroup === 'under18';
    get('goals-eyebrow').textContent = under18 ? 'YOUR DIRECTION · FITNESS & RECOVERY' : 'YOUR DIRECTION · BODY RECOMPOSITION';
    get('goals-title').replaceChildren(node('span', under18 ? 'Build fitness.' : 'Build endurance.'), document.createElement('br'), node('span', under18 ? 'Support strength and recovery.' : 'Lose fat. Build muscle.'));
    get('profile-description').textContent = under18 ? 'Your direction is age-appropriate fitness, strength, and recovery. Add context to help the guidance fit your situation.' : 'Your direction is endurance and body recomposition: lose fat while building muscle. Add context to help the guidance fit your situation.';
    get('overview-goals').textContent = under18 ? 'Your goals: fitness, strength, and recovery.' : 'Your goals: endurance, fat loss, and muscle.';
    updatePageEyebrow();
    get('asof').textContent = `Through ${date(review.asOf)}`;
    get('checkin-window').textContent = `For the 7 complete days ending ${date(review.asOf)}.`;
    renderNextSteps();
    renderCards('strengths', review.strengths, 'More recorded data will help identify repeatable patterns to build on.');
    const hasContext = ['18_60', '61_64', '65_plus', 'under18'].includes(review.profile?.ageGroup) && Boolean(review.checkin || review.checkinContext?.report);
    renderCards('opportunities', review.opportunities, hasContext ? 'No additional change is suggested from these records. Use your next steps and review how they feel.' : 'Add your context and weekly check-in to choose a useful focus.');
    renderCards('observations', review.observations, 'More recorded days will help put changes in heart rate, HRV, and weight in context.');
    renderCoverage(); renderEvidence(); fillProfile(); fillCheckin(); renderPreviousCheckin();
  }
  function errorMessage(message) {
    get('error-text').textContent = message;
    get('error').hidden = !message;
  }
  async function request(path, options) {
    const requestEpoch = window.LiveStatAPI?.epoch;
    const response = await (window.LiveStatAPI ? window.LiveStatAPI.fetch(path, { cache: 'no-store', ...options }) : fetch(path, { cache: 'no-store', ...options }));
    if (window.LiveStatAPI && (requestEpoch !== window.LiveStatAPI.epoch || !window.LiveStatAPI.isOwner())) throw new Error('Owner access changed. Sign in as the owner to continue.');
    let result;
    try { result = await response.json(); }
    catch (_) { throw new Error('The coaching response could not be read. Please try again.'); }
    if (window.LiveStatAPI && (requestEpoch !== window.LiveStatAPI.epoch || !window.LiveStatAPI.isOwner())) throw new Error('Owner access changed. Sign in as the owner to continue.');
    if (!response.ok) throw new Error(text(result.error) || text(result.message) || `Coaching could not load (${response.status}).`);
    if (!result || typeof result.asOf !== 'string') throw new Error('The coaching review is not ready yet. Please try again shortly.');
    return result;
  }
  async function refresh() {
    if (window.LiveStatAPI && !window.LiveStatAPI.isOwner()) return;
    if (loading) { queuedRefresh = true; return; }
    loading = true;
    const requestRevision = revision;
    if (!review) get('loading').hidden = false;
    try {
      const result = await request('/api/coach');
      if (window.LiveStatAPI && !window.LiveStatAPI.isOwner()) return;
      if (requestRevision !== revision) { queuedRefresh = true; return; }
      review = result; errorMessage(''); render();
    } catch (error) { get('loading').hidden = true; errorMessage(error.message); }
    finally {
      loading = false;
      if (queuedRefresh) { queuedRefresh = false; refresh(); }
    }
  }
  function optionalNumber(id) { return get(id).value.trim() === '' ? null : Number(get(id).value); }
  async function saveProfile(event) {
    event.preventDefault();
    if (window.LiveStatAPI && !window.LiveStatAPI.isOwner()) return;
    if (savingProfile || !get('profile-form').reportValidity()) return;
    const version = profileVersion;
    savingProfile = true;
    revision += 1;
    get('save-profile').disabled = true;
    get('profile-status').textContent = 'Saving context…';
    try {
      const result = await request('/api/coach/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ageGroup: get('age-group').value, limitations: get('limitations').value, scaleSourceId: get('scale-source').value }) });
      revision += 1;
      if (version === profileVersion) profileDirty = false;
      review = result; errorMessage(''); render();
      get('profile-status').textContent = profileDirty ? 'Saved. You have additional unsaved edits.' : 'Context saved. Coaching updated.';
    } catch (error) { get('profile-status').textContent = error.message; }
    finally { savingProfile = false; get('save-profile').disabled = false; }
  }
  async function saveCheckin(event) {
    event.preventDefault();
    if (window.LiveStatAPI && !window.LiveStatAPI.isOwner()) return;
    if (!review || savingCheckin || !get('checkin-form').reportValidity()) return;
    const version = checkinVersion;
    savingCheckin = true;
    revision += 1;
    get('save-checkin').disabled = true;
    get('checkin-status').textContent = 'Saving your check-in…';
    const checkin = { weekEnding: review.asOf, strengthDays: optionalNumber('strength-days'), moderateMinutes: optionalNumber('moderate-minutes'), vigorousMinutes: optionalNumber('vigorous-minutes'), energy: optionalNumber('energy'), note: get('checkin-note').value };
    try {
      const result = await request('/api/coach/check-in', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(checkin) });
      revision += 1;
      if (version === checkinVersion) checkinDirty = false;
      review = result; errorMessage(''); render();
      get('checkin-status').textContent = checkinDirty ? 'Saved. You have additional unsaved edits.' : 'Check-in saved. Coaching updated.';
    } catch (error) { get('checkin-status').textContent = error.message; }
    finally { savingCheckin = false; get('save-checkin').disabled = false; }
  }
  ['input', 'change'].forEach((eventName) => {
    get('profile-form').addEventListener(eventName, () => { profileDirty = true; profileVersion += 1; get('profile-status').textContent = 'Unsaved changes'; });
    get('checkin-form').addEventListener(eventName, () => { checkinDirty = true; checkinVersion += 1; get('checkin-status').textContent = 'Unsaved changes'; });
  });
  get('profile-form').addEventListener('submit', saveProfile);
  get('checkin-form').addEventListener('submit', saveCheckin);
  get('retry').addEventListener('click', refresh);
  document.addEventListener('daymark:data-updated', () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150); });
  document.addEventListener('daymark:page-changed', (event) => { if (event.detail?.page === 'coach') { updatePageEyebrow(); if (!review) refresh(); } });
  document.addEventListener('livestat:session', (event) => {
    if (event.detail.authenticated && event.detail.role === 'owner') refresh();
    else {
      revision += 1; review = null; profileDirty = false; checkinDirty = false;
      get('content').hidden = true;
      get('profile-form').reset(); get('checkin-form').reset();
      ['strengths', 'opportunities', 'observations', 'data-gaps', 'next-steps', 'previous-checkin'].forEach((id) => get(id).replaceChildren());
      get('summary').textContent = ''; get('profile-status').textContent = ''; get('checkin-status').textContent = '';
    }
  });
  (async () => { if (window.LiveStatAPI) await window.LiveStatAPI.ready; refresh(); })();
})();
