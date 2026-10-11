import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecord, requestMinutes, commitMinutes, validateMinutes, addSource, acknowledge, digest, editSegment } from '../packages/records/src/record.mjs';
import { setAutomation, automaticMinutesAt, queueAutomaticMinutes, updateMinutesPreview } from '../packages/records/src/automation.mjs';
import { createRepository } from '../services/records/src/repository.mjs';
import { runCycle } from '../services/records/src/worker.mjs';
const segment = {id:'s1',revision:1,text:'决定周五评审',startMs:0,endMs:1000,speaker:'',sourceId:'text-import'};
const result = {title:'评审',topics:[{title:'评审安排',summary:'确定评审时间',evidence:[{segmentId:'s1',revision:1}]}],sections:[{heading:'决定',items:[{text:'周五评审',evidence:[{segmentId:'s1',revision:1}]}]}],actions:[]};
function record() { const r=createRecord('fixture');r.segments=[{...segment}];r.transcriptRevision=1;r.capture='recording';return r; }
test('automatic minutes debounce live updates, deduplicate and finalize after drain', () => {
 const r=record();setAutomation(r,{enabled:true,intervalSeconds:30},1000);
 assert.equal(automaticMinutesAt(r,1001),31000);assert.equal(queueAutomaticMinutes(r,'fixture',30999),undefined);
 const j=queueAutomaticMinutes(r,'fixture',31000);assert.equal(j.scope,'live');assert.equal(queueAutomaticMinutes(r,'fixture',32000),undefined);
 j.fence='f';r.segments.push({...segment,id:'s2'});r.transcriptRevision++;
 commitMinutes(r,j.id,result,'f');assert.equal(r.liveMinutes.title,'评审');assert.equal(r.minutes,null);
 assert.equal(automaticMinutesAt(r,32000),61000);
 r.capture='sealed';assert.equal(queueAutomaticMinutes(r,'fixture',32000),undefined);
 r.capture='completed';const final=queueAutomaticMinutes(r,'fixture',32000);assert.equal(final.scope,'final');
 final.fence='z';commitMinutes(r,final.id,result,'z');assert.equal(r.minutes.revision,1);assert.equal(automaticMinutesAt(r,33000),Infinity);
});
test('manual corrections, disabled automation and edited evidence fence drafts', () => {
 const r=record();setAutomation(r,{enabled:true},0);r.minutes={edited:true};assert.equal(automaticMinutesAt(r),Infinity);r.minutes=null;
 const j=requestMinutes(r,{scope:'live',automatic:true});j.status='running';j.fence='f';
 updateMinutesPreview(r,j.id,'f','{"title":"会中草稿","sections":[{"heading":"决定","items":[{"text":"周五', {firstTokenMs:100});
 assert.equal(j.preview.at(-1).text,'周五');assert.equal(r.minutes,null);
 r.segments[0].translation='旧翻译';r.segments[0].translationLease=999999;editSegment(r,'s1',{revision:1,text:'改为周六评审'});assert.equal(r.segments[0].translation,undefined);assert.equal(r.segments[0].translationLease,undefined);commitMinutes(r,j.id,result,'f');assert.equal(j.status,'stale');assert.equal(j.preview,undefined);
 const retry=requestMinutes(r,{scope:'live',automatic:true});retry.status='running';retry.fence='x';
 setAutomation(r,{enabled:false});updateMinutesPreview(r,retry.id,'x','{"title":"迟到结果"}',{});assert.equal(retry.preview,undefined);
 assert.throws(()=>commitMinutes(r,retry.id,result,'x'),/stale_job/);
});
test('topic citations are validated and local/model jobs have separate identities', () => {
 const r=record();r.capture='completed';assert.notEqual(requestMinutes(r,{mode:'model'}).id,requestMinutes(r,{mode:'extractive'}).id);
 const invalid=structuredClone(result);invalid.topics[0].evidence[0].revision=2;assert.throws(()=>validateMinutes(invalid,r.segments),/invalid_minutes_topics/);
});
test('audio progresses while a model job streams, without publishing an unvalidated draft', async () => {
 const root=await mkdtemp(join(tmpdir(),'tts-live-'));const repo=await createRepository({root});
 let release, started; const blocked=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});
 const r=record(), source=addSource(r,{kind:'microphone'}), bytes=Buffer.alloc(3200);
 const object=await repo.putAudio(r.id,bytes);acknowledge(r,{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence:0,sampleOffset:0,sampleCount:1600,sampleRate:16000,digest:digest(bytes),...object});
 requestMinutes(r,{scope:'live'});await repo.insert(r);
 try {
  const pending=runCycle(repo,{minutes:async (_job,_config,{onDelta})=>{await onDelta('{"title":"流式预览"',{firstTokenMs:4,elapsedMs:5});started();await blocked;return result;}},{lane:'minutes'});
  await ready;assert.equal((await repo.get(r.id)).jobs[0].preview[0].text,'流式预览');assert.equal((await repo.get(r.id)).liveMinutes,null);
  await runCycle(repo,{transcribe:async()=> '后续讨论'},{lane:'audio'});assert.equal((await repo.get(r.id)).segments.length,2);
  release();await pending;assert.equal((await repo.get(r.id)).liveMinutes.title,'评审');
 } finally {release();await repo.close();await rm(root,{recursive:true,force:true});}
});

test('translation waiting never delays audio transcript persistence', async () => {
 const root=await mkdtemp(join(tmpdir(),'tts-translation-'));const repo=await createRepository({root});
 let release,started;const blocked=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});
 const r=record();r.translationTarget='en';const source=addSource(r,{kind:'microphone'}),bytes=Buffer.alloc(3200);
 const object=await repo.putAudio(r.id,bytes);acknowledge(r,{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence:0,sampleOffset:0,sampleCount:1600,sampleRate:16000,digest:digest(bytes),...object});await repo.insert(r);
 try {
  const pending=runCycle(repo,{translate:async()=>{started();await blocked;return 'Synthetic translation';}},{lane:'translation'});
  await ready;await runCycle(repo,{transcribe:async()=> '新的片段'},{lane:'audio'});assert.equal((await repo.get(r.id)).segments.length,2);
  release();await pending;assert.equal((await repo.get(r.id)).segments[0].translation,'Synthetic translation');
 } finally {release();await repo.close();await rm(root,{recursive:true,force:true});}
});
