import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createRecordServer } from '../services/records/src/server.mjs';
import { digest } from '../packages/records/src/record.mjs';
import { runCycle } from '../services/records/src/worker.mjs';

const code = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/recording-playback.ts', import.meta.url), 'utf8')).replace(/^import .*$/gm, '').replace(/export /g, '');
const sandbox = { exports: {}, encodeURIComponent };
vm.runInNewContext(code + '\nObject.assign(exports,{recordingPlaybackState,recordingAudioUrl});', sandbox);
const { recordingPlaybackState, recordingAudioUrl } = sandbox.exports;
const record = { retainAudio: true, audioPurged: false, capture: 'completed', sources: [{ id: 'received', watermark: 0 }, { id: 'empty', watermark: -1 }] };

test('original playback requires retained, unpurged and completed audio', () => {
  for (const fields of [{ retainAudio: false }, { audioPurged: true }, { capture: 'recording' }, { capture: 'paused' }, { capture: 'sealed' }]) {
    const state = recordingPlaybackState({ ...record, ...fields });
    assert.equal(state.available, false);
    assert.ok(state.message);
    assert.equal('sources' in state, false);
  }
});

test('playback exposes only sources with durable audio receipts and preserves the record', () => {
  const before = JSON.stringify(record);
  const state = recordingPlaybackState(record);
  assert.equal(state.available, true);
  assert.deepEqual(Array.from(state.sources, source => source.id), ['received']);
  assert.equal(recordingPlaybackState({ ...record, sources: [record.sources[1]] }).available, false);
  assert.equal(JSON.stringify(record), before);
});

test('audio playback stays on the authenticated same-origin route', () => {
  assert.equal(recordingAudioUrl('record/id', 'source?token=secret'), '/api/records/record%2Fid/audio/source%3Ftoken%3Dsecret');
});

test('unavailable playback explains cleanup and how to retain the next recording', () => {
  const purged = recordingPlaybackState({ ...record, retainAudio: false, audioPurged: true });
  assert.match(purged.message, /已清理.*无法恢复/);
  assert.match(purged.message, /保留原音/);
  const temporary = recordingPlaybackState({ ...record, retainAudio: false });
  assert.match(temporary.message, /未开启.*保留原音/);
  assert.match(temporary.message, /转录后清理/);
});

test('retained recordings serve complete WAV and byte ranges while temporary or purged audio stays private', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-playback-'));
  const app = await createRecordServer({ root, databaseUrl: '', port: 0 });
  const address = await app.start(), base = `http://127.0.0.1:${address.port}/api`;
  const pcm = [Buffer.alloc(3200, 5), Buffer.alloc(1600, 9)], audioBytes = Buffer.concat(pcm);
  try {
    const registration = await fetch(base + '/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'playback@example.test', password: 'playback-test-password' }) });
    const user = await registration.json(), headers = { Cookie: registration.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': user.csrf, 'Content-Type': 'application/json' };
    async function post(path, body) {
      const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
      assert.ok(response.ok, `${path}: ${response.status}`);
      return response.json();
    }
    async function recording(retainAudio) {
      const saved = await post('/records', { retainAudio }), source = await post(`/records/${saved.id}/sources`, { kind: 'microphone' });
      let sampleOffset = 0;
      for (const [sequence, bytes] of pcm.entries()) {
        await post(`/records/${saved.id}/audio`, { sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, sequence, sampleOffset,
          sampleCount: bytes.length / 2, sampleRate: 16000, digest: digest(bytes), pcm: bytes.toString('base64') });
        sampleOffset += bytes.length / 2;
      }
      await post(`/records/${saved.id}/seal`, { sources: [{ sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, lastSequence: 1 }] });
      return { id: saved.id, sourceId: source.id };
    }
    const retained = await recording(true), url = base + recordingAudioUrl(retained.id, retained.sourceId).slice(4);
    assert.equal((await fetch(url, { headers })).status, 404, 'sealed audio is not exposed before completion');
    for (let i = 0; i < pcm.length; i++) await runCycle(app.repo, { transcribe: async () => '' }, { lane: 'audio' });
    const completed = await app.repo.get(retained.id);
    assert.equal(completed.capture, 'completed');
    assert.equal(completed.sources[0].watermark, completed.sources[0].lastSequence);
    const full = await fetch(url, { headers }), wav = Buffer.from(await full.arrayBuffer());
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'audio/wav');
    assert.equal(full.headers.get('cache-control'), 'no-store');
    assert.equal(full.headers.get('content-length'), String(audioBytes.length + 44));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(40), audioBytes.length);
    assert.deepEqual(wav.subarray(44), audioBytes);
    for (const [start, end] of [[0, 43], [3238, 3250], [3244, wav.length - 1]]) {
      const part = await fetch(url, { headers: { ...headers, Range: `bytes=${start}-${end}` } });
      assert.equal(part.status, 206);
      assert.equal(part.headers.get('content-range'), `bytes ${start}-${end}/${wav.length}`);
      assert.deepEqual(Buffer.from(await part.arrayBuffer()), wav.subarray(start, end + 1));
    }
    assert.equal((await fetch(url, { headers: { ...headers, Range: `bytes=${wav.length}-` } })).status, 416);
    assert.equal((await fetch(url)).status, 401);
    await app.repo.change(retained.id, value => { value.audioPurged = true; });
    assert.equal((await fetch(url, { headers })).status, 404, 'purged flag denies even an object still on disk');
    const temporary = await recording(false), temporaryUrl = base + recordingAudioUrl(temporary.id, temporary.sourceId).slice(4);
    await app.repo.change(temporary.id, value => { value.capture = 'completed'; });
    assert.equal((await fetch(temporaryUrl, { headers })).status, 404, 'temporary objects do not override retention consent');
    await app.repo.change(temporary.id, value => { value.capture = 'sealed'; });
    for (let i = 0; i < pcm.length; i++) await runCycle(app.repo, { transcribe: async () => '' }, { lane: 'audio' });
    const cleaned = await app.repo.get(temporary.id);
    assert.equal(cleaned.audioPurged, true);
    assert.equal(cleaned.retainAudio, false);
    await assert.rejects(app.repo.readAudio(cleaned.chunks[0].object), /ENOENT/);
    assert.equal((await fetch(temporaryUrl, { headers })).status, 404);
  } finally {
    await app.stop();
    await rm(root, { recursive: true });
  }
});
