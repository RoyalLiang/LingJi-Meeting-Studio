import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelRoles, roleModelConfig, minutesModelRouting, minutesRoleConfig } from '../services/records/src/model-roles.mjs';
import { createRecord, requestMinutes } from '../packages/records/src/record.mjs';
import { generateMinutes, translateText, analyzeIntents } from '../services/records/src/providers.mjs';
import { buildMinutesManifest } from '../services/records/src/minutes-pipeline.mjs';
import { translationConnection } from '../services/records/src/seed-translation.mjs';
import { setAutomation, queueAutomaticMinutes } from '../packages/records/src/automation.mjs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { createWorkerWakeup } from '../services/records/src/worker-wakeup.mjs';
import { createRepository } from '../services/records/src/repository.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('role models inherit defaults and preserve the configured gateway without copying model facts', () => {
  const config = { LLM_MODEL: 'default-model', LLM_API_KEY: 'synthetic-only', LLM_API_URL: 'https://fixture.invalid', LLM_MODEL_FACTS: { catalog: { contextWindow: 90000 } }, LLM_ROLE_MODELS: JSON.stringify({ translation: 'fast-model', minutesFinal: 'default-model' }) };
  const fast = roleModelConfig(config, 'translation');
  assert.equal(fast.LLM_MODEL, 'fast-model');
  assert.equal(fast.LLM_API_KEY, config.LLM_API_KEY);
  assert.equal(fast.LLM_API_URL, config.LLM_API_URL);
  assert.equal(fast.LLM_MODEL_FACTS, undefined);
  assert.strictEqual(roleModelConfig(config, 'minutesFinal'), config);
  assert.strictEqual(roleModelConfig(config, 'analysis'), config);
  assert.equal(roleModelConfig(config, 'translation', '{"translation":"frozen-model"}').LLM_MODEL, 'frozen-model');
});

test('role model configuration rejects unknown roles and malformed model identifiers', () => {
  assert.deepEqual(parseModelRoles(), {});
  for (const value of ['{', 'null', '[]', '{"unknown":"model"}', '{"translation":1}', '{"analysis":" x"}', '{"analysis":"a\\nb"}', '{"__proto__":"x"}']) {
    assert.throws(() => parseModelRoles(value), { code: 'invalid_model_roles', status: 400 });
  }
  assert.throws(() => roleModelConfig({}, 'unknown'), { code: 'invalid_model_role' });
});

test('minutes routing is canonical, frozen in the job and part of request deduplication', () => {
  const routing = minutesModelRouting({ LLM_ROLE_MODELS: '{"translation":"unused","minutesFinal":"final-model","minutesMap":"map-model"}' });
  assert.equal(routing, '{"minutesMap":"map-model","minutesFinal":"final-model"}');
  assert.equal(minutesModelRouting({ LLM_ROLE_MODELS: '{"translation":"unused"}' }), '');
  const record = createRecord('owner');
  record.capture = 'completed';
  record.segments = [{ id: 's1', revision: 1, text: '合成会议来源', startMs: 0, endMs: 1000 }];
  const first = requestMinutes(record, { modelVersion: 'base', modelRouting: routing });
  assert.strictEqual(requestMinutes(record, { modelVersion: 'base', modelRouting: routing }), first);
  const second = requestMinutes(record, { modelVersion: 'base', modelRouting: '{"minutesFinal":"changed-model"}' });
  assert.notEqual(second.id, first.id);
  assert.equal(first.modelRouting, routing);
  const plain = createRecord('owner'); plain.capture = 'completed'; plain.segments = record.segments;
  assert.equal(requestMinutes(plain, { modelVersion: 'base' }).modelRouting, '');
});

