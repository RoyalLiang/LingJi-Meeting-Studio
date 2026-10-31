import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { truncateText } from '../packages/records/src/text.mjs';
import { sharedMinutes } from '../packages/records/src/shared-content.mjs';
import { createRecordServer } from '../services/records/src/server.mjs';

const frontend = await Promise.all(['citation-context.ts', 'share-content.ts'].map(async file => stripTypeScriptTypes(await readFile(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8')).replace(/^import .*$/gm, '').replace(/export /g, '')));
const sandbox = { exports: {}, URL, sharedMinutes, truncateText };
vm.runInNewContext(frontend.join('\n') + '\nObject.assign(exports,{citationContext,canCreateShareLinks,minutesForShare,shareFilename,createShareDocument});', sandbox);
const { citationContext, canCreateShareLinks, minutesForShare, shareFilename, createShareDocument } = sandbox.exports;
const segment = (id, revision, text, startMs) => ({ id, revision, text, startMs, endMs: startMs + 1000, speaker: '说话人 1', sourceId: 'fixture', edited: false });
const ref = (segmentId, revision = 1) => ({ segmentId, revision });
const snapshot = [segment('s1', 1, '之前的讨论', 0), segment('s2', 1, '引用时的原文', 1000), segment('s3', 1, '之后的答复', 2000), segment('s4', 1, '表格专属引用', 3000), segment('s5', 1, '未引用的敏感内容', 4000), segment('s2', 2, '后来人工修改的原文', 1000)];
const minutes = () => ({ title: '发布准备', revision: 1, transcriptRevision: 5, evidenceSnapshot: structuredClone(snapshot), edited: false, sections: [{ heading: '安排', items: [{ text: '安排发布', evidence: [ref('s2')] }] }], actions: [], topics: [{ id: 'release', title: '发布', summary: '版本发布安排', evidence: [ref('s1')] }], tables: [{ topicId: 'release', title: '发布计划', columns: ['任务'], rows: [{ cells: ['周五发版'], evidence: [ref('s4')] }] }], speakerSummaries: [{ speakerId: null, speaker: '说话人 1', summary: '承担回归', evidence: [ref('s3')] }] });

test('citation context preserves the exact frozen revision and chronological adjacent turns without mutating the snapshot', () => {
  const unordered = [snapshot[3], snapshot[2], snapshot[0], snapshot[1]], before = JSON.stringify(unordered);
  const context = citationContext({ reference: ref('s2'), snapshot: unordered }, 1);
  assert.equal(context.target.text, '引用时的原文');
  assert.deepEqual(Array.from(context.segments, value => value.id), ['s1', 's2', 's3']);
  assert.equal(context.hasMore, true); assert.equal(JSON.stringify(unordered), before);
  assert.equal(citationContext({ reference: ref('s2', 2), snapshot: unordered }), null);
});

test('minutes-only sharing excludes every transcript snapshot while preserving summary content', () => {
  const value = minutes(), result = sharedMinutes(value);
  assert.deepEqual(result.evidenceSnapshot, []);
  assert.deepEqual(result.tables[0].rows[0].evidence, []);
  assert.equal(result.tables[0].rows[0].cells[0], '周五发版');
  assert.equal(value.evidenceSnapshot.length, 6);

});

test('share serialization removes unrecognized provider fields and internal source metadata at every level', () => {
  const value = minutes();
  value.extra = 'private metadata'; value.runtime = { private: 'runtime' };
  value.sections[0].extra = 'private section'; value.sections[0].items[0].extra = 'private item'; value.sections[0].items[0].evidence[0].extra = 'private reference';
  value.topics[0].extra = ref('s5'); value.tables[0].extra = 'private table'; value.tables[0].rows[0].extra = 'private row'; value.speakerSummaries[0].extra = 'private speaker';
  value.evidenceSnapshot[1].translationFence = 'internal fence'; value.evidenceSnapshot[1].speakerHash = 'internal hash'; value.evidenceSnapshot[1].versions = [{ text: 'unshared version' }];
  const result = JSON.stringify(sharedMinutes(value));
  assert.doesNotMatch(result, /private|internal|unshared version|sourceId|versions|runtime|未引用的敏感内容/);
  assert.doesNotMatch(result, /引用时的原文|表格专属引用/);
});

test('standalone and loopback clients never offer unreachable share links while deployed origins retain link sharing', () => {
  for (const origin of ['http://127.0.0.1:55554', 'http://127.1.2.3:3030', 'http://localhost:3000', 'http://app.localhost', 'http://[::1]:3000', 'http://0.0.0.0:3000', 'tauri://localhost', 'invalid']) assert.equal(canCreateShareLinks(false, origin), false, origin);
  assert.equal(canCreateShareLinks(true, 'https://studio.example'), false);
  assert.equal(canCreateShareLinks(false, 'https://studio.example'), true);
});

test('portable HTML escapes content and restricts minutes scope to cited frozen text without network assets or scripts', () => {
  const record = { title: '<img src=x onerror=alert(1)>', capture: 'completed', minutes: minutes(), segments: snapshot, notes: '私密人工笔记' };
  const html = createShareDocument(record, 'minutes');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /引用时的原文|表格专属引用/); assert.match(html, /承担回归/);
  assert.doesNotMatch(html, /未引用的敏感内容|后来人工修改|私密人工笔记|<script|<img|https?:\/\//);
  assert.match(html, /default-src 'none'/); assert.doesNotMatch(html, /href="#source/);
  assert.doesNotMatch(createShareDocument(record, 'full'), /未引用的敏感内容|全部转录|引用原文/);
  assert.equal(shareFilename('a/b:c'), 'a_b_c.html');
});

test('active and finishing meetings can export their available AI draft before final minutes complete', () => {
  const live = minutes(), final = { ...minutes(), title: '最终版' };
  assert.equal(minutesForShare({ capture: 'recording', minutes: final, liveMinutes: live }), live);
  assert.equal(minutesForShare({ capture: 'completed', minutes: final, liveMinutes: live }), final);
  const html = createShareDocument({ title: '会议', capture: 'completed', minutes: null, liveMinutes: live, segments: [] }, 'minutes');
  assert.doesNotMatch(html, /纪要草稿/); assert.match(html, /版本发布安排/);
});

test('HTTP read-only sharing keeps exact table sources, excludes unshared transcript and honors revocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-share-ui-'));
  const app = await createRecordServer({ root, databaseUrl: '', port: 0 });
  const address = await app.start(), base = `http://127.0.0.1:${address.port}`;
  const call = async (path, options = {}) => { const response = await fetch(base + path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } }); return { status: response.status, headers: response.headers, data: await response.json() }; };
  try {
    const login = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'share-fixture@example.invalid', password: 'fixture-password-long' }) });
    assert.equal(login.status, 200, login.data.error);
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': login.data.csrf };
    const created = await call('/api/records', { method: 'POST', headers, body: JSON.stringify({ title: '分享验收' }) }), id = created.data.id;
    assert.equal(created.status, 201, created.data.error);
    await app.repo.change(id, record => { record.capture = 'recording'; record.liveMinutes = minutes(); record.segments = structuredClone(snapshot); });
    const link = await call(`/api/records/${id}/shares`, { method: 'POST', headers, body: JSON.stringify({ scope: 'minutes' }) });
    assert.equal(link.status, 200, link.data.error);
    const shared = await call(`/api/shared/${link.data.token}`);
    assert.equal(shared.status, 200); assert.equal(shared.data.draft, undefined); assert.equal(shared.data.segments, undefined);
    assert.deepEqual(shared.data.minutes.evidenceSnapshot, []);
    await app.repo.change(id, record => { record.shares[0].scope='full'; });
    const legacy=await call(`/api/shared/${link.data.token}`);
    assert.equal(legacy.data.segments,undefined);assert.deepEqual(legacy.data.minutes.evidenceSnapshot,[]);
    assert.doesNotMatch(JSON.stringify(legacy.data),/引用时的原文|未引用的敏感内容/);
    const rejected=await call(`/api/records/${id}/shares`,{method:'POST',headers,body:JSON.stringify({scope:'full'})});
    assert.equal(rejected.status,400);
    await call(`/api/records/${id}/shares/${link.data.id}`, { method: 'DELETE', headers, body: '{}' });
    assert.equal((await call(`/api/shared/${link.data.token}`)).status, 404);
  } finally { await app.stop(); await rm(root, { recursive: true, force: true }); }
});
