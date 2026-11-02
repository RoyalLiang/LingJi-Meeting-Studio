import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage as message,fauxToolCall as call} from '@earendil-works/pi-ai/providers/faux';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord} from '../packages/records/src/record.mjs';
import {gitTarget,gitRoot,gitArchivePath} from '../packages/records/src/git-sync.mjs';
import {createExtensions} from '../services/records/src/integrations/extensions.mjs';
import {createMeetingAgentRuntime} from '../services/records/src/meeting-agent.mjs';
import {createGitSync} from '../services/records/src/git-sync.mjs';

import {source,writeSha,projects,gitRemoteFixture as remote} from './fixtures/git-sync.mjs';
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'lingji-git-sync-')),repo=await createRepository({root,databaseUrl:''}),network=remote(),extensions=await createExtensions(repo);
  const models=createModels(),fake=fauxProvider({provider:'git-test',models:[{id:'test'}],tokensPerSecond:Infinity});models.setProvider(fake.provider);let agent,sync;
  t.after(async()=>{await sync?.close();await agent?.close();await repo.close();await rm(root,{recursive:true,force:true});});
  async function open(){agent=await createMeetingAgentRuntime({repo,extensions,models,model:{provider:'git-test',modelId:'test'}});sync=await createGitSync({repo,agent,extensions,request:network.request,localAccount:true,pollMs:3600000,agentPollMs:10,retryDelayMs:10});}
  await open();
  const policy={root:source,token:'synthetic-git-token',enabled:true,confirmed:true,prompt:'整理决策，保留人工修订和引用。',skillId:'meeting-review',skillVersion:'1.0.0',pluginIds:[],pluginVersions:{},remoteToolsConfirmed:true,mappings:[],aliases:[],directory:'docs/meetings',mode:'mr',includeNotes:false,includeEvidence:true};
  async function record(title='浦东机场｜周会',workspaceId){const r=createRecord('owner',{title,autoMinutes:false});Object.assign(r,{capture:'completed',transcription:'ready',transcriptRevision:1,minutesRevision:1,workspaceId,notes:'private-notes',segments:[{id:'cited',revision:1,text:'决定保留人工修订。',startMs:0,endMs:1000},{id:'uncited',revision:1,text:'never-export-uncited-transcript',startMs:1000,endMs:2000}]});const evidence=[{segmentId:'cited',revision:1}];r.minutes={title,revision:1,transcriptRevision:1,edited:true,sections:[{title:'人工纪要',items:[{text:'人工修订内容不能丢失',evidence}]}],decisions:[{text:'保留人工修订',evidence}],actions:[],evidenceSnapshot:[r.segments[0]]};await repo.insert(r);return r;}
  function respond(r){fake.setResponses([message(call('read_selected_meeting',{recordId:r.id}),{stopReason:'toolUse'}),context=>{assert.doesNotMatch(JSON.stringify(context),/never-export-uncited-transcript|private-notes/);return message(JSON.stringify({summary:'归档整理结果。',decisions:[{text:'保留人工修订',evidence:[{recordId:r.id,segmentId:'cited',revision:1}]}],actions:[]}));}]);}
  return {root,repo,network,policy,record,respond,get sync(){return sync;},async restart(){await sync.close();await agent.close();await open();}};
}
async function settled(sync,id){for(let i=0;i<300;i++){const job=await sync.get('owner',id);if(['succeeded','blocked','failed','unknown','paused'].includes(job.status))return job;await delay(10);}throw Error('Git task did not settle');}

