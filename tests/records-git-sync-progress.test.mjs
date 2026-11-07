import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord} from '../packages/records/src/record.mjs';
import {createExtensions} from '../services/records/src/integrations/extensions.mjs';
import {createMeetingAgentRuntime} from '../services/records/src/meeting-agent.mjs';
import {meetingTasks} from '../services/records/src/meeting-tasks.mjs';
import {createGitSync} from '../services/records/src/git-sync.mjs';
import {source,gitRemoteFixture} from './fixtures/git-sync.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'lingji-git-progress-'));
  const repo=await createRepository({root,databaseUrl:''}),network=gitRemoteFixture(),extensions=await createExtensions(repo);
  const config={LLM_MODEL:'fixture',LLM_API_KEY:'synthetic',LLM_API_URL:'https://fixture.invalid/v1',LLM_PROTOCOL:'chat-completions'};
  await writeFile(join(root,'providers.json'),JSON.stringify(config));
  const record=createRecord('owner',{title:'浦东机场｜合成回归',autoMinutes:false}),evidence=[{segmentId:'s',revision:1}];
  Object.assign(record,{capture:'completed',transcription:'ready',transcriptRevision:1,minutesRevision:1,segments:[{id:'s',revision:1,text:'保留来源',startMs:0,endMs:1000}],minutes:{title:record.title,revision:1,transcriptRevision:1,edited:true,sections:[{title:'结论',items:[{text:'保留来源',evidence}]}],decisions:[],actions:[],evidenceSnapshot:[]}});
  await repo.insert(record);
  let calls=0,agent,sync;const original=globalThis.fetch;
  globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:JSON.stringify(calls===1?{toolCalls:[{name:'read_selected_meeting',arguments:{recordId:record.id}}]}:{summary:'合成归档完成',decisions:[{text:'保留来源',evidence:[{recordId:record.id,segmentId:'s',revision:1}]}],actions:[]})}}],usage:{prompt_tokens:50,completion_tokens:10,total_tokens:60}});};
  t.after(async()=>{await sync?.close();await agent?.close();await meetingTasks(repo).close();globalThis.fetch=original;await repo.close();await rm(root,{recursive:true,force:true});});
  async function open(){
    agent=await createMeetingAgentRuntime({repo,extensions,env:config});
    sync=await createGitSync({repo,agent,extensions,request:network.request,localAccount:true,pollMs:3600000,agentPollMs:10});
  }
  await open();
  await sync.save('owner',{root:source,token:'synthetic-git-token',enabled:true,confirmed:true,prompt:'整理已确认结论。',skillId:'meeting-review',skillVersion:'1.0.0',pluginIds:[],pluginVersions:{},remoteToolsConfirmed:true,mappings:[],aliases:[],directory:'docs/meetings',mode:'mr',includeNotes:false,includeEvidence:true});
  return {repo,get agent(){return agent;},get sync(){return sync;},record,network,calls:()=>calls,restart:async()=>{await sync.close();await agent.close();await open();}};
}
async function waitFor(h,id,predicate) {
  let job;for(let i=0;i<160;i++){job=await h.sync.get('owner',id);if(predicate(job))return job;await delay(10);}return job;
}

test('Git sync exposes actual reading progress and reported tokens from configured model',async t=>{
  const h=await fixture(t),start=await h.sync.start('owner',h.record.id);
  const job=await waitFor(h,start.id,job=>['succeeded','failed','blocked'].includes(job.status));
  assert.equal(job.status,'succeeded',JSON.stringify(job));
  assert.equal(h.calls(),2);assert.equal(job.ledger.totalTokens,120);
  assert.equal(job.progress.read,1);assert.equal(job.progress.total,1);
  assert.ok(job.timeline.some(item=>item.kind==='tool'&&item.name==='read_selected_meeting'));
});

test('a sealed meeting cannot indefinitely stop an unrelated completed meeting Git sync',async t=>{
  const h=await fixture(t),draining=createRecord('owner');draining.capture='sealed';await h.repo.insert(draining);
  const start=await h.sync.start('owner',h.record.id);
  const job=await waitFor(h,start.id,job=>['succeeded','failed','blocked'].includes(job.status));
  assert.equal(job.status,'succeeded',JSON.stringify({status:job.status,phase:job.phase,ledger:job.ledger,timeline:job.timeline,calls:h.calls()}));
  assert.equal(job.ledger.totalTokens,120);assert.equal(h.network.mrs.length,1);
});

test('actual recording reports its wait reason without fabricating tokens and resumes after capture stops',async t=>{
  const h=await fixture(t),recording=createRecord('owner');recording.capture='recording';await h.repo.insert(recording);
  const start=await h.sync.start('owner',h.record.id);
  const waiting=await waitFor(h,start.id,job=>job.activity?.reason==='recording');
  assert.equal(waiting.status,'queued');assert.equal(waiting.activity.state,'queued');
  assert.equal(h.calls(),0);assert.equal(waiting.ledger.totalTokens,0);assert.equal(waiting.progress.read,0);
  const diagnostic=await meetingTasks(h.repo).diagnostics('owner',waiting.kernelId);
  assert.equal(diagnostic.activity.reason,'recording');assert.equal(diagnostic.progress.total,1);
  assert.doesNotMatch(JSON.stringify(diagnostic),/synthetic-git-token|保留来源|合成回归/);
  await h.repo.change(recording.id,row=>{row.capture='sealed';});
  const done=await waitFor(h,start.id,job=>job.status==='succeeded');
  assert.equal(done.status,'succeeded');assert.equal(done.activity,undefined);assert.equal(done.ledger.totalTokens,120);
  assert.equal(h.network.mrs.length,1);
});

test('an existing queued Git job resumes after process restart without another model request or commit',async t=>{
  const h=await fixture(t),recording=createRecord('owner');recording.capture='recording';await h.repo.insert(recording);
  const start=await h.sync.start('owner',h.record.id);
  assert.equal((await waitFor(h,start.id,job=>job.activity?.reason==='recording')).status,'queued');
  await h.restart();
  await h.repo.change(recording.id,row=>{row.capture='sealed';});
  const done=await waitFor(h,start.id,job=>job.status==='succeeded');
  assert.equal(done.status,'succeeded');assert.equal(done.progress.read,1);assert.equal(h.calls(),2);
  assert.equal(h.network.writes.filter(item=>item.path.endsWith('/repository/commits')).length,1);
});
