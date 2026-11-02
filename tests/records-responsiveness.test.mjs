import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveConfig,readConfig} from '../services/records/src/config.mjs';
import {createRepository} from '../services/records/src/repository.mjs';
import {createExtensions} from '../services/records/src/integrations/extensions.mjs';
const env={NODE_ENV:'test',ASR_PROVIDER:'openai-compatible'};
test('unchanged settings do not rewrite disk and concurrent saves preserve both fields',async()=>{
 const root=await mkdtemp(join(tmpdir(),'settings-speed-'));
 try{
 await saveConfig(root,{LLM_MODEL:'fixture'},env);const before=await stat(join(root,'providers.json'));
 await new Promise(resolve=>setTimeout(resolve,10));await saveConfig(root,{LLM_MODEL:'fixture'},env);
 assert.equal((await stat(join(root,'providers.json'))).mtimeMs,before.mtimeMs);
 await Promise.all([saveConfig(root,{ASR_MODEL:'speech'},env),saveConfig(root,{LLM_MODEL:'new'},env)]);
 const saved=await readConfig(root,env);assert.equal(saved.ASR_MODEL,'speech');assert.equal(saved.LLM_MODEL,'new');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('private Skill uses authenticated pinned reads, seals credentials and isolates updates by owner',async()=>{
 const root=await mkdtemp(join(tmpdir(),'skill-private-')),repo=await createRepository({root});
 const token='private-fixture-token',sha='b'.repeat(40),content='---\nname: private-skill\ndescription: Private meeting review\n---\nRead selected meetings.';let reads=0;
 try{
 const ext=await createExtensions(repo,{requestGithub:async(url,options)=>{
 assert.equal(options.headers.Authorization,`Bearer ${token}`);reads++;
 return {status:200,headers:{},text:JSON.stringify(url.includes('/commits/')?{sha}:{type:'file',encoding:'base64',size:content.length,content:Buffer.from(content).toString('base64')})};
 }});
 const input={source:'https://github.com/org/private',ref:'main',token};
 const preview=await ext.skillPreview(input,'owner');assert.equal(preview.version,sha);assert.doesNotMatch(JSON.stringify(preview),/private-fixture-token/);
 const installed=await ext.installSkill('owner',{...input,expectedVersion:sha,confirmed:true});assert.equal(installed.hasToken,true);
 assert.doesNotMatch(JSON.stringify(await repo.list('extension')),/private-fixture-token/);
 await ext.skillPreview({source:input.source,extensionId:installed.id},'owner');assert.equal(reads,6);
 await assert.rejects(ext.skillPreview({source:'https://github.com/other/repo',extensionId:installed.id},'owner'),{code:'invalid_skill_source'});
 await assert.rejects(ext.skillPreview({source:input.source,extensionId:installed.id},'other'),{code:'extension_not_found'});
 }finally{await repo.close();await rm(root,{recursive:true,force:true});}
});

test('meeting reads reuse serialized snapshots, invalidate on writes, and recheck deletion and owner',async()=>{
 const {createRecordServer}=await import('../services/records/src/server.mjs');
 const {createRecord}=await import('../packages/records/src/record.mjs');
 const root=await mkdtemp(join(tmpdir(),'record-read-'));const app=await createRecordServer({root,localAccount:true,port:0});
 try{
 const address=await app.start(),base=`http://127.0.0.1:${address.port}`,cookie=(await app.localSession()).split(';')[0];
 const owner=(await app.repo.list('user')).find(user=>user.email==='local@device.invalid').id,r=createRecord(owner,{title:'first'});await app.repo.insert(r);
 const original=app.repo.get.bind(app.repo);let reads=0;app.repo.get=async id=>{if(id===r.id)reads++;return original(id);};
 const get=()=>fetch(base+`/api/records/${r.id}`,{headers:{cookie}});
 const first=await get(),body=await first.json();assert.equal(first.status,200,JSON.stringify(body));assert.equal(body.title,'first');assert.equal((await (await get()).json()).title,'first');assert.equal(reads,1);
 await app.repo.change(r.id,value=>{value.title='updated';});assert.equal((await (await get()).json()).title,'updated');assert.equal(reads,2);
 await app.repo.change(r.id,value=>{value.owner='other';});assert.equal((await get()).status,404);
 await app.repo.change(r.id,value=>{value.owner=owner;value.deleted=true;});assert.equal((await get()).status,410);
 await app.repo.change(r.id,value=>{value.deleted=false;value.deleteAt=new Date(Date.now()-1000).toISOString();});assert.equal((await get()).status,410);
 }finally{await app.stop();await rm(root,{recursive:true,force:true});}
});

test('text minutes stay enabled independently of raw audio consent',async()=>{
 const {recordMinutesConfig}=await import('../services/records/src/config.mjs');
 const config={MINUTES_MODE:'openai-realtime',LLM_API_KEY:'test-key',LLM_API_URL:'https://fixture.invalid',LLM_MODEL:'test'};
 assert.equal(recordMinutesConfig({realtimeAudioConsent:false},config).MINUTES_MODE,'asr-llm');
 assert.equal(recordMinutesConfig({realtimeAudioConsent:true},config),config);
 const audioOnly={...config,MINUTES_MODE:'doubao-audio-only'};assert.equal(recordMinutesConfig({},audioOnly),audioOnly);
 assert.equal(config.MINUTES_MODE,'openai-realtime');
 const {meetingSummaryPreview}=await import('../services/records/src/meeting-agent-wire.mjs');
 assert.equal(meetingSummaryPreview('{"toolCalls":[]'), '');
 assert.equal(meetingSummaryPreview('{"result":{"summary":"## hi\\n**ready**\\u4e'), '## hi\n**ready**');
});

test('streamed summaries accept field reordering and top-level output without confusing nested text',async()=>{
 const {meetingSummaryPreview:preview}=await import('../services/records/src/meeting-agent-wire.mjs');
 assert.equal(preview('{"result":{"decisions":[],"summary":"## 即时\\n**预览**'), '## 即时\n**预览**');
 assert.equal(preview('{"actions":[],"summary":"顶层摘要'), '顶层摘要');
 assert.equal(preview('{"result":{"decisions":[{"summary":"不要展示"}],"summary":"正确'), '正确');
 assert.equal(preview('{"toolCalls":[{"arguments":{"summary":"隐藏"}}]}'), '');
 assert.equal(preview(JSON.stringify({result:{summary:'末尾\\'}})), '末尾\\');
});

test('concurrent retransmitted audio stores one chunk with the same verified envelope',async()=>{
 const {createRecordServer}=await import('../services/records/src/server.mjs');
 const {digest}=await import('../packages/records/src/record.mjs');
 const {chunkWaveform}=await import('../services/records/src/waveform.mjs');
 const root=await mkdtemp(join(tmpdir(),'audio-envelope-')),app=await createRecordServer({root,localAccount:true,port:0});
 try{
 const address=await app.start(),base=`http://127.0.0.1:${address.port}/api`,cookie=(await app.localSession()).split(';')[0];
 const boot=await(await fetch(base+'/bootstrap',{headers:{cookie}})).json();
 const post=async(path,body)=>{const res=await fetch(base+path,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':boot.csrf},body:JSON.stringify(body)});assert.ok(res.ok,await res.clone().text());return res.json();};
 const record=await post('/records',{retainAudio:true}),source=await post(`/records/${record.id}/sources`,{kind:'microphone'}),pcm=Buffer.alloc(3200,5);
 const body={sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence:0,sampleOffset:0,sampleCount:1600,sampleRate:16000,digest:digest(pcm),pcm:pcm.toString('base64')};
 const receipts=await Promise.all([post(`/records/${record.id}/audio`,body),post(`/records/${record.id}/audio`,body)]);
 assert.equal(receipts[0].watermark,receipts[1].watermark);const saved=await app.repo.get(record.id);assert.equal(saved.chunks.length,1);assert.equal(saved.chunks[0].waveform,chunkWaveform(pcm));
 }finally{await app.stop();await rm(root,{recursive:true,force:true});}
});

test('first explicit audio authorization binds the audio model instead of the text fallback',async()=>{
 const {createRecordServer}=await import('../services/records/src/server.mjs');
 const root=await mkdtemp(join(tmpdir(),'minutes-consent-')),app=await createRecordServer({root,localAccount:true,port:0});
 try{
 await saveConfig(root,{ASR_PROVIDER:'openai-compatible',MINUTES_MODE:'openai-realtime',OPENAI_REALTIME_API_KEY:'fixture-key',OPENAI_REALTIME_MODEL:'audio-fixture',LLM_API_KEY:'fixture-key',LLM_MODEL:'text-fixture'},env);
 const address=await app.start(),base=`http://127.0.0.1:${address.port}/api`,cookie=(await app.localSession()).split(';')[0];
 const boot=await(await fetch(base+'/bootstrap',{headers:{cookie}})).json();
 const post=async(path,body)=>{const res=await fetch(base+path,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':boot.csrf},body:JSON.stringify(body)});assert.ok(res.ok,await res.clone().text());return res.json();};
 const record=await post('/records',{autoMinutes:true});assert.equal(record.autoMinutes.enabled,true);assert.equal(record.realtimeAudioConsent,false);
 await app.repo.change(record.id,r=>{r.capture='completed';r.transcriptRevision=1;r.segments=[{id:'s1',revision:1,text:'决定确认版本',startMs:0,endMs:1000,speaker:'A',sourceId:'text-import'}];});
 const response=await post(`/records/${record.id}/minutes`,{mode:'model',realtimeAudioConsent:true});assert.equal(response.modelVersion,'openai-realtime:audio-fixture');assert.equal((await app.repo.get(record.id)).realtimeAudioConsent,true);
 }finally{await app.stop();await rm(root,{recursive:true,force:true});}
});

test('frontend enables text summaries when an audio provider is unconfigured',async()=>{
 const {readFile}=await import('node:fs/promises'),{transpileTypeScript}=await import('./helpers/typescript.mjs');
 const source=transpileTypeScript(await readFile(new URL('../apps/web/src/provider-settings.ts',import.meta.url),'utf8'));
 const {minutesAvailable}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const providers={minutes:false,textMinutes:true,minutesMode:'openai-realtime'};
 assert.equal(minutesAvailable(providers),true);assert.equal(minutesAvailable(providers,true),false);
 assert.equal(minutesAvailable({...providers,minutesMode:'doubao-audio-only'}),false);
 assert.equal(minutesAvailable({...providers,minutes:true},true),true);assert.equal(minutesAvailable(undefined),false);
});

test('future audio defaults persist per account, survive reconnect and honor a per-meeting decline',async()=>{
 const {createRecordServer}=await import('../services/records/src/server.mjs');
 const root=await mkdtemp(join(tmpdir(),'audio-default-'));let app=await createRecordServer({root,port:0});
 try{
 const address=await app.start();let base=`http://127.0.0.1:${address.port}/api`;
 const register=async email=>{const res=await fetch(base+'/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:'FixturePassword2026!'})});assert.equal(res.status,200);const user=await res.json();return{cookie:res.headers.get('set-cookie').split(';')[0],'x-csrf-token':user.csrf,'content-type':'application/json'};};
 const first=await register('audio-first@example.test'),second=await register('audio-second@example.test');
 const call=async(headers,path,method='GET',body)=>{const res=await fetch(base+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});assert.ok(res.ok,await res.clone().text());return res.json();};
 const saved=await call(first,'/settings/providers','PUT',{MINUTES_MODE:'doubao-audio-only',LLM_PROTOCOL:'responses',LLM_API_KEY:'fixture-key',LLM_MODEL:'fixture-audio',AUTO_AUDIO_MINUTES:'true'});assert.equal(saved.audioMinutesDefault,true);
 assert.equal((await call(first,'/bootstrap')).audioMinutesDefault,true);assert.equal((await call(second,'/bootstrap')).audioMinutesDefault,false);
 assert.equal((await call(first,'/settings/providers')).values.AUTO_AUDIO_MINUTES,'true');
 const automatic=await call(first,'/records','POST',{});assert.equal(automatic.autoMinutes.enabled,true);assert.equal(automatic.realtimeAudioConsent,true);
 const declined=await call(first,'/records','POST',{autoMinutes:false,realtimeAudioConsent:false});assert.equal(declined.autoMinutes.enabled,false);assert.equal(declined.realtimeAudioConsent,false);
 const other=await call(second,'/records','POST',{});assert.equal(other.realtimeAudioConsent,false);
 await app.stop();app=await createRecordServer({root,port:0});const restarted=await app.start();base=`http://127.0.0.1:${restarted.port}/api`;assert.equal((await call(first,'/bootstrap')).audioMinutesDefault,true);
 await call(first,'/settings/providers','PUT',{AUTO_AUDIO_MINUTES:'false'});assert.equal((await call(first,'/bootstrap')).audioMinutesDefault,false);assert.equal((await app.repo.get(automatic.id)).realtimeAudioConsent,true);
 }finally{await app.stop();await rm(root,{recursive:true,force:true});}
});
