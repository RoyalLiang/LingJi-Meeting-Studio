import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecordServer } from '../services/records/src/server.mjs';
import { feishuBlocks, feishuFolder, createFeishu } from '../services/records/src/integrations/feishu.mjs';
import { exportMinutesMarkdown } from '../services/records/src/markdown-export.mjs';
import {minutesBoard} from '../packages/records/src/minutes-presentation.mjs';
import { createSecretStore } from '../services/records/src/integrations/secret-store.mjs';

const documentId='docFixture123456';
const appSecret='fixture-app-secret-private';
const accessToken='fixture-access-token-private';
function recordMinutes(record){
  record.capture='completed';record.transcriptRevision=2;record.minutesRevision=1;record.notes='private-saved-notes';
  record.minutes={title:'发布计划',revision:1,transcriptRevision:1,edited:true,evidenceSnapshot:[{id:'s1',revision:1,text:'引用版本一',startMs:0}],
    sections:[{heading:'结论',items:[{text:'保留人工修订',evidence:[{segmentId:'s1',revision:1}]}]}],actions:[]};
  record.segments=[{id:'s1',revision:2,text:'后续修改，不在引用范围'}];
}
function provider(){
  const calls=[],flags={};
  const remote={calls,flags,connections:[],async fetch(url,options){
    const body=options.body?String(options.body):'';calls.push({url,body,headers:options.headers});
    if(url.endsWith('/blocks/convert')){if(flags.convertGate)await flags.convertGate;return Response.json({code:0,data:{first_level_block_ids:['heading'],blocks:[{block_id:'heading',parent_id:'readonly',block_type:3,heading1:{elements:[{text_run:{content:'发布计划'}}]}}]}});}
    if(url.endsWith('/docx/v1/documents')){if(flags.createTimeout)throw new Error('network lost');return Response.json({code:0,data:{document:{document_id:documentId}}});}
    if(url.includes('/descendant?')){if(flags.writeFail)return Response.json({code:1770001,msg:'private-upstream-message'},{status:400});return Response.json({code:0,data:{block_id_relations:JSON.parse(body).descendants.filter(block=>!flags.missingNativeBlock||block.block_type!==4).map(block=>({temporary_block_id:block.block_id,block_id:`remote-${block.block_id}`}))}});}
    if(url.endsWith('/metas/batch_query'))return Response.json({code:0,data:{metas:[{doc_token:documentId,doc_type:'docx',title:'人工核对的会议纪要',url:`https://fixture.feishu.cn/docx/${documentId}`}],failed_list:[]}});
    if(url.includes('/children?')){const index=(remote.boardResources||0)+1;remote.boardResources=index;return Response.json({code:0,data:{children:JSON.parse(body).children.map(block=>block.block_type===43?{block_type:43,board:{token:`boardFixture123456789012-${index}`}}:block)}});}
    if(url.includes('/whiteboards/')&&url.includes('/nodes?')){remote.boardWrites=(remote.boardWrites||0)+1;if(flags.boardFailAt===remote.boardWrites)return Response.json({code:1770001},{status:400});return Response.json({code:0,data:{ids:JSON.parse(body).nodes.map(node=>node.id)}});}
    if(url.includes('/members/transfer_owner?'))return Response.json({code:0,data:{}});
    throw new Error('Unexpected fixture URL');
  }};
  remote.sdkFactory=async({appId,appSecret:secret,signal})=>{
    let state='idle';const close=()=>{state='idle';};signal.addEventListener('abort',close,{once:true});
    return {async start(){remote.connections.push({appId,secret});if(flags.connectGate)await flags.connectGate;if(flags.connectError||signal.aborted)throw new Error('private-sdk-details');state='connected';},
      status:()=>({state:flags.offline?'reconnecting':state,reconnectAttempts:0}),
      async request(url,{body}={}){const response=await remote.fetch(url,{body:body?JSON.stringify(body):undefined,headers:{Authorization:`Bearer ${accessToken}`}});const data=await response.json();if(!response.ok)throw {response:{status:response.status,data}};return data;},
      close(){signal.removeEventListener('abort',close);close();}
    };
  };return remote;
}
async function harness(t,{autoPollMs=100}={}){
  const root=await mkdtemp(join(tmpdir(),'lingji-feishu-')),remote=provider(),app=await createRecordServer({root,databaseUrl:'',port:0,feishuOptions:{sdkFactory:remote.sdkFactory,autoPollMs}});
  const address=await app.start(),base=`http://127.0.0.1:${address.port}/api`;
  const response=await fetch(`${base}/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'feishu@example.test',password:'fixture-password'})});
  const user=await response.json(),headers={Cookie:response.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':user.csrf,'Content-Type':'application/json'};
  const request=async(path,method='GET',body)=>{const result=await fetch(`${base}${path}`,{method,headers,...(body?{body:JSON.stringify(body)}:{})});return {status:result.status,body:await result.json()};};
  t.after(async()=>{await app.stop();await rm(root,{recursive:true,force:true});});
  const created=await request('/records','POST',{});await app.repo.change(created.body.id,recordMinutes);
  async function connect(){
    assert.equal((await request('/integrations/feishu','PUT',{appId:'cli_a1b2c3d4e5f67890',appSecret})).status,200);
    const value=await request('/integrations/feishu','PATCH',{enabled:true});assert.equal(value.status,200);await waitFor(async()=>(await request('/integrations/feishu')).body.connected);
  }
  const preview=()=>request(`/records/${created.body.id}/feishu/preview`,'POST',{title:'人工核对的会议纪要',folderToken:'',includeNotes:false,includeEvidence:true});
  const wait=async id=>{for(let i=0;i<60;i++){const value=await request(`/integrations/feishu/exports/${id}`);if(value.body.status!=='publishing')return value.body;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Fixture export did not complete');};
  return {root,remote,app,base,headers,request,recordId:created.body.id,connect,preview,wait};
}

test('secret store binds ciphertext to owner and keeps key private',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lingji-vault-'));
  try{const store=await createSecretStore(root),sealed=store.seal('owner-a',{token:accessToken});assert.equal(store.open('owner-a',sealed).token,accessToken);assert.throws(()=>store.open('owner-b',sealed));assert.ok(!(await readFile(join(root,'integrations.key'))).includes(Buffer.from(accessToken)));if(process.platform!=='win32')assert.equal((await stat(join(root,'integrations.key'))).mode&0o777,0o600);}finally{await rm(root,{recursive:true,force:true});}
});
test('Feishu content scopes and converted block trees reject missing, duplicate or unsafe content',()=>{
  assert.equal(feishuFolder('https://team.feishu.cn/drive/folder/folderFixture123?from=copy'),'folderFixture123');
  for(const value of ['https://feishu.cn.evil.test/drive/folder/folderFixture123','http://localhost/drive/folder/folderFixture123','https://a.feishu.cn/wiki/wikiFixture123'])assert.throws(()=>feishuFolder(value));
  const blocks={first_level_block_ids:['table'],blocks:[{block_id:'table',parent_id:'old',block_type:31,children:['cell'],table:{merge_info:[],property:{row_size:1,column_size:1,merge_info:[]}}},{block_id:'cell',block_type:32}]};
  const cleaned=feishuBlocks(blocks);assert.equal(cleaned.descendants[0].parent_id,undefined);assert.equal(cleaned.descendants[0].table.merge_info,undefined);assert.equal(blocks.blocks[0].parent_id,'old');
  assert.throws(()=>feishuBlocks({...blocks,first_level_block_ids:['table','cell']}));assert.throws(()=>feishuBlocks({first_level_block_ids:['x'],blocks:[{block_id:'x',image:{token:'image'}}]}));
  const record={};recordMinutes(record);const text=exportMinutesMarkdown(record,{includeNotes:false,includeEvidence:false});assert.doesNotMatch(text,/private-saved-notes|引用版本一|\[\^1\]/);assert.match(text,/保留人工修订/);
});
test('Feishu SDK connection, frozen preview, owner isolation and one-time publication persist a receipt',async t=>{
  const h=await harness(t);await h.connect();
  const settings=await h.request('/integrations/feishu');assert.equal(settings.body.connected,true);assert.doesNotMatch(JSON.stringify(settings.body),/fixture-app-secret|fixture-access-token|fixture-refresh/);
  const stored=(await h.app.repo.list('feishu-connection'))[0];assert.doesNotMatch(JSON.stringify(stored),/fixture-app-secret|fixture-access-token|fixture-refresh/);
  const preview=await h.preview();assert.doesNotMatch(preview.body.markdown,/^# /,'Feishu already provides the document title');assert.match(preview.body.markdown,/保留人工修订|引用版本一/);assert.doesNotMatch(preview.body.markdown,/private-saved-notes|后续修改/);
  const id=preview.body.id;assert.equal((await h.request(`/integrations/feishu/exports/${id}/publish`,'POST',{confirmed:false})).status,400);
  assert.equal((await h.request(`/integrations/feishu/exports/${id}/publish`,'POST',{confirmed:true})).status,202);
  const receipt=await h.wait(id);assert.equal(receipt.status,'succeeded');assert.equal(receipt.url,`https://fixture.feishu.cn/docx/${documentId}`);
  const saved=(await h.request(`/records/${h.recordId}/feishu`)).body.exports[0];assert.equal(saved.includeEvidence,true);assert.equal(saved.includeNotes,false);assert.equal(saved.automatic,false);assert.equal(Object.hasOwn(saved,'error'),false);
  await h.request(`/integrations/feishu/exports/${id}/publish`,'POST',{confirmed:true});assert.equal(h.remote.calls.filter(call=>call.url.endsWith('/docx/v1/documents')).length,1);
  assert.equal((await fetch(`${h.base}/integrations/feishu/exports/${id}`)).status,401);
  const other=await fetch(`${h.base}/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'other@example.test',password:'fixture-password'})});
  assert.equal((await fetch(`${h.base}/integrations/feishu/exports/${id}`,{headers:{Cookie:other.headers.get('set-cookie').split(';')[0]}})).status,404);
  const stale=await h.preview();await h.app.repo.change(h.recordId,record=>{record.minutes.sections[0].items[0].text='另一次人工修订';record.minutesRevision++;record.minutes.revision++;});
  assert.equal((await h.request(`/integrations/feishu/exports/${stale.body.id}/publish`,'POST',{confirmed:true})).body.error,'feishu_preview_stale');
});
test('uncertain create and partial write never automatically create a second document',async t=>{
  const h=await harness(t);await h.connect();h.remote.flags.createTimeout=true;
  const first=await h.preview();await h.request(`/integrations/feishu/exports/${first.body.id}/publish`,'POST',{confirmed:true});assert.equal((await h.wait(first.body.id)).status,'unknown');
  await h.request(`/integrations/feishu/exports/${first.body.id}/publish`,'POST',{confirmed:true});assert.equal(h.remote.calls.filter(call=>call.url.endsWith('/docx/v1/documents')).length,1);
  h.remote.flags.createTimeout=false;h.remote.flags.writeFail=true;
  const second=await h.preview();await h.request(`/integrations/feishu/exports/${second.body.id}/publish`,'POST',{confirmed:true});const partial=await h.wait(second.body.id);assert.equal(partial.status,'partial');assert.equal(partial.documentId,documentId);assert.doesNotMatch(JSON.stringify(partial),/private-upstream-message/);
});

async function waitFor(check){for(let i=0;i<100;i++){const result=await check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Fixture condition timed out');}
test('disconnect and source deletion while converting prevent later Feishu document creation',async t=>{
  const h=await harness(t);await h.connect();let release;h.remote.flags.convertGate=new Promise(resolve=>{release=resolve;});
  const draft=await h.preview();await h.request(`/integrations/feishu/exports/${draft.body.id}/publish`,'POST',{confirmed:true});
  await waitFor(()=>h.remote.calls.some(call=>call.url.endsWith('/blocks/convert')));
  await h.request('/integrations/feishu','DELETE');release();const result=await h.wait(draft.body.id);assert.equal(result.status,'failed');assert.equal(h.remote.calls.filter(call=>call.url.endsWith('/docx/v1/documents')).length,0);
  await h.connect();h.remote.calls.length=0;h.remote.flags.convertGate=new Promise(resolve=>{release=resolve;});
  const second=await h.preview();await h.request(`/integrations/feishu/exports/${second.body.id}/publish`,'POST',{confirmed:true});await waitFor(()=>h.remote.calls.some(call=>call.url.endsWith('/blocks/convert')));
  await h.app.repo.change(h.recordId,record=>{record.deleted=true;});release();
  await waitFor(async()=>{const value=await h.app.repo.get(second.body.id);return value.status==='failed'&&value;});
  assert.equal(h.remote.calls.filter(call=>call.url.endsWith('/docx/v1/documents')).length,0);assert.equal((await h.request(`/integrations/feishu/exports/${second.body.id}`)).status,404);
});
test('automatic export excludes already-ended meetings, sends final minutes once and invalidates on reconnect',async t=>{
  const h=await harness(t);await h.connect();
  assert.equal((await h.request('/integrations/feishu/automation','PUT',{enabled:true,confirmed:false,folderToken:'',includeNotes:false,includeEvidence:true})).status,400);
  const configured=await h.request('/integrations/feishu/automation','PUT',{enabled:true,confirmed:true,folderToken:'',includeNotes:false,includeEvidence:true});assert.equal(configured.body.enabled,true);
  const created=await h.request('/records','POST',{});await h.app.repo.change(created.body.id,record=>{recordMinutes(record);record.title='人工核对的会议纪要';record.transcription='ready';record.minutes.transcriptRevision=record.transcriptRevision;});
  const finished=await waitFor(async()=>{const current=await h.request('/integrations/feishu/automation');return current.body.recent.find(item=>item.status==='succeeded');});
  assert.equal(finished.recordId,created.body.id);assert.equal(h.remote.calls.filter(call=>call.url.endsWith('/docx/v1/documents')).length,1);
  const again=await h.request('/integrations/feishu/automation');assert.equal(again.body.recent.length,1);assert.equal((await h.app.repo.get(finished.id)).markdown,'');
  await h.request('/integrations/feishu','DELETE');assert.equal((await h.request('/integrations/feishu/automation')).body.connectionChanged,true);
  await h.request('/integrations/feishu/automation','PUT',{enabled:false});
});

test('automatic export waits for current final minutes and does not send stale human drafts or failed final jobs',async t=>{
  const h=await harness(t,{autoPollMs:60000});await h.connect();await h.request('/integrations/feishu/automation','PUT',{enabled:true,confirmed:true,folderToken:'',includeNotes:false,includeEvidence:true});
  const created=await h.request('/records','POST',{});await h.app.repo.change(created.body.id,record=>{recordMinutes(record);record.title='人工核对的会议纪要';record.transcription='ready';});
  const service=await createFeishu(h.app.repo,{sdkFactory:h.remote.sdkFactory});
  try{await service.automaticTick();assert.equal(h.remote.calls.filter(call=>call.url.endsWith('/docx/v1/documents')).length,0);
    await h.app.repo.change(created.body.id,record=>{record.minutes.transcriptRevision=record.transcriptRevision;record.jobs=[{id:'final',scope:'final',status:'failed'}];});await service.automaticTick();assert.equal(h.remote.calls.filter(call=>call.url.endsWith('/docx/v1/documents')).length,0);
    await h.app.repo.change(created.body.id,record=>{record.jobs[0].status='completed';});await service.automaticTick();const state=await h.request('/integrations/feishu/automation');assert.equal(state.body.recent.length,1);assert.equal((await h.wait(state.body.recent[0].id)).status,'succeeded');
  }finally{await service.close();}
});

test('application identity connects and exports without OAuth callback, user identity or relay',async t=>{
  const h=await harness(t),initial=await h.request('/integrations/feishu');
  assert.equal(initial.body.authMode,'app');
  const configured=await h.request('/integrations/feishu','PUT',{appId:'cli_a1b2c3d4e5f67890',appSecret,authMode:'app'});
  assert.equal(configured.status,200);assert.equal(configured.body.authMode,'app');assert.equal(configured.body.redirectUri,undefined);
  assert.ok(!configured.body.scopes.includes('offline_access'));
  const connected=await h.request('/integrations/feishu','PATCH',{enabled:true});
  assert.equal(connected.status,200);assert.equal(connected.body.connected,true);
  assert.equal(h.remote.connections.length,1);
  assert.ok(!h.remote.calls.some(call=>/user_info|oauth|callback/.test(call.url)));
  assert.equal((await h.request('/integrations/feishu/authorize','POST',{})).status,404);
  const draft=await h.preview();assert.equal(draft.body.authMode,'app');
  await h.request(`/integrations/feishu/exports/${draft.body.id}/publish`,'POST',{confirmed:true});
  assert.equal((await h.wait(draft.body.id)).status,'succeeded');
  assert.equal(h.remote.connections.length,1);
  assert.doesNotMatch(JSON.stringify([configured,connected,draft]),/fixture-app-secret|fixture-access-token|fixture-refresh/);
});

test('saving credentials reports asynchronous connection failure and disabling fences a late start',async t=>{
  const h=await harness(t);h.remote.flags.connectError=true;
  const denied=await h.request('/integrations/feishu','PUT',{appId:'cli_a1b2c3d4e5f67890',appSecret});
  assert.equal(denied.status,200);await waitFor(async()=>(await h.request('/integrations/feishu')).body.connection.state==='failed');assert.doesNotMatch(JSON.stringify(denied),/private-sdk|fixture-app-secret/);
  h.remote.flags.connectError=false;let release;h.remote.flags.connectGate=new Promise(resolve=>{release=resolve;});
  const previous=h.remote.connections.length,connecting=h.request('/integrations/feishu','PATCH',{enabled:true});
  try{await waitFor(()=>h.remote.connections.length>previous);await h.request('/integrations/feishu','PATCH',{enabled:false});}finally{release();}
  assert.equal((await connecting).status,200);assert.equal((await h.request('/integrations/feishu')).body.connected,false);
});

test('application identity automatically exports only new finalized meetings once',async t=>{
  const h=await harness(t);await h.request('/integrations/feishu','PUT',{appId:'cli_a1b2c3d4e5f67890',appSecret,authMode:'app'});
  assert.equal((await h.request('/integrations/feishu','PATCH',{enabled:true})).status,200);
  assert.equal((await h.request('/integrations/feishu/automation','PUT',{enabled:true,confirmed:true,folderToken:'',includeNotes:false,includeEvidence:true})).status,200);
  const created=await h.request('/records','POST',{});
  await h.app.repo.change(created.body.id,record=>{recordMinutes(record);record.title='人工核对的会议纪要';record.transcription='ready';record.minutes.transcriptRevision=record.transcriptRevision;});
  const result=await waitFor(async()=>{const state=await h.request('/integrations/feishu/automation');return state.body.recent.find(item=>item.status==='succeeded');});
  assert.equal(result.authMode,'app');assert.equal(result.recordId,created.body.id);
  assert.equal(h.remote.calls.filter(call=>call.url.endsWith('/docx/v1/documents')).length,1);
  assert.ok(!h.remote.calls.some(call=>call.url.endsWith('/user_info')));
});

test('reconnecting SDK is not reported as connected and cannot publish a prepared export',async t=>{
  const h=await harness(t);await h.connect();const draft=await h.preview();h.remote.flags.offline=true;
  const state=await h.request('/integrations/feishu');assert.equal(state.body.enabled,true);assert.equal(state.body.connected,false);assert.equal(state.body.connection.state,'reconnecting');
  assert.equal((await h.request(`/integrations/feishu/exports/${draft.body.id}/publish`,'POST',{confirmed:true})).status,409);
  assert.equal(h.remote.calls.filter(call=>call.url.endsWith('/docx/v1/documents')).length,0);
  h.remote.flags.offline=false;assert.equal((await h.request(`/integrations/feishu/exports/${draft.body.id}/publish`,'POST',{confirmed:true})).status,202);assert.equal((await h.wait(draft.body.id)).status,'succeeded');
});

test('legacy user tokens are removed and old authorization routes do not exist',async t=>{
  const h=await harness(t);await h.connect();await h.request('/integrations/feishu','DELETE');
  const conn=(await h.app.repo.list('feishu-connection'))[0],vault=await createSecretStore(h.root);
  await h.app.repo.change(conn.id,current=>{delete current.authMode;current.connected=true;current.redirectUri='https://obsolete.example/callback';current.credentials=vault.seal(current.id,{appSecret,accessToken:'legacy-user-token',refreshToken:'legacy-refresh'});});
  const service=await createFeishu(h.app.repo,{sdkFactory:h.remote.sdkFactory});
  try{const state=await service.settings(conn.owner),stored=await h.app.repo.get(conn.id);assert.equal(state.connected,false);assert.equal(state.authMode,'app');assert.equal(stored.redirectUri,undefined);assert.deepEqual(vault.open(conn.id,stored.credentials),{appSecret});
    for(const path of ['/integrations/feishu/authorize','/integrations/feishu/authorize/cancel','/integrations/feishu/callback'])assert.equal((await h.request(path,'POST',{})).status,404);
  }finally{await service.close();}
});

test('disconnect cancels SDK initialization even while its first storage read is pending',async t=>{
  const h=await harness(t);await h.request('/integrations/feishu','PUT',{appId:'cli_a1b2c3d4e5f67890',appSecret});
  await h.request('/integrations/feishu','PATCH',{enabled:false});h.remote.connections.length=0;
  const conn=(await h.app.repo.list('feishu-connection'))[0],original=h.app.repo.get.bind(h.app.repo);let reads=0,release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{entered=resolve;});
  h.app.repo.get=async id=>{const value=await original(id);if(id===conn.id&&++reads===2){entered();await gate;}return value;};
  const connecting=h.request('/integrations/feishu','PATCH',{enabled:true});
  try{await waiting;await h.request('/integrations/feishu','DELETE');}finally{release();}
  await connecting;h.app.repo.get=original;
  assert.equal(h.remote.connections.length,0);assert.equal((await h.request('/integrations/feishu')).body.connected,false);
});

test('saving credentials starts automatically and the capability switch preserves credentials',async t=>{
  const h=await harness(t);const configured=await h.request('/integrations/feishu','PUT',{appId:'cli_a1b2c3d4e5f67890',appSecret});
  assert.equal(configured.status,200);assert.equal(configured.body.enabled,true);await waitFor(async()=>(await h.request('/integrations/feishu')).body.connected);assert.equal(h.remote.connections.length,1);
  const disabled=await h.request('/integrations/feishu','PATCH',{enabled:false});assert.equal(disabled.body.hasSecret,true);assert.equal(disabled.body.enabled,false);assert.equal(disabled.body.connected,false);
  const enabled=await h.request('/integrations/feishu','PATCH',{enabled:true});assert.equal(enabled.body.enabled,true);await waitFor(async()=>(await h.request('/integrations/feishu')).body.connected);assert.equal(h.remote.connections.length,2);
  assert.equal((await h.request('/integrations/feishu/connect','POST',{})).status,404);
});

test('an old enable request cannot close a newer automatically connected configuration',async t=>{
  const h=await harness(t);await h.connect();await h.request('/integrations/feishu','PATCH',{enabled:false});
  const conn=(await h.app.repo.list('feishu-connection'))[0],original=h.app.repo.change.bind(h.app.repo);let calls=0,release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{entered=resolve;});
  h.app.repo.change=async(id,mutate)=>{const result=await original(id,mutate);if(id===conn.id&&++calls===1){entered();await gate;}return result;};
  const old=h.request('/integrations/feishu','PATCH',{enabled:true});
  try{await waiting;assert.equal((await h.request('/integrations/feishu','PUT',{appId:'cli_a1b2c3d4e5f67890',appSecret:'new-fixture-app-secret'})).status,200);}finally{release();}
  assert.notEqual((await old).status,200);h.app.repo.change=original;
  const state=await h.request('/integrations/feishu');assert.equal(state.body.enabled,true);assert.equal(state.body.connected,true);assert.equal(state.body.connection.state,'connected');
});

test('a delayed configuration response cannot stop the newer saved configuration',async t=>{
  const h=await harness(t);await h.connect();
  const conn=(await h.app.repo.list('feishu-connection'))[0],original=h.app.repo.change.bind(h.app.repo);let calls=0,release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{entered=resolve;});
  h.app.repo.change=async(id,mutate)=>{const result=await original(id,mutate);if(id===conn.id&&++calls===1){entered();await gate;}return result;};
  const old=h.request('/integrations/feishu','PUT',{appId:'cli_a1b2c3d4e5f67890',appSecret:'old-delayed-fixture-secret'});
  try{await waiting;assert.equal((await h.request('/integrations/feishu','PUT',{appId:'cli_a1b2c3d4e5f67890',appSecret:'latest-fixture-secret'})).status,200);}finally{release();}
  assert.notEqual((await old).status,200);h.app.repo.change=original;
  const state=await h.request('/integrations/feishu');assert.equal(state.body.connected,true);assert.equal(state.body.enabled,true);
  assert.equal(h.remote.connections.at(-1).secret,'latest-fixture-secret');
});

test('disabling before a first configuration insert remains disabled after service restart',async t=>{
  const h=await harness(t),original=h.app.repo.insert.bind(h.app.repo);let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{entered=resolve;});
  h.app.repo.insert=async value=>{if(value.kind==='feishu-connection'){entered();await gate;}return original(value);};
  const configuring=h.request('/integrations/feishu','PUT',{appId:'cli_a1b2c3d4e5f67890',appSecret});
  try{await waiting;const disabled=await h.request('/integrations/feishu','PATCH',{enabled:false});assert.equal(disabled.body.enabled,false);}finally{release();}
  assert.notEqual((await configuring).status,200);h.app.repo.insert=original;
  const conn=(await h.app.repo.list('feishu-connection'))[0],service=await createFeishu(h.app.repo,{sdkFactory:h.remote.sdkFactory});
  try{assert.equal((await service.settings(conn.owner)).enabled,false);assert.equal(h.remote.connections.length,0);}finally{await service.close();}
});

test('saving unchanged credentials preserves an approved automation rule across reload and restart',async t=>{
  const h=await harness(t);await h.connect();
  await h.request('/integrations/feishu/automation','PUT',{enabled:true,folderToken:'folderFixture123',includeNotes:true,includeEvidence:false,confirmed:true});
  const before=(await h.app.repo.list('feishu-connection'))[0].generation;
  await h.request('/integrations/feishu','PUT',{appId:'cli_a1b2c3d4e5f67890',appSecret:''});
  assert.equal((await h.app.repo.list('feishu-connection'))[0].generation,before);
  let policy=(await h.request('/integrations/feishu/automation')).body;
  assert.equal(policy.enabled,true);assert.equal(policy.connectionChanged,false);assert.equal(policy.includeNotes,true);
  const conn=(await h.app.repo.list('feishu-connection'))[0],service=await createFeishu(h.app.repo,{sdkFactory:h.remote.sdkFactory,autoPollMs:60000});
  try{policy=await service.automation(conn.owner);assert.equal(policy.enabled,true);assert.equal(policy.connectionChanged,false);assert.equal(policy.folderToken,'folderFixture123');}finally{await service.close();}
});

test('member destination and editable board are frozen and published before ownership transfer',async t=>{
 const h=await harness(t);await h.connect();
 const preview=await h.request(`/records/${h.recordId}/feishu/preview`,'POST',{title:'人工核对的会议纪要',folderToken:'',destinationEmail:'member@example.test',includeBoard:true,includeNotes:false,includeEvidence:true});
 assert.ok(preview.body.summaryBlocks.descendants.some(block=>block.block_type===4));
 assert.equal(preview.status,201);assert.equal(preview.body.destinationEmail,'member@example.test');assert.ok(preview.body.boardNodes.length>1);
 await h.request(`/integrations/feishu/exports/${preview.body.id}/publish`,'POST',{confirmed:true});
 const receipt=await h.wait(preview.body.id);assert.equal(receipt.status,'succeeded');
 const urls=h.remote.calls.map(c=>c.url),nodes=urls.findIndex(url=>url.includes('/whiteboards/')&&url.includes('/nodes?')),transfer=urls.findIndex(url=>url.includes('/members/transfer_owner?'));
 assert.ok(nodes>0);assert.ok(transfer>nodes);
 const written=JSON.parse(h.remote.calls.find(call=>call.url.includes('/descendant?')).body);
 assert.deepEqual(written.children_id.slice(0,preview.body.summaryBlocks.children_id.length),preview.body.summaryBlocks.children_id);
 assert.ok(written.descendants.some(block=>block.block_type===4));assert.match(h.remote.calls[transfer].body,/member@example.test/);
 assert.match(urls[transfer],/stay_put=false/);
 const invalid=await h.request(`/records/${h.recordId}/feishu/preview`,'POST',{title:'test',folderToken:'folderFixture123',destinationEmail:'member@example.test',includeBoard:false,includeNotes:false,includeEvidence:false});assert.equal(invalid.status,400);
});


test('board keeps legacy and ambiguous topics from claiming unrelated sections or tables',()=>{
 const minutes={title:'会议',topics:[{title:'A'},{title:'B'},{id:'dup',title:'C'},{id:'dup',title:'D'}],sections:[{heading:'独立章节',items:[{text:'未归属内容'},{text:'含歧义内容',topicId:'dup'}]}],tables:[{title:'独立表格',columns:['值'],rows:[{cells:['原始值']}]}]};
 const nodes=minutesBoard(minutes),byText=new Map(nodes.filter(node=>node.text).map(node=>[node.text.text,node]));
  const section=byText.get('独立章节'),other=byText.get('其他图表');
  assert.ok(byText.get('未归属内容').y>section.y&&byText.get('未归属内容').y<other.y);
  assert.ok(byText.get('含歧义内容').y>section.y&&byText.get('含歧义内容').y<other.y);
  assert.ok(byText.get('独立表格').y>other.y);

});


test('disabled automation retains its saved board and destination choices',async t=>{
 const h=await harness(t);await h.connect();
 const policy={enabled:true,folderToken:'',destinationEmail:'member@example.test',includeBoard:false,includeNotes:true,includeEvidence:false,confirmed:true};
 await h.request('/integrations/feishu/automation','PUT',policy);await h.request('/integrations/feishu/automation','PUT',{enabled:false});
 const saved=(await h.request('/integrations/feishu/automation')).body;assert.equal(saved.configured,true);assert.equal(saved.enabled,false);assert.equal(saved.includeBoard,false);assert.equal(saved.destinationEmail,policy.destinationEmail);assert.equal(saved.includeNotes,true);
});


test('editable board has readable topic hierarchy and real diagram primitives',()=>{
  const nodes=minutesBoard({title:'设计评审',sections:[{heading:'发布安排',items:[{text:'周五评审'}]}],actions:[]});
  const byText=new Map(nodes.filter(node=>node.text).map(node=>[node.text.text,node]));
  const root=byText.get('设计评审'),topic=byText.get('发布安排'),detail=byText.get('周五评审');
  assert.ok(root.text.font_size>topic.text.font_size&&topic.text.font_size>detail.text.font_size);
  assert.equal(root.text.font_weight,'bold');assert.equal(detail.text.font_weight,'regular');
  assert.ok(topic.y<detail.y);assert.ok(nodes.some(node=>node.type==='connector'));

});

test('large minutes publish one overview while complete content stays in the document',async t=>{
  const h=await harness(t);await h.connect();
  await h.app.repo.change(h.recordId,record=>{
    record.minutes.sections[0].items=Array.from({length:120},(_,index)=>({text:`核对事项 ${index+1}`,evidence:[{segmentId:'s1',revision:1}]}));
  });
  const preview=await h.request(`/records/${h.recordId}/feishu/preview`,'POST',{title:'人工核对的会议纪要',folderToken:'',includeBoard:true,boardTheme:'dark',includeNotes:false,includeEvidence:true});
  assert.equal(preview.status,201);assert.equal(preview.body.boardTheme,'dark');assert.equal(preview.body.boardPages.length,1);
  assert.equal(preview.body.boardNodes[0].style.fill_color,'#151D2E');assert.match(preview.body.markdown,/核对事项 120/);assert.match(JSON.stringify(preview.body.boardPages),/摘要摘录/);
  await h.request(`/integrations/feishu/exports/${preview.body.id}/publish`,'POST',{confirmed:true});
  assert.equal((await h.wait(preview.body.id)).status,'succeeded');
  const board=h.remote.calls.find(call=>call.url.includes('/children?'));assert.equal(JSON.parse(board.body).index,0);
  const batches=h.remote.calls.filter(call=>call.url.includes('/whiteboards/')&&call.url.includes('/nodes?'));
  assert.equal(batches.length,preview.body.boardPages.length);assert.ok(batches.every(call=>JSON.parse(call.body).nodes.length<=3000));
  assert.equal(batches.reduce((total,call)=>total+JSON.parse(call.body).nodes.length,0),preview.body.boardPages.reduce((sum,page)=>sum+page.nodes.length,0));
  assert.equal(new Set(batches.map(call=>new URL(call.url).searchParams.get('client_token'))).size,batches.length);
});

test('saving and disabling Feishu configuration does not wait for the remote connection',async t=>{
 const h=await harness(t);let release;h.remote.flags.connectGate=new Promise(resolve=>{release=resolve;});
 const configuring=h.request('/integrations/feishu','PUT',{appId:'cli_a1b2c3d4e5f67890',appSecret});
 try{
  const saved=await Promise.race([configuring,new Promise((_,reject)=>setTimeout(()=>reject(new Error('configuration blocked by network')),1000))]);
  assert.equal(saved.status,200);assert.equal(saved.body.hasSecret,true);assert.equal(saved.body.enabled,true);assert.equal(saved.body.connected,false);assert.equal(saved.body.connection.state,'connecting');
  const disabled=await h.request('/integrations/feishu','PATCH',{enabled:false});assert.equal(disabled.body.enabled,false);
 }finally{release();await configuring;}
 await new Promise(resolve=>setImmediate(resolve));assert.equal((await h.request('/integrations/feishu')).body.connected,false);
});


test('native summary publishes without a board, retains scope and clears frozen heavy content',async t=>{
 const h=await harness(t);await h.connect();
 await h.app.repo.change(h.recordId,record=>{record.minutes.highlights=[{text:'保留结论',evidence:[{segmentId:'s1',revision:1}]}];record.minutes.actions=[{text:'核对接口',owner:null,due:null,evidence:[{segmentId:'s1',revision:1}]}];});
 const preview=await h.request(`/records/${h.recordId}/feishu/preview`,'POST',{title:'人工核对的会议纪要',includeBoard:false,includeNotes:false,includeEvidence:false});
 assert.equal(preview.status,201);assert.equal(preview.body.boardNodes.length,0);
 assert.doesNotMatch(JSON.stringify(preview.body.summaryBlocks),/private-saved-notes|引用版本一|后续修改|\[1\]/);
 const fetched=await h.request(`/integrations/feishu/exports/${preview.body.id}`);assert.deepEqual(fetched.body.summaryBlocks,preview.body.summaryBlocks);
 await h.request(`/integrations/feishu/exports/${preview.body.id}/publish`,'POST',{confirmed:true});assert.equal((await h.wait(preview.body.id)).status,'succeeded');
 assert.ok(!h.remote.calls.some(call=>call.url.includes('/children?')||call.url.includes('/whiteboards/')));
 const written=JSON.parse(h.remote.calls.find(call=>call.url.includes('/descendant?')).body);
 assert.ok(written.descendants.some(block=>block.block_type===19));assert.ok(written.descendants.some(block=>block.block_type===31));
 const saved=await h.app.repo.get(preview.body.id);assert.equal(saved.summaryBlocks,null);assert.equal(saved.markdown,'');
});

test('too many native blocks fail before any Feishu document is created',async t=>{
 const h=await harness(t);await h.connect();await h.app.repo.change(h.recordId,record=>{record.minutes.actions=Array.from({length:140},(_,i)=>({text:`事项 ${i}`,owner:'原文负责人',due:'原文时间'}));});
 const draft=await h.preview();assert.equal(draft.status,400);assert.equal(draft.body.error,'feishu_document_too_large');
 assert.equal(h.remote.calls.filter(call=>call.url.endsWith('/docx/v1/documents')).length,0);
});

test('missing native block acknowledgement stops before board or transfer and never duplicates a document',async t=>{
 const h=await harness(t);await h.connect();h.remote.flags.missingNativeBlock=true;
 const preview=await h.request(`/records/${h.recordId}/feishu/preview`,'POST',{title:'人工核对的会议纪要',destinationEmail:'member@example.test',includeBoard:true,includeNotes:false,includeEvidence:true});
 await h.request(`/integrations/feishu/exports/${preview.body.id}/publish`,'POST',{confirmed:true});
 const result=await h.wait(preview.body.id);assert.equal(result.status,'partial');assert.equal(result.error,'feishu_verification_failed');
 assert.ok(!h.remote.calls.some(call=>/children\?|whiteboards|transfer_owner/.test(call.url)));
 await h.request(`/integrations/feishu/exports/${preview.body.id}/publish`,'POST',{confirmed:true});assert.equal(h.remote.calls.filter(call=>call.url.endsWith('/docx/v1/documents')).length,1);
 assert.equal((await h.app.repo.get(preview.body.id)).summaryBlocks,null);
});

test('overview write failure preserves a partial receipt and never transfers or creates a second document',async t=>{
 const h=await harness(t);await h.connect();
 await h.app.repo.change(h.recordId,r=>{r.minutes.sections[0].items=Array.from({length:40},(_,i)=>({text:`保留条目 ${i}`,kind:'fact',evidence:[{segmentId:'s1',revision:1}]}));});
 const draft=await h.request(`/records/${h.recordId}/feishu/preview`,'POST',{title:'人工核对的会议纪要',folderToken:'',destinationEmail:'preview@example.test',includeBoard:true,includeNotes:false,includeEvidence:true});
 assert.equal(draft.status,201);assert.equal(draft.body.boardPages.length,1);h.remote.flags.boardFailAt=1;
 await h.request(`/integrations/feishu/exports/${draft.body.id}/publish`,'POST',{confirmed:true});const receipt=await h.wait(draft.body.id);
 assert.equal(receipt.status,'partial');assert.equal(receipt.documentId,documentId);
 const stored=await h.app.repo.get(draft.body.id);assert.equal(stored.boardTokens.length,1);assert.deepEqual(stored.boardPages,[]);
 assert.ok(!h.remote.calls.some(c=>c.url.includes('transfer_owner')));
 await h.request(`/integrations/feishu/exports/${draft.body.id}/publish`,'POST',{confirmed:true});assert.equal(h.remote.calls.filter(c=>c.url.endsWith('/docx/v1/documents')).length,1);
});

test('interrupted publication clears frozen page data and keeps recovery metadata',async t=>{
 const h=await harness(t);await h.connect();
 for(const hasDocument of [false,true]){
  const draft=await h.request(`/records/${h.recordId}/feishu/preview`,'POST',{title:'人工核对的会议纪要',folderToken:'',includeBoard:true,includeNotes:false,includeEvidence:true});
  await h.app.repo.change(draft.body.id,v=>{v.status='publishing';v.updatedAt=Date.now()-180001;v.boardPage=2;v.boardTokens=['first-board','second-board'];if(hasDocument)v.documentId=documentId;});
  const result=await h.request(`/integrations/feishu/exports/${draft.body.id}`);assert.equal(result.body.status,hasDocument?'partial':'unknown');
  const stored=await h.app.repo.get(draft.body.id);assert.equal(stored.markdown,'');assert.deepEqual(stored.boardNodes,[]);assert.deepEqual(stored.boardPages,[]);assert.equal(stored.summaryBlocks,null);
  assert.deepEqual(stored.boardTokens,['first-board','second-board']);assert.equal(stored.boardPage,2);if(hasDocument)assert.equal(stored.documentId,documentId);
 }
 assert.ok(!h.remote.calls.some(c=>c.url.endsWith('/docx/v1/documents')));
});
