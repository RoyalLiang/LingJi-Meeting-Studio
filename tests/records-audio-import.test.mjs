import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {streamAudioImport,waitForImportUpload,compatibilityAudioImport} from '../apps/web/src/audio/stream-import.ts';

function virtualWave(seconds) {
  const dataBytes=16000*seconds*2,header=Buffer.alloc(44),reads=[];
  header.write('RIFF');header.writeUInt32LE(dataBytes+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(dataBytes,40);
  class Wave extends File {
    constructor(){super([header],'synthetic-long.wav',{type:'audio/wav'});}
    get size(){return dataBytes+44;}
    arrayBuffer(){assert.fail('whole-file decoding is forbidden');}
    slice(start=0,end=this.size){
      end=Math.min(end,this.size);let position=start;
      return {stream:()=>new ReadableStream({pull(controller){
        if(position>=end){controller.close();return;}
        const size=Math.min(65536,end-position);reads.push(size);const bytes=new Uint8Array(size);
        if(position<header.length)bytes.set(header.subarray(position,Math.min(position+size,header.length)));
        position+=size;controller.enqueue(bytes);
      }})};
    }
  }
  return {file:new Wave(),reads};
}

test('35-minute >64 MiB PCM file streams through the real demuxer without whole-file decoding',async()=>{
  const {file,reads}=virtualWave(35*60);let bytes=0,chunks=0,maximum=0,progress=0;
  const samples=await streamAudioImport(file,async pcm=>{bytes+=pcm.byteLength;chunks++;maximum=Math.max(maximum,pcm.byteLength);},value=>progress=value);
  assert.ok(file.size>64*1024*1024);assert.equal(samples,16000*35*60);assert.equal(bytes,samples*2);assert.equal(chunks,210);assert.equal(maximum,320000);assert.equal(progress,1);assert.ok(Math.max(...reads)<=2*1024*1024);
});

test('decoder obeys consumer backpressure and cancellation closes its read pipeline',async()=>{
  const {file}=virtualWave(120);const controller=new AbortController();let entered,release;
  const first=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);let chunks=0;
  const running=streamAudioImport(file,async()=>{chunks++;entered();await gate;},()=>{},controller.signal);
  await first;await new Promise(resolve=>setImmediate(resolve));assert.equal(chunks,1);
  controller.abort();release();await assert.rejects(running,/abort|cancel|dispos/i);assert.equal(chunks,1);
});

test('malformed input fails before producing any PCM',async()=>{
  await assert.rejects(streamAudioImport(new File(['not audio'],'bad.mp3'),()=>assert.fail('must not emit audio'),()=>{}));
});

test('capture import durably queues contiguous chunks and drains bounded batches',async()=>{
  const text=await readFile(new URL('../apps/web/src/audio/capture.ts',import.meta.url),'utf8');
  const source=stripTypeScriptTypes(text.slice(text.indexOf('export async function importAudio'))).replaceAll('export ','');
  const exports={},saved=[];let drains=0;
  vm.runInNewContext(source+'\nexports.importAudio=importAudio;',{
    exports,waitForImportUpload,streamAudioImport:async(_file,consume)=>{for(let i=0;i<10;i++)await consume(new ArrayBuffer(i===9?20:320000));},
    api:async()=>({id:'s',epoch:'e',sessionId:'ss'}),makeChunk:async(_s,_e,sequence,offset,pcm)=>({sequence,offset,samples:pcm.byteLength/2}),
    enqueue:async(_id,chunk)=>saved.push(chunk),drainQueue:async()=>{drains++;},ArrayBuffer,
  });
  await exports.importAudio({name:'synthetic.wav'},{id:'r'},()=>{});
  assert.equal(saved.length,10);assert.equal(drains,3);assert.equal(saved[9].offset,1440000);assert.equal(saved[9].samples,10);assert.deepEqual(saved.map(chunk=>chunk.sequence),[0,1,2,3,4,5,6,7,8,9]);
});

test('stopping an import leaves the durable background upload running without blocking cancellation',async()=>{
  const controller=new AbortController();let release,finished=false;
  const upload=new Promise(resolve=>release=resolve).then(()=>{finished=true;});
  const waiting=waitForImportUpload(upload,controller.signal);controller.abort();
  await assert.rejects(waiting,{name:'AbortError'});assert.equal(finished,false);release();await upload;assert.equal(finished,true);
});

