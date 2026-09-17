// Runs before first paint so a stored theme never flashes the wrong palette.
// "system" stores nothing and leaves the choice to prefers-color-scheme.
(function () {
  try {
    var stored = localStorage.getItem('taskflow-theme');
    if (stored === 'light' || stored === 'dark') document.documentElement.dataset.theme = stored;
  } catch (error) {
    // Storage can be blocked; the system theme still applies.
  }
})();
