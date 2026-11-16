import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {transformSync} from 'esbuild';

async function component(path,modules,globals={}){
  const source=await readFile(new URL('../apps/web/src/'+path,import.meta.url),'utf8');
  const compiled=transformSync(source,{loader:'tsx',format:'cjs',jsx:'automatic'}).code;
  const exports={},sandbox={exports,module:{exports},require:name=>modules[name]||{},...globals};
  vm.runInNewContext(compiled,sandbox);return sandbox.module.exports;
}
const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};

test('native recording reports stay independent from the visible clock and return idle after clearing a paused record',async()=>{
  const reports=[];
  const module=await component('components/RecordingProgress.tsx',{'react':{useSyncExternalStore:(_subscribe,read)=>read()},'react/jsx-runtime':jsx,'../audio/signal':{capturedDurationMs:saved=>saved},'../model':{timecode:ms=>String(ms)},'../useRecordingDuration':{useRecordingDuration:(_id,saved)=>saved},'../useRecordingWidget':{useRecordingWidget:report=>reports.push(report)}});
  const signals=module.createCaptureSignals(),record={id:'meeting',capture:'paused',durationMs:2000,sources:[]},props={record,recording:false,busy:false,signals,manifests:[],onError(){}};
  module.RecordingRuntime(props);assert.equal(reports.at(-1).paused,true);
  module.RecordingProgress(props);assert.equal(reports.length,1,'reading clock must not own native reports');
  module.RecordingRuntime({...props,record:null});assert.equal(reports.at(-1).paused,false);assert.equal(reports.at(-1).canResume,false);assert.equal(reports.at(-1).recording,false);
});

test('virtual segments remeasure unchanged-length content after preceding layout changes',async()=>{
  const effects=[],values=[],mutations=[],resizes=[];let refs=0,top=100;
  const container={scrollTop:0,clientTop:0,getBoundingClientRect:()=>({top:0}),parentElement:null};
  const root={closest:()=>container,getBoundingClientRect:()=>({top}),parentElement:container};
  const module=await component('components/VirtualSegments.tsx',{'react':{useRef:initial=>({current:refs++===0?root:initial}),useState:initial=>[initial,update=>{const previous=values.at(-1)??initial;values.push(typeof update==='function'?update(previous):update);} ],useLayoutEffect:effect=>effects.push(effect)},'react/jsx-runtime':jsx,'@tanstack/react-virtual':{useVirtualizer:()=>({getTotalSize:()=>160,getVirtualItems:()=>[]})},'../virtual-segments':{segmentRange:()=>[]}}, {ResizeObserver:class{constructor(callback){resizes.push(callback);}observe(){}disconnect(){}},MutationObserver:class{constructor(callback){mutations.push(callback);}observe(){}disconnect(){}},requestAnimationFrame:callback=>{callback();return 1;},cancelAnimationFrame(){}});
  module.VirtualSegments({segments:[{id:'segment'}],children:()=>null});const cleanup=effects[0]();assert.equal(values.at(-1),100);
  top=200;mutations[0]();assert.equal(values.at(-1),200,'same segment count but taller preceding notice');
  top=260;resizes[0]();assert.equal(values.at(-1),260,'width changes may wrap preceding text');cleanup();
});
