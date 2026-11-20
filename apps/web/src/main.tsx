import { createRoot } from 'react-dom/client';
import App from './App';
import { isTauri } from '@tauri-apps/api/core';
import { RecordingWidget } from './components/RecordingWidget';
import { initializeTheme } from './native-theme';
import './styles.css';
import './workbench.css';
initializeTheme();
const widgetMode=isTauri() && location.hash==='#recording-widget';
document.documentElement.classList.toggle('webview2',isTauri() && /Windows/.test(navigator.userAgent));
document.documentElement.classList.toggle('recording-capsule-mode',widgetMode);
createRoot(document.getElementById('root')!).render(widgetMode ? <RecordingWidget/> : <App/>);

if (location.pathname === '/quick-record' && !isTauri() && 'serviceWorker' in navigator && import.meta.env.PROD) {
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