test('Git eligibility uses unique names OR stable Workspace IDs and rejects ambiguity',()=>{
  const mapping=[{workspaceId:'workspace-1',projectId:20}];
  assert.equal(gitTarget({title:'普通讨论',workspaceId:'workspace-1'},projects,mapping).project.id,20);
  assert.equal(gitTarget({title:'浦东机场｜周会'},projects).project.id,10);
  assert.equal(gitTarget({title:'PSA Weekly Discussion'},projects).project.id,20);
  assert.equal(gitTarget({title:'PSAnext'},projects).status,'blocked');
  assert.equal(gitTarget({title:'浦东机场 PSA',workspaceId:'workspace-1'},projects,mapping).reason,'git_target_conflict');
  assert.equal(gitTarget({title:'浦东机场',workspaceId:'workspace-1'},projects,mapping).reason,'git_target_conflict');
  assert.equal(gitTarget({title:'普通讨论'},projects).reason,'git_target_unclear');
  assert.throws(()=>gitRoot('https://user:token@git.example.test/root'));assert.throws(()=>gitArchivePath('../secrets'));assert.throws(()=>gitArchivePath('.git/config'));
});
test('real Pi + pi-durable sync preserves human minutes, limits transcript, pins sources and creates one MR',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record();h.respond(r);
  await h.sync.tick();const first=(await h.sync.settings('owner')).recent[0],result=await settled(h.sync,first.id);
  assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(result.commit,writeSha);assert.equal(h.network.mrs.length,1);
  const contents=[...h.network.files.values()].join('\n');assert.match(contents,/人工修订内容不能丢失/);assert.match(contents,/归档整理结果/);assert.doesNotMatch(contents,/private-notes|never-export-uncited-transcript/);
  const agentTask=await h.repo.get((await h.repo.list('git-sync-job'))[0].id);assert.ok(agentTask.agentId);assert.equal(agentTask.files[agentTask.manifestPath].includes('"minutesRevision": 1'),true);
  assert.deepEqual((await h.repo.get(r.id)).minutes,r.minutes);assert.doesNotMatch(JSON.stringify(await h.repo.list('git-sync-rule')),/synthetic-git-token/);
  assert.equal((await h.sync.start('owner',r.id)).id,first.id);await h.sync.tick();assert.equal(h.network.writes.filter(w=>w.path.endsWith('/repository/commits')).length,1);
  await h.restart();assert.equal((await h.sync.get('owner',first.id)).status,'succeeded');assert.equal(h.network.mrs.length,1);
  await assert.rejects(h.sync.get('other',first.id),{code:'git_task_not_found'});
});
test('unknown commit result is reconciled before retry, without a second commit',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record();h.respond(r);h.network.timeoutAfterCommit();
  const started=await h.sync.start('owner',r.id),unknown=await settled(h.sync,started.id);assert.equal(unknown.status,'unknown',JSON.stringify(unknown));assert.equal(unknown.error,'git_result_unknown');
  await h.sync.control('owner',started.id,'retry');const result=await settled(h.sync,started.id);assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(h.network.writes.filter(w=>w.path.endsWith('/repository/commits')).length,1);assert.equal(h.network.mrs.length,1);
});
test('historic records are excluded, ambiguous titles give feedback, deletion removes content',async t=>{
  const h=await fixture(t),old=await h.record();await h.sync.save('owner',h.policy);await h.sync.tick();assert.equal((await h.sync.settings('owner')).recent.length,0);
  const unclear=await h.record('停车位交互改造'),started=await h.sync.start('owner',unclear.id),blocked=await settled(h.sync,started.id);assert.equal(blocked.status,'blocked');assert.equal(blocked.error,'git_target_unclear');assert.equal(h.network.writes.length,0);
  await h.repo.change(unclear.id,r=>{r.deleted=true;});await h.sync.tick();const redacted=await h.sync.get('owner',blocked.id);assert.equal(redacted.title,'会议已删除或过期');assert.equal(redacted.error,'git_source_unavailable');assert.equal((await h.sync.preview('owner')).results.some(r=>r.recordId===old.id),true);
});
test('permission failures persist actionable feedback and disabled rules fence queued writes',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record();h.respond(r);h.network.denyWrites();
  const first=await h.sync.start('owner',r.id),failed=await settled(h.sync,first.id);assert.equal(failed.error,'git_write_forbidden');assert.equal(failed.status,'failed');
  h.network.denyWrites(false);await h.sync.save('owner',{enabled:false});await assert.rejects(h.sync.control('owner',first.id,'retry'),{code:'git_rule_changed'});assert.equal(h.network.mrs.length,0);
});
test('a title changed during the last preflight GET prevents every subsequent write',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record();h.respond(r);let changed=false;
  h.network.onRead(async path=>{if(!changed&&path.includes('/repository/branches/lingji')){changed=true;await h.repo.change(r.id,record=>{record.title='PSA 周会';});}});
  const first=await h.sync.start('owner',r.id),result=await settled(h.sync,first.id);assert.equal(result.status,'blocked',JSON.stringify(result));assert.equal(result.error,'git_source_changed');assert.equal(changed,true);assert.equal(h.network.writes.length,0);
});
test('explicit retry after fixing an unwritten ambiguous title creates a new snapshot',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record('普通讨论'),started=await h.sync.start('owner',r.id),blocked=await settled(h.sync,started.id);
  await h.repo.change(r.id,record=>{record.title='浦东机场｜周会';});h.respond(r);
  const next=await h.sync.control('owner',blocked.id,'retry');assert.notEqual(next.id,blocked.id);assert.equal((await settled(h.sync,next.id)).status,'succeeded');assert.equal((await h.sync.get('owner',blocked.id)).status,'superseded');
});
test('pausing during preflight prevents writes and resumes the same archive without duplicate model work',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record();h.respond(r);let paused=false,jobId;
  h.network.onRead(async(path,options)=>{if(!paused&&path.includes('/repository/branches/lingji')){paused=true;void h.sync.control('owner',jobId,'pause');await new Promise(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',resolve,{once:true});});}});
  const started=await h.sync.start('owner',r.id);jobId=started.id;assert.equal((await settled(h.sync,jobId)).status,'paused');assert.equal(h.network.writes.length,0);
  await h.sync.control('owner',jobId,'resume');assert.equal((await settled(h.sync,jobId)).status,'succeeded');assert.equal(h.network.mrs.length,1);
});
test('process restart during preflight restores the durable phase and reconciles one commit',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record();h.respond(r);let reached,once=false;
  const waiting=new Promise(resolve=>{reached=resolve;});
  h.network.onRead(async(path,options)=>{if(!once&&path.includes('/repository/branches/lingji')){once=true;reached();await new Promise(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',resolve,{once:true});});}});
  const job=await h.sync.start('owner',r.id);await Promise.race([waiting,delay(2000).then(()=>{throw Error('preflight not reached');})]);await h.restart();
  assert.equal((await settled(h.sync,job.id)).status,'succeeded');assert.equal(h.network.writes.filter(w=>w.path.endsWith('/repository/commits')).length,1);assert.equal(h.network.mrs.length,1);
});
test('429 retries use bounded durable sleeps and do not replay a successful commit',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record();h.respond(r);let attempts=0;
  h.network.onRead(path=>{if(path.includes('/repository/branches/lingji')&&attempts++<3)return {status:429,headers:{},text:'{}'};});
  const job=await h.sync.start('owner',r.id);assert.equal((await settled(h.sync,job.id)).status,'succeeded');assert.equal((await h.repo.get(job.id)).rateAttempts,3);assert.equal(h.network.writes.filter(w=>w.path.endsWith('/repository/commits')).length,1);
});
test('persistent 429 stops after three retries and leaves actionable failure feedback',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record();h.respond(r);let attempts=0;
  h.network.onRead(path=>{if(path.includes('/repository/branches/lingji')){attempts++;return {status:429,headers:{},text:'{}'};}});
  const job=await h.sync.start('owner',r.id),failed=await settled(h.sync,job.id);assert.equal(failed.error,'git_rate_limited');assert.equal(failed.status,'failed');assert.equal(attempts,4);assert.equal(h.network.writes.length,0);
});
test('model reasoning configuration changes during preflight fence the archive',async t=>{
  const h=await fixture(t);await writeFile(join(h.root,'providers.json'),JSON.stringify({LLM_REASONING_EFFORT:'low'}));await h.sync.save('owner',h.policy);const r=await h.record();h.respond(r);let changed=false;
  h.network.onRead(async path=>{if(!changed&&path.includes('/repository/branches/lingji')){changed=true;await writeFile(join(h.root,'providers.json'),JSON.stringify({LLM_REASONING_EFFORT:'high'}));}});
  const job=await h.sync.start('owner',r.id),result=await settled(h.sync,job.id);assert.equal(result.error,'git_model_changed');assert.equal(h.network.writes.length,0);
});
test('disabling the rule during preflight prevents all subsequent POST requests',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record();h.respond(r);let changed=false;
  h.network.onRead(async path=>{if(!changed&&path.includes('/repository/branches/lingji')){changed=true;await h.sync.save('owner',{enabled:false});}});
  const job=await h.sync.start('owner',r.id),result=await settled(h.sync,job.id);assert.equal(result.error,'git_rule_changed');assert.equal(h.network.writes.length,0);
});
test('direct branch writes require separate consent and only create missing archive files',async t=>{
  const h=await fixture(t);await assert.rejects(h.sync.save('owner',{...h.policy,mode:'direct'}),{code:'git_direct_confirmation_required'});await h.sync.save('owner',{...h.policy,mode:'direct',directConfirmed:true});const r=await h.record();h.respond(r);
  const job=await h.sync.start('owner',r.id),result=await settled(h.sync,job.id);assert.equal(result.status,'succeeded');assert.equal(result.branch,'main');assert.equal(h.network.mrs.length,0);assert.equal(h.network.writes.filter(w=>w.path.endsWith('/repository/commits')).length,1);
});
test('replacing credentials fences old writes; explicit retry uses only the new credential',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record();h.respond(r);h.network.allowToken('synthetic-readonly-token',true);h.network.allowToken('synthetic-new-write-token');let replaced=false;
  h.network.onRead(async path=>{if(!replaced&&path.includes('/repository/branches/lingji')){replaced=true;await h.sync.save('owner',{...h.policy,token:'synthetic-readonly-token'});}});
  const job=await h.sync.start('owner',r.id),blocked=await settled(h.sync,job.id);assert.equal(blocked.error,'git_rule_changed');assert.equal(h.network.writes.length,0);
  await h.sync.control('owner',job.id,'retry');const denied=await settled(h.sync,job.id);assert.equal(denied.error,'git_write_forbidden');assert.ok(h.network.writes.every(w=>w.token==='synthetic-readonly-token'));
  await h.sync.save('owner',{...h.policy,token:'synthetic-new-write-token'});await h.sync.control('owner',job.id,'retry');assert.equal((await settled(h.sync,job.id)).status,'succeeded');assert.equal(h.network.mrs.length,1);assert.ok(!h.network.writes.some(w=>w.token==='synthetic-git-token'));
});
test('automatic initial root discovery uses the durable 429 retry budget',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record();h.respond(r);let reads=0;
  h.network.onRead(path=>{if(path==='/groups/root'&&reads++===0)return {status:429,headers:{},text:'{}'};});
  await h.sync.tick();const job=(await h.sync.settings('owner')).recent[0];assert.equal((await settled(h.sync,job.id)).status,'succeeded');assert.ok(reads>=2);assert.equal((await h.repo.get(job.id)).rateAttempts,1);assert.equal(h.network.mrs.length,1);
});
test('idle history polling and automatic scans never reread completed meeting bodies',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record();h.respond(r);const job=await h.sync.start('owner',r.id);assert.equal((await settled(h.sync,job.id)).status,'succeeded');
  const get=h.repo.get.bind(h.repo);let bodyReads=0;h.repo.get=async id=>{if(id===r.id)bodyReads++;return get(id);};
  for(let i=0;i<4;i++){await h.sync.settings('owner');await h.sync.tick();}
  assert.equal(bodyReads,0);
});
test('new archive policies use a new branch and versioned path; credentials alone keep the same snapshot',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record();h.respond(r);const first=await h.sync.start('owner',r.id);assert.equal((await settled(h.sync,first.id)).status,'succeeded');const old=await h.repo.get(first.id);
  await h.sync.save('owner',{...h.policy,prompt:'改为整理项目风险与引用。'});h.respond(r);const next=await h.sync.start('owner',r.id);assert.equal((await settled(h.sync,next.id)).status,'succeeded');const current=await h.repo.get(next.id);assert.notEqual(old.branch,current.branch);assert.notEqual(old.filePath,current.filePath);
});
test('already merged content reconciles from the base branch after the archive branch was removed',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record();h.respond(r);h.network.timeoutAfterCommit();const job=await h.sync.start('owner',r.id);assert.equal((await settled(h.sync,job.id)).status,'unknown');const row=await h.repo.get(job.id);
  for(const [path,content] of Object.entries(row.files))h.network.files.set(`main:${path}`,content);h.network.branches.set('main',writeSha);h.network.branches.delete(row.branch);
  await h.sync.control('owner',job.id,'retry');const result=await settled(h.sync,job.id);assert.equal(result.status,'succeeded');assert.match(result.url,/\/commit\//);assert.equal(h.network.writes.filter(w=>w.path.endsWith('/repository/commits')).length,1);assert.equal(h.network.mrs.length,0);
});
test('archive dates follow the configured timezone across a UTC day boundary',async t=>{
  const h=await fixture(t);await h.sync.save('owner',{...h.policy,timezone:'Asia/Shanghai'});const r=await h.record();await h.repo.change(r.id,record=>{record.createdAt='2026-11-02T17:00:00.000Z';});h.respond(r);const job=await h.sync.start('owner',r.id);assert.equal((await settled(h.sync,job.id)).status,'succeeded');const row=await h.repo.get(job.id);assert.match(row.filePath,/docs\/meetings\/2026-11-03-/);assert.equal(JSON.parse(row.files[row.manifestPath]).timezone,'Asia/Shanghai');
});

