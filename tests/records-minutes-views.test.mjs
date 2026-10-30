import { minutesActionText } from '../packages/records/src/minutes-quality.mjs';
import { speakerLabels as sharedSpeakerLabels } from '../packages/records/src/minutes-speakers.mjs';
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
const sandbox = {exports:{},minutesActionText,speakerLabels:sharedSpeakerLabels};
vm.runInNewContext(source + '\nObject.assign(exports,{topicBranches,speakerViews,decisionItems,currentMinutesJob,speakerLabels});', sandbox);
const {topicBranches,speakerViews,decisionItems,currentMinutesJob,speakerLabels} = sandbox.exports;
const usageSource=stripTypeScriptTypes(await readFile(new URL('../apps/web/src/minutes-usage.ts',import.meta.url),'utf8')).replace(/^import .*$/gm,'').replace(/export /g,'');
vm.runInNewContext(usageSource+'\nObject.assign(exports,{minutesUsageView});',sandbox);
const {minutesUsageView}=sandbox.exports;

test('meeting audio display uses the shared timeline rather than summing parallel tracks',()=>{
 const record={durationMs:281000,usage:{samples:16000*562,llmTokens:0}};
 assert.equal(minutesUsageView(record).audio,'04:41');
});

test('minutes usage distinguishes unknown tokens from a provider zero and uses the shared recording timeline',()=>{
 const record={durationMs:123000,usage:{samples:16000*246,llmTokens:0}};
 let usage=minutesUsageView(record,{status:'running'});assert.equal(usage.audio,'02:03');assert.equal(usage.tokens,'待回传');assert.equal(usage.showBreakdown,false);
 usage=minutesUsageView(record);assert.equal(usage.tokens,'未提供');
 record.usage.minutesMeter={requests:1,reportedRequests:1,totalTokens:0,totalTokensRequests:1,inputTokens:0,inputTokensRequests:1,outputTokens:0,outputTokensRequests:1};
 usage=minutesUsageView(record);assert.equal(usage.tokens,'0 token');assert.equal(usage.input,'0');assert.equal(usage.output,'0');
 record.usage.llmTokens=99999;record.usage.minutesMeter.totalTokens=1234;record.usage.minutesMeter.requests=2;usage=minutesUsageView(record);assert.equal(usage.tokens,'1,234 token');assert.match(usage.status,/部分/);
 const legacy=minutesUsageView({usage:{samples:0,llmTokens:50}});assert.equal(legacy.tokens,'未提供');assert.equal(legacy.showBreakdown,false);
});
test('incomplete historical usage snapshots stay unknown without crashing or manufacturing audio zero',()=>{
 for(const usage of [undefined,null,'old-format',[],{}, {samples:-1}, {samples:'16000'}, {samples:Infinity}, {samples:NaN}, {minutesMeter:42}, {minutesMeter:{requests:1,reportedRequests:1,totalTokensRequests:1,totalTokens:'0',inputTokensRequests:1,inputTokens:-1}}]) {
  const view=minutesUsageView({usage});assert.equal(view.audio,'—');assert.equal(view.tokens,'未提供');assert.equal(view.showBreakdown,false);
 }
 const current=minutesUsageView({durationMs:0,usage:{samples:0,llmTokens:0,minutesMeter:{requests:1,reportedRequests:1,totalTokens:0,totalTokensRequests:1}}});
 assert.equal(current.audio,'00:00');assert.equal(current.tokens,'0 token');
});

test('ended meeting status ignores old live failures and old transcript failures while preserving current final errors', () => {
  const record={capture:'completed',transcriptRevision:4,jobs:[{id:'live',scope:'live',status:'failed',transcriptRevision:4}]};
  assert.equal(currentMinutesJob(record).id,'live');
  record.jobs.push({id:'old-final',scope:'final',status:'failed',transcriptRevision:3});assert.equal(currentMinutesJob(record).id,'live');
  record.jobs.push({id:'final',scope:'final',status:'running',transcriptRevision:4});assert.equal(currentMinutesJob(record).id,'final');
  record.jobs.push({id:'cancelled',scope:'final',status:'cancelled',transcriptRevision:4});assert.equal(currentMinutesJob(record).id,'final');
  record.jobs[2].status='failed';assert.equal(currentMinutesJob(record).status,'failed');
  record.jobs.push({id:'success',scope:'final',status:'completed',transcriptRevision:4});assert.equal(currentMinutesJob(record).id,'success');
});

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
  assert.equal(branches[0].items.length,0);
  assert.equal(branches[1].items.length,0);
  assert.equal(branches[2].title,'讨论重点');
  assert.equal(branches[2].items.length,2);
  assert.equal(branches[2].items[1].evidence[0].segmentId,'s2');
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

