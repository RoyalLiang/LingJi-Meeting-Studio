import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../services/records/src/repository.mjs';
import { createRecord } from '../packages/records/src/record.mjs';
import { knowledgeCandidates } from '../packages/records/src/knowledge.mjs';

function sealed(owner = 'owner', title = '发布会议') {
  const record = createRecord(owner, { title });
  Object.assign(record, { capture: 'completed', transcriptRevision: 1, minutesRevision: 1,
    segments: [{ id: 'segment', revision: 1, text: '周五发布。术语指增量发布。', sourceId: 'source', startMs: 0, endMs: 1000 }],
    minutes: { revision: 1, transcriptRevision: 1, topics: [{ id: 'release', title: '发布时间' }],
      decisions: [{ text: '周五发布', topicId: 'release', evidence: [{ segmentId: 'segment', revision: 1 }] }],
      actions: [{ text: '验证安装包', owner: '小陈', due: '周四', evidence: [{ segmentId: 'segment', revision: 1 }] }],
      sections: [{ heading: '风险', items: [{ kind: 'risk', text: '联调尚未完成', evidence: [{ segmentId: 'segment', revision: 1 }] }] }],
      terms: [{ text: '灰度', definition: '增量发布', evidence: [{ segmentId: 'segment', revision: 1 }] }],
    } });
  return record;
}
async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-'));
  const repo = await createRepository({ root, databaseUrl: '' });
  t.after(async () => { await repo.close(); await rm(root, { recursive: true, force: true }); });
  return repo;
}

test('sealed knowledge carries exact evidence; draft/stale sources never become knowledge', () => {
  const record = sealed();
  assert.deepEqual(knowledgeCandidates(record).map(entry => entry.kind), ['decision', 'action', 'risk', 'term']);
  record.capture = 'recording'; assert.equal(knowledgeCandidates(record).length, 0);
  record.capture = 'completed'; record.segments[0].revision++; assert.equal(knowledgeCandidates(record).length, 0);
});

test('knowledge persists, ranks and highlights as plain offsets across a hundred meetings', async t => {
  const repo = await repository(t);
  for (let i = 0; i < 100; i++) {
    const record = sealed('owner', `会议 ${i}`); record.workspaceId = i < 90 ? 'project' : null;
    await repo.insert(record);
  }
  await repo.insert(sealed('other-owner'));
  const found = await repo.listKnowledge('owner', 'project', { query: '周五发布', kind: 'decision' });
  assert.equal(found.total, 90); assert.equal(found.entries.length, 40); assert.equal(found.hasMore, true);
  assert.deepEqual(found.entries[0].highlights, [{ start: 0, end: 4 }]);
  assert.equal((await repo.listKnowledge('owner', 'inbox', { kind: 'term' })).total, 10);
  assert.equal((await repo.listKnowledge('absent', 'all')).total, 0);
  assert.equal((await repo.listKnowledge('owner', 'all', { query: '<script>' })).total, 0);
  assert.equal((await repo.listKnowledge('owner', 'project', { query: '周五发布', kind: 'decision', offset: 80 })).entries.length, 10);
});

test('reviews use a revision fence; source revision retracts evidence and deletion purges content', async t => {
  const repo = await repository(t), record = sealed(); await repo.insert(record);
  const entry = (await repo.listKnowledge('owner', 'all', { kind: 'decision' })).entries[0];
  const confirmed = await repo.reviewKnowledge('owner', 'all', entry.id, { status: 'confirmed', revision: 0 });
  assert.equal(confirmed.reviewRevision, 1);
  await assert.rejects(repo.reviewKnowledge('owner', 'all', entry.id, { status: 'dismissed', revision: 0 }), { code: 'knowledge_revision_conflict' });
  await assert.rejects(repo.reviewKnowledge('other-owner', 'all', entry.id, { status: 'confirmed', revision: 1 }), { code: 'knowledge_not_found' });
  await repo.change(record.id, value => { value.title = '重命名'; });
  assert.equal((await repo.listKnowledge('owner', 'all', { kind: 'decision' })).entries[0].status, 'confirmed');
  await repo.change(record.id, value => { value.segments[0].revision++; value.transcriptRevision++; });
  assert.equal((await repo.listKnowledge('owner', 'all')).total, 0);
  const retracted = await repo.listKnowledge('owner', 'all', { status: 'retracted' }); assert.equal(retracted.total, 4);
  await assert.rejects(repo.reviewKnowledge('owner', 'all', entry.id, { status: 'confirmed', revision: 2 }), { code: 'knowledge_retracted' });
  await repo.change(record.id, value => { value.deleted = true; });
  assert.equal((await repo.listKnowledge('owner', 'all', { status: 'retracted' })).total, 0);
});

