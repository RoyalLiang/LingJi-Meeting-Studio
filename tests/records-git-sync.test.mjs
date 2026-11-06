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
async function fixture(t,agentOptions={}){
  const root=await mkdtemp(join(tmpdir(),'lingji-git-sync-')),repo=await createRepository({root,databaseUrl:''}),network=remote(),extensions=await createExtensions(repo);
  const models=createModels(),fake=fauxProvider({provider:'git-test',models:[{id:'test'}],tokensPerSecond:Infinity});models.setProvider(fake.provider);let agent,sync;
  t.after(async()=>{await sync?.close();await agent?.close();await repo.close();await rm(root,{recursive:true,force:true});});
  async function open(){agent=await createMeetingAgentRuntime({...agentOptions,repo,extensions,models,model:{provider:'git-test',modelId:'test'}});sync=await createGitSync({repo,agent,extensions,request:network.request,localAccount:true,pollMs:3600000,agentPollMs:10,retryDelayMs:10});}
  await open();
  const policy={root:source,token:'synthetic-git-token',enabled:true,confirmed:true,prompt:'整理决策，保留人工修订和引用。',skillId:'meeting-review',skillVersion:'1.0.0',pluginIds:[],pluginVersions:{},remoteToolsConfirmed:true,mappings:[],aliases:[],directory:'docs/meetings',mode:'mr',includeNotes:false,includeEvidence:true};
  async function record(title='浦东机场｜周会',workspaceId){const r=createRecord('owner',{title,autoMinutes:false});Object.assign(r,{capture:'completed',transcription:'ready',transcriptRevision:1,minutesRevision:1,workspaceId,notes:'private-notes',segments:[{id:'cited',revision:1,text:'决定保留人工修订。',startMs:0,endMs:1000},{id:'uncited',revision:1,text:'never-export-uncited-transcript',startMs:1000,endMs:2000}]});const evidence=[{segmentId:'cited',revision:1}];r.minutes={title,revision:1,transcriptRevision:1,edited:true,sections:[{title:'人工纪要',items:[{text:'人工修订内容不能丢失',evidence}]}],decisions:[{text:'保留人工修订',evidence}],actions:[],evidenceSnapshot:[r.segments[0]]};await repo.insert(r);return r;}
  function respond(r){fake.setResponses([message(call('read_selected_meeting',{recordId:r.id}),{stopReason:'toolUse'}),context=>{assert.doesNotMatch(JSON.stringify(context),/never-export-uncited-transcript|private-notes/);return message(JSON.stringify({summary:'归档整理结果。',decisions:[{text:'保留人工修订',evidence:[{recordId:r.id,segmentId:'cited',revision:1}]}],actions:[]}));}]);}
  return {root,repo,network,policy,record,respond,extensions,fake,get agent(){return agent;},get sync(){return sync;},async restart(){await sync.close();await agent.close();await open();}};
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


test('Git archives retain all selected Skills and read a top-level bundle with real Pi',async t=>{
 const h=await fixture(t),version='c'.repeat(40),id='extension:bundle-test';await h.repo.insert({id,kind:'extension',owner:'owner',type:'skill',source:'https://git.example.test/root/skills',path:'skills',name:'项目指引集合',version,enabled:true,bundle:true,content:'# 项目指引集合',members:[{name:'risk',path:'skills/risk',description:'风险整理',version,content:'保留人工纪要与风险引用。'}]});
 const policy={...h.policy,skillIds:['meeting-review',id],skillVersions:{'meeting-review':'1.0.0',[id]:version}};await h.sync.save('owner',policy);assert.deepEqual((await h.sync.settings('owner')).skillIds.slice().sort(),policy.skillIds.slice().sort());const r=await h.record(),scope=await h.extensions.snapshot('owner',policy),guide=scope.guides.find(g=>g.name==='risk');h.fake.setResponses([message(call('read_selected_skill',{key:guide.key}),{stopReason:'toolUse'}),message(call('read_selected_meeting',{recordId:r.id}),{stopReason:'toolUse'}),message(call('manage_git_sync',{action:'archive',mode:'mr',directory:'docs/meetings',content:'# 风险归档\n保留人工纪要与风险引用。'}),{stopReason:'toolUse'}),message(JSON.stringify({summary:'风险已整理',decisions:[{text:'保留人工纪要',evidence:[{recordId:r.id,segmentId:'cited',revision:1}]}],actions:[]}))]);const job=await h.sync.start('owner',r.id);assert.equal((await settled(h.sync,job.id)).status,'succeeded');const row=await h.repo.get(job.id),manifest=JSON.parse(Object.entries(row.files).find(([path])=>path.endsWith('source.json'))?.[1]||Object.entries(row.files).find(([path])=>path.endsWith('.json'))[1]);assert.equal(manifest.skills.length,2);assert.ok(manifest.skillFiles.some(g=>g.path==='skills/risk'));
});

test('a slow connection check cannot delay disabling Git sync',async t=>{
 const h=await fixture(t);await h.sync.save('owner',h.policy);
 let entered,release;const seen=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
 h.network.onRead(async path=>{if(path==='/groups/root'){entered();await gate;}});
 const checking=h.sync.check('owner',{root:source,token:'synthetic-git-token'});await seen;
 try{const disabling=h.sync.save('owner',{enabled:false});const result=await Promise.race([disabling,delay(80).then(()=>null)]);assert.ok(result,'disabling must not wait for unrelated network checks');assert.equal(result.enabled,false);}finally{release();await checking;}
});

test('an older enable save cannot overwrite a newer disable while validation is slow',async t=>{
 const h=await fixture(t);await h.sync.save('owner',h.policy);
 let entered,release;const seen=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});h.network.onRead(async path=>{if(path==='/groups/root'){entered();await gate;}});
 h.network.allowToken('delayed-new-token');const saving=h.sync.save('owner',{...h.policy,token:'delayed-new-token',prompt:'新版整理指令'}).then(value=>({value}),error=>({error}));await seen;
 try{const disabled=await Promise.race([h.sync.save('owner',{enabled:false}),delay(80).then(()=>null)]);assert.ok(disabled,'disable must be durable before validation completes');}finally{release();}
 const stale=await saving;assert.equal(stale.error?.code,'git_rule_changed');assert.equal((await h.sync.settings('owner')).enabled,false);
});

