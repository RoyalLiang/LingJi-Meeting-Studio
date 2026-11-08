export function waitForImportUpload<T>(upload: Promise<T>, signal?: AbortSignal) {
  if (!signal) return upload;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
    void upload.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
  });
}

const compatibilityLimit = '当前浏览器无法处理这段音频，请转换为 WAV 后重试。';
export async function compatibilityAudioImport(file: File, metadata: { durationSeconds: number; channels: number }, consume: (pcm: ArrayBuffer) => Promise<void>, progress: (value: number) => void, signal?: AbortSignal) {
  signal?.throwIfAborted();
  // shortcut: kernels without a streaming decoder use bounded native decoding; larger inputs need WAV or native import.
  if (file.size > 64 * 1024 * 1024 || !Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds <= 0 || metadata.durationSeconds > 900 || !Number.isInteger(metadata.channels) || metadata.channels < 1 || metadata.channels > 32 || metadata.durationSeconds * 16000 * metadata.channels * 4 > 96 * 1024 * 1024 || typeof globalThis.AudioContext !== 'function') throw new Error(compatibilityLimit);
  const context = new AudioContext({ sampleRate: 16000 }), close = () => { void context.close().catch(() => {}); };
  signal?.addEventListener('abort', close, { once: true });
  try {
    if (context.sampleRate !== 16000) throw new Error(compatibilityLimit);
    const compressed = await file.arrayBuffer(); signal?.throwIfAborted();
    let audio: AudioBuffer;
    try { audio = await waitForImportUpload(context.decodeAudioData(compressed), signal); }
    catch { signal?.throwIfAborted(); throw new Error('无法解码这段音频，请转换为 WAV 后重试。'); }
    if (audio.sampleRate !== 16000 || audio.numberOfChannels < 1 || audio.numberOfChannels > 32 || audio.length * audio.numberOfChannels * 4 > 96 * 1024 * 1024 || audio.length > 900 * 16000) throw new Error(compatibilityLimit);
    const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
    for (let offset = 0; offset < audio.length; offset += 160000) {
      signal?.throwIfAborted();
      const frames = Math.min(160000, audio.length - offset), pcm = new ArrayBuffer(frames * 2), view = new DataView(pcm);
      for (let frame = 0; frame < frames; frame++) {
        let value = 0; for (const channel of channels) value += channel[offset + frame] / channels.length;
        view.setInt16(frame * 2, Math.max(-32768, Math.min(32767, Math.round(value * 32768))), true);
      }
      await consume(pcm); progress((offset + frames) / audio.length);
    }
    return audio.length;
  } finally { signal?.removeEventListener('abort', close); close(); }
}

// Decoding and resampling keep only the input cache, decoder buffers and one PCM chunk.
export async function streamAudioImport(file: File, consume: (pcm: ArrayBuffer) => Promise<void>, progress: (value: number) => void, signal?: AbortSignal) {
  const { Input, WAVE, MP3, MP4, OGG, FLAC, ADTS, MATROSKA, BlobSource, Conversion, Output, WavOutputFormat, NullTarget } = await import('mediabunny');
  const input = new Input({ formats: [WAVE, MP3, MP4, OGG, FLAC, ADTS, MATROSKA], source: new BlobSource(file, { maxCacheSize: 2 * 1024 * 1024 }) });
  let conversion: Awaited<ReturnType<typeof Conversion.init>> | undefined;
  const abort = () => { void conversion?.cancel().catch(() => {}); input.dispose(); };
  signal?.addEventListener('abort', abort, { once: true });
  let chunk = new Uint8Array(320000), used = 0, samples = 0;
  try {
    signal?.throwIfAborted();
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('未找到可导入的音频，请转换为 WAV 后重试。');
    if (!await track.canDecode()) {
      if (file.size > 64 * 1024 * 1024) throw new Error(compatibilityLimit);
      const metadata = { durationSeconds: await track.computeDuration(), channels: await track.getNumberOfChannels() };
      input.dispose(); return await compatibilityAudioImport(file, metadata, consume, progress, signal);
    }
    conversion = await Conversion.init({
      input, output: new Output({ format: new WavOutputFormat({large:true}), target: new NullTarget() }),
      video: { discard: true },
      audio: current => current.id !== track.id ? { discard: true } : {
        codec: 'pcm-s16', sampleRate: 16000, numberOfChannels: 1, sampleFormat: 's16',
        process: async sample => {
          signal?.throwIfAborted();
          const length = sample.allocationSize({ format: 's16', planeIndex: 0 });
          if (length > 16000 * 2 * 10) throw new Error('解码器返回的音频块过大，请转换格式后重试。');
          const bytes = new Uint8Array(length); sample.copyTo(bytes, { format: 's16', planeIndex: 0 });
          samples += sample.numberOfFrames;
          for (let offset = 0; offset < bytes.length;) {
            const count = Math.min(chunk.length - used, bytes.length - offset);
            chunk.set(bytes.subarray(offset, offset + count), used); used += count; offset += count;
            if (used === chunk.length) { await consume(chunk.buffer); chunk = new Uint8Array(320000); used = 0; }
          }
          return sample;
        },
      },
    });
    if (!conversion.isValid) throw new Error('此文件没有可解码的音轨，请转换格式后重试。');
    conversion.onProgress = value => progress(Math.max(0, Math.min(0.99, value)));
    await conversion.execute(); signal?.throwIfAborted();
    if (used) await consume(chunk.buffer.slice(0, used));
    if (!samples) throw new Error('音频中没有可导入的采样。');
    progress(1);
    return samples;
  } finally { signal?.removeEventListener('abort', abort); input.dispose(); }
}
