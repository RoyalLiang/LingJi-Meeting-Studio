import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {transform} from 'esbuild';

const code=(await transform(await readFile(new URL('../apps/web/src/components/FeedbackNotice.tsx',import.meta.url),'utf8'),{loader:'tsx',jsx:'automatic',format:'cjs'})).code;
function notice(){
  const slots=[];let cursor=0;
  const jsx=(type,props)=>({type,props}),exports={};
  const sandbox={exports,module:{exports},require:name=>name==='react'?{useState:initial=>{const index=cursor++;if(!(index in slots))slots[index]=initial;return [slots[index],value=>{slots[index]=value;}];}}:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:{Toast:'toast'}};
  vm.runInNewContext(code,sandbox);
  return props=>{cursor=0;return sandbox.module.exports.FeedbackNotice(props);};
}

test('dismissing a warning survives refresh and transient processing states until a new notice identity',()=>{
  const render=notice(),props={message:'语音处理暂时受阻。',open:true};
  const shown=render(props);assert.equal(shown.props.persistent,true);assert.equal(shown.props.warning,true);
  shown.props.dismiss();assert.equal(render(props),null);
  assert.equal(render({...props,open:false}),null);
  assert.equal(render({...props,open:true,message:props.message+'音频仍在保存期内。'}),null);
  assert.notEqual(notice()(props),null,'an explicitly reopened/new notice may show again');
});
