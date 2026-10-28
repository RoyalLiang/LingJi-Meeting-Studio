import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../services/records/src/repository.mjs';
import { createRecordServer } from '../services/records/src/server.mjs';
import { saveConfig, readConfig } from '../services/records/src/config.mjs';
import { processFunasrAudio } from '../services/records/src/funasr-transcription.mjs';
import { runCycle } from '../services/records/src/worker.mjs';
import { createRecord, addSource, acknowledge, digest, validateMinutes } from '../packages/records/src/record.mjs';
import { minutesContext, mergeLiveMinutes } from '../packages/records/src/live-minutes.mjs';
import { automaticMinutesAt, queueAutomaticMinutes, setAutomation } from '../packages/records/src/automation.mjs';

const segment=(id,startMs=0)=>({id,revision:1,startMs,endMs:startMs+1000,text:`讨论${id}`,sourceId:'mic'});
const ref=s=>({segmentId:s.id,revision:s.revision});
const empty=()=>({title:'持续会议',sections:[],topics:[],actions:[],decisions:[]});

test('manual editing accepts cumulative minutes using only the server frozen evidence budget',async()=>{
 const root=await mkdtemp(join(tmpdir(),'minutes-edit-smoke-')),app=await createRecordServer({root,databaseUrl:'',port:0});
 try{
  const address=await app.start(),base=`http://127.0.0.1:${address.port}`,email='minutes-smoke@example.com';
  const login=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'long-password'})}),session=await login.json();
  assert.equal(login.status,200);
  const headers={'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':session.csrf};
    const record=createRecord(`user:${digest(email)}`),snapshot=[segment('s1')],evidence=[ref(snapshot[0])];
  const minutes={...empty(),sections:Array.from({length:21},(_,i)=>({heading:`议题${i}`,items:[{text:`要点${i}`,evidence}]}))};
  record.minutesRevision=1;record.minutes={...minutes,revision:1,evidenceSnapshot:snapshot};await app.repo.insert(record);
  const save=body=>fetch(`${base}/api/records/${record.id}/minutes`,{method:'PATCH',headers,body:JSON.stringify(body)});
  const response=await save({revision:1,minutes});assert.equal(response.status,200,await response.text());
  assert.equal((await app.repo.get(record.id)).minutes.edited,true);
  await app.repo.change(record.id,r=>{r.minutes.evidenceSnapshot=[snapshot[0]];});
    const forged=await save({revision:2,minutes:{...minutes,sections:[...minutes.sections,{heading:'伪造超额容量',items:[{text:'额外内容',evidence}]}],evidenceSnapshot:snapshot,aggregateParts:100}});
  assert.equal(forged.status,422);
 }finally{await app.stop();await rm(root,{recursive:true,force:true});}
});

test('cumulative minutes grow with unique frozen evidence while model responses stay bounded',()=>{
 const snapshot=[segment('s1'),segment('s2',1000)],evidence=[ref(snapshot[0])];
 const item={text:'跟进',evidence};
 for(const extra of [
  {sections:Array.from({length:21},(_,i)=>({heading:`议题${i}`,items:[item]}))},
  {topics:Array.from({length:31},(_,i)=>({id:`t${i}`,title:`主题${i}`,summary:'讨论',evidence}))},
  {actions:Array.from({length:101},(_,i)=>({...item,text:`行动${i}`}))}
 ]){
  const minutes={...empty(),sections:[{heading:'要点',items:[item]}],...extra};
  assert.throws(()=>validateMinutes(minutes,snapshot));
  assert.doesNotThrow(()=>validateMinutes(minutes,snapshot,undefined,{aggregate:true}));
  assert.throws(()=>validateMinutes(minutes,[snapshot[0],snapshot[0]],undefined,{aggregate:true}));
 }
 const bad={...empty(),sections:[{heading:'要点',items:[{...item,evidence:[{segmentId:'unknown',revision:1}]}]}]};
 assert.throws(()=>validateMinutes(bad,snapshot,undefined,{aggregate:true}));
 assert.throws(()=>validateMinutes({...empty(),sections:[{heading:'要点',items:Array(101).fill(item)}]},snapshot,undefined,{aggregate:true}));
 const many=Array.from({length:501},(_,i)=>segment(`s${i}`,i*1000));
 const long={...empty(),topics:[{id:'t1',title:'长期议题',summary:'持续讨论',evidence:many.map(ref)}],sections:[{heading:'要点',items:[item]}]};
 assert.throws(()=>validateMinutes(long,many));
 assert.doesNotThrow(()=>validateMinutes(long,many,undefined,{aggregate:true}));
});

