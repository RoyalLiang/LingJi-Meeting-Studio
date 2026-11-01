import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRecordServer } from '../services/records/src/server.mjs';
import { feishuBlocks, feishuFolder, createFeishu, FEISHU_SCOPES } from '../services/records/src/integrations/feishu.mjs';
import { exportMinutesMarkdown } from '../services/records/src/markdown-export.mjs';
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
  return {calls,flags,async fetch(url,options){
    const body=options.body?String(options.body):'';calls.push({url,body,headers:options.headers});
    if(url==='https://accounts.feishu.cn/oauth/v3/token'){if(flags.oauthError)return Response.json({error:'invalid_client',error_description:'private-oauth-details'},{status:400});const value={code:0,access_token:accessToken,expires_in:7200,refresh_token:'fixture-refresh-private',refresh_token_expires_in:604800,scope:FEISHU_SCOPES.join(' ')};if(flags.oauthNoCode)delete value.code;return Response.json(value);}
    if(url.endsWith('/authen/v1/user_info'))return Response.json({code:0,data:{open_id:'fixture-open-id',tenant_key:'fixture-tenant',name:'本地测试用户'}});
    if(url.endsWith('/blocks/convert')){if(flags.convertGate)await flags.convertGate;return Response.json({code:0,data:{first_level_block_ids:['heading'],blocks:[{block_id:'heading',parent_id:'readonly',block_type:3,heading1:{elements:[{text_run:{content:'发布计划'}}]}}]}});}
    if(url.endsWith('/docx/v1/documents')){if(flags.createTimeout)throw new Error('network lost');return Response.json({code:0,data:{document:{document_id:documentId}}});}
    if(url.includes('/descendant?')){if(flags.writeFail)return Response.json({code:1770001,msg:'private-upstream-message'},{status:400});return Response.json({code:0,data:{block_id_relations:[{temporary_block_id:'heading',block_id:'remote-heading'}]}});}
    if(url.endsWith('/metas/batch_query'))return Response.json({code:0,data:{metas:[{doc_token:documentId,doc_type:'docx',title:'人工核对的会议纪要',url:`https://fixture.feishu.cn/docx/${documentId}`}],failed_list:[]}});
    throw new Error('Unexpected fixture URL');
  }};
}
async function harness(t,{autoPollMs=100}={}){
  const root=await mkdtemp(join(tmpdir(),'lingji-feishu-')),remote=provider(),app=await createRecordServer({root,databaseUrl:'',port:0,feishuOptions:{fetch:remote.fetch,autoPollMs}});
  const address=await app.start(),base=`http://127.0.0.1:${address.port}/api`;
  const response=await fetch(`${base}/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'feishu@example.test',password:'fixture-password'})});
  const user=await response.json(),headers={Cookie:response.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':user.csrf,'Content-Type':'application/json'};
  const request=async(path,method='GET',body)=>{const result=await fetch(`${base}${path}`,{method,headers,...(body?{body:JSON.stringify(body)}:{})});return {status:result.status,body:await result.json()};};
  t.after(async()=>{await app.stop();await rm(root,{recursive:true,force:true});});
  const created=await request('/records','POST',{});await app.repo.change(created.body.id,recordMinutes);
  async function connect(expected=200){
    assert.equal((await request('/integrations/feishu','PUT',{appId:'cli_fixture_app',appSecret,redirectUri:`${base.replace('http:','https:')}/integrations/feishu/callback`})).status,200);
    const started=await request('/integrations/feishu/authorize','POST',{}),url=new URL(started.body.url);
    assert.equal(url.origin,'https://accounts.feishu.cn');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
    assert.equal(url.searchParams.get('scope'),FEISHU_SCOPES.join(' '));
    const returned=await fetch(`${base}/integrations/feishu/callback?state=${url.searchParams.get('state')}&code=fixture-code`);
    assert.equal(returned.status,expected);assert.doesNotMatch(await returned.text(),/fixture-code|fixture-app-secret|fixture-access-token|private-oauth-details/);if(expected!==200)return;
    const exchange=new URLSearchParams(remote.calls.filter(call=>call.url.endsWith('/oauth/v3/token')).at(-1).body);
    assert.equal(createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'),url.searchParams.get('code_challenge'));
    assert.equal((await fetch(`${base}/integrations/feishu/callback?state=${url.searchParams.get('state')}&code=fixture-code`)).status,400);
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
test('Feishu OAuth, frozen preview, owner isolation and one-time publication persist a receipt',async t=>{
  const h=await harness(t);await h.connect();
  const settings=await h.request('/integrations/feishu');assert.equal(settings.body.connected,true);assert.doesNotMatch(JSON.stringify(settings.body),/fixture-app-secret|fixture-access-token|fixture-refresh/);
  const stored=(await h.app.repo.list('feishu-connection'))[0];assert.doesNotMatch(JSON.stringify(stored),/fixture-app-secret|fixture-access-token|fixture-refresh/);
  const preview=await h.preview();assert.match(preview.body.markdown,/保留人工修订|引用版本一/);assert.doesNotMatch(preview.body.markdown,/private-saved-notes|后续修改/);
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

test('OAuth v3 accepts success without code and rejects OAuth error fields without leaking details',async t=>{const h=await harness(t);h.remote.flags.oauthNoCode=true;await h.connect();assert.equal((await h.request('/integrations/feishu')).body.connected,true);h.remote.flags.oauthError=true;await h.connect(400);assert.equal((await h.request('/integrations/feishu')).body.connected,false);});

test('automatic export waits for current final minutes and does not send stale human drafts or failed final jobs',async t=>{
  const h=await harness(t,{autoPollMs:60000});await h.connect();await h.request('/integrations/feishu/automation','PUT',{enabled:true,confirmed:true,folderToken:'',includeNotes:false,includeEvidence:true});
  const created=await h.request('/records','POST',{});await h.app.repo.change(created.body.id,record=>{recordMinutes(record);record.title='人工核对的会议纪要';record.transcription='ready';});
  const service=await createFeishu(h.app.repo,{fetch:h.remote.fetch});
  try{await service.automaticTick();assert.equal(h.remote.calls.filter(call=>call.url.endsWith('/docx/v1/documents')).length,0);
    await h.app.repo.change(created.body.id,record=>{record.minutes.transcriptRevision=record.transcriptRevision;record.jobs=[{id:'final',scope:'final',status:'failed'}];});await service.automaticTick();assert.equal(h.remote.calls.filter(call=>call.url.endsWith('/docx/v1/documents')).length,0);
    await h.app.repo.change(created.body.id,record=>{record.jobs[0].status='completed';});await service.automaticTick();const state=await h.request('/integrations/feishu/automation');assert.equal(state.body.recent.length,1);assert.equal((await h.wait(state.body.recent[0].id)).status,'succeeded');
  }finally{await service.close();}
});
