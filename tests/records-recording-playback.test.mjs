import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

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
