import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord,editSegment} from '../packages/records/src/record.mjs';
import {createMeetingAgentRuntime} from '../services/records/src/meeting-agent.mjs';
import {questionKeywords,knowledgeSnapshot} from '../services/records/src/knowledge-questions.mjs';
function sealed(index,owner='owner'){
 const record=createRecord(owner,{title:'会议 '+index});
 const text=index===99?'Zipformer 的上线负责人是小陈，周五发布。':'讨论第'+index+'次日常事项';
 Object.assign(record,{workspaceId:null,capture:'completed',transcriptRevision:1,minutesRevision:1,segments:[{id:'s-'+index,revision:1,text,sourceId:'source',startMs:0,endMs:1000}],minutes:{revision:1,transcriptRevision:1,topics:[{id:'release',title:index===99?'Zipformer 上线':'日常事项'}],decisions:[{text,topicId:'release',evidence:[{segmentId:'s-'+index,revision:1}]}]}});
 return record;
}
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'knowledge-questions-')),repo=await createRepository({root});let runtime;t.after(async()=>{await runtime?.close();await repo.close();await rm(root,{recursive:true,force:true});});return {repo,async open(options){runtime=await createMeetingAgentRuntime({repo,...options});return runtime;}};}
async function settled(runtime,id){for(let i=0;i<200;i++){const task=await runtime.get('owner',id);if(['completed','failed','blocked','cancelled'].includes(task.status))return task;await delay(10);}throw Error('question did not settle');}
function models(result,record){const models=createModels(),fake=fauxProvider({provider:'knowledge-test',models:[{id:'answer'}],tokensPerSecond:Infinity});fake.setResponses([fauxAssistantMessage([fauxToolCall("read_selected_meeting",{recordId:record.id})],{stopReason:"toolUse"}),fauxAssistantMessage(JSON.stringify(result))]);models.setProvider(fake.provider);return {models,model:{provider:'knowledge-test',modelId:'answer'}};}
test('natural question retrieves relevant frozen evidence across 100 meetings without reading unrelated transcripts',async t=>{
 const {repo}=await fixture(t);let target;
 for(let i=0;i<100;i++){const record=sealed(i);await repo.insert(record);if(i===99)target=record;}
 await repo.insert(sealed(99,'other-owner'));
 const result=await repo.retrieveKnowledge('owner','all','Zipformer 上线由谁负责？');
 assert.equal(result.coverage.indexedMeetings,100);assert.equal(result.coverage.usedMeetings,1);assert.equal(result.entries[0].recordId,target.id);
 assert.ok(questionKeywords('请问目前 Zipformer 如何上线？').includes('zipformer'));
 assert.equal(await repo.validateKnowledge('owner',result),true);
 const snapshot=knowledgeSnapshot(target,result);assert.equal(snapshot.segments[0].text,target.segments[0].text);
 target.minutes.evidenceSnapshot=structuredClone(target.segments);target.transcriptRevision=2;
 const preserved=knowledgeSnapshot(target,result);assert.equal(preserved.transcriptRevision,1);assert.equal(preserved.segments[0].text,target.segments[0].text);
 assert.equal((await repo.retrieveKnowledge('owner','all','完全不存在的火星样品')).entries.length,0);
 await assert.rejects(repo.validateKnowledge('other-owner',result),/agent_knowledge_changed/);
 await repo.reviewKnowledge('owner','all',result.entries[0].id,{status:'dismissed',revision:result.entries[0].reviewRevision});
 await assert.rejects(repo.validateKnowledge('owner',result),/agent_knowledge_changed/);
});
test('knowledge answer uses exact citations, no invented actions, and invalidates after a review without record mutation',async t=>{
 const f=await fixture(t),record=sealed(99);await f.repo.insert(record);
 const knowledge=await f.repo.retrieveKnowledge('owner','all','Zipformer 上线由谁负责？'),evidence=[{recordId:record.id,segmentId:'s-99',revision:1}];
 const runtime=await f.open(models({summary:'依据如下。',answers:[{text:'候选纪要记载由小陈负责。',evidence}],insufficientEvidence:false,decisions:[],actions:[]},record));
 const input={question:knowledge.question,requestId:'knowledge-1'},task=await runtime.requestKnowledge('owner',input,knowledge),done=await settled(runtime,task.id);
 assert.equal(done.status,'completed',JSON.stringify(done));assert.deepEqual(done.result.answers[0].evidence,evidence);assert.deepEqual(done.result.actions,[]);
 assert.equal((await runtime.requestKnowledge('owner',input,knowledge)).id,task.id);
 await f.repo.insert(sealed(1));const refreshed=await f.repo.retrieveKnowledge('owner','all',input.question);assert.notEqual(refreshed.coverage.indexedMeetings,knowledge.coverage.indexedMeetings);assert.equal((await runtime.requestKnowledge('owner',input,refreshed)).id,task.id);
 await assert.rejects(runtime.requestKnowledge('owner',{...input,question:'changed question'},refreshed),/agent_request_conflict/);
 const version=(await f.repo.getRecordAccess([record.id]))[0].version;
 await f.repo.reviewKnowledge('owner','all',knowledge.entries[0].id,{status:'dismissed',revision:knowledge.entries[0].reviewRevision});
 assert.equal((await f.repo.getRecordAccess([record.id]))[0].version,version);
 const blocked=await runtime.get('owner',task.id);assert.equal(blocked.status,'blocked');assert.equal(blocked.result,undefined);assert.equal(blocked.preview,'');
});
test('insufficient evidence answer does not need a fabricated decision or action',async t=>{
 const f=await fixture(t),record=sealed(99);await f.repo.insert(record);const knowledge=await f.repo.retrieveKnowledge('owner','all','Zipformer 上线预算是多少？');
 const runtime=await f.open(models({summary:'所有项目已正式批准1000万元预算',answers:[],insufficientEvidence:true,decisions:[],actions:[]},record));
 const task=await runtime.requestKnowledge('owner',{question:knowledge.question,requestId:'knowledge-missing'},knowledge),done=await settled(runtime,task.id);
 assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(done.result.insufficientEvidence,true);assert.deepEqual(done.result.answers,[]);assert.doesNotMatch(done.result.summary,/1000万元/);
});