test('pause is persisted during an unrelated slow check and prevents further Git writes',async t=>{
 const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record();h.respond(r);
 let projectSeen,releaseProject,checkSeen,releaseCheck,checking=false,held=false;
 const atProject=new Promise(r=>{projectSeen=r;}),projectGate=new Promise(r=>{releaseProject=r;}),atCheck=new Promise(r=>{checkSeen=r;}),checkGate=new Promise(r=>{releaseCheck=r;});
 h.network.onRead(async path=>{if(path==='/projects/10'&&!held){held=true;projectSeen();await projectGate;}else if(path==='/groups/root'&&checking){checkSeen();await checkGate;}});
 const job=await h.sync.start('owner',r.id);await atProject;checking=true;const check=h.sync.check('owner',{root:source,token:'synthetic-git-token'});await atCheck;
 try{const paused=await Promise.race([h.sync.control('owner',job.id,'pause'),delay(80).then(()=>null)]);assert.ok(paused,'pause must not wait for a connection check');assert.equal(paused.status,'paused');releaseProject();await delay(25);assert.equal(h.network.writes.length,0);}finally{releaseProject();releaseCheck();await check;}
});

test('direct sync initializes an empty repository at its declared default branch',async t=>{
 const h=await fixture(t);h.network.branches.delete('main');h.network.onRead(path=>path==='/projects/10'?{status:200,headers:{},text:JSON.stringify({...projects[0],empty_repo:true})}:undefined);
 await h.sync.save('owner',{...h.policy,mode:'direct',directConfirmed:true});const r=await h.record();h.respond(r);const job=await h.sync.start('owner',r.id);const result=await settled(h.sync,job.id);
 assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(result.branch,'main');assert.equal(h.network.mrs.length,0);assert.equal(h.network.writes.filter(w=>w.path.endsWith('/repository/commits')).length,1);
});