test('App cancellation seals the persisted local manifest as paused while upload continues',async()=>{
  const {createRecord,addSource,pause}=await import('../packages/records/src/record.mjs');
  const record=createRecord('fixture'),saved=[];let started,release;
  const entering=new Promise(resolve=>started=resolve),upload=new Promise(resolve=>release=resolve);
  const text=await readFile(new URL('../apps/web/src/audio/capture.ts',import.meta.url),'utf8');
  const source=stripTypeScriptTypes(text.slice(text.indexOf('export async function importAudio'))).replaceAll('export ','');
  const exports={};vm.runInNewContext(source+'\nexports.importAudio=importAudio;',{
    exports,waitForImportUpload,streamAudioImport:async(_file,consume)=>consume(new ArrayBuffer(320000)),
    api:async()=>addSource(record,{kind:'import'}),makeChunk:async(sourceId,epoch,sequence,offset,pcm,sessionId)=>({sourceId,epoch,sequence,offset,sampleCount:pcm.byteLength/2,sessionId}),
    enqueue:async(_id,chunk)=>saved.push(chunk),drainQueue:()=>{started();return upload;},ArrayBuffer,
  });
  const app=await readFile(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
  const handler=stripTypeScriptTypes(app.slice(app.indexOf('async function onImport(file: File)'),app.indexOf('\n  useEffect(',app.indexOf('async function onImport(file: File)'))));
  const importRequest={current:null};let mode;
  const appExports={};vm.runInNewContext(handler+'\nexports.onImport=onImport;',{
    exports:appExports,record,importRequest,AbortController,importAudio:exports.importAudio,
    setBusy(){},setImportProgress(){},setError(){},showToast(){},messageOf:String,refresh:async()=>{},
    stopCapture:async value=>{mode=value;pause(record,record.sources.map(source=>({sourceId:source.id,epoch:source.epoch,lastSequence:saved.filter(chunk=>chunk.sourceId===source.id).at(-1)?.sequence??-1})));return true;},
  });
  const running=appExports.onImport({name:'fixture.wav'});await entering;importRequest.current.abort();await running;
  assert.equal(mode,'pause');assert.equal(record.capture,'paused');assert.equal(record.sources[0].stopped,true);assert.equal(record.sources[0].lastSequence,0);assert.equal(record.sources[0].watermark,-1);assert.equal(importRequest.current,null);release();
});

test('native compatibility decoder bounds memory admission, mixes PCM and preserves backpressure', async () => {
  const previous = globalThis.AudioContext; let created = 0, closed = 0, reads = 0;
  const frames = 12 * 16000, channels = [new Float32Array(frames).fill(.5), new Float32Array(frames).fill(.25)];
  globalThis.AudioContext = class { sampleRate = 16000; constructor() { created++; } async close() { closed++; } async decodeAudioData() { return { length: frames, sampleRate: 16000, numberOfChannels: 2, getChannelData: index => channels[index] }; } };
  const file = new File(['small native decoder fixture'], 'small.mp3'), arrayBuffer = file.arrayBuffer.bind(file); file.arrayBuffer = () => { reads++; return arrayBuffer(); };
  try {
    await assert.rejects(compatibilityAudioImport(file, { durationSeconds: 901, channels: 2 }, async () => assert.fail('inadmissible'), () => {}));
    assert.equal(created, 0); assert.equal(reads, 0);
    let release, reached; const blocked = new Promise(done => { release = done; }), ready = new Promise(done => { reached = done; }), chunks = [];
    const pending = compatibilityAudioImport(file, { durationSeconds: 12, channels: 2 }, async pcm => { chunks.push(pcm); if (chunks.length === 1) { reached(); await blocked; } }, () => {});
    await ready; assert.equal(chunks.length, 1); assert.equal(chunks[0].byteLength, 320000); assert.equal(new DataView(chunks[0]).getInt16(0, true), 12288);
    release(); assert.equal(await pending, frames); assert.deepEqual(chunks.map(chunk => chunk.byteLength), [320000, 64000]); assert.equal(closed, 1);
  } finally { if (previous === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = previous; }
});

test('native compatibility cancellation closes decoder while late decoding cannot emit PCM', async () => {
  const previous = globalThis.AudioContext; let close = 0, finish, started;
  const ready = new Promise(done => { started = done; });
  globalThis.AudioContext = class { sampleRate = 16000; async close() { close++; } decodeAudioData() { started(); return new Promise(done => { finish = done; }); } };
  try {
    const controller = new AbortController(), pending = compatibilityAudioImport(new File(['tiny'], 'small.mp3'), { durationSeconds: 2, channels: 1 }, async () => assert.fail('cancelled decode must not publish'), () => {}, controller.signal);
    const rejected = assert.rejects(pending, { name: 'AbortError' }); await ready; controller.abort(); await rejected;
    finish({ length: 16000, sampleRate: 16000, numberOfChannels: 1, getChannelData: () => new Float32Array(16000) }); await new Promise(done => setImmediate(done)); assert.ok(close >= 1);
  } finally { if (previous === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = previous; }
});

test('a small MP3 without WebCodecs uses the native compatibility path through the real demuxer', async () => {
  const previous = globalThis.AudioContext; let contexts = 0;
  globalThis.AudioContext = class { sampleRate = 16000; constructor() { contexts++; } async close() {} async decodeAudioData() { return { sampleRate: 16000, length: 17280, numberOfChannels: 1, getChannelData: () => new Float32Array(17280).fill(.25) }; } };
  try {
    // Generated with ffmpeg lavfi sine=frequency=440:sample_rate=16000:duration=1, libmp3lame 16k mono, no metadata.
    const bytes = await readFile(new URL('./fixtures/audio/import-compatibility.mp3', import.meta.url));
    let emitted = 0; const result = await streamAudioImport(new File([bytes], 'compatibility.mp3', { type: 'audio/mpeg' }), async pcm => { emitted += pcm.byteLength; }, () => {});
    assert.equal(contexts, 1); assert.equal(result, 17280); assert.equal(emitted, 34560);
  } finally { if (previous === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = previous; }
});