// Different records remain separate even when all archival content and timestamps match.
test('distinct record IDs never share an archival task',async t=>{
 const h=await fixture(t);await h.sync.save('owner',h.policy);const first=await h.record(),second=structuredClone(first);second.id=crypto.randomUUID();await h.repo.insert(second);
 h.respond(first);const a=await h.sync.start('owner',first.id);assert.equal((await settled(h.sync,a.id)).status,'succeeded');
 h.respond(second);const b=await h.sync.start('owner',second.id);assert.notEqual(a.id,b.id);assert.equal((await settled(h.sync,b.id)).status,'succeeded');assert.equal((await h.sync.get('owner',b.id)).recordId,second.id);assert.equal(h.network.mrs.length,2);
});

test('retention purges archived payloads beyond the recent history limit',async t=>{
 const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record();
 await h.repo.insert({id:'git-sync:old-retention',kind:'git-sync-job',owner:'owner',recordId:r.id,status:'succeeded',createdAt:'2020-01-01T00:00:00.000Z',updatedAt:'2020-01-01T00:00:00.000Z',original:'sensitive original',files:{'minutes.md':'sensitive artifact'}});
 for(let i=0;i<1000;i++)await h.repo.insert({id:`git-sync:new-retention-${String(i).padStart(4,'0')}`,kind:'git-sync-job',owner:'owner',recordId:r.id,status:'succeeded',createdAt:'2021-01-01T00:00:00.000Z',updatedAt:'2021-01-01T00:00:00.000Z'});
 await h.repo.change(r.id,item=>{item.deleted=true;});await h.sync.tick();const old=await h.repo.get('git-sync:old-retention');assert.equal(old.original,null);assert.equal(old.files,null);assert.equal(old.error,'git_source_unavailable');
});

test('deleting a source during prepare never restores a purged archival payload',async t=>{
 const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record(),change=h.repo.change.bind(h.repo);let interleaved=false;
 h.repo.change=async(id,mutate)=>{
  if(!interleaved&&id.startsWith('git-sync:')){const candidate=await h.repo.get(id);if(candidate){const copy=structuredClone(candidate);mutate(copy);if(copy.original){interleaved=true;await change(r.id,item=>{item.deleted=true;});await h.sync.tick();}}}
  return change(id,mutate);
 };
 const job=await h.sync.start('owner',r.id);await settled(h.sync,job.id);await delay(30);const stored=await h.repo.get(job.id);assert.equal(interleaved,true);assert.equal(stored.error,'git_source_unavailable');assert.equal(stored.original,null);assert.equal(stored.files,null);assert.equal(h.network.writes.length,0);
});
