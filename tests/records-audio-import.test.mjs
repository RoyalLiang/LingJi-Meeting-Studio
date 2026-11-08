import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';import {stripTypeScriptTypes} from 'node:module';
const durationCode=stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/import-duration.ts',import.meta.url),'utf8')).replaceAll('export ','')+'\nexports.importDuration=importDuration;';
function metadata(duration){const exports={},state={revoked:0,cleaned:0};class Audio{duration=duration;set src(value){queueMicrotask(()=>this.onloadedmetadata());}removeAttribute(){state.cleaned++;}load(){}}vm.runInNewContext(durationCode,{exports,Audio,URL:{createObjectURL:()=> 'fixture',revokeObjectURL:()=>state.revoked++},setTimeout,clearTimeout});return {...exports,state};}
test('metadata rejects oversized decoded duration before allocating PCM and always releases object URL',async()=>{for(const value of [901,3600,Infinity,0]){const h=metadata(value);await assert.rejects(h.importDuration({}),/15 分钟|时长/);assert.equal(h.state.revoked,1);assert.equal(h.state.cleaned,1);}const h=metadata(600);assert.equal(await h.importDuration({}),600);});
test('import uses one 16k decoder, mixes channels and drains bounded batches',async()=>{
 const text=await readFile(new URL('../apps/web/src/audio/capture.ts',import.meta.url),'utf8'),source=stripTypeScriptTypes(text.slice(text.indexOf('export async function importAudio('))).replaceAll('export ','');
 const exports={},saved=[],channels=[new Float32Array(160000*9+10).fill(.5),new Float32Array(160000*9+10).fill(-.25)];let drains=0,closed=0;
 class AudioContext{constructor(options){assert.equal(options.sampleRate,16000);}async decodeAudioData(){return{length:channels[0].length,numberOfChannels:2,getChannelData:index=>channels[index]};}async close(){closed++;}}
 vm.runInNewContext(source+'\nexports.importAudio=importAudio;',{exports,AudioContext,importDuration:async()=>100,pcmWaveInfo:async()=>null,api:async()=>({id:'source',epoch:'e',sessionId:'s'}),makeChunk:async(_s,_e,sequence,offset,pcm)=>({sequence,offset,pcm}),enqueue:async(_id,chunk)=>saved.push(chunk),drainQueue:async()=>{drains++;},ArrayBuffer,DataView});
 await exports.importAudio({size:100,name:'synthetic.wav',arrayBuffer:async()=>new ArrayBuffer(0)},{id:'r'},()=>{});
 assert.equal(saved.length,10);assert.equal(drains,2);assert.equal(closed,1);assert.equal(saved[0].pcm.byteLength,320000);assert.equal(saved.at(-1).pcm.byteLength,20);assert.equal(new DataView(saved[0].pcm).getInt16(0,true),4096);assert.equal(saved[1].offset,160000);
});

test('20-minute 16k PCM WAV metadata uses a bounded header read',async()=>{
 const {pcmWaveInfo}=await import('../apps/web/src/audio/import-duration.ts');const header=Buffer.alloc(44);header.write('RIFF');header.write('WAVE',8);header.write('fmt ',12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);const samples=16000*1200;header.writeUInt32LE(samples*2,40);let readBytes=0;
 const info=await pcmWaveInfo({size:44+samples*2,slice:(start,end)=>{readBytes=end-start;return new Blob([header]);}});assert.equal(info.samples,samples);assert.equal(info.offset,44);assert.ok(readBytes<=65536);
});
test('long supported PCM WAV streams without whole-file decode or the compressed duration limit',async()=>{
 const text=await readFile(new URL('../apps/web/src/audio/capture.ts',import.meta.url),'utf8'),source=stripTypeScriptTypes(text.slice(text.indexOf('export async function importAudio('))).replaceAll('export ','');
 const exports={},samples=16000*1200;let chunks=0,total=0,maxRead=0;
 vm.runInNewContext(source+'\nexports.importAudio=importAudio;',{exports,pcmWaveInfo:async()=>({offset:44,channels:1,samples}),importDuration:()=>assert.fail('PCM must bypass compressed decode'),AudioContext:class{constructor(){assert.fail('no PCM decoder needed');}},api:async()=>({id:'s',epoch:'e',sessionId:'ss'}),makeChunk:async(_s,_e,sequence,offset,pcm)=>({sequence,offset,samples:pcm.byteLength/2}),enqueue:async(_id,c)=>{assert.equal(c.offset,total);total+=c.samples;chunks++;},drainQueue:async()=>{},ArrayBuffer,DataView});
 const file={size:44+samples*2,arrayBuffer:()=>assert.fail('whole-file read'),slice:(start,end)=>{maxRead=Math.max(maxRead,end-start);return{arrayBuffer:async()=>new ArrayBuffer(end-start)};}};
 await exports.importAudio(file,{id:'r'},()=>{});assert.equal(total,samples);assert.equal(chunks,120);assert.ok(maxRead<=320000);
});
