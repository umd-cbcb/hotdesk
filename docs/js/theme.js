/* Three-state theme control: system (default), light, dark.
   The <head> script has already applied the stored choice; this only wires the
   buttons and keeps them labelled. */
(function (global) {
  'use strict';

  var KEY = 'cbcb-hotdesk-theme';
  var ORDER = ['system', 'light', 'dark'];

  var ICONS = {
    // Half-filled circle: follows the device.
    system: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="8.4" stroke="currentColor" stroke-width="1.8"/>' +
      '<path d="M12 3.6a8.4 8.4 0 0 1 0 16.8z" fill="currentColor"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="4.4" stroke="currentColor" stroke-width="1.8"/>' +
      '<g stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
      '<path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2"/>' +
      '<path d="M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"/></g></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M20 13.4A8.2 8.2 0 1 1 10.6 4a6.6 6.6 0 0 0 9.4 9.4z" ' +
      'fill="currentColor"/></svg>',
  };

  var LABEL = {
    system: 'Theme: follows your device',
    light: 'Theme: light',
    dark: 'Theme: dark',
  };

  function current() {
    try {
      var saved = localStorage.getItem(KEY);
      return ORDER.indexOf(saved) > 0 ? saved : 'system';
    } catch (e) { return 'system'; }
  }

  function apply(mode) {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    try {
      if (mode === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, mode);
    } catch (e) { /* private browsing: the choice just will not persist */ }
    paint();
  }

  var buttons = [];

  function paint() {
    var mode = current();
    var next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
    buttons.forEach(function (btn) {
      btn.innerHTML = ICONS[mode];
      btn.setAttribute('aria-label', LABEL[mode] + '. Activate for ' + next + '.');
      btn.title = LABEL[mode];
    });
  }

  function attach(btn) {
    if (!btn || buttons.indexOf(btn) > -1) return;
    buttons.push(btn);
    btn.addEventListener('click', function () {
      apply(ORDER[(ORDER.indexOf(current()) + 1) % ORDER.length]);
    });
    paint();
  }

  global.Theme = { attach: attach, current: current, apply: apply };

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('#btn-theme, #btn-theme-admin').forEach(attach);
  });
})(window);
