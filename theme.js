'use strict';

// Resolve appearance before the stylesheet paints. Only an appearance preference
// is stored; health data and credentials are not read by this module.
(function (root) {
  const document = root.document;
  const storageKey = 'livestat-appearance';
  const valid = (value) => ['system', 'light', 'dark'].includes(value);
  let preference = 'system';
  let media = null;
  try {
    const saved = root.localStorage.getItem(storageKey);
    if (valid(saved)) preference = saved;
  } catch (_) { /* Appearance still works when browser storage is unavailable. */ }
  try { media = root.matchMedia('(prefers-color-scheme: dark)'); } catch (_) { /* Default to light. */ }
  function apply() {
    const resolved = preference === 'system' ? media && media.matches ? 'dark' : 'light' : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    const picker = document.getElementById('appearance-select');
    if (picker) picker.value = preference;
    const status = document.getElementById('appearance-status');
    if (status) status.textContent = `Appearance: ${preference === 'system' ? 'System (' + resolved + ')' : resolved}.`;
  }
  function choose(value) {
    if (!valid(value)) return;
    preference = value;
    try { root.localStorage.setItem(storageKey, value); } catch (_) { /* This tab still updates. */ }
    apply();
  }
  apply();
  if (media && typeof media.addEventListener === 'function') media.addEventListener('change', () => { if (preference === 'system') apply(); });
  else if (media && typeof media.addListener === 'function') media.addListener(() => { if (preference === 'system') apply(); });
  root.addEventListener('storage', (event) => {
    if (event.key !== storageKey) return;
    preference = valid(event.newValue) ? event.newValue : 'system';
    apply();
  });
  function bindPicker() {
    const picker = document.getElementById('appearance-select');
    if (picker) picker.addEventListener('change', () => choose(picker.value));
    apply();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindPicker, { once: true });
  else bindPicker();
})(window);
