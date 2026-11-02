import { digest, requireThat } from '../../../packages/records/src/record.mjs';

export const waveformKey = (chunks, leadingSamples) => digest(JSON.stringify(['waveform-v2',leadingSamples,chunks.map(c=>[c.object,c.digest,c.sampleOffset,c.sampleCount])]));
export const validWaveform = (value,samples) => value?.samples === samples && value?.sampleRate === 16000 && Array.isArray(value.peaks) && value.peaks.length === 192 && value.peaks.every(p=>Number.isFinite(p)&&p>=0&&p<=1);

const stride = 1000, legacyStride = 128;
// Overview peaks need 16 samples/s, not a second audio-sized history in the aggregate.
export function chunkWaveform(pcm) {
  const peaks=Buffer.alloc(Math.ceil(pcm.length/2/stride));
  for(let start=0;start<pcm.length/2;start+=stride){
    let peak=0;for(let i=start;i<Math.min(start+stride,pcm.length/2);i++)peak=Math.max(peak,Math.abs(pcm.readInt16LE(i*2)));
    peaks[Math.floor(start/stride)]=Math.round(peak*255/32768);
  }
  return 'v2:'+peaks.toString('base64');
}
// Eight reads overlap slow filesystem access; each buffer is released after its summary.
export async function recordingWaveform(chunks, readAudio, cancelled = () => false, leadingSamples = 0) {
  const samples = leadingSamples + chunks.reduce((sum, chunk) => sum + chunk.sampleCount, 0);
  const peaks = Array(192).fill(0);
  let next = 0, failed = false;
  const scan = async () => {
    while (next < chunks.length && !failed && !cancelled()) {
      const chunk = chunks[next++];
      try {
        const compact=typeof chunk.waveform==='string' && chunk.waveform.startsWith('v2:'), step=compact?stride:legacyStride, width=compact?1:2;
        const encoded=compact?chunk.waveform.slice(3):chunk.waveform, length=Math.ceil(chunk.sampleCount/step)*width;
        const packed=typeof encoded==='string' && encoded.length===Math.ceil(length/3)*4 ? Buffer.from(encoded,'base64') : null;
        const envelope=packed?.length===length && (compact || Array.from({length:packed.length/2},(_,i)=>packed.readUInt16LE(i*2)).every(value=>value<=32768)) ? packed : null;
        const pcm = envelope ? null : await readAudio(chunk.object);
        if (cancelled() || failed) return;
        requireThat(envelope || pcm.length === chunk.sampleCount * 2, 'audio_unavailable', 404);
        const start = leadingSamples + chunk.sampleOffset, end = start + chunk.sampleCount;
        for (let bin = Math.floor(start * 192 / samples); bin < 192 && Math.ceil(bin * samples / 192) < end; bin++) {
          const from = Math.max(0,Math.ceil(bin * samples / 192) - start), until = Math.min(chunk.sampleCount,Math.ceil((bin+1) * samples / 192) - start);
          let peak = peaks[bin] * 32768;
          for (let index = envelope ? Math.floor(from/step) : from; index < (envelope ? Math.ceil(until/step) : until); index++) { const value = envelope ? (compact?envelope[index]*32768/255:envelope.readUInt16LE(index*2)) : Math.abs(pcm.readInt16LE(index*2)); if (value > peak) peak = value; }
          peaks[bin] = peak / 32768;
        }
      } catch (error) { failed = true; throw error; }
    }
  };
  await Promise.all(Array.from({length:Math.min(8,chunks.length)},scan));
  return cancelled() ? null : { samples, sampleRate: 16000, peaks };
}
