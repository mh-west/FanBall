/* Keep an already-open FanBall tab current after a new Site deployment. */
(() => {
  const watchedAssets = ['/index.html', '/app.js', '/enhancements.js', '/style.css'];
  const intervalMs = 30_000;
  let baseline = null;
  let checking = false;

  function fingerprint(source) {
    let hash = 2166136261;
    for (let i = 0; i < source.length; i++) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${source.length}:${hash >>> 0}`;
  }

  async function snapshot() {
    const values = await Promise.all(watchedAssets.map(async (path) => {
      const separator = path.includes('?') ? '&' : '?';
      const response = await fetch(`${path}${separator}fanball_update_check=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!response.ok) throw new Error(`Unable to check ${path}`);
      return fingerprint(await response.text());
    }));
    return values.join('|');
  }

  async function checkForUpdate() {
    // A hidden tab skips the check (it runs again when the tab is shown): background tabs often have their
    // connections cut, which only filled the console with "ERR_CONNECTION_CLOSED" (2026-11-12).
    if (checking || document.visibilityState === 'prerender' || document.visibilityState === 'hidden') return;
    checking = true;
    try {
      const current = await snapshot();
      if (baseline === null) baseline = current;
      else if (current !== baseline) {
        document.documentElement.dataset.fanballUpdating = 'true';
        // Come back to the same screen after the reload (the selected game is kept in local storage).
        try { sessionStorage.setItem('fanball:restore', JSON.stringify({ page: typeof page !== 'undefined' ? page : 'home', inning: typeof selectedLogInning !== 'undefined' ? selectedLogInning : null, at: Date.now() })); } catch (_) {}
        window.setTimeout(() => window.location.reload(), 350);
      }
    } catch (_) {
      // Temporary network failures should not disrupt the open game.
    } finally {
      checking = false;
    }
  }

  checkForUpdate();
  window.setInterval(checkForUpdate, intervalMs);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
})();
