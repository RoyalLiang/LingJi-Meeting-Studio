import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { CaptureController as BrowserController, capabilities as browserCapabilities } from './capture';
import { NativeCaptureController } from './native-controller';
export type CaptureController = BrowserController | NativeCaptureController;
export const CaptureController = isTauri() ? NativeCaptureController : BrowserController;
export const capabilities = () => isTauri() ? { secure: true, microphone: true, display: true, worklet: true } : browserCapabilities();
export { importAudio, type CaptureIssue, type CaptureKind } from './capture';

if (isTauri()) {
  void listen('client-close-requested', () => {
    const event = new Event('beforeunload', { cancelable: true });
    const allowed = window.dispatchEvent(event);
    void invoke('client_close', { force: !allowed }).catch(console.error);
  }).then(() => invoke('client_ready')).catch(console.error);
}
