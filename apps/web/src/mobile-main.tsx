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
    if (typeof message.data === 'string' && message.data.startsWith('system-audio-')) {
      window.dispatchEvent(new CustomEvent('lingji:system-audio', { detail: message.data }));
      if (message.data.startsWith('system-audio-frame:')) port.postMessage('system-audio-ack');
    }
    if (message.data === 'network-changed') window.dispatchEvent(new Event('lingji:network-changed'));
    if (typeof message.data === 'string' && message.data.startsWith('direct-addresses:')) {
      window.dispatchEvent(new CustomEvent('lingji:direct-addresses', { detail: message.data.slice('direct-addresses:'.length) }));
    }
    if (typeof message.data === 'string' && message.data.startsWith('update-result:')) {
      window.dispatchEvent(new CustomEvent('lingji:update-result', { detail: message.data.slice('update-result:'.length) }));
    }
    if (message.data === 'sheet-back') Array.from(document.querySelectorAll('.mobile-source-sheet[open]')).at(-1)
      ?.dispatchEvent(new Event('cancel', { cancelable: true }));
  };
  chrome();
  window.addEventListener('lingji:recording-opened', () => port.postMessage('start'));
  window.addEventListener('lingji:recording-closed', () => port.postMessage('stop'));
  window.addEventListener('lingji:recording-state', event => port.postMessage((event as CustomEvent<string>).detail));
  window.addEventListener('lingji:check-update', event => port.postMessage('check-update:' + (event as CustomEvent<string>).detail));
  window.addEventListener('lingji:request-direct-addresses', () => port.postMessage('direct-addresses'));
  window.addEventListener('lingji:system-audio-disarm', () => port.postMessage('system-audio-disarm'));
});
