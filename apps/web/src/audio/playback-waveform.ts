export type RecordingWaveform = { samples: number; sampleRate: number; peaks: number[] };

export function mergeWaveforms(tracks: RecordingWaveform[]): number[] {
  if (!tracks.length) return [];
  const valid = tracks.filter(track => Number.isSafeInteger(track.samples) && track.samples > 0 && track.sampleRate === 16000
    && track.peaks.length === 192 && track.peaks.every(peak => Number.isFinite(peak) && peak >= 0 && peak <= 1));
  if (valid.length !== tracks.length) throw new Error('Invalid recording waveform');
  const samples = Math.max(...valid.map(track => track.samples)), peaks = Array<number>(192).fill(0);
  for (const track of valid) {
    track.peaks.forEach((peak, bin) => {
      const start = Math.floor(bin / 192 * track.samples / samples * 192);
      const end = Math.max(start + 1, Math.ceil((bin + 1) / 192 * track.samples / samples * 192));
      for (let index = start; index < Math.min(192, end); index++) peaks[index] = Math.max(peaks[index], peak);
    });
  }
  return peaks;
}

export function parsePlaybackTime(value: string): number | null {
  if (!/^\d{1,5}:[0-5]\d(?::[0-5]\d)?$/.test(value.trim())) return null;
  return value.trim().split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

export function waveformTicks(duration: number): number[] {
  if (!(duration > 0)) return [];
  return [0, duration / 4, duration / 2, duration * 3 / 4, duration];
}
