import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {transform} from 'esbuild';

const code=(await transform(await readFile(new URL('../apps/web/src/components/FeedbackNotice.tsx',import.meta.url),'utf8'),{loader:'tsx',jsx:'automatic',format:'cjs'})).code;
function notice(storage){
  const slots=[];let cursor=0;
  const jsx=(type,props)=>({type,props}),exports={};
  const sandbox={exports,module:{exports},localStorage:storage,require:name=>name==='react'?{useState:initial=>{const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return [slots[index],value=>{slots[index]=value;}];}}:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:{Toast:'toast'}};
  vm.runInNewContext(code,sandbox);
  return props=>{cursor=0;return sandbox.module.exports.FeedbackNotice(props);};
}

test('a floating processing failure keeps its action without reserving document space',()=>{
  const run=()=>{},shown=notice()({message:'整理未完成',inline:false,action:{label:'重新整理',run}});
  assert.equal(shown.props.inline,false);
  assert.equal(shown.props.persistent,true);
  assert.equal(shown.props.action.run,run);
});

test('dismissing a warning survives refresh and transient processing states until a new notice identity',()=>{
  const render=notice(),props={message:'语音处理暂时受阻。',open:true};
  const shown=render(props);assert.equal(shown.props.persistent,true);assert.equal(shown.props.warning,true);
  shown.props.dismiss();assert.equal(render(props),null);
  assert.equal(render({...props,open:false}),null);
  assert.equal(render({...props,open:true,message:props.message+'音频仍在保存期内。'}),null);
  assert.notEqual(notice()(props),null,'an explicitly reopened/new notice may show again');
});

test('acknowledging a processing incident survives app remount, while another incident and explicit reopen remain visible', () => {
  const saved=new Map(),storage={getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)};
  const props={message:'语音处理未完成。',dismissalKey:'record-a:failure-a'};
  const first=notice(storage)(props);assert.ok(first);first.props.dismiss();
  assert.equal(notice(storage)(props),null,'a new mounted app must respect the acknowledged incident');
  assert.ok(notice(storage)({...props,dismissalKey:'record-a:failure-b'}),'a new failure stays visible');
  assert.ok(notice(storage)({...props,forceOpen:true}),'the warning icon can reopen an acknowledged incident');
});

test('unavailable notice storage never blocks rendering or dismissal', () => {
  const storage={getItem(){throw Error('storage disabled');},setItem(){throw Error('storage disabled');}};
  const render=notice(storage),props={message:'处理未完成',dismissalKey:'failure'};
  const first=render(props);assert.ok(first);first.props.dismiss();assert.equal(render(props),null);
});

import { createRecord, addSource, publicRecord } from '../packages/records/src/record.mjs';

test('processing incident identity is stable across refreshes but changes for explicit retry and different error', () => {
  const record=createRecord('fixture'),source=addSource(record,{kind:'microphone'});
  source.asr={state:'failed',error:'doubao_asr_45000292'};record.transcription='failed';
  const first=publicRecord(record).transcriptionIssue;
  assert.equal(first.code,'doubao_asr_45000292');
  record.transcriptRevision++;record.notesRevision++;
  assert.equal(publicRecord(record).transcriptionIssue.identity,first.identity,'unrelated content updates must not reopen a warning');
  record.transcriptionRetryVersion=1;
  assert.notEqual(publicRecord(record).transcriptionIssue.identity,first.identity,'an explicit retry starts another incident');
  const second=publicRecord(record).transcriptionIssue.identity;
  source.asr.error='provider_unauthorized';assert.notEqual(publicRecord(record).transcriptionIssue.identity,second);
  source.asr={state:'completed'};assert.equal(publicRecord(record).transcriptionIssue,undefined);
});

test('processing notices float by default instead of shifting the meeting layout',()=>{
 const shown=notice()({message:'纪要服务暂不可用'});
 assert.equal(shown.props.inline,false);
});
