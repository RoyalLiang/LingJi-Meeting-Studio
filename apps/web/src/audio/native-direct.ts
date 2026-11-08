import type { Source } from '../model';
import type { NativeInvoke, NativeStream } from './native-stream';

export type NativeManifest = { sourceId: string; sessionId: string; epoch: string; lastSequence: number; sampleEnd: number };
export type DirectProgress = { sampleEnd: number; acknowledgedSampleEnd: number; bufferedBytes: number; rms: number; quietSeconds: number; stopped: boolean; finished: boolean; error?: string | null };
export type DirectSession = { id: string; label: string; source: Source; recordId: string; stopped: boolean; action?: string; purged?: boolean; disconnected?: boolean };
export type DirectStream = NativeStream & { source: Source; manifest?: NativeManifest };

export async function openNativeDirect(invoke: NativeInvoke, recordId: string, kind: 'display' | 'microphone', deviceId: string,
  onError: (error: Error | null, retaining?: boolean) => void, onProgress: (progress: DirectProgress) => void): Promise<DirectStream> {
  const started = await invoke('capture_direct_start', { recordId, kind, deviceId }) as { id: string; label: string; source: Source };
  return attachNativeDirect(invoke, started, onError, onProgress);
}
export function attachNativeDirect(invoke: NativeInvoke, started: { id: string; label: string; source: Source },
  onError: (error: Error | null, retaining?: boolean) => void, onProgress: (progress: DirectProgress) => void): DirectStream {
  let polling = false, ended = false, observationFailed = false, stopping: Promise<void> | undefined, resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const stream: DirectStream = { ...started, done, stop: async () => {
    stopping ??= (async () => {
      stream.manifest = await invoke('capture_direct_stop', { id: started.id, action: 'source' }) as NativeManifest;
      ended = true; clearInterval(timer); resolveDone();
    })().catch(error => { stopping = undefined; throw error; });
    await stopping;
  } };
  const timer = setInterval(() => { void poll(); }, 500);
  async function poll() {
    if (ended || polling) return;
    polling = true;
    try {
      const progress = await invoke('capture_direct_progress', { id: started.id }) as DirectProgress;
      if (ended) return;
      observationFailed = false; onProgress(progress);
      if (progress.error || progress.stopped) {
        await stream.stop();
        onError(progress.error ? new Error('本机音频采集已停止，已保存片段会继续处理。请检查音源后重新接入。') : null);
      }
    } catch {
      if (!ended && !observationFailed) { observationFailed = true; onError(new Error('音源状态暂时无法确认，控制与缓存已保留，请稍后重试。'), true); }
    } finally { polling = false; }
  }
  return stream;
}
