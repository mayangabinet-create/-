// Match the app's saved appearance before the page paints.
(() => {
  function applyTheme() {
    let pref;
    try { pref = localStorage.getItem('theme_pref'); } catch (_) {}
    const explicit = pref === 'light' || pref === 'dark';
    const dark = explicit ? pref === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }
  applyTheme();
  window.addEventListener('storage', applyTheme);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
})();
