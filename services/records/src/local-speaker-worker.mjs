import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { LOCAL_SPEAKER_MODEL } from './local-asr.mjs';
import { createLocalSpeakerInference } from './local-speaker-inference.mjs';

const directory = process.argv[2]; if (!directory) process.exit(1);
const require = createRequire(join(directory, 'package.json'));
const inference = await createLocalSpeakerInference(directory, require('sherpa-onnx-node'));
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
send({ protocol: 1, ready: true, model: LOCAL_SPEAKER_MODEL });
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.length > 1300000) process.exit(1);
  let request;
  try {
    request = JSON.parse(line);
    if (!Number.isSafeInteger(request.id) || typeof request.pcm !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(request.pcm) || request.embedding !== undefined && typeof request.embedding !== 'boolean' || request.diarize !== undefined && typeof request.diarize !== 'boolean' || request.embedding !== true && request.diarize !== true || request.embedding && request.diarize) process.exit(1);
    const bytes = Buffer.from(request.pcm, 'base64');
    if (!bytes.length || bytes.length > 960000 || bytes.length % 2) process.exit(1);
    const samples = new Float32Array(bytes.length / 2);
    for (let at = 0; at < samples.length; at++) samples[at] = bytes.readInt16LE(at * 2) / 32768;
    if (request.embedding && samples.length < 32000) throw Error('speaker_audio_too_short');
    send({ id: request.id, text: '', ...(request.embedding ? { embedding: inference.extract(samples) } : { diarization: inference.diarize(samples).map(({ start, end, overlap, embedding }) => ({ start, end, overlap, ...(embedding ? { embedding } : {}) })) }) });
  } catch { send({ id: request?.id, error: 'local_asr_inference_failed' }); }
}
