import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { canStartSpeechSource, retryableSpeechError } from '../services/records/src/asr-recovery.mjs';

const code = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/recognition-status.ts', import.meta.url), 'utf8'));
const { recognitionStatus } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const now = Date.now();
function failed(error = 'doubao_connection_failed') {
  const source = { id: 'one', watermark: 3, asr: { state: 'failed', attempts: 5, error, retryAt: now - 1 } };
  const record = { deleteAt: new Date(now + 86400000).toISOString(), chunks: [{ sourceId: 'one', attempts: 5, state: 'pending' }] };
  return { source, record };
}

test('only transient speech failures can recover beyond the attempt cap', () => {
  for (const error of ['doubao_connection_failed', 'doubao_completion_timeout', 'doubao_incomplete_session', 'doubao_http_429', 'doubao_http_503']) {
    const { record, source } = failed(error);
    assert.equal(retryableSpeechError(error), true);
    assert.equal(canStartSpeechSource(record, source, now), true);
  }
  for (const error of ['doubao_http_401', 'doubao_http_403', 'invalid_provider', 'doubao_error_45000001']) {
    const { record, source } = failed(error);
    assert.equal(canStartSpeechSource(record, source, now), false);
  }
});

test('automatic recovery respects retention, cleanup, cooldown and ownership', () => {
  for (const patch of [{ deleted: true }, { audioPurged: true }, { audioCleanup: {} }, { deleteAt: new Date(now - 1).toISOString() }]) {
    const { record, source } = failed();
    assert.equal(canStartSpeechSource({ ...record, ...patch }, source, now), false);
  }
  for (const patch of [{ retryAt: now + 1 }, { lease: now + 1 }]) {
    const { record, source } = failed(); Object.assign(source.asr, patch);
    assert.equal(canStartSpeechSource(record, source, now), false);
  }
  const { record, source } = failed(); record.chunks[0].expired = true;
  assert.equal(canStartSpeechSource(record, source, now), false);
});

test('speech failure is visible even when legacy record still says queued or has old minutes', () => {
  const record = { capture: 'recording', transcription: 'queued', transcriptRevision: 12, usage: { samples: 16000 }, sources: [{ asr: { state: 'failed', error: 'doubao_connection_failed' } }] };
  assert.match(recognitionStatus(record), /自动重连/);
  record.sources[0].asr.error = 'doubao_http_401';
  assert.match(recognitionStatus(record), /检查服务设置/);
  record.sources = [];
  assert.equal(recognitionStatus(record), null);
  record.transcriptRevision = 0;
  assert.match(recognitionStatus(record), /已收到音频/);
  record.usage.samples = 0;
  assert.equal(recognitionStatus(record), null);
});
