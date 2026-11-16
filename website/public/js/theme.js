// Theme: dark by default; the user's choice is remembered on this device.
// Loaded as a plain (blocking) script in <head> so the page never flashes light first.
// Button labels are translated: the app sets window.SyncSafeT (the translate function).
(function () {
  var KEY = 'syncsafe-theme';
  var COLORS = { dark: '#18202a', light: '#ffffff' };
  var SUN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function read() {
    try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; } catch (e) { return 'dark'; }
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', COLORS[theme]);
    try {
      var bars = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SystemBars;
      if (bars && bars.setStyle) bars.setStyle({ style: theme === 'dark' ? 'DARK' : 'LIGHT' }).catch(function () {});
    } catch (e) { /* not in the app */ }
    var tr = window.SyncSafeT || function (k) { return k === 'theme.light' ? 'Light mode' : 'Dark mode'; };
    var next = theme === 'dark' ? 'light' : 'dark';
    var text = tr(next === 'light' ? 'theme.light' : 'theme.dark');
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-label', text);
      buttons[i].setAttribute('title', text);
      buttons[i].innerHTML = (next === 'light' ? SUN : MOON) + '<span class="theme-label"></span>';
      buttons[i].querySelector('.theme-label').textContent = text;
    }
  }

  var current = read();
  apply(current);
  window.SyncSafeTheme = { refresh: function () { apply(current); }, current: function () { return current; } };

  document.addEventListener('DOMContentLoaded', function () {
    apply(current);
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function () {
        current = current === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(KEY, current); } catch (e) { /* ignore */ }
        apply(current);
      });
    }
  });
})();
