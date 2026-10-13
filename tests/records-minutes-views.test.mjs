import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { validateMinutes } from '../packages/records/src/record.mjs';
import { createRecord, requestMinutes, commitMinutes } from '../packages/records/src/record.mjs';
import { generateMinutes } from '../services/records/src/providers.mjs';
import http from 'node:http';

const snapshot = [
  { id:'s1', revision:1, speakerId:'person-a', speaker:'说话人 1', text:'周五发布第一版。', startMs:0, endMs:2000 },
  { id:'s2', revision:2, speakerId:'person-b', speaker:'说话人 2', text:'我负责回归测试。', startMs:2000, endMs:4000 },
  { id:'s3', revision:1, speakerId:null, speaker:'', text:'这个问题还需要确认。', startMs:4000, endMs:6000 },
];
const ref = index => ({ segmentId:snapshot[index].id, revision:snapshot[index].revision });
const base = () => ({ title:'发布准备', sections:[{heading:'讨论重点',items:[{text:'周五发布第一版。',evidence:[ref(0)]},{text:'回归测试由说话人 2 负责。',evidence:[ref(1)]}]}], actions:[], evidenceSnapshot:structuredClone(snapshot) });
const source = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/minutes-views.ts', import.meta.url),'utf8')).replace(/^import .*$/gm,'').replace(/export /g,'');
const sandbox = {exports:{}};
vm.runInNewContext(source + '\nObject.assign(exports,{topicBranches,speakerViews,decisionItems});', sandbox);
const {topicBranches,speakerViews,decisionItems} = sandbox.exports;

test('speaker summaries and decisions validate evidence revisions and persist stable speaker attribution', () => {
  const minutes = {...base(), speakerSummaries:[{speakerId:'person-a',speaker:'说话人 1',summary:'确认第一版发布时间。',evidence:[ref(0)]}],decisions:[{text:'第一版周五发布。',evidence:[ref(0)]}]};
  assert.equal(validateMinutes(minutes,snapshot),minutes);
  assert.equal(speakerViews(minutes)[0].method,'summary');
  assert.equal(decisionItems(minutes).length,1);
  const invalid=structuredClone(minutes); invalid.speakerSummaries[0].evidence=[ref(1)];
  assert.throws(()=>validateMinutes(invalid,snapshot),{code:'speaker_evidence_mismatch'});
  invalid.speakerSummaries[0].evidence=[{segmentId:'s1',revision:9}];
  assert.throws(()=>validateMinutes(invalid,snapshot),{code:'invalid_speaker_summaries'});
});

test('invented speaker names, duplicate identities and unsupported decisions are rejected', () => {
  const minutes = {...base(),speakerSummaries:[{speakerId:'person-a',speaker:'总经理',summary:'确认发布。',evidence:[ref(0)]}]};
  assert.throws(()=>validateMinutes(minutes,snapshot),{code:'speaker_evidence_mismatch'});
  minutes.speakerSummaries[0].speaker='说话人 1'; minutes.speakerSummaries.push(structuredClone(minutes.speakerSummaries[0]));
  assert.throws(()=>validateMinutes(minutes,snapshot),{code:'invalid_speaker_summaries'});
  assert.throws(()=>validateMinutes({...base(),decisions:[{text:'立即发布',evidence:[]}]},snapshot),{code:'invalid_minutes_decisions'});
  assert.throws(()=>validateMinutes({...base(),decisions:[null]},snapshot),{code:'invalid_minutes_decisions'});
  assert.throws(()=>validateMinutes({...base(),speakerSummaries:[null]},snapshot),{code:'invalid_speaker_summaries'});
  assert.throws(()=>validateMinutes({...base(),decisions:[{text:'发布',evidence:[null]}]},snapshot),{code:'invalid_minutes_decisions'});
});

