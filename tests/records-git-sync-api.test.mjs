import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage as message,fauxToolCall as call} from '@earendil-works/pi-ai/providers/faux';
import {createRecordServer} from '../services/records/src/server.mjs';
import {createRecord} from '../packages/records/src/record.mjs';
import {source,gitRemoteFixture} from './fixtures/git-sync.mjs';

test('Git sync HTTP enforces auth, CSRF, explicit consent, owner boundaries and encoded task IDs',async t=>{
  const root=await mkdtemp(join(tmpdir(),'lingji-git-api-')),network=gitRemoteFixture(false),models=createModels(),fake=fauxProvider({provider:'git-api-test',models:[{id:'test'}],tokensPerSecond:Infinity});models.setProvider(fake.provider);
  const app=await createRecordServer({root,databaseUrl:'',port:0,agentOptions:{models,model:{provider:'git-api-test',modelId:'test'}},gitSyncOptions:{request:network.request,pollMs:3600000,agentPollMs:10,retryDelayMs:10}});await app.start();
  t.after(async()=>{await app.stop();await rm(root,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${app.server.address().port}/api`;
  const login=async(email='dev@local.test',path='login')=>{const res=await fetch(`${url}/auth/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'LocalMeeting2026!'})});assert.equal(res.status,200);const data=await res.json();return {cookie:res.headers.get('set-cookie').split(';')[0],csrf:data.csrf};};
  const owner=await login(),other=await login('git-other@local.test','register');
  async function request(path,method='GET',body,user=owner,csrf=true){const r=await fetch(url+path,{method,headers:{Cookie:user.cookie,'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':user.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};}
  const policy={enabled:true,confirmed:true,root:source,token:'synthetic-git-token',prompt:'整理决策并引用来源。',skillId:'meeting-review',skillVersion:'1.0.0',pluginIds:[],pluginVersions:{},mappings:[],aliases:[],mode:'mr',directory:'docs/meetings',includeNotes:false,includeEvidence:true};
  assert.equal((await fetch(url+'/integrations/git-sync')).status,401);
  assert.equal((await request('/integrations/git-sync/check','POST',policy,owner,false)).status,403);
  assert.equal((await request('/integrations/git-sync','PUT',{...policy,confirmed:false})).status,400);
  assert.equal((await request('/integrations/git-sync','PUT',{...policy,mode:'direct'})).body.error,'git_direct_confirmation_required');
  assert.equal((await request('/integrations/git-sync/check','POST',policy)).body.projects.length,2);
  assert.equal((await request('/integrations/git-sync/preview','POST',{root:source,token:policy.token,mappings:[],aliases:[]})).status,200);
  const saved=await request('/integrations/git-sync','PUT',policy);assert.equal(saved.status,200);assert.equal(saved.body.enabled,true);assert.ok(!JSON.stringify(saved.body).includes(policy.token));
  const user=(await app.repo.list('user')).find(u=>u.email==='dev@local.test'),record=createRecord(user.id,{title:'浦东机场 周会',autoMinutes:false});
  Object.assign(record,{capture:'completed',transcription:'ready',transcriptRevision:1,minutesRevision:1,segments:[{id:'cited',revision:1,text:'周五评审',startMs:0,endMs:1000}],minutes:{title:'人工纪要',revision:1,transcriptRevision:1,edited:true,sections:[{title:'结论',items:[{text:'周五评审',evidence:[{segmentId:'cited',revision:1}]}]}],decisions:[],actions:[],evidenceSnapshot:[]}});await app.repo.insert(record);
  fake.setResponses([message(call('read_selected_meeting',{recordId:record.id}),{stopReason:'toolUse'}),message(JSON.stringify({summary:'整理完成',decisions:[{text:'周五评审',evidence:[{recordId:record.id,segmentId:'cited',revision:1}]}],actions:[]}))]);
  assert.equal((await request('/integrations/git-sync/tasks','POST',{recordId:record.id,confirmed:false})).status,400);
  const started=await request('/integrations/git-sync/tasks','POST',{recordId:record.id,confirmed:true});assert.equal(started.status,202,JSON.stringify(started));
  const path='/integrations/git-sync/tasks/'+encodeURIComponent(started.body.id);assert.equal((await request(path,'GET',undefined,other)).status,404);
  let result;for(let i=0;i<200;i++){result=await request(path);if(['succeeded','failed','blocked','unknown'].includes(result.body.status))break;await delay(15);}
  assert.equal(result.body.status,'succeeded',JSON.stringify(result));assert.equal(network.mrs.length,1);
  assert.equal((await request('/integrations/git-sync','GET',undefined,other)).body.recent.length,0);
  assert.ok(!JSON.stringify((await request('/integrations/git-sync')).body).includes(policy.token));
  const disabled=await request('/integrations/git-sync','PUT',{...policy,enabled:false,confirmed:false,prompt:'关闭后保存的指令',directory:'docs/updated'});assert.equal(disabled.status,200);const reread=await request('/integrations/git-sync');assert.equal(reread.body.enabled,false);assert.equal(reread.body.prompt,'关闭后保存的指令');assert.equal(reread.body.directory,'docs/updated');
});
