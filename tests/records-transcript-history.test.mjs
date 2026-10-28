import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vm from 'node:vm';
import {build,transform} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const source=await readFile(new URL('../apps/web/src/components/Transcript.tsx',import.meta.url),'utf8');
const record={id:'large',segments:Array.from({length:3000},(_,i)=>({id:String(i),revision:1,startMs:i*1000,speaker:'说话人 1',text:`会议内容 ${i}`})),sources:[]};
test('closed history defers thousands of transcript nodes without losing edit state on collapse',async()=>{
  let loaded=false;
  const box={memo:component=>component,module:{exports:{}},useState:()=>[loaded,value=>{loaded=value;}],CorrectionSuggestions:()=>null,TextAlignLeft:()=>null};
  box.React={createElement:(tag,props,...children)=>({tag,props,children})};
  const code=(await transform(source.replace(/^import .*$/gm,''),{loader:'tsx',format:'cjs'})).code;
  vm.runInNewContext(code,box);
  const props={record,save:async()=>true,changed:()=>{}},render=()=>box.module.exports.TranscriptHistory(props);
  const closed=render();assert.equal(closed.tag,'details');assert.equal(closed.children[1],false);
  assert.equal(closed.children[0].props['aria-label'],'逐字记录与纠错 · 3000 段');
  assert.equal(closed.children[0].props.title,'逐字记录与纠错 · 3000 段');
  closed.props.onToggle({currentTarget:{open:true}});
  const opened=render(),children=opened.children[1].children;
  assert.equal(children[1].props.record,record);assert.equal(children[1].props.save,props.save);
  opened.props.onToggle({currentTarget:{open:false}});
  assert.equal(loaded,true,'collapsing must retain the mounted transcript and its unsaved draft');
  assert.equal(render().children[1].children[1].props.record,record);
});
test('real closed history renders a summary only for a 3000-segment meeting',async()=>{
  const compiled=await build({entryPoints:['apps/web/src/components/Transcript.tsx'],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/jsx-runtime','react-dom']});
  const mod={exports:{}};
  vm.runInNewContext(compiled.outputFiles[0].text,{module:mod,exports:mod.exports,require:createRequire(resolve('package.json')),console});
  const html=renderToStaticMarkup(React.createElement(mod.exports.TranscriptHistory,{record,save:async()=>true,changed:()=>{}}));
  assert.match(html,/逐字记录与纠错 · 3000 段/);
  assert.doesNotMatch(html,/segment-|会议内容|重新校对/);
  assert.ok((html.match(/<[^/!]/g)||[]).length<8,'closed history must remain a small icon control');
  assert.doesNotMatch(html,/>逐字记录与纠错/);
});