test('MR mode leaves an empty repository unchanged and explains initialization is required',async t=>{
 const h=await fixture(t);h.network.branches.delete('main');h.network.onRead(path=>path==='/projects/10'?{status:200,headers:{},text:JSON.stringify({...projects[0],empty_repo:true})}:undefined);
 await h.sync.save('owner',h.policy);const r=await h.record();h.respond(r);const job=await h.sync.start('owner',r.id),result=await settled(h.sync,job.id);
 assert.equal(result.error,'git_repository_empty');assert.equal(h.network.writes.length,0);
});

test('missing default branch in a nonempty repository is not reported as an invisible project',async t=>{
 const h=await fixture(t);h.network.branches.delete('main');h.network.branches.set('other','a'.repeat(40));h.network.onRead(path=>path==='/projects/10'?{status:200,headers:{},text:JSON.stringify({...projects[0],empty_repo:false})}:undefined);
 await h.sync.save('owner',{...h.policy,mode:'direct',directConfirmed:true});const r=await h.record();h.respond(r);const job=await h.sync.start('owner',r.id),result=await settled(h.sync,job.id);
 assert.equal(result.error,'git_default_branch_missing');assert.equal(h.network.writes.length,0);
});

test('uncertain first commit in an empty repository is verified before retrying',async t=>{
 const h=await fixture(t);h.network.branches.delete('main');h.network.onRead(path=>path==='/projects/10'?{status:200,headers:{},text:JSON.stringify({...projects[0],empty_repo:true})}:undefined);
 await h.sync.save('owner',{...h.policy,mode:'direct',directConfirmed:true});const r=await h.record();h.respond(r);h.network.timeoutAfterCommit();const job=await h.sync.start('owner',r.id);
 assert.equal((await settled(h.sync,job.id)).status,'unknown');await h.sync.control('owner',job.id,'retry');assert.equal((await settled(h.sync,job.id)).status,'succeeded');assert.equal(h.network.writes.filter(w=>w.path.endsWith('/repository/commits')).length,1);
});

test('save reports mapping, alias and directory errors specifically and accepts the visible default directory',async t=>{
 const h=await fixture(t);const w={id:crypto.randomUUID(),kind:'workspace',owner:'owner',name:'RTLS'};await h.repo.insert(w);
 await assert.rejects(h.sync.save('owner',{...h.policy,mappings:[{workspaceId:'missing',projectId:10}]}),{code:'git_mapping_invalid'});
 await assert.rejects(h.sync.save('owner',{...h.policy,mappings:[{workspaceId:w.id,projectId:10},{workspaceId:w.id,projectId:20}]}),{code:'git_mapping_duplicate'});
 await assert.rejects(h.sync.save('owner',{...h.policy,aliases:[{name:'',projectId:10}]}),{code:'git_alias_invalid'});
 await assert.rejects(h.sync.save('owner',{...h.policy,directory:'../secret'}),{code:'git_directory_invalid'});
 assert.equal((await h.sync.save('owner',{...h.policy,directory:''})).directory,'docs/meetings');
});

test('saving local preferences reuses the validated connection while changed credentials are checked',async t=>{
 const h=await fixture(t);await h.sync.save('owner',h.policy);let requests=0;h.network.onRead(()=>{requests++;});
 await h.sync.save('owner',{...h.policy,prompt:'只调整整理方式'});assert.equal(requests,0,'local edits must not repeat remote catalog requests');
 h.network.allowToken('changed-synthetic-token');await h.sync.save('owner',{...h.policy,token:'changed-synthetic-token'});assert.ok(requests>0);
});