test('topic trees preserve uncovered information without repeating the same minute item across branches', () => {
  const minutes={...base(),topics:[{title:'发布时间',summary:'第一版计划',evidence:[ref(0)]},{title:'重复引用的讨论',summary:'时间复核',evidence:[ref(0)]}]};
  const branches=topicBranches(minutes);
  assert.equal(branches[0].items.length,1);
  assert.equal(branches[1].items.length,0);
  assert.equal(branches[2].title,'其他讨论要点');
  assert.equal(branches[2].items[0].evidence[0].segmentId,'s2');
});

test('legacy summaries remain excerpts and unknown voices never become invented speaker summaries', () => {
  const minutes=base();
  assert.equal(validateMinutes(minutes,snapshot),minutes);
  const speakers=speakerViews(minutes);
  assert.equal(speakers.length,2);
  assert.ok(speakers.every(s=>s.method==='extract'));
  assert.equal(speakers[0].speakerId,'person-a');
  assert.equal(decisionItems(minutes).length,0);
  assert.equal(topicBranches(minutes)[0].title,'讨论重点');
});

test('explicit table topic identity is unique and does not replace frozen row evidence', () => {
  const value = { ...base(), topics: [{ id: 'release', title: '发布', summary: '发布准备', evidence: [ref(0)] }], tables: [{
    title: '回归安排', topicId: 'release', columns: ['工作', '时间'], rows: [{ cells: ['测试', '周四'], evidence: [ref(1)] }],
  }] };
  assert.equal(validateMinutes(value, snapshot), value);
  for (const id of ['', null, ' '.repeat(3), 'x'.repeat(81)]) {
    const invalid = structuredClone(value); invalid.topics[0].id = id;
    assert.throws(() => validateMinutes(invalid, snapshot), { code: 'invalid_minutes_topics' });
  }
  const duplicate = structuredClone(value); duplicate.topics.push(structuredClone(duplicate.topics[0]));
  assert.throws(() => validateMinutes(duplicate, snapshot), { code: 'invalid_minutes_topics' });
  const missing = structuredClone(value); missing.tables[0].topicId = 'unknown';
  assert.throws(() => validateMinutes(missing, snapshot), { code: 'invalid_minutes_tables' });
  const stale = structuredClone(value); stale.tables[0].rows[0].evidence[0].revision = 9;
  assert.throws(() => validateMinutes(stale, snapshot), { code: 'invalid_minutes_tables' });
});

test('configured model request generates and commits new views with the frozen transcript identity', async t => {
  let instruction='';
  const result={...base(),topics:[{id:'release',title:'发布准备',summary:'发布前完成回归。',evidence:[ref(0)]}],tables:[{topicId:'release',title:'回归安排',columns:['工作','时间'],rows:[{cells:['回归测试','周四'],evidence:[ref(1)]}]}],speakerSummaries:[{speakerId:'person-b',speaker:'说话人 2',summary:'承担回归测试。',evidence:[ref(1)]}],decisions:[{text:'周五发布。',evidence:[ref(0)]}]};
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    instruction=JSON.parse(body).messages[0].content;
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const record=createRecord('test-owner',{autoMinutes:false});record.capture='completed';record.transcription='ready';record.segments=structuredClone(snapshot);record.transcriptRevision=3;
  const job=requestMinutes(record,{mode:'model'});job.fence='test-fence';
  const minutes=await generateMinutes(job,{LLM_API_URL:`http://127.0.0.1:${server.address().port}`,LLM_API_KEY:'fixture-key',LLM_MODEL:'fixture-model',LLM_PROTOCOL:'chat-completions'});
  assert.match(instruction,/speakerSummaries/);assert.match(instruction,/decisions/);assert.match(instruction,/speakerId/);
  assert.match(instruction,/topicId/);
  commitMinutes(record,job.id,minutes,job.fence);
  assert.equal(record.minutes.speakerSummaries[0].speakerId,'person-b');
  assert.equal(record.minutes.decisions[0].evidence[0].revision,1);
  assert.equal(record.minutes.evidenceSnapshot[1].revision,2);
  assert.equal(record.minutes.topics[0].id,'release');
  assert.equal(record.minutes.tables[0].topicId,'release');
});
