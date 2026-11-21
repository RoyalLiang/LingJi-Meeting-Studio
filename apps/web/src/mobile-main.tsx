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
  const chrome = () => port.postMessage(document.querySelector('.mobile-source-sheet[open]') ? 'sheet-open' : 'sheet-closed');
  document.addEventListener('meeting:chrome', chrome);
  port.onmessage = message => {
    if (message.data === 'sheet-back') document.querySelector('.mobile-source-sheet[open]')
      ?.dispatchEvent(new Event('cancel', { cancelable: true }));
  };
  chrome();
  window.addEventListener('lingji:recording-opened', () => port.postMessage('start'));
  window.addEventListener('lingji:recording-closed', () => port.postMessage('stop'));
});
