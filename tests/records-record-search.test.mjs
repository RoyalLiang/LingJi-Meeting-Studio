import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecord } from '../packages/records/src/record.mjs';
import { createRepository } from '../services/records/src/repository.mjs';
import { searchHighlights, recordSearchBody } from '../services/records/src/record-search.mjs';

async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), 'lingji-record-search-')); let repo = await createRepository({ root });
  try { await work({ repo, reopen: async () => { await repo.close(); repo = await createRepository({ root }); return repo; } }); }
  finally { await repo.close(); await rm(root, { recursive: true, force: true }); }
}
function searchable(owner, title, text, createdAt = '2026-11-09T00:00:00Z') {
  const record = createRecord(owner, { title, language: 'zh', autoMinutes: false }); record.title = title; record.createdAt = createdAt;
  record.segments.push({ id: 'segment', revision: 1, sourceId: 'text-import', text, speaker: '', startMs: 0, endMs: 0, edited: false }); return record;
}

test('literal full-record search ranks by BM25, keeps scope and retention, and returns safe original-case excerpts without hydrating records', async () => fixture(async ({ repo, reopen }) => {
  const dense = searchable('owner', '早期讨论', '性能卡点。性能卡点需要优先排查。', '2026-11-08T00:00:00Z');
  const sparse = searchable('owner', '最新讨论', '性能卡点。' + '其他内容。'.repeat(500));
  const hidden = searchable('other', '其他用户', '性能卡点');
  const scoped = searchable('owner', '单独目录', '性能卡点'); scoped.workspaceId = 'separate';
  const expired = searchable('owner', '到期内容', '性能卡点'); expired.deleteAt = '2000-01-01T00:00:00Z';
  for (const record of [dense, sparse, hidden, scoped, expired]) await repo.insert(record);
  const get = repo.get; repo.get = () => assert.fail('search must not hydrate records');
  let results = await repo.listSummaries('owner', 'inbox', '性能卡点'); assert.deepEqual(results.map(result => result.id), [dense.id, sparse.id]);
  assert.equal(results[0].search.snippet.slice(results[0].search.highlights[0].start, results[0].search.highlights[0].end), '性能卡点');
  assert.equal((await repo.listSummaries('owner', 'separate', '性能卡点')).length, 1);
  assert.equal((await repo.listSummaries('owner', 'inbox', '卡点')).length, 2);
  assert.ok((await repo.listSummaries('owner', 'inbox')).every(result => !result.search)); repo.get = get;
  await repo.change(dense.id, record => { record.segments[0].text = '已经完成'; });
  assert.equal((await repo.listSummaries('owner', 'inbox', '性能卡点')).length, 1);
  repo = await reopen(); results = await repo.listSummaries('owner', 'inbox', '性能卡点'); assert.equal(results[0].id, sparse.id);
}));

test('search literals preserve quotes, backslashes, Unicode offsets and HTML as text', async () => fixture(async ({ repo }) => {
  const record = searchable('owner', 'İstanbul 🚢 复盘', 'Quote"slash\\ <img src=x onerror=alert(1)> 尚需确认。'); await repo.insert(record);
  for (const query of ['Quote"slash\\', '<img src=x', '🚢', 'İ']) {
    const results = await repo.listSummaries('owner', 'all', query); assert.equal(results.length, 1);
    assert.ok(results[0].search.highlights.length || results[0].search.titleHighlights.length);
  }
  assert.deepEqual(searchHighlights('İstanbul 🚢', 'İ'), [{ start: 0, end: 1 }]);
  assert.deepEqual(searchHighlights('İstanbul 🚢', '🚢'), [{ start: 9, end: 11 }]);
  await assert.rejects(repo.listSummaries('owner', 'all', '\0'), { code: 'invalid_search_query' });
}));

test('minute search indexes user-facing values and excludes internal IDs and frozen evidence snapshots', () => {
  const record = searchable('owner', '会议主题', '当前原文'); record.minutes = { title: '决策归档', sections: [{ heading: '风险', items: [{ text: '发布需要复验', evidence: [{ segmentId: 'private-internal-id', revision: 1 }] }] }], evidenceSnapshot: [{ text: '已经撤销的旧原文' }], speakerSummaries: [{speaker:'小林',summary:'提出交付安排'}], tables: [{ columns: ['项目'], rows: [{ cells: ['完整说明'] }] }] };
  const body = recordSearchBody(record); assert.match(body, /发布需要复验/); assert.match(body, /完整说明/); assert.match(body,/小林/); assert.doesNotMatch(body, /private-internal-id|已经撤销的旧原文|segmentId/);
});


test('excerpt positions survive Unicode case expansion and include the full maximum-length query', async () => fixture(async ({ repo }) => {
  const unicode = searchable('owner', 'Unicode前缀', 'İ'.repeat(100) + 'Target');
  const long = searchable('owner', '长关键词', 'a'.repeat(100) + 'x'.repeat(200));
  await repo.insert(unicode); await repo.insert(long);
  for (const query of ['Target', 'x'.repeat(200)]) {
    const [result] = await repo.listSummaries('owner', 'all', query); assert.ok(result.search.highlights.length);
    const range = result.search.highlights[0]; assert.equal(result.search.snippet.slice(range.start, range.end).toLowerCase(), query.toLowerCase());
    assert.ok(Array.from(result.search.snippet).length <= 320);
  }
}));