test('agent-led sync survives a legacy expired deadline',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record();
  h.fake.setResponses([async()=>{await delay(80);return message(call('read_selected_meeting',{recordId:r.id}),{stopReason:'toolUse'});},message(JSON.stringify({summary:'已归档',decisions:[{text:'保留人工修订',evidence:[{recordId:r.id,segmentId:'cited',revision:1}]}],actions:[]}))]);
  const job=await h.sync.start('owner',r.id);await h.repo.change(job.id,row=>{row.deadline=1;});
  assert.equal((await settled(h.sync,job.id)).status,'succeeded');
});

test('Skill controls archive mode and directory, waits for reply across restart, and writes once',async t=>{
  const h=await fixture(t,{timeoutMs:20}),version='d'.repeat(40),id='extension:interactive-sync';
  await h.repo.insert({id,kind:'extension',owner:'owner',type:'skill',source:'https://git.example.test/root/skills',path:'skills/archive',name:'归档工作流',version,enabled:true,content:'询问归档方式，收到答复后直接提交到 docs/skill-notes，保留来源。'});
  const policy={...h.policy,skillIds:[id],skillVersions:{[id]:version},mode:'',directory:''};await h.sync.save('owner',policy);
  const r=await h.record(),scope=await h.extensions.snapshot('owner',policy),guide=scope.guides[0];
  h.fake.setResponses([
    message(call('read_selected_skill',{key:guide.key}),{stopReason:'toolUse'}),
    message(call('read_selected_meeting',{recordId:r.id}),{stopReason:'toolUse'}),
    message(call('request_user_input',{id:'write-mode',question:'请确认本次归档方式。',options:['直接提交','创建合并请求']}),{stopReason:'toolUse'}),
    context=>{assert.match(JSON.stringify(context),/直接提交/);return message(call('manage_git_sync',{action:'archive',mode:'direct',directory:'docs/skill-notes',content:'# Skill 归档\n保留人工修订。'}),{stopReason:'toolUse'});},
    context=>{assert.ok(!context.messages.some(m=>m.role==='toolResult'&&m.isError));return message(JSON.stringify({summary:'已按所选 Skill 完成归档。',decisions:[{text:'保留人工修订',evidence:[{recordId:r.id,segmentId:'cited',revision:1}]}],actions:[]}));}
  ]);
  const job=await h.sync.start('owner',r.id);let waiting;
  for(let i=0;i<200;i++){waiting=await h.sync.get('owner',job.id);if(waiting.interaction)break;await delay(10);}
  assert.equal(waiting.status,'waiting');await delay(80);assert.equal((await h.sync.get('owner',job.id)).status,'waiting');assert.equal(h.network.writes.length,0);assert.equal((await h.sync.status('owner')).recent[0].managed,true);const inputId=waiting.interaction.id;
  await h.repo.change(job.id,row=>{row.deadline=1;});await h.restart();
  waiting=await h.sync.get('owner',job.id);assert.equal(waiting.interaction.id,inputId);
  await assert.rejects(h.sync.respond('other',job.id,{id:inputId,answer:'直接提交'}),{code:'git_task_not_found'});
  await assert.rejects(h.sync.respond('owner',job.id,{id:'stale',answer:'直接提交'}),{code:'agent_input_changed'});
  await h.sync.respond('owner',job.id,{id:inputId,answer:'直接提交'});
  const done=await settled(h.sync,job.id);assert.equal(done.status,'succeeded',JSON.stringify(done));assert.equal(done.mode,'direct');assert.equal(h.network.mrs.length,0);
  const stored=await h.repo.get(job.id);assert.ok(Object.keys(stored.files).every(path=>path.startsWith('docs/skill-notes/')));assert.match(stored.files[stored.manifestPath],/originalMarkdown/);
  assert.equal(h.network.writes.filter(w=>w.path.endsWith('/repository/commits')).length,1);
});