test('SQL conflicts group Unicode and whitespace variants without inventing a contradiction', async t => {
  const repo=await repository(t),first=sealed(),second=sealed();
  first.minutes.topics[0].title='ＡＰＩ  发布时间'; second.minutes.topics[0].title='API 发布时间';second.minutes.decisions[0].text='周六发布';
  await repo.insert(first);await repo.insert(second);
  const result=await repo.listKnowledge('owner','all');assert.equal(result.conflicts.length,1);assert.equal(result.conflicts[0].entries.length,2);
  const decision=result.entries.find(entry=>entry.recordId===second.id&&entry.kind==='decision');await repo.reviewKnowledge('owner','all',decision.id,{status:'dismissed',revision:0});
  assert.equal((await repo.listKnowledge('owner','all')).conflicts.length,0);
});

test('knowledge search treats quotes and backslashes as literal text', async t => {
  const repo = await repository(t), record = sealed();
  record.minutes.decisions[0].text = '核对 "API" 和 a\\b 接口'; await repo.insert(record);
  assert.equal((await repo.listKnowledge('owner','all',{query:'"API"'})).total,1);
  assert.equal((await repo.listKnowledge('owner','all',{query:'a\\b'})).total,1);
});

test('knowledge citations open the frozen minute version and reject replacement transcript revisions',async()=>{
  const {knowledgeCitationSelection}=await import('../apps/web/src/citation-context.ts');
  const record=sealed();record.minutes.evidenceSnapshot=record.segments.map(segment=>({...segment}));
  record.transcriptRevision=2; // An unrelated record edit does not change the minute's frozen revision.
  const entry=knowledgeCandidates(record)[0];assert.equal(entry.transcriptRevision,1);
  const selection=knowledgeCitationSelection(entry,record.minutes);assert.equal(selection.reference.segmentId,'segment');assert.equal(selection.transcriptRevision,1);
  record.minutes.evidenceSnapshot[0].text='later mutation';assert.equal(selection.snapshot[0].text,'周五发布。术语指增量发布。');
  assert.throws(()=>knowledgeCitationSelection(entry,{...record.minutes,revision:2}),/原文版本已不可用/);
  assert.throws(()=>knowledgeCitationSelection(entry,{...record.minutes,evidenceSnapshot:[{...record.segments[0],revision:2}]}),/原文版本已不可用/);
});

test('manual prose keeps knowledge categories and never revives withdrawn facts',async()=>{
 const {manualMinutesContent}=await import('../packages/records/src/minutes-quality.mjs'),{validateMinutes}=await import('../packages/records/src/record.mjs');
 const record=sealed();record.minutes.evidenceSnapshot=record.segments;record.minutes.title=record.title;record.minutes.topics[0].summary='发布计划';record.minutes.topics[0].evidence=[{segmentId:'segment',revision:1}];
 record.minutes.actions.push({text:'旧任务已撤回',status:'withdrawn',evidence:[{segmentId:'segment',revision:1}]});
 assert.ok(!knowledgeCandidates(record).some(entry=>entry.text==='旧任务已撤回'));
 const manual=manualMinutesContent(record.minutes);validateMinutes(manual,record.segments);assert.deepEqual(manualMinutesContent(manual),manual);
 record.minutes={...manual,revision:2,transcriptRevision:1,evidenceSnapshot:record.segments};record.minutesRevision=2;
 assert.deepEqual(knowledgeCandidates(record).map(entry=>entry.kind).sort(),['action','decision','risk','term']);
});
