import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformSync,buildSync} from 'esbuild';
import vm from 'node:vm';
const code=transformSync(await readFile(new URL('../apps/web/src/api.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
function client(fetch){const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,require:()=>({trace(){}}),performance,crypto,AbortController,AbortSignal:{timeout:()=>AbortSignal.timeout(5),any:AbortSignal.any.bind(AbortSignal)},fetch,setTimeout,clearTimeout,Uint8Array});return module.exports;}
test('stalled service request times out so a local audio lane can recover',async()=>{
  const h=client((_,init)=>new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true})));
  const keepAlive=setTimeout(()=>{},100);try{await assert.rejects(h.serviceFetch('/api/health'),{code:'service_unavailable'});}finally{clearTimeout(keepAlive);}
});
test('caller cancellation stays distinguishable and no request is silently retried',async()=>{
  let calls=0;const h=client((_,init)=>{calls++;return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));});
  const controller=new AbortController();const waiting=h.serviceFetch('/api/records',{signal:controller.signal});controller.abort();await assert.rejects(waiting,{name:'AbortError'});assert.equal(calls,1);
});
test('an aborted response body is a recoverable service interruption',async()=>{
  const h=client(()=>{});await assert.rejects(h.readServiceJson({status:200,json:async()=>{throw new DOMException('timeout','AbortError');}}),{code:'service_unavailable'});
});

test('long downloads keep caller cancellation without the JSON upload deadline',async()=>{
  let signal;const h=client(async(_,init)=>{signal=init.signal;return{};});
  const controller=new AbortController();await h.serviceFetch('/audio/large.wav',{signal:controller.signal},0);
  await new Promise(r=>setTimeout(r,15));assert.equal(signal.aborted,false);controller.abort();assert.equal(signal.aborted,true);
});

import {mkdtemp,mkdir,writeFile,readFile as read,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
const run=(program,args)=>new Promise((resolve,reject)=>{const child=spawn(program,args,{stdio:'ignore'});child.once('error',reject);child.once('exit',code=>resolve(code));});
const handoff=new URL('../apps/desktop/src-tauri/src/macos_preview_handoff.sh',import.meta.url).pathname;
for(const success of [true,false])test(`macOS update handoff waits for exit and ${success?'replaces atomically':'rolls back on launch failure'}`,{skip:process.platform==='win32'},async()=>{
  const root=await mkdtemp(join(tmpdir(),"lingji handoff's "));
  try{
    const target=join(root,'聆记 Preview.app'),stage=await mkdtemp(join(root,'.lingji-update-')),next=join(stage,'next.app'),opener=join(root,'opener.sh');
    await mkdir(target);await mkdir(next);await writeFile(join(target,'version'),'old');await writeFile(join(next,'version'),'new');
    await writeFile(opener,`#!/bin/sh\nexit ${success?0:1}\n`,{mode:0o755});
    const owner=spawn(process.execPath,['-e','setTimeout(()=>{},150)'],{stdio:'ignore'});
    const result=run('/bin/sh',[handoff,String(owner.pid),target,next,opener]);
    await new Promise(r=>setTimeout(r,30));assert.equal(await read(join(target,'version'),'utf8'),'old');
    assert.equal(await result,success?0:5);assert.equal(await read(join(target,'version'),'utf8'),success?'new':'old');
    if(success){await stat(stage);assert.equal(await read(join(stage,'previous.app','version'),'utf8'),'old');assert.equal(await read(join(stage,'helper-ready'),'utf8'),'');}else assert.equal(await read(join(next,'version'),'utf8'),'new');
  }finally{await rm(root,{recursive:true,force:true});}
});


import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createRequire} from 'node:module';
test('completed progress uses the final minutes snapshot instead of an older live snapshot',()=>{
 const bundle=buildSync({entryPoints:[new URL('../apps/web/src/components/ProcessingProgress.tsx',import.meta.url).pathname],bundle:true,platform:'node',format:'cjs',write:false,jsx:'automatic',external:['react','react/jsx-runtime']}).outputFiles[0].text;
 const module={exports:{}};vm.runInNewContext(bundle,{module,exports:module.exports,require:createRequire(import.meta.url)});
 const record={capture:'completed',durationMs:70*60000,segments:[],liveMinutes:{evidenceSnapshot:[{endMs:48*60000}]},minutes:{evidenceSnapshot:[{endMs:70*60000}]}};
 const html=renderToStaticMarkup(React.createElement(module.exports.ProcessingProgress,{record,localDurationMs:70*60000,pending:0}));
 assert.match(html,/纪要依据 <time>70:00<\/time>/);assert.doesNotMatch(html,/48:00/);
});

import {parse} from '@babel/parser';
test('meeting sibling panes have distinct keys so repeated refresh cannot duplicate minutes',async()=>{
 const text=await readFile(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
 const ast=parse(text,{sourceType:'module',plugins:['jsx','typescript']});
 let owners=0;
 function visit(node){
  if(node.type==='JSXFragment'||node.type==='JSXElement'){
   const keys=node.children.flatMap(child=>{
    const opening=child.type==='JSXElement'?child.openingElement:null;
    const attr=opening?.attributes.find(a=>a.type==='JSXAttribute'&&a.name.name==='key');
    return attr?.value?[text.slice(attr.value.start,attr.value.end)]:[];
   });
   if(keys.length>1){owners++;assert.equal(new Set(keys).size,keys.length,`duplicate sibling keys: ${keys.join(', ')}`);}
  }
  for(const value of Object.values(node))if(Array.isArray(value))value.forEach(item=>{if(item&&typeof item==='object')visit(item);});else if(value&&typeof value==='object')visit(value);
 }
 visit(ast);assert.ok(owners>0);
});

import {prepareClientBackend} from '../scripts/prepare-client-backend.mjs';
test('runtime preparation retries a transient fetch but still rejects invalid archive content',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'lingji-runtime-retry-')),previous=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{if(++calls===1)throw new DOMException('fixture timeout','TimeoutError');return new Response('invalid archive');};
 try{await assert.rejects(prepareClientBackend({root,cacheRoot:join(root,'cache')}),/checksum mismatch/);assert.equal(calls,2);}
 finally{globalThis.fetch=previous;await rm(root,{recursive:true,force:true});}
});
