import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../services/records/src/repository.mjs';
import { saveConfig, normalizeConfig, publicConfig, readConfig } from '../services/records/src/config.mjs';
import { providerStatus, transcribe } from '../services/records/src/providers.mjs';
import { runCycle } from '../services/records/src/worker.mjs';
import { processFunasrAudio } from '../services/records/src/funasr-transcription.mjs';
import { recoverLocalWork } from '../services/records/src/desktop-backend.mjs';
import { createRecord, addSource, acknowledge, seal, pause, digest, requestMinutes, editSegment } from '../packages/records/src/record.mjs';

const speech = seconds => { const pcm=Buffer.alloc(Math.round(seconds*32000)); for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(i%8<4?3000:-3000,i); return pcm; };
const silence = seconds => Buffer.alloc(Math.round(seconds*32000));
async function fixture(work, respond) {
  const root=await mkdtemp(join(tmpdir(),'lingji-funasr-')),requests=[];
  const server=createServer(async(req,res)=>{
    const parts=[];for await(const part of req)parts.push(part);
    const form=await new Response(Buffer.concat(parts),{headers:{'Content-Type':req.headers['content-type']}}).formData();
    const wav=Buffer.from(await form.get('file').arrayBuffer());
    assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(24),16000);assert.equal(wav.length-44,wav.readUInt32LE(40));
    const request={wav,model:form.get('model'),language:form.get('language'),authorization:req.headers.authorization};requests.push(request);
    if(respond)return respond(request,res);
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({text:'测试决定，保留来源。'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config=normalizeConfig({NODE_ENV:'test',MINUTES_MODE:'asr-llm',ASR_PROVIDER:'funasr',FUNASR_API_URL:`http://127.0.0.1:${server.address().port}/v1/audio/transcriptions`,FUNASR_MODEL:'sensevoice',FUNASR_API_KEY:'',LLM_API_KEY:'',RECORD_PROVIDER:'',RECORD_LEARNING_ENABLED:'false'});
  const repo=await createRepository({root,databaseUrl:'',s3:{bucket:''}});await writeFile(join(root,'providers.json'),JSON.stringify(config));
  try{return await work(repo,config,requests);}finally{await repo.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
}
async function recordWith(repo, tracks, {stopped=true,paused=false}={}) {
 const record=createRecord('owner',{language:'zh',autoMinutes:false}),sources=tracks.map(()=>addSource(record,{kind:'microphone'}));await repo.insert(record);
 for(let t=0;t<tracks.length;t++) {let offset=0;
  for(let sequence=0;sequence<tracks[t].length;sequence++){
   const bytes=tracks[t][sequence],object=await repo.putAudio(record.id,bytes),s=sources[t];
   const chunk={sessionId:s.sessionId,sourceId:s.id,epoch:s.epoch,sequence,sampleOffset:offset,sampleCount:bytes.length/2,sampleRate:16000,digest:digest(bytes),...object};
   await repo.change(record.id,r=>acknowledge(r,chunk));if(sequence===0)await repo.change(record.id,r=>acknowledge(r,chunk));offset+=chunk.sampleCount;
  }
 }
 const manifest=sources.map((s,i)=>({sessionId:s.sessionId,sourceId:s.id,epoch:s.epoch,lastSequence:tracks[i].length-1}));
 if(stopped)await repo.change(record.id,r=>(paused?pause:seal)(r,manifest));
 return {record,sources,manifest};
}
const native = bytes => {const parts=[];for(let offset=0;offset<bytes.length;){const end=Math.min(bytes.length,offset+(parts.length?32000:12800));parts.push(bytes.subarray(offset,end));offset=end;}return parts;};

test('FunASR settings allow optional local auth, preserve privacy, and validate service protocol',async()=>fixture(async(repo,config)=>{
 const saved=await saveConfig(repo.root,config,{NODE_ENV:'desktop'});assert.equal(saved.FUNASR_API_KEY,false);assert.equal(providerStatus(await readConfig(repo.root)).asr,true);
 await saveConfig(repo.root,{FUNASR_API_KEY:'private-service-key'},{NODE_ENV:'desktop'});assert.equal(publicConfig(await readConfig(repo.root)).FUNASR_API_KEY,true);assert.ok(!JSON.stringify(publicConfig(await readConfig(repo.root))).includes('private-service-key'));
 await saveConfig(repo.root,{FUNASR_API_URL:'http://127.0.0.1:8000/v1/audio/transcriptions'},{NODE_ENV:'production'});
 await assert.rejects(saveConfig(repo.root,{FUNASR_API_URL:'http://example.com/v1/audio/transcriptions'},{NODE_ENV:'production'}),{code:'invalid_provider_url'});
 await assert.rejects(saveConfig(repo.root,{FUNASR_API_URL:'https://example.com/api/v1/asr'},{NODE_ENV:'desktop'}),{code:'funasr_compatible_endpoint_required'});
 assert.equal(providerStatus({...config,MINUTES_MODE:'doubao-audio-only'}).asrProvider,'doubao-audio-only');
}));

test('FunASR multipart maps mixed language to auto, strips tags and adds auth only when configured',async()=>fixture(async(_repo,config,requests)=>{
 const pcm=speech(3);assert.equal(await transcribe(pcm,{language:'zhen'},{},config),'真实文字');assert.equal(requests[0].authorization,undefined);assert.equal(requests[0].language,'auto');assert.equal(requests[0].model,'sensevoice');assert.deepEqual(requests[0].wav.subarray(44),pcm);
 await transcribe(pcm,{language:'en'},{},{...config,FUNASR_API_KEY:'gateway'});assert.equal(requests[1].authorization,'Bearer gateway');assert.equal(requests[1].language,'en');
},(_request,res)=>res.end(JSON.stringify({text:'<|zh|><|NEUTRAL|>真实文字'}))));

test('FunASR explicit provider errors remain actionable and never fabricate a transcript',async()=>{
 for(const [status,body,code] of [[401,'secret upstream detail','funasr_credentials_rejected'],[404,'missing','funasr_endpoint_unavailable'],[200,'{"result":[]}','invalid_funasr_response'],[200,'not json','invalid_funasr_response']])await fixture(async(_repo,config)=>{
  await assert.rejects(transcribe(speech(2),{language:'zh'},{},config),{code});
 },(_request,res)=>{res.writeHead(status);res.end(body);});
});

test('native short packets aggregate into one real request and retain every durable identity and final reference',async()=>fixture(async(repo,_config,requests)=>{
 const pcm=Buffer.concat([speech(4.2),silence(0.1)]),{record}=await recordWith(repo,[native(pcm)]);
 await runCycle(repo,{}, {lane:'audio'});const current=await repo.get(record.id);
 assert.equal(current.capture,'completed');assert.equal(requests.length,1);assert.deepEqual(requests[0].wav.subarray(44),pcm);
 assert.ok(current.chunks.every(c=>c.state==='done'));assert.equal(current.segments.length,1);const s=current.segments[0];
 assert.equal(s.startMs,0);assert.equal(s.endMs,4300);assert.equal(s.transcriptProvider,'funasr');assert.equal(s.modelVersion,'sensevoice');assert.deepEqual(s.chunkKeys,current.chunks.map(c=>c.key));
 const job=requestMinutes(current);assert.equal(job.snapshot[0].id,s.id);assert.equal(job.snapshot[0].revision,1);
 await runCycle(repo,{}, {lane:'audio'});assert.equal(requests.length,1);assert.equal((await repo.get(record.id)).segments.length,1);
}));

test('quiet-tail flush works while recording, without waiting for the maximum window',async()=>fixture(async(repo,_config,requests)=>{
 const {record}=await recordWith(repo,[[speech(1),speech(1),silence(0.8)]],{stopped:false});await runCycle(repo,{}, {lane:'audio'});
 const current=await repo.get(record.id);assert.equal(current.capture,'recording');assert.equal(current.chunks.filter(c=>c.state==='done').length,3);assert.equal(requests.length,1);
}));

test('unfinished speech waits, while pause drains the tail immediately despite a batch-wait delay',async()=>fixture(async(repo,_config,requests)=>{
 const {record,manifest}=await recordWith(repo,[native(speech(3.4))],{stopped:false});await runCycle(repo,{}, {lane:'audio'});
 let current=await repo.get(record.id);assert.equal(requests.length,0);assert.ok(current.chunks[0].batchWaiting);assert.equal(current.chunks[0].attempts,0);
 await repo.change(record.id,r=>pause(r,manifest));await runCycle(repo,{}, {lane:'audio'});current=await repo.get(record.id);
 assert.equal(current.capture,'paused');assert.ok(current.chunks.every(c=>c.state==='done'));assert.equal(requests.length,1);
}));

test('active speech has a bounded wait and 30-second request limit',async()=>fixture(async(repo,_config,requests)=>{
 const {record}=await recordWith(repo,[[speech(1),speech(1),speech(1)]],{stopped:false});await repo.change(record.id,r=>{r.chunks[0].acceptedAt=Date.now()-21000;});await runCycle(repo,{}, {lane:'audio'});assert.equal(requests.length,1);
 const big=await recordWith(repo,[Array.from({length:40},()=>speech(1))]);await runCycle(repo,{}, {lane:'audio'});await runCycle(repo,{}, {lane:'audio'});
 const current=await repo.get(big.record.id);assert.equal(current.capture,'completed');assert.ok(requests.every(r=>r.wav.length<=960044));assert.equal(requests.length,3);assert.equal(current.segments.length,2);
}));

test('two sources remain separate and concurrent workers cannot duplicate a leased batch',async()=>{
 let release,entered,arrived=0;const gate=new Promise(r=>{entered=r;}),waiting=new Promise(r=>{release=r;});
 await fixture(async(repo,config,requests)=>{
  const {record}=await recordWith(repo,[[speech(3)],[speech(4)]]);
  const work=processFunasrAudio(repo,await repo.get(record.id),config);await gate;
  await processFunasrAudio(repo,await repo.get(record.id),config);assert.equal(requests.length,2);release();await work;
  const current=await repo.get(record.id);assert.equal(current.capture,'completed');assert.equal(current.segments.length,2);assert.equal(new Set(current.segments.map(s=>s.sourceId)).size,2);
 },async(_request,res)=>{if(++arrived===2)entered();await waiting;res.end(JSON.stringify({text:'分别转录'}));});
});

test('failed service keeps capture/audio, and a subsequent retry drains successfully',async()=>{
 let fail=true;
 await fixture(async(repo,_config,requests)=>{
  const {record}=await recordWith(repo,[[speech(3)]],{stopped:false});await repo.change(record.id,r=>{r.chunks[0].acceptedAt=Date.now()-21000;});
  await runCycle(repo,{}, {lane:'audio'});let current=await repo.get(record.id);assert.equal(current.capture,'recording');assert.equal(current.transcription,'blocked');assert.equal(current.chunks[0].attempts,1);assert.equal(current.chunks[0].state,'pending');assert.equal((await repo.readAudio(current.chunks[0].object)).length,96000);
  fail=false;await repo.change(record.id,r=>{r.chunks[0].retryAt=0;});await runCycle(repo,{}, {lane:'audio'});current=await repo.get(record.id);assert.equal(current.chunks[0].state,'done');assert.equal(current.capture,'recording');assert.equal(requests.length,2);
 },(_request,res)=>{res.writeHead(fail?503:200);res.end(JSON.stringify({text:'恢复转录'}));});
});

test('provider change during inference discards old output and releases the exact owned batch',async()=>{
 let release,entered;const gate=new Promise(r=>{entered=r;});
 await fixture(async(repo,config)=>{
  const {record}=await recordWith(repo,[[speech(3)]]);const work=processFunasrAudio(repo,await repo.get(record.id),config);await gate;
  await saveConfig(repo.root,{FUNASR_MODEL:'paraformer'},{NODE_ENV:'test'});release();await work;
  const current=await repo.get(record.id);assert.equal(current.segments.length,0);assert.ok(current.chunks.every(c=>c.state==='pending'&&!c.lease));
 },async(_request,res)=>{entered();await new Promise(r=>{release=r;});res.end(JSON.stringify({text:'旧模型结果'}));});
});

test('generation fence rejects late inference after deletion',async()=>{
 let release,entered;const gate=new Promise(r=>{entered=r;});
 await fixture(async(repo,config)=>{
  const {record}=await recordWith(repo,[[speech(3)]]);const work=processFunasrAudio(repo,await repo.get(record.id),config);await gate;
  await repo.change(record.id,r=>{r.deleted=true;r.generation++;});release();await work;assert.equal((await repo.get(record.id)).segments.length,0);
 },async(_request,res)=>{entered();await new Promise(r=>{release=r;});res.end(JSON.stringify({text:'删除后的迟到结果'}));});
});

test('stopped source with a missing durable packet waits, then drains all bytes in order',async()=>fixture(async(repo,_config,requests)=>{
 const r=createRecord('owner'),s=addSource(r,{kind:'display'});await repo.insert(r);
 async function append(sequence){const bytes=speech(1),object=await repo.putAudio(r.id,bytes);await repo.change(r.id,record=>acknowledge(record,{sessionId:s.sessionId,sourceId:s.id,epoch:s.epoch,sequence,sampleOffset:sequence*16000,sampleCount:16000,sampleRate:16000,digest:digest(bytes),...object}));}
 await append(0);await append(2);await repo.change(r.id,record=>seal(record,[{sessionId:s.sessionId,sourceId:s.id,epoch:s.epoch,lastSequence:2}]));await runCycle(repo,{}, {lane:'audio'});assert.equal(requests.length,0);
 await append(1);await runCycle(repo,{}, {lane:'audio'});assert.equal(requests.length,1);assert.equal(requests[0].wav.length,96044);assert.equal((await repo.get(r.id)).capture,'completed');
}));

test('restart recovers durable pending packets and preserves existing human revisions',async()=>fixture(async(repo,config)=>{
 const {record,sources}=await recordWith(repo,[[speech(3)]]);await runCycle(repo,{}, {lane:'audio'});const first=(await repo.get(record.id)).segments[0];await repo.change(record.id,r=>editSegment(r,first.id,{revision:1,text:'人工确认的原文',speaker:'主持人'}));
 await repo.change(record.id,r=>{r.capture='paused';sources[0].stopped=true;addSource(r,{kind:'microphone'});});
 const current=await repo.get(record.id),s=current.sources.at(-1),bytes=speech(3),object=await repo.putAudio(record.id,bytes);
 await repo.change(record.id,r=>{acknowledge(r,{sessionId:s.sessionId,sourceId:s.id,epoch:s.epoch,sequence:0,sampleOffset:0,sampleCount:48000,sampleRate:16000,digest:digest(bytes),...object});const c=r.chunks.at(-1);c.lease=Date.now()+180000;c.fence='interrupted';c.state='processing';seal(r,r.sources.map(source=>({sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,lastSequence:0})));});
 await recoverLocalWork(repo);await processFunasrAudio(repo,await repo.get(record.id),config);const final=await repo.get(record.id);assert.equal(final.capture,'completed');assert.equal(final.segments[0].text,'人工确认的原文');assert.equal(final.segments[0].revision,2);assert.equal(final.segments.length,2);
}));

test('pause during aggregate audio reads flushes without reintroducing batch wait',async()=>fixture(async(repo,config,requests)=>{
 const {record,manifest}=await recordWith(repo,[native(speech(3.4))],{stopped:false});
 const read=repo.readAudio.bind(repo);let release,entered;const gate=new Promise(r=>{entered=r;}),waiting=new Promise(r=>{release=r;});
 repo.readAudio=async object=>{entered();await waiting;return read(object);};
 const work=processFunasrAudio(repo,await repo.get(record.id),config);await gate;await repo.change(record.id,r=>pause(r,manifest));release();await work;
 const current=await repo.get(record.id);assert.ok(current.chunks.every(c=>c.state==='done'));assert.equal(current.capture,'paused');assert.equal(requests.length,1);
}));

test('a failed quiet-boundary request never spends retries on its unsent suffix',async()=>fixture(async(repo,_config,requests)=>{
 const {record}=await recordWith(repo,[[speech(2),silence(1),speech(2)]]);
 await runCycle(repo,{}, {lane:'audio'});const current=await repo.get(record.id);
 assert.equal(requests.length,1);assert.equal(requests[0].wav.length,96044);
 assert.equal(current.chunks[0].attempts,1);assert.equal(current.chunks[1].attempts,1);assert.equal(current.chunks[2].attempts,0);
 assert.equal(current.chunks[2].state,'pending');assert.equal(current.chunks[2].error,undefined);assert.equal(current.chunks[2].lease,undefined);
},(_request,res)=>{res.writeHead(503);res.end('{}');}));


test('provider change discards an obsolete failure without exhausting new service retries',async()=>{
 let release,entered;const gate=new Promise(r=>{entered=r;});let calls=0;
 await fixture(async(repo,config,requests)=>{
  const {record}=await recordWith(repo,[[speech(3)]]);await repo.change(record.id,r=>{r.chunks[0].attempts=4;});
  const work=processFunasrAudio(repo,await repo.get(record.id),config);await gate;
  await saveConfig(repo.root,{FUNASR_MODEL:'paraformer'},{NODE_ENV:'test'});release();await work;
  const current=await repo.get(record.id);assert.equal(current.chunks[0].attempts,4);assert.equal(current.chunks[0].state,'pending');assert.equal(current.chunks[0].lease,undefined);assert.notEqual(current.transcription,'failed');
  await runCycle(repo,{}, {lane:'audio'});const final=await repo.get(record.id);assert.equal(final.capture,'completed');assert.equal(final.chunks[0].state,'done');assert.equal(requests.length,2);assert.equal(requests[1].model,'paraformer');
 },async(_request,res)=>{
  if(++calls===1){entered();await new Promise(r=>{release=r;});res.writeHead(503);res.end('{}');}
  else res.end(JSON.stringify({text:'新模型结果'}));
 });
});