test('Skill cannot change a fixed archive mode or directory',async t=>{
  const h=await fixture(t),version='e'.repeat(40),id='extension:scope-test';await h.repo.insert({id,kind:'extension',owner:'owner',type:'skill',source:'https://git.example.test/root/skills',path:'skills/test',name:'Scope test',version,enabled:true,content:'Archive within the user scope.'});
  await h.sync.save('owner',{...h.policy,skillIds:[id],skillVersions:{[id]:version}});const r=await h.record();h.fake.setResponses([
    message(call('read_selected_meeting',{recordId:r.id}),{stopReason:'toolUse'}),
    message(call('manage_git_sync',{action:'archive',mode:'direct',directory:'other/path',content:'outside fixed policy'}),{stopReason:'toolUse'}),
    context=>{assert.ok(context.messages.some(m=>m.role==='toolResult'&&m.isError&&JSON.stringify(m).includes('git_scope_changed')));return message(JSON.stringify({summary:'无法归档',decisions:[{text:'保留来源',evidence:[{recordId:r.id,segmentId:'cited',revision:1}]}],actions:[]}));}
  ]);const job=await h.sync.start('owner',r.id);let waiting;for(let i=0;i<300;i++){waiting=await h.sync.get('owner',job.id);if(waiting.status==='waiting')break;await delay(10);}assert.equal(waiting.status,'waiting');assert.equal(waiting.interaction.kind,'continuation');assert.equal(h.network.writes.length,0);
});

test('Skill retry reconciles an uncertain staged commit without a duplicate write',async t=>{
  const h=await fixture(t),version='f'.repeat(40),id='extension:reconcile-test';await h.repo.insert({id,kind:'extension',owner:'owner',type:'skill',source:'https://git.example.test/root/skills',path:'skills/archive',name:'Archive',version,enabled:true,content:'Archive and reconcile uncertain remote results before retrying.'});
  await h.sync.save('owner',{...h.policy,skillIds:[id],skillVersions:{[id]:version},mode:'',directory:''});const r=await h.record();
  const finish=()=>message(JSON.stringify({summary:'归档结果',decisions:[{text:'保留来源',evidence:[{recordId:r.id,segmentId:'cited',revision:1}]}],actions:[]}));
  h.network.timeoutAfterCommit();h.fake.setResponses([message(call('read_selected_meeting',{recordId:r.id}),{stopReason:'toolUse'}),message(call('manage_git_sync',{action:'archive',mode:'mr',directory:'docs/skill-notes',content:'# 归档'}),{stopReason:'toolUse'}),finish()]);
  const job=await h.sync.start('owner',r.id),unknown=await settled(h.sync,job.id);assert.equal(unknown.status,'unknown',JSON.stringify(unknown));assert.equal(unknown.error,'git_result_unknown');
  h.fake.setResponses([message(call('read_selected_meeting',{recordId:r.id}),{stopReason:'toolUse'}),message(call('manage_git_sync',{action:'reconcile'}),{stopReason:'toolUse'}),finish()]);await h.sync.control('owner',job.id,'retry');
  const done=await settled(h.sync,job.id);assert.equal(done.status,'succeeded',JSON.stringify(done));assert.equal(h.network.writes.filter(w=>w.path.endsWith('/repository/commits')).length,1);assert.equal(h.network.mrs.length,1);
});

test('pre-upgrade custom Skill settings apply the managed workflow to new tasks',async t=>{
  const h=await fixture(t),id='extension:legacy-policy',version='a'.repeat(40);await h.repo.insert({id,kind:'extension',owner:'owner',type:'skill',source:'https://git.example.test/root/skills',path:'skills/archive',name:'Archive',version,enabled:true,content:'Archive into the specified directory.'});
  await h.sync.save('owner',{...h.policy,skillIds:[id],skillVersions:{[id]:version}});const rule=(await h.repo.list('git-sync-rule'))[0];await h.repo.change(rule.id,row=>{delete row.managed;});const r=await h.record();
  h.fake.setResponses([message(call('read_selected_meeting',{recordId:r.id}),{stopReason:'toolUse'}),message(call('manage_git_sync',{action:'archive',mode:'mr',directory:'docs/meetings',content:'# Skill archive'}),{stopReason:'toolUse'}),message(JSON.stringify({summary:'已归档',decisions:[{text:'保留人工修订',evidence:[{recordId:r.id,segmentId:'cited',revision:1}]}],actions:[]}))]);
  const job=await h.sync.start('owner',r.id);assert.equal(job.managed,true);assert.equal((await settled(h.sync,job.id)).status,'succeeded');
});

