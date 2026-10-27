import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecord, validateMinutes } from '../packages/records/src/record.mjs';
import { translateText, providerStatus } from '../services/records/src/providers.mjs';
import { readConfig, saveConfig, publicConfig } from '../services/records/src/config.mjs';
import { createRepository } from '../services/records/src/repository.mjs';
import { runCycle } from '../services/records/src/worker.mjs';
import { translationChunks } from '../services/records/src/seed-translation.mjs';
import { setTranslationTarget } from '../packages/records/src/translation.mjs';
import { publicRecord, requireThat } from '../packages/records/src/record.mjs';

test('translation chunks preserve every source character within the UTF-8 budget', () => {
  const source = 'Meeting notes, keep natural word boundaries. 中文发言与 emoji 🎙️。'.repeat(60);
  const chunks = translationChunks(source);
  assert.equal(chunks.join(''), source);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) <= 768 && !chunk.includes('\uFFFD')));
  assert.deepEqual(translationChunks('hello world next words', 16), ['hello world ', 'next words']);
  assert.deepEqual(translationChunks('🎙🎙', 4), ['🎙', '🎙']);
  assert.throws(() => translationChunks(source, 3), RangeError);
});

test('translation target changes revoke worker leases and keep internal fences private', () => {
  const record = { ...createRecord('owner'), translationTarget: 'en', translationRevision: 1, segments: [{ id: 'segment', revision: 1,
    text: '原文', translation: 'Previous translation', translationLanguage: 'en', translationLease: 123,
    translationFence: 'private-fence', translationError: 'failed', translationAttempts: 3, translationRetryAt: 999 }] };
  const visible = publicRecord(record);
  assert.equal(visible.segments[0].translationLease, undefined);
  assert.equal(visible.segments[0].translationFence, undefined);
  setTranslationTarget(record, 'ja', requireThat);
  assert.equal(record.translationRevision, 2);
  assert.equal(record.segments[0].text, '原文');
  assert.equal(record.segments[0].translation, 'Previous translation');
  for (const key of ['translationLease', 'translationFence', 'translationError', 'translationAttempts', 'translationRetryAt']) assert.equal(record.segments[0][key], undefined);
  assert.throws(() => setTranslationTarget(record, 'invalid', requireThat), /invalid_translation_target/);
});

const snapshot = [{ id: 's1', revision: 2, text: 'Alpha is ready.', speaker: '', startMs: 0, endMs: 1000 }];
const evidence = [{ segmentId: 's1', revision: 2 }];
const minutes = () => ({ title: 'Fixture discussion', sections: [{ heading: 'Summary', items: [{ text: 'Alpha is ready.', evidence }] }], actions: [] });
test('summary tables and current discussion require frozen version references and bounded rectangular rows', () => {
  const result = { ...minutes(), tables: [{ title: 'Comparison', columns: ['Item', 'State'], rows: [{ cells: ['Alpha', 'Ready'], evidence }] }], currentDiscussion: [{ text: 'Alpha is ready.', evidence }] };
  assert.equal(validateMinutes(result, snapshot), result);
  for (const change of [
    value => { value.tables[0].rows[0].evidence[0].revision = 1; },
    value => { value.tables[0].rows[0].cells.pop(); },
    value => { value.tables[0].rows[0].cells[0] = null; },
    value => { value.tables[0].columns = []; },
    value => { value.tables[0].rows = []; },
    value => { value.tables[0].rows[0].evidence = [null]; },
    value => { value.tables = [null]; },
  ]) {
    const invalid = structuredClone(result); invalid.tables = structuredClone(invalid.tables); change(invalid);
    assert.throws(() => validateMinutes(invalid, snapshot), { code: 'invalid_minutes_tables' });
  }
  const invalid = structuredClone(result); invalid.currentDiscussion[0].evidence = [];
  assert.throws(() => validateMinutes(invalid, snapshot), { code: 'invalid_current_discussion' });
});

test('Doubao translation uses Responses translation_options, with a dedicated model and plain output', async () => {
  const original = globalThis.fetch; let body, requested;
  globalThis.fetch = async (url, options) => {
    requested = url; body = JSON.parse(options.body);
    return new Response(JSON.stringify({ status: 'completed', output_text: 'Alpha is ready.', choices: [{ message: { content: '{"text":"old JSON prompt"}' } }] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const url = 'https://fixture.example/translation/responses';
    const result = await translateText('甲已准备就绪。', 'en', { TRANSLATION_PROVIDER:'doubao-seed', LLM_API_URL: url, LLM_PROTOCOL: 'responses', LLM_API_KEY: 'fixture-key', LLM_MODEL: 'minutes-model' });
    assert.equal(result, 'Alpha is ready.'); assert.equal(requested, url);
    assert.equal(body.model, 'doubao-seed-translation-250915');
    assert.equal(body.input[0].content[0].text, '甲已准备就绪。');
    assert.deepEqual(body.input[0].content[0].translation_options, { target_language: 'en' });
    assert.equal(body.text, undefined); assert.equal(body.messages, undefined);
  } finally { globalThis.fetch = original; }
});

test('translation credentials are masked, preserve blank secrets, and are not reused at a different URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'live-translation-config-'));
  try {
    await saveConfig(root, { DOUBAO_TRANSLATION_API_URL: 'https://translate.example/responses', DOUBAO_TRANSLATION_API_KEY: 'translation-secret', DOUBAO_TRANSLATION_MODEL: 'ep-approved' }, {});
    await saveConfig(root, { DOUBAO_TRANSLATION_API_KEY: '' }, {});
    const config = await readConfig(root, {});
    assert.equal(config.DOUBAO_TRANSLATION_API_KEY, 'translation-secret');
    assert.equal(config.DOUBAO_TRANSLATION_MODEL, 'ep-approved');
    assert.equal(publicConfig(config).DOUBAO_TRANSLATION_API_KEY, true);
    assert.equal(JSON.stringify(publicConfig(config)).includes('translation-secret'), false);
    assert.equal(providerStatus(config).translation, true);
    assert.equal(providerStatus({ LLM_API_URL: 'https://minutes.example/responses', LLM_API_KEY: 'minutes-secret', DOUBAO_TRANSLATION_API_URL: 'https://other.example/responses' }).translation, false);
    await assert.rejects(translateText('test', 'en', { LLM_API_URL: 'https://minutes.example/responses', LLM_API_KEY: 'minutes-secret', DOUBAO_TRANSLATION_API_URL: 'https://other.example/responses' }), { code: 'translation_not_configured' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const fail of [false, true]) test(`translation ${fail ? 'failure' : 'success'} from a previous enable cycle cannot modify the current cycle`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'live-translation-fence-')); const repo = await createRepository({ root });
  let release;
  try {
    const record = createRecord('owner'); record.capture = 'completed'; record.translationTarget = 'en'; record.translationRevision = 1; record.segments = structuredClone(snapshot);
    await repo.insert(record);
    const work = runCycle(repo, { translate: () => new Promise((resolve, reject) => { release = () => fail ? reject(new Error('old failure')) : resolve('Old translation'); }) }, { lane: 'translation' });
    for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(release);
    await repo.change(record.id, r => { r.translationRevision = 3; r.translationTarget = 'en'; for (const s of r.segments) { delete s.translationLease; delete s.translationFence; } });
    release(); await work;
    const current = await repo.get(record.id);
    assert.equal(current.segments[0].translation, undefined);
    assert.equal(current.segments[0].translationError, undefined);
  } finally { await repo.close(); await rm(root, { recursive: true, force: true }); }
});
