// Private native inference process. JSON-line IPC only; no listener or network.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { LOCAL_ASR_MODEL } from './local-asr.mjs';

const directory = process.argv[2];
if (!directory) process.exit(1);
const require = createRequire(join(directory, 'package.json'));
const sherpa = require('sherpa-onnx-node');
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { senseVoice: { model: join(directory, 'sensevoice/model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 }, tokens: join(directory, 'sensevoice/tokens.txt'), numThreads: 4, provider: 'cpu', debug: 0 },
});
const vad = new sherpa.Vad({ sileroVad: { model: join(directory, 'silero_vad.onnx'), threshold: .5, minSilenceDuration: .35, minSpeechDuration: .1, windowSize: 512, maxSpeechDuration: 30 }, sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0 }, 35);
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
send({ protocol: 1, ready: true, model: LOCAL_ASR_MODEL });
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.length > 1300000) process.exit(1);
  let request;
  try {
    request = JSON.parse(line);
    if (!Number.isSafeInteger(request.id) || typeof request.pcm !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(request.pcm)) process.exit(1);
    const bytes = Buffer.from(request.pcm, 'base64');
    if (!bytes.length || bytes.length > 960000 || bytes.length % 2) process.exit(1);
    const samples = new Float32Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2) / 32768;
    vad.reset();
    for (let i = 0; i < samples.length; i += 512) {
      const block = new Float32Array(512); block.set(samples.subarray(i, i + 512)); vad.acceptWaveform(block);
    }
    vad.flush();
    // VAD filters silent windows. Keep the original utterance context: directly
    // cropping its boundaries was observed to alter initial words in real probes.
    let text = '', language;
    if (!vad.isEmpty()) {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples }); recognizer.decode(stream);
      const result = recognizer.getResult(stream);
      text = result.text.replace(/<\|[^|]*\|>/g, '').trim();
      const detected = typeof result.lang === 'string' ? result.lang.replace(/^<\|(zh|en|ja|ko|yue)\|>$/u, '$1') : '';
      if (text && ['zh', 'en', 'ja', 'ko', 'yue'].includes(detected)) language = detected;
    }
    send({ id: request.id, text, ...(language ? { language } : {}) });
  } catch {
    if (!request?.id) process.exit(1);
    send({ id: request.id, error: 'inference_failed' });
  }
}
// Parent termination closes stdin, including when the backend is forcibly killed.
process.exit(0);