test('withdrawing evidence during recording-priority wait prevents the queued model request',async t=>{
 const f=await fixture(t),record=sealed(99);await f.repo.insert(record);
 const blocker=createRecord('owner');await f.repo.insert(blocker);await f.repo.change(blocker.id,value=>{value.capture='recording';});
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(...args)=>{calls.push(args);throw Error('withdrawn evidence must not reach a model');};
 const profile={contextWindow:65536,maxOutputTokens:1024,nativeTools:false,prices:{input:1,output:2,cacheRead:0.1,cacheWrite:1}};
 const runtime=await f.open({env:{LLM_MODEL:'knowledge-fixture',LLM_API_KEY:'synthetic',LLM_API_URL:'https://knowledge-fixture.invalid/v1',LLM_PROTOCOL:'chat-completions',LLM_MODEL_PROFILES:JSON.stringify({'knowledge-fixture':profile})}});
 const knowledge=await f.repo.retrieveKnowledge('owner','all','Zipformer 上线由谁负责？');
 const task=await runtime.requestKnowledge('owner',{question:knowledge.question,requestId:'knowledge-queued-withdraw'},knowledge);
 let queued;
 for(let i=0;i<250;i++){queued=await runtime.get('owner',task.id);if(queued.activity?.state==='queued')break;await delay(10);}
 assert.equal(queued.activity?.state,'queued',JSON.stringify(queued));
 await f.repo.reviewKnowledge('owner','all',knowledge.entries[0].id,{status:'dismissed',revision:knowledge.entries[0].reviewRevision});
 await f.repo.change(blocker.id,value=>{value.capture='completed';});
 for(let i=0;i<30;i++)await delay(10);
 const blocked=await runtime.get('owner',task.id);assert.equal(blocked.status,'blocked');assert.equal(blocked.error,'agent_knowledge_changed');assert.equal(calls.length,0);
});

test('an older exact project match outranks hundreds of newer generic matches before the SQL candidate limit',async t=>{
 const {repo}=await fixture(t);let target;
 for(let i=0;i<100;i++){
  const record=sealed(i);record.createdAt=new Date(Date.now()-86400000+i*1000).toISOString();
  record.minutes.topics=[];record.minutes.decisions=Array.from({length:6},(_,j)=>({text:i===0&&j===0?'Zipformer由小陈负责。':`负责第${i}轮第${j}项跟进`,evidence:[{segmentId:'s-'+i,revision:1}]}));
  await repo.insert(record);if(i===0)target=record;
 }
 assert.ok(questionKeywords('Zipformer由谁负责？').includes('zipformer'));
 const found=await repo.retrieveKnowledge('owner','all','Zipformer由谁负责？');
 assert.equal(found.coverage.indexedMeetings,100);assert.ok(found.entries.some(entry=>entry.recordId===target.id&&entry.text.includes('Zipformer')));assert.equal(found.entries[0].recordId,target.id);
});


test('knowledge questions execute against original reviewed content after speaker-only renaming',async t=>{
 const f=await fixture(t),record=sealed(99);record.minutes.evidenceSnapshot=structuredClone(record.segments);await f.repo.insert(record);
 const knowledge=await f.repo.retrieveKnowledge('owner','all','Zipformer 上线由谁负责？');
 await f.repo.change(record.id,current=>editSegment(current,'s-99',{revision:1,text:current.segments[0].text,speaker:'主持人'}));
 const updated=await f.repo.get(record.id),snapshot=knowledgeSnapshot(updated,knowledge);
 assert.equal(snapshot.minutesRevision,1);assert.equal(snapshot.transcriptRevision,1);assert.equal(snapshot.segments[0].revision,1);
 const evidence=[{recordId:record.id,segmentId:'s-99',revision:1}];
 const runtime=await f.open(models({summary:'依据如下。',answers:[{text:'由小陈负责。',evidence}],insufficientEvidence:false,decisions:[],actions:[]},record));
 const task=await runtime.requestKnowledge('owner',{question:knowledge.question,requestId:'renamed-knowledge'},knowledge),done=await settled(runtime,task.id);
 assert.equal(done.status,'completed',JSON.stringify(done));assert.deepEqual(done.result.answers[0].evidence,evidence);
 assert.throws(()=>knowledgeSnapshot({...updated,minutes:{...updated.minutes,revision:3,attributionBaseRevision:undefined},minutesRevision:3},knowledge),/agent_knowledge_changed/);
});
