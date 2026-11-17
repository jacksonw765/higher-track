// Loaded in <head> so the right colours are in place before the first paint.
// Follows the system setting until the user picks a theme, then remembers the choice.
(() => {
  const stored = () => {
    try {
      return localStorage.getItem('theme');
    } catch {
      return null;
    }
  };
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => (document.documentElement.dataset.theme = stored() || (system.matches ? 'dark' : 'light'));
  apply();
  system.addEventListener('change', apply);
  window.toggleTheme = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    document.documentElement.dataset.theme = next;
    return next;
  };
})();