test('production request paths route all roles through a fixture gateway', async t => {
  const original = globalThis.fetch, models = [];
  t.after(() => { globalThis.fetch = original; });
  const evidence = [{ segmentId: 's1', revision: 1 }];
  const minutes = { title: '合成纪要', sections: [{ heading: '要点', items: [{ text: '合成内容', evidence }] }], actions: [] };
  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body); models.push(body.model);
    const result = body.model === 'translate-model' ? { translation: '合成译文' } : body.model === 'intent-model' ? { items: [] } : minutes;
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  };
  const env = { LLM_API_URL: 'https://fixture.invalid/v1/chat/completions', LLM_API_KEY: 'synthetic-key', LLM_MODEL: 'base', LLM_PROTOCOL: 'chat-completions', TRANSLATION_PROVIDER: 'text-model', LLM_ROLE_MODELS: JSON.stringify({ translation: 'translate-model', intents: 'intent-model', minutesMap: 'map-model', minutesFinal: 'final-model' }) };
  assert.equal(await translateText('合成内容', 'en', env), '合成译文');
  assert.equal(await translateText('合成内容', 'en', { ...env, TRANSLATION_PROVIDER: 'auto', LLM_API_URL: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions' }), '合成译文');
  assert.deepEqual((await analyzeIntents([{ id: 's1', revision: 1, text: '合成内容' }], env)).items, []);
  const job = { template: 'meeting', scope: 'final', modelVersion: 'base', modelRouting: minutesModelRouting(env), snapshot: [{ id: 's1', revision: 1, text: '合成内容' }] };
  await generateMinutes({ ...job, stage: 'window' }, env);
  await generateMinutes({ ...job, stage: 'synthesis' }, env);
  await generateMinutes({ ...job, stage: 'single' }, env);
  await generateMinutes({ ...job, scope: 'live', stage: 'single' }, env);
  await generateMinutes({ ...job, stage: 'window', modelRouting: '{"minutesMap":"frozen-model"}' }, env);
  await generateMinutes({ ...job, stage: 'single', modelRouting: '' }, env);
  const legacy = { ...job, stage: 'single' }; delete legacy.modelRouting;
  await generateMinutes(legacy, env);
  assert.deepEqual(models, ['translate-model', 'translate-model', 'intent-model', 'map-model', 'final-model', 'final-model', 'map-model', 'frozen-model', 'base', 'base']);
  assert.equal(translationConnection({ ...env, TRANSLATION_PROVIDER: 'doubao-seed' }).model, 'doubao-seed-translation-250915');
});

test('role planning caps source windows and synthesis at their own model limits', () => {
  const config = { LLM_MODEL: 'base', LLM_MODEL_PROFILES: JSON.stringify({ base: { contextWindow: 131072, maxOutputTokens: 8192 }, small: { contextWindow: 16384, maxOutputTokens: 4096 } }) };
  const job = { scope: 'final', modelVersion: 'base', modelRouting: '{"minutesMap":"small"}', generation: 1, transcriptRevision: 1, notesRevision: 0, snapshot: Array.from({ length: 120 }, (_, i) => ({ id: 's' + i, revision: 1, text: '合成来源内容。'.repeat(100), startMs: i * 1000, endMs: (i + 1) * 1000 })) };
  const mapped = buildMinutesManifest(job, config);
  assert.ok(mapped.budget >= 4096 && mapped.budget <= 7000);
  assert.ok(mapped.windows.length > 10);
  const reduced = buildMinutesManifest({ ...job, modelRouting: '{"minutesFinal":"small"}' }, config);
  assert.ok(reduced.synthesisBudget >= 4096 && reduced.synthesisBudget <= 7000);
  assert.ok(reduced.budget <= 7000, 'a single-window final must also fit the final model');
});

test('dedicated audio model prefixes preserve their own model facts and settings', () => {
  for (const mode of ['doubao-audio', 'doubao-audio-only', 'openai-realtime']) {
    const config = { MINUTES_MODE: mode, LLM_MODEL: 'audio-A', LLM_MODEL_FACTS: { reasoningUnsupported: true }, LLM_ROLE_MODELS: '{"minutesMap":"text-only-model"}' };
    assert.strictEqual(minutesRoleConfig({ modelVersion: mode + ':audio-A', scope: 'live', stage: 'single' }, config), config);
    assert.equal(minutesModelRouting(config), '');
  }
});

test('legacy jobs without a routing field retain their bounded automatic retry chain', () => {
  const record = createRecord('owner'); record.capture = 'completed'; record.transcriptRevision = 1;
  record.segments = [{ id: 's1', revision: 1, text: '合成会议来源', startMs: 0, endMs: 1000 }];
  setAutomation(record, { enabled: true }, 1000);
  const previous = queueAutomaticMinutes(record, 'base', 1000);
  Object.assign(previous, { status: 'failed', error: 'llm_timeout', failedAt: 1000, retryAttempt: 2, retryOf: 'first-attempt' });
  delete previous.modelRouting;
  const retry = queueAutomaticMinutes(record, 'base', 31000);
  assert.equal(retry.retryAttempt, 3);
  assert.equal(retry.retryOf, 'first-attempt');
});

test('model settings edits preserve other roles and clearing a role restores inheritance', async () => {
  const source = await readFile(new URL('../apps/web/src/provider-settings.ts', import.meta.url), 'utf8');
  const compiled = stripTypeScriptTypes(source);
  const ui = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
  const initial = '{"translation":"fast-model","minutesFinal":"final-model"}';
  const changed = ui.updateModelRole(initial, 'minutesMap', 'map-model');
  assert.deepEqual(ui.modelRoleValues(changed), { translation: 'fast-model', minutesFinal: 'final-model', minutesMap: 'map-model' });
  const cleared = ui.updateModelRole(changed, 'minutesFinal', '');
  assert.deepEqual(ui.modelRoleValues(cleared), { translation: 'fast-model', minutesMap: 'map-model' });
  for (const invalid of ['{', 'null', '[]']) assert.deepEqual(ui.modelRoleValues(invalid), {});
});

test('worker wakeups retain changes during a cycle and close every waiting lane', async () => {
  let notify, unsubscribed = 0;
  const wakeup = createWorkerWakeup({ subscribeChanges(listener, options) { notify = listener; assert.equal(options.all, true); return () => { unsubscribed++; }; } });
  const before = wakeup.cursor(); notify(['changed-during-cycle']);
  let ready = false; void wakeup.wait(before, 30000).then(() => { ready = true; });
  await Promise.resolve(); assert.equal(ready, true);
  const first = wakeup.wait(wakeup.cursor(), 30000), second = wakeup.wait(wakeup.cursor(), 30000);
  wakeup.close(); await Promise.all([first, second]);
  wakeup.close(); assert.equal(unsubscribed, 1);
});

test('SQLite change listeners see committed writes, preserve completed-only policy and ignore no-ops', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lingji-event-policy-')), repo = await createRepository({ root, databaseUrl: '' });
  t.after(async () => { await repo.close(); await rm(root, { recursive: true, force: true }); });
  const all = [], completed = [];
  repo.subscribeChanges(ids => all.push(ids), { all: true }); repo.subscribeChanges(ids => completed.push(ids));
  const record = createRecord('owner'); record.capture = 'completed'; await repo.insert(record);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(completed, [[record.id]]); assert.deepEqual(all, [[record.id]]);
  all.length = 0; completed.length = 0;
  await repo.change(record.id, () => {}); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(all, []); assert.deepEqual(completed, []);
  await repo.change(record.id, value => { value.title = 'synthetic update'; }, { returnRecord: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(all, [[record.id]]); assert.deepEqual(completed, []);
  all.length = 0;
  await assert.rejects(repo.change(record.id, value => { value.title = 'rolled back'; throw new Error('synthetic rollback'); }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(all, []); assert.equal((await repo.get(record.id)).title, 'synthetic update');
});

test('SQLite changes from another connection wake an idle worker and expose committed state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lingji-event-external-'));
  const reader = await createRepository({ root, databaseUrl: '' }), writer = await createRepository({ root, databaseUrl: '' });
  const wakeup = createWorkerWakeup(reader);
  t.after(async () => { wakeup.close(); await writer.close(); await reader.close(); await rm(root, { recursive: true, force: true }); });
  const cursor = wakeup.cursor(), waiting = wakeup.wait(cursor, 5000);
  const record = createRecord('owner'); await writer.insert(record);
  await waiting;
  assert.notEqual(wakeup.cursor(), cursor, 'must wake on the external commit rather than only the deadline');
  assert.equal((await reader.get(record.id)).id, record.id);
  assert.equal(await reader.nextWorkAt('minutes'), Infinity);
  await assert.rejects(reader.nextWorkAt('unknown'), { code: 'invalid_worker_lane' });
});

test('an idle event-driven worker exits promptly on SIGTERM instead of waiting for its long deadline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lingji-worker-stop-'));
  const child = spawn(process.execPath, ['services/records/src/worker.mjs'], { cwd: process.cwd(), env: { ...process.env, RECORD_DATA_DIR: root, RECORD_DATABASE_URL: '', NODE_ENV: 'test', RECORD_PROVIDER: 'mock', RECORD_LEARNING_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; } await rm(root, { recursive: true, force: true }); });
  let output = '', errors = '';
  child.stderr.on('data', bytes => { errors += bytes; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker startup timeout: ' + errors.slice(-1000))), 10000);
    child.once('error', reject);
    child.stdout.on('data', bytes => { output += bytes; if (output.includes('[record-worker]')) { clearTimeout(timer); resolve(); } });
  });
  const exit = once(child, 'exit'); child.kill('SIGTERM');
  let timer;
  try {
    const [code, signal] = await Promise.race([exit, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('idle worker did not stop promptly')), 5000); })]);
    assert.equal(code, 0, errors); assert.equal(signal, null);
  } finally { clearTimeout(timer); }
});
