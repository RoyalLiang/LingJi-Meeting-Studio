import { createRoot } from 'react-dom/client';
import { MobileApp } from './MobileApp';
import { initializeTheme } from './native-theme';

initializeTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
createRoot(document.getElementById('root')!).render(<MobileApp/>);

// The Android wrapper passes a document-scoped port for releasing its microphone service.
window.addEventListener('message', event => {
  const port = event.ports[0];
  if (event.data !== 'lingji-recording' || !port || event.source) return;
  port.postMessage('ready');
  window.addEventListener('lingji:recording-opened', () => port.postMessage('start'));
  window.addEventListener('lingji:recording-closed', () => port.postMessage('stop'));
});