test('large meeting memory stays within 12KB and keeps recent relevant topics',()=>{
 const topics=Array.from({length:450},(_,i)=>({id:`topic-${i}`,title:`议题${i}`,summary:`摘要${i}`}));
 const old=segment('old'),decision={text:'议题449原计划周五发布',evidence:[ref(old)]};
 topics.at(-1).evidence=[ref(old)];
 const previous={...empty(),topics,decisions:[decision],sections:[{heading:'议题449',items:[decision]}]};
 const context=minutesContext(previous,[{...segment('new'),text:'继续讨论议题449'}]);
 assert.ok(Buffer.byteLength(JSON.stringify(context))<=12000);
 assert.ok(context.topics.some(topic=>topic.id==='topic-449'));
 assert.ok(context.items.some(item=>item.text===decision.text&&item.id));
 assert.ok(context.recentPoints.some(item=>item.text===decision.text));
 assert.equal(previous.topics.length,450);
});

test('reused hidden topic ID cannot move old decisions or actions into a new project',()=>{
 const old=segment('old'),fresh=segment('fresh',300000),oldEvidence=[ref(old)],newEvidence=[ref(fresh)];
 const previous={...empty(),topics:[{id:'t1',title:'甲项目',summary:'甲进度',evidence:oldEvidence}],sections:[{heading:'甲项目',items:[{text:'甲由张工负责',topicId:'t1',evidence:oldEvidence}]}],actions:[{text:'甲项目检查',owner:'张工',topicId:'t1',evidence:oldEvidence}],evidenceSnapshot:[old]};
 const incoming={...empty(),topics:[{id:'t1',title:'乙项目',summary:'乙进度',evidence:newEvidence}],sections:[{heading:'乙项目',items:[{text:'乙由李工负责',topicId:'t1',evidence:newEvidence}]}],actions:[{text:'乙项目检查',owner:'李工',topicId:'t1',evidence:newEvidence}]};
 incoming.highlights=[{text:'乙项目检查',topicId:'t1',evidence:newEvidence}];
 incoming.currentDiscussion=[{text:'乙项目检查',topicId:'t1',evidence:newEvidence}];
 const merged=mergeLiveMinutes(previous,incoming,[fresh]),newId=merged.topics.find(topic=>topic.title==='乙项目').id;
 assert.notEqual(newId,'t1');
 assert.equal(merged.actions.find(action=>action.owner==='张工').topicId,'t1');
 assert.equal(merged.actions.find(action=>action.owner==='李工').topicId,newId);
 assert.equal(merged.sections.find(section=>section.heading==='甲项目').items[0].topicId,'t1');
 assert.equal(merged.sections.find(section=>section.heading==='乙项目').items[0].topicId,newId);
 assert.equal(merged.highlights[0].topicId,newId);
 assert.equal(merged.currentDiscussion[0].topicId,newId);
 assert.doesNotThrow(()=>validateMinutes(merged,[old,fresh],undefined,{aggregate:true}));
});

test('live retry budget, manual edits and new revisions keep their boundaries',()=>{
 const fixture=()=>{const r=createRecord('owner');r.capture='recording';r.segments=[segment('s1')];r.transcriptRevision=1;setAutomation(r,{enabled:true,intervalSeconds:30},1000);const job=queueAutomaticMinutes(r,'fixture-model',31000);Object.assign(job,{status:'failed',error:'llm_timeout',failedAt:32000});return {r,job};};
 const {r}=fixture(),second=queueAutomaticMinutes(r,'fixture-model',47000);
 Object.assign(second,{status:'failed',error:'llm_timeout',failedAt:48000});
 assert.equal(automaticMinutesAt(r,48001),78000);
 const third=queueAutomaticMinutes(r,'fixture-model',78000);
 Object.assign(third,{status:'failed',error:'llm_timeout',failedAt:79000});
 assert.equal(third.retryAttempt,3);assert.equal(automaticMinutesAt(r,100000),Infinity);
 r.segments.push(segment('s2',1000));r.transcriptRevision++;
 const next=queueAutomaticMinutes(r,'fixture-model',110000);assert.equal(next.retryAttempt,1);
 for(const mutate of [({job})=>{job.error='llm_auth_failed';},({r})=>{r.minutesRevision++;},({r})=>{r.minutes={edited:true};},({r})=>{r.autoMinutes.enabled=false;}]){
  const value=fixture();mutate(value);assert.equal(automaticMinutesAt(value.r,100000),Infinity);
 }
});

