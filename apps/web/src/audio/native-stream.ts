export type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export type NativePacket = { sequence: number; sampleOffset: number; buffer: ArrayBuffer };
export type NativeStream = { id: string; label: string; done: Promise<void>; stop: (discard?: boolean) => Promise<void> };

export function decodeNativePacket(raw: ArrayBuffer, sequence: number, offset: number): NativePacket {
  if (!(raw instanceof ArrayBuffer) || raw.byteLength < 14) throw new Error('原生音频包不完整');
  const view = new DataView(raw), count = view.getUint32(8, true);
  if (view.getUint32(0, true) !== sequence || view.getUint32(4, true) !== offset || count < 1 || count > 16000 || raw.byteLength !== 12 + count * 2) {
    throw new Error('原生音频序号、偏移或长度不一致，采集已停止');
  }
  return { sequence, sampleOffset: offset, buffer: raw.slice(12) };
}

export async function openNativeStream(invoke: NativeInvoke, kind: 'display' | 'microphone', deviceId: string,
  onPacket: (packet: NativePacket) => Promise<void>, onError: (error: Error) => void): Promise<NativeStream> {
  const started = await invoke('capture_start', { kind, deviceId }) as { id: string; label: string };
  let stopping: Promise<void> | undefined, discard = false, stopRequested = false, sequence = 0, offset = 0;
  const done = (async () => {
    try {
      for (;;) {
        const raw = await invoke('capture_read', { id: started.id }) as ArrayBuffer;
        if (raw.byteLength === 0) {
          if (!stopRequested) throw new Error('音频采集意外停止，已保留本地录音。请恢复录制并检查音频设备。');
          break;
        }
        const packet = decodeNativePacket(raw, sequence, offset); sequence++; offset += packet.buffer.byteLength / 2;
        if (!discard) await onPacket(packet); // Persist before requesting another native packet.
      }
    } catch (reason) {
      await invoke('capture_stop', { id: started.id, discard: true }).catch(() => {});
      if (!discard) {
        const error = reason instanceof Error ? reason : new Error(String(reason)); onError(error); throw error;
      }
    }
  })();
  void done.catch(() => {});
  return { ...started, done, stop: async (drop = false) => {
    stopRequested = true; discard ||= drop;
    stopping ??= invoke('capture_stop', { id: started.id, discard }).then(() => {});
    await stopping; await done;
  } };
}
