import { requireThat } from '../../../packages/records/src/record.mjs';

// Summarize one PCM object at a time: memory stays bounded for long meetings.
export async function recordingWaveform(chunks, readAudio, cancelled = () => false, leadingSamples = 0) {
  const samples = leadingSamples + chunks.reduce((sum, chunk) => sum + chunk.sampleCount, 0);
  const peaks = Array(192).fill(0);
  for (const chunk of chunks) {
    if (cancelled()) return null;
    const pcm = await readAudio(chunk.object);
    if (cancelled()) return null;
    requireThat(pcm.length === chunk.sampleCount * 2, 'audio_unavailable', 404);
    for (let index = 0; index < chunk.sampleCount; index++) {
      const bin = Math.min(191, Math.floor((leadingSamples + chunk.sampleOffset + index) * 192 / samples));
      peaks[bin] = Math.max(peaks[bin], Math.abs(pcm.readInt16LE(index * 2)) / 32768);
    }
  }
  return { samples, sampleRate: 16000, peaks };
}