test('Skill chooses multiple archive paths and messages inside a fixed target directory',async t=>{
  const h=await fixture(t),id='extension:batch-archive',version='9'.repeat(40);await h.repo.insert({id,kind:'extension',owner:'owner',type:'skill',source:'https://git.example.test/root/skills',path:'skills/archive',name:'Project archive',version,enabled:true,content:'List project files, then archive a context and a meeting note with meaningful commit and MR titles.'});
  await h.sync.save('owner',{...h.policy,skillIds:[id],skillVersions:{[id]:version},mode:'',directory:'docs/project'});const r=await h.record();
  h.network.onRead(path=>path.endsWith('/repository/tree')?{status:200,headers:{},text:JSON.stringify([{name:'README.md',path:'README.md',type:'blob'}])}:undefined);
  h.fake.setResponses([message(call('read_selected_meeting',{recordId:r.id}),{stopReason:'toolUse'}),message(call('manage_git_sync',{action:'list_files'}),{stopReason:'toolUse'}),message(call('manage_git_sync',{action:'archive',mode:'mr',directory:'docs/project',files:[{path:'CONTEXT.md',content:'# Project context'},{path:'meetings/review.md',content:'# Meeting decisions'}],commitMessage:'docs: initialize project knowledge',title:'项目资料归档'}),{stopReason:'toolUse'}),message(JSON.stringify({summary:'已按项目规则归档',decisions:[{text:'保留人工内容',evidence:[{recordId:r.id,segmentId:'cited',revision:1}]}],actions:[]}))]);
  const job=await h.sync.start('owner',r.id),done=await settled(h.sync,job.id);assert.equal(done.status,'succeeded',JSON.stringify(done));const stored=await h.repo.get(job.id);assert.ok(stored.files['docs/project/CONTEXT.md']);assert.ok(stored.files['docs/project/meetings/review.md']);assert.equal(Object.keys(stored.files).length,3);
  assert.match(h.network.writes.find(write=>write.path.endsWith('/repository/commits')).body.commit_message,/^docs: initialize project knowledge/);assert.equal(h.network.writes.find(write=>write.path.endsWith('/merge_requests')).body.title,'项目资料归档');
});


test('invalidating a rule cancels its pending Agent question and releases later work',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const first=await h.record(),next=await h.record('浦东机场｜后续会议');
  h.fake.setResponses([message(call('read_selected_meeting',{recordId:first.id}),{stopReason:'toolUse'}),message(call('request_user_input',{id:'confirm',question:'继续归档？'}),{stopReason:'toolUse'})]);
  const started=await h.sync.start('owner',first.id);let waiting;
  for(let i=0;i<200;i++){waiting=await h.sync.get('owner',started.id);if(waiting.interaction)break;await delay(10);}
  assert.ok(waiting.interaction);await h.sync.save('owner',{...h.policy,prompt:'保留来源并补充待确认事项。'});
  assert.equal((await settled(h.sync,started.id)).error,'git_rule_changed');
  for(let i=0;i<200&&(await h.agent.get('owner',waiting.agentId)).status!=='cancelled';i++)await delay(10);
  assert.equal((await h.agent.get('owner',waiting.agentId)).status,'cancelled');
  await assert.rejects(h.sync.respond('owner',started.id,{id:waiting.interaction.id,answer:'继续'}),{code:'git_rule_changed'});
  h.respond(next);const resumed=await h.sync.start('owner',next.id);assert.equal((await settled(h.sync,resumed.id)).status,'succeeded');
});

