import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import {WebSocketServer} from 'ws';
import {createDoubaoSpeakerStream} from '../services/records/src/doubao.mjs';
import {createRecord,addSource,acknowledge} from '../packages/records/src/record.mjs';
import {processSpeakerSources,closeSpeakerStreams} from '../services/records/src/speaker-streams.mjs';

const bytes=randomBytes(480000);
async function fixture(run,{pause=true,interval=0,timeout=2000}={}) {
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(resolve=>server.once('listening',resolve));
  const peers=[],clients=[];let paused=pause;
  server.on('connection',socket=>{peers.push(socket);if(paused)socket._socket.pause();});
  const config={DOUBAO_ASR_URL:`ws://127.0.0.1:${server.address().port}`,DOUBAO_API_KEY:'synthetic',DOUBAO_ASR_RESOURCE_ID:'synthetic'};
  const factory=(language='zh',_config=config,options={})=>{const client=createDoubaoSpeakerStream(language,config,{...options,interval,timeout});clients.push(client);return client;};
  const resume=()=>{paused=false;for(const peer of peers)peer._socket.resume();};
  const stopReading=()=>{paused=true;for(const peer of peers)peer._socket.pause();};
  const close=()=>{for(const client of clients)client.close();for(const peer of peers)peer.terminate();};
  const watchdog=setTimeout(close,12000);
  try { await run({config,factory,resume,stopReading}); }
  finally { clearTimeout(watchdog);close();await new Promise(resolve=>server.close(resolve)); }
}

test('stopped WS reader hits a bounded send deadline and can recover before it',async()=>{
  await fixture(async({factory})=>{
    const client=factory();await client.ready;let completed=0,error;
    for(;completed<40;completed++){try{await client.write(bytes);}catch(caught){error=caught;break;}}
    assert.ok(completed<40);assert.equal(error?.code,'doubao_completion_timeout');
    assert.equal(client.state.error?.code,'doubao_completion_timeout');
  });
  await fixture(async({factory,resume,stopReading})=>{
    const client=factory();await client.ready;await client.write(bytes);
    stopReading();const pending=client.write(bytes);await wait(50);resume();await pending;
    assert.equal(client.state.error,null);
  },{pause:false});
});

test('closing an ASR stream interrupts paced sends',()=>fixture(async({factory})=>{
  const client=factory();await client.ready;const pending=client.write(bytes);pending.catch(()=>{});
  await wait(20);client.close();await assert.rejects(pending,{code:'doubao_stream_cancelled'});
},{pause:false,interval:1000}));

test('send timeout releases lease and preserves acknowledged chunks for ordered retry',()=>fixture(async({config,factory,resume})=>{
  const record=createRecord('synthetic',{title:'Synthetic timeout recovery'}),source=addSource(record,{kind:'microphone'});
  const count=40;
  for(let i=0;i<count;i++)acknowledge(record,{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence:i,sampleOffset:i*240000,sampleCount:240000,sampleRate:16000,digest:'a'.repeat(64),object:`synthetic-${i}`});
  const identity=chunk=>Object.fromEntries(['key','object','digest','sourceId','sessionId','epoch','sequence','sampleOffset','sampleCount','sampleRate'].map(key=>[key,chunk[key]]));
  const preserved=record.chunks.map(identity),reads=[];
  const repo={async get(){return structuredClone(record);},async change(_id,mutate){return mutate(record);},async readAudio(object){reads.push(object);return bytes;}};
  try {
    for(let tick=0;tick<count && record.sources[0].asr?.state!=='failed';tick++)await processSpeakerSources(repo,structuredClone(record),config,factory);
    const failed=record.sources[0].asr;
    assert.equal(failed.state,'failed');assert.equal(failed.error,'doubao_completion_timeout');
    assert.equal(failed.retryable,true);assert.equal(failed.lease,undefined);
    assert.equal(record.chunks.length,count);assert.ok(record.chunks.every(chunk=>chunk.state==='pending'));
    assert.deepEqual(record.chunks.map(identity),preserved);
    resume();failed.retryAt=0;reads.length=0;
    await processSpeakerSources(repo,structuredClone(record),config,factory);
    await processSpeakerSources(repo,structuredClone(record),config,factory);
    assert.equal(record.sources[0].asr.state,'running');assert.notEqual(record.sources[0].asr.fence,failed.fence);
    assert.equal(record.sources[0].asr.lastFedSequence,1);assert.deepEqual(reads,['synthetic-0','synthetic-1']);
    assert.deepEqual(record.chunks.map(identity),preserved);
  } finally { closeSpeakerStreams(repo); }
}));