test('SenseVoice durable batches keep AI minutes advancing past the first few minutes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'sensevoice-minutes-smoke-')),prior=process.env.LINGJI_LOCAL_ASR_DIR;
  process.env.LINGJI_LOCAL_ASR_DIR=root;await writeFile(join(root,'manifest.json'),'{}');
  const repo=await createRepository({root,databaseUrl:''});let transcriptions=0,calls=0;
  try{
    await saveConfig(root,{ASR_PROVIDER:'sensevoice-local',MINUTES_MODE:'asr-llm',LLM_PROTOCOL:'responses',LLM_API_URL:'https://fixture.invalid/responses',LLM_API_KEY:'fixture-local-key',LLM_MODEL:'fixture-model'},{LINGJI_LOCAL_ASR_DIR:root});
    const config=await readConfig(root);
    const record=createRecord('owner',{language:'zh',autoMinutes:true}),source=addSource(record,{kind:'microphone'});
    setAutomation(record,{enabled:true,intervalSeconds:30});await repo.insert(record);
    const pcm=Buffer.alloc(15*32000);for(let at=0;at<pcm.length;at+=2)pcm.writeInt16LE(5000,at);
    const object=await repo.putAudio(record.id,pcm);
    for(let round=0;round<24;round++){
      for(let offset=0;offset<2;offset++){
        const sequence=round*2+offset;
        await repo.change(record.id,r=>acknowledge(r,{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence,sampleOffset:sequence*15*16000,sampleCount:15*16000,sampleRate:16000,channels:1,digest:digest(pcm),...object}));
      }
      await processFunasrAudio(repo,await repo.get(record.id),config,async()=>{transcriptions++;return `第${round+1}轮讨论：设备状态、原因和跟进安排。`;});
      const transcribed=await repo.get(record.id);
      assert.equal(transcribed.segments.length,round+1,JSON.stringify({transcriptions,chunks:transcribed.chunks.map(({state,error,sampleCount})=>({state,error,sampleCount})),asr:transcribed.sources[0].asr}));
      await repo.change(record.id,r=>{r.autoMinutes.enabledAt=Date.now()-31000;r.autoMinutes.lastRequestedAt=Date.now()-31000;});
      await runCycle(repo,{minutes:async job=>{
        calls++;const fresh=job.snapshot.find(segment=>!segment.contextOnly),evidence=[{segmentId:fresh.id,revision:fresh.revision}];
        return {title:'SenseVoice持续会议',sections:Array.from({length:3},(_,index)=>({heading:`第${round+1}轮议题${index+1}`,items:[{text:`第${round+1}轮要点${index+1}`,evidence}]})),actions:[]};
      }},{lane:'minutes'});
      const saved=await repo.get(record.id),latest=saved.segments.at(-1),job=saved.jobs.at(-1);
      assert.equal(job.status,'completed',`minute ${(round+1)/2}: ${job.error || job.status}`);
      assert.equal(saved.liveMinutes.transcriptRevision,saved.transcriptRevision);
      assert.ok(saved.liveMinutes.evidenceSnapshot.some(segment=>segment.id===latest.id));
    }
    const saved=await repo.get(record.id);
    assert.equal(transcriptions,24);assert.equal(calls,24);
    assert.ok(saved.liveMinutes.sections.flatMap(section=>section.items).some(item=>item.text==='第24轮要点3'));
    assert.ok(saved.liveMinutes.sections.flatMap(section=>section.items).some(item=>item.text==='第1轮要点1'));
  }finally{
    await repo.close();if(prior===undefined)delete process.env.LINGJI_LOCAL_ASR_DIR;else process.env.LINGJI_LOCAL_ASR_DIR=prior;
    await rm(root,{recursive:true,force:true});
  }
});
test('a transient live minutes failure retries without needing another SenseVoice batch',()=>{
  const r=createRecord('owner');r.capture='recording';r.segments=[{id:'s1',revision:1,text:'决定评审',startMs:0,endMs:1000}];r.transcriptRevision=1;
  setAutomation(r,{enabled:true,intervalSeconds:30},1000);
  const job=queueAutomaticMinutes(r,'fixture-model',31000);Object.assign(job,{status:'failed',error:'llm_timeout',failedAt:32000});
  assert.equal(automaticMinutesAt(r,32001),47000);
  assert.equal(queueAutomaticMinutes(r,'fixture-model',46999),undefined);
  const retry=queueAutomaticMinutes(r,'fixture-model',47000);
  assert.equal(retry.retryOf,job.id);assert.equal(retry.retryAttempt,2);
});