test('a failed latest request stays visible while later transcript chunks arrive',()=>{
 const failed={id:'failed-request',status:'failed',scope:'live',transcriptRevision:7,error:'llm_timeout'};
 const record={capture:'recording',transcriptRevision:558,jobs:[failed]};
 assert.equal(currentMinutesJob(record)?.id,failed.id);
});


test('known speaker identities use the meeting registry while frozen names and revisions remain authoritative',()=>{
 const parts=[{id:'a',revision:1,speaker:'',speakerId:'person-b'},{id:'b',revision:1,speaker:'旧姓名',speakerId:'person-a'},{id:'c',revision:1,speaker:''}];
 const labels=speakerLabels(parts,[{id:'person-a',label:'说话人 1'},{id:'person-b',label:'说话人 2'}],[{id:'c',revision:2,speaker:'新修订错误归属'}]);
 assert.equal(labels.get('a:1'),'说话人2');assert.equal(labels.get('b:1'),'说话人1');assert.equal(labels.get('c:1'),'未区分说话人');
});

test('minutes annotations show stable speaker numbers rather than names',()=>{
 const parts=[{id:'a',revision:1,speaker:'李工',speakerId:'b'},{id:'b',revision:1,speaker:'张工',speakerId:'a'},{id:'c',revision:1,speaker:'王工',speakerId:'c'},{id:'unknown',revision:1,speaker:''}];
 const labels=speakerLabels(parts,[{id:'a',label:'张工'},{id:'b',label:'李工'},{id:'c',label:'王工'}],[{id:'b',revision:2,speakerId:'c',speaker:'王工'}]);
 assert.equal(labels.get('a:1'),'说话人2');assert.equal(labels.get('b:1'),'说话人1');assert.equal(labels.get('c:1'),'说话人3');assert.equal(labels.get('unknown:1'),'未区分说话人');
});

test('retained process sections keep project headings even when a broad root topic cites the same source',()=>{
  const value=base(),evidence=[ref(0)];
  value.topics=[{id:'general',title:'项目讨论',summary:'两个项目已讨论。',evidence}];
  value.sections=['项目A','项目B'].map(name=>({heading:`讨论过程 · ${name}`,items:[{text:'颜色蓝色',kind:'fact',label:'过程记录',evidence}]}));
  const branches=topicBranches(value);
  for(const name of ['项目A','项目B'])assert.equal(branches.find(branch=>branch.title===`讨论过程 · ${name}`)?.items[0].text,'颜色蓝色');
});

test('ordinary section headings remain authoritative under a broad shared-source topic',()=>{
  const value=base(),evidence=[ref(0)];
  value.topics=[{id:'general',title:'整体情况',summary:'两个项目已讨论。',evidence}];
  value.sections=['项目A','项目B'].map(heading=>({heading,items:[{text:'颜色蓝色',evidence}]}));
  const branches=topicBranches(value);
  for(const heading of ['项目A','项目B'])assert.equal(branches.find(branch=>branch.title===heading)?.items[0].text,'颜色蓝色');
});

test('labels and item context are not removed by paragraph text deduplication',()=>{
  const value=base(),evidence=[ref(0)];
  value.topics=[{id:'general',title:'项目讨论',summary:'颜色蓝色',evidence}];
  value.sections=[{heading:'项目讨论',items:['项目A','项目B'].map(label=>({text:'颜色蓝色',label,evidence}))}];
  const branch=topicBranches(value)[0];
  assert.deepEqual(Array.from(branch.items,item=>item.label),['项目A','项目B']);
});

test('explicit broad topic membership keeps the source project context in each card',()=>{
  const value=base(),evidence=[ref(0)];
  value.topics=[{id:'general',title:'整体情况',summary:'两个项目已讨论。',evidence}];
  value.sections=['项目A','项目B'].map(heading=>({heading,items:[{text:'颜色蓝色',topicId:'general',evidence}]}));
  assert.deepEqual(Array.from(topicBranches(value)[0].items,item=>item.label),['项目A','项目B']);
});


test('legacy minutes without a snapshot still resolve exact current speaker revisions',()=>{
 const labels=speakerLabels([],[{id:'speaker-a',label:'说话人 1'}],[{id:'spoken',revision:4,speakerId:'speaker-a',speaker:''}]);
 assert.equal(labels.get('spoken:4'),'说话人1');assert.equal(labels.has('spoken:3'),false);
});