test('a paused Git question preserves its answer slot without blocking other Agent work',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const first=await h.record(),other=await h.record('浦东机场｜独立复盘');
  h.fake.setResponses([message(call('read_selected_meeting',{recordId:first.id}),{stopReason:'toolUse'}),message(call('request_user_input',{id:'confirm',question:'继续归档？'}),{stopReason:'toolUse'})]);
  const started=await h.sync.start('owner',first.id);let waiting;
  for(let i=0;i<200;i++){waiting=await h.sync.get('owner',started.id);if(waiting.interaction)break;await delay(10);}
  assert.ok(waiting.interaction);assert.equal((await h.sync.control('owner',started.id,'pause')).status,'paused');
  h.respond(other);const review=await h.agent.request('owner',{recordIds:[other.id],requestId:'independent-review',prompt:'独立复盘',scopeConfirmed:true,minutesOnly:true});
  let done;for(let i=0;i<200;i++){done=await h.agent.get('owner',review.id);if(['completed','failed','blocked','cancelled'].includes(done.status))break;await delay(10);}
  assert.equal(done.status,'completed',JSON.stringify(done));
  h.respond(first);const resumed=await h.sync.control('owner',started.id,'resume');assert.equal(resumed.interaction.id,waiting.interaction.id);
  await h.sync.respond('owner',started.id,{id:waiting.interaction.id,answer:'继续'});assert.equal((await settled(h.sync,started.id)).status,'succeeded');
});

test('a Skill final response needing human confirmation stays interactive instead of failing the sync',async t=>{
 const h=await fixture(t,{timeoutMs:20}),version='b'.repeat(40),id='extension:human-followup';
 await h.repo.insert({id,kind:'extension',owner:'owner',type:'skill',source:'https://git.example.test/root/skills',path:'skills/archive',name:'人工确认归档',version,enabled:true,content:'目标不明确时请先向用户确认，再归档到已选项目。'});
 const policy={...h.policy,skillIds:[id],skillVersions:{[id]:version},mode:'',directory:''};await h.sync.save('owner',policy);const r=await h.record();
 h.respond(r);const job=await h.sync.start('owner',r.id);let waiting;
 for(let i=0;i<300;i++){waiting=await h.sync.get('owner',job.id);if(['waiting','failed'].includes(waiting.status))break;await delay(10);}
 assert.equal(waiting.status,'waiting',JSON.stringify(waiting));assert.match(waiting.interaction.question,/归档整理结果/);assert.equal(h.network.writes.length,0);
 const inputId=waiting.interaction.id;await h.restart();assert.equal((await h.sync.get('owner',job.id)).interaction.id,inputId);
 const scope=await h.extensions.snapshot('owner',policy),guide=scope.guides[0];
 h.fake.setResponses([context=>{assert.match(JSON.stringify(context),/已核对目标/);return message(call('read_selected_skill',{key:guide.key}),{stopReason:'toolUse'});},message(call('read_selected_meeting',{recordId:r.id}),{stopReason:'toolUse'}),message(call('manage_git_sync',{action:'archive',mode:'mr',directory:'docs/briefs',content:'# 已确认归档\n保留人工修订。'}),{stopReason:'toolUse'}),message(JSON.stringify({summary:'已完成归档',decisions:[],actions:[]}))]);
 await assert.rejects(h.sync.respond('owner',job.id,{id:'outdated',answer:'已核对目标'}),{code:'agent_input_changed'});
 await h.sync.respond('owner',job.id,{id:inputId,answer:'已核对目标与权限，请继续同一项目的同步。'});
 const done=await settled(h.sync,job.id);assert.equal(done.status,'succeeded',JSON.stringify(done));assert.equal(h.network.mrs.length,1);
});

