import { digest, requireThat } from '../../../packages/records/src/record.mjs';

export const waveformKey = (chunks, leadingSamples) => digest(JSON.stringify(['waveform-v2',leadingSamples,chunks.map(c=>[c.object,c.digest,c.sampleOffset,c.sampleCount])]));
export const validWaveform = (value,samples) => value?.samples === samples && value?.sampleRate === 16000 && Array.isArray(value.peaks) && value.peaks.length === 192 && value.peaks.every(p=>Number.isFinite(p)&&p>=0&&p<=1);

// Eight reads overlap slow filesystem access; each buffer is released after its summary.
export async function recordingWaveform(chunks, readAudio, cancelled = () => false, leadingSamples = 0) {
  const samples = leadingSamples + chunks.reduce((sum, chunk) => sum + chunk.sampleCount, 0);
  const peaks = Array(192).fill(0);
  let next = 0, failed = false;
  const scan = async () => {
    while (next < chunks.length && !failed && !cancelled()) {
      const chunk = chunks[next++];
      try {
        const pcm = await readAudio(chunk.object);
        if (cancelled() || failed) return;
        requireThat(pcm.length === chunk.sampleCount * 2, 'audio_unavailable', 404);
        const start = leadingSamples + chunk.sampleOffset, end = start + chunk.sampleCount;
        for (let bin = Math.floor(start * 192 / samples); bin < 192 && Math.ceil(bin * samples / 192) < end; bin++) {
          const from = Math.max(0,Math.ceil(bin * samples / 192) - start), until = Math.min(chunk.sampleCount,Math.ceil((bin+1) * samples / 192) - start);
          let peak = peaks[bin] * 32768;
          for (let index = from; index < until; index++) { const value = Math.abs(pcm.readInt16LE(index*2)); if (value > peak) peak = value; }
          peaks[bin] = peak / 32768;
        }
      } catch (error) { failed = true; throw error; }
    }
  };
  await Promise.all(Array.from({length:Math.min(8,chunks.length)},scan));
  return cancelled() ? null : { samples, sampleRate: 16000, peaks };
}
