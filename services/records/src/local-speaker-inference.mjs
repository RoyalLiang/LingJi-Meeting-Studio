import { join } from 'node:path';
import { LOCAL_SPEAKER_MODEL, verifyLocalAsrAssets } from './local-asr.mjs';

// Speaker vectors stay in the private inference process unless an explicit caller requests them.
export async function createLocalSpeakerInference(directory, sherpa) {
  await verifyLocalAsrAssets(directory, { model: LOCAL_SPEAKER_MODEL });
  const embedding = { model: join(directory, 'speakers/embedding.onnx'), numThreads: 2, provider: 'cpu', debug: 0 };
  const extractor = new sherpa.SpeakerEmbeddingExtractor(embedding);
  let diarizer;
  function extract(samples) {
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples }); stream.inputFinished();
    if (!extractor.isReady(stream)) throw Error('speaker_audio_too_short');
    return Array.from(extractor.compute(stream));
  }
  return {
    extract,
    diarize(samples) {
      diarizer ||= new sherpa.OfflineSpeakerDiarization({
        segmentation: { pyannote: { model: join(directory, 'speakers/segmentation.int8.onnx') }, numThreads: 2, provider: 'cpu', debug: 0 },
        embedding, clustering: { numClusters: -1, threshold: 0.8 }, minDurationOn: 0.3, minDurationOff: 0.5,
      });
      const slices = [];
      for (const turn of diarizer.process(samples).sort((a, b) => a.start - b.start || a.end - b.end)) {
        const start = Math.max(0, Math.floor(turn.start * 16000)), end = Math.min(samples.length, Math.ceil(turn.end * 16000));
        if (end - start < 4800) continue;
        const previous = slices.at(-1);
        if (previous && start < previous.end) {
          previous.end = Math.max(previous.end, end); if (previous.cluster !== turn.speaker) { previous.overlap = true; previous.cluster = null; }
        } else slices.push({ start, end, overlap: false, cluster: turn.speaker });
      }
      if (slices.length > 64) throw Error('too_many_speaker_slices');
      const bounded = slices, clusters = new Map();
      for (const slice of bounded) if (!slice.overlap) {
        const group = clusters.get(slice.cluster) || []; group.push(slice); clusters.set(slice.cluster, group);
      }
      const embeddings = new Map();
      for (const [cluster, group] of clusters) {
        const speech = new Float32Array(group.reduce((size, slice) => size + slice.end - slice.start, 0)); let offset = 0;
        for (const slice of group) { speech.set(samples.subarray(slice.start, slice.end), offset); offset += slice.end - slice.start; }
        embeddings.set(cluster, extract(speech));
      }
      const turns=[];
   for(const slice of bounded){
    const previous=turns.at(-1);
    // Keep same-speaker pauses in the ASR context, but compute embeddings from the original speech intervals above.
    if(previous&&!previous.overlap&&!slice.overlap&&Number.isSafeInteger(slice.cluster)&&slice.cluster>=0&&previous.cluster===slice.cluster){previous.end=slice.end;continue;}
    turns.push({...slice,...(slice.overlap?{}:{embedding:embeddings.get(slice.cluster)})});
   }
   return turns;
    },
  };
}