test('failed Git tasks retain answered questions across restart and retry without bloating lists',async t=>{
  const h=await fixture(t);await h.sync.save('owner',h.policy);const r=await h.record();
  h.fake.setResponses([
    message(call('read_selected_meeting',{recordId:r.id}),{stopReason:'toolUse'}),
    message(call('request_user_input',{id:'destination',question:'确认保留人工修订？',options:['保留']}),{stopReason:'toolUse'}),
    message('invalid final JSON')
  ]);
  const job=await h.sync.start('owner',r.id);let waiting;
  for(let i=0;i<200;i++){waiting=await h.sync.get('owner',job.id);if(waiting.interaction)break;await delay(10);}
  assert.ok(waiting.interaction);await h.sync.respond('owner',job.id,{id:waiting.interaction.id,answer:'保留人工修订'});
  const failed=await settled(h.sync,job.id);assert.equal(failed.status,'failed');
  assert.deepEqual(failed.conversation.map(({question,answer})=>({question,answer})),[{question:'确认保留人工修订？',answer:'保留人工修订'}]);
  assert.equal((await h.sync.status('owner')).recent[0].conversation,undefined);
  await h.restart();assert.deepEqual((await h.sync.get('owner',job.id)).conversation,failed.conversation);
  h.fake.setResponses([
    context=>{assert.match(JSON.stringify(context),/保留人工修订/);return message(call('read_selected_meeting',{recordId:r.id}),{stopReason:'toolUse'});},
    message(JSON.stringify({summary:'已保留修订',decisions:[{text:'保留人工修订',evidence:[{recordId:r.id,segmentId:'cited',revision:1}]}],actions:[]}))
  ]);
  await h.sync.control('owner',job.id,'retry');const done=await settled(h.sync,job.id);assert.equal(done.status,'succeeded',JSON.stringify(done));
  assert.equal(done.conversation.length,1);assert.equal(h.network.writes.filter(w=>w.path.endsWith('/repository/commits')).length,1);
  await h.repo.change(r.id,row=>{row.deleted=true;});assert.equal((await h.sync.get('owner',job.id)).conversation,undefined);
});

test('disabled configuration saves all edited preferences without enabling future writes',async t=>{
 const h=await fixture(t);await h.sync.save('owner',h.policy);
 const draft={...h.policy,enabled:false,confirmed:false,prompt:'关闭期间更新的整理指令',mode:'direct',directConfirmed:false,directory:'docs/updated'};
 const saved=await h.sync.save('owner',draft);assert.equal(saved.enabled,false);assert.equal(saved.prompt,draft.prompt);assert.equal(saved.directory,draft.directory);assert.equal(saved.mode,'direct');
 await h.restart();const read=await h.sync.settings('owner');assert.equal(read.prompt,draft.prompt);assert.equal(read.directory,draft.directory);assert.equal(h.network.writes.length,0);
 await assert.rejects(h.sync.save('owner',{...draft,enabled:true}),{code:'git_confirmation_required'});
});

test('scope preview returns the freshly checked project catalog for dropdown refresh',async t=>{
 const h=await fixture(t);await h.sync.save('owner',h.policy);const preview=await h.sync.preview('owner',h.policy);assert.deepEqual(preview.projects.map(({id,path})=>({id,path})),projects.map(({id,path})=>({id,path})));
});

test('saving a disabled draft fences writes before a slow changed-connection validation',async t=>{
 const h=await fixture(t);await h.sync.save('owner',h.policy);let release,entered;const gate=new Promise(r=>{release=r;}),seen=new Promise(r=>{entered=r;});h.network.allowToken('new-draft-token');h.network.onRead(async()=>{entered();await gate;});
 const saving=h.sync.save('owner',{...h.policy,enabled:false,confirmed:false,token:'new-draft-token',prompt:'新配置'});await seen;try{assert.equal((await h.sync.settings('owner')).enabled,false);assert.equal(h.network.writes.length,0);}finally{release();}assert.equal((await saving).prompt,'新配置');
});
