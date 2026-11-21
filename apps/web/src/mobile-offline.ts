export function registerMobileOffline() {
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    void navigator.serviceWorker.register('/quick-record-sw.js', { scope: '/quick-record' }).then(async () => {
      const registration = await navigator.serviceWorker.ready;
      const cache = (entries: PerformanceEntry[]) => {
        const assets = entries.map(entry => entry.name).filter(name => {
          const url = new URL(name, location.origin);
          return url.origin === location.origin && /^\/(assets|brand)\//.test(url.pathname);
        });
        if (assets.length) registration.active?.postMessage({ assets });
      };
      cache(performance.getEntriesByType('resource'));
      new PerformanceObserver(list => cache(list.getEntries())).observe({ type: 'resource' });
    }).catch(() => {});
  }
}
