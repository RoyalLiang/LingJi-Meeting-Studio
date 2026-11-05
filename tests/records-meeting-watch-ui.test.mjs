import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
const result=await build({entryPoints:['apps/web/src/useMeetingAutomation.ts'],bundle:true,write:false,format:'cjs',platform:'node',external:['react','@tauri-apps/api/core','@tauri-apps/api/event']});
function harness({reject=true}={}){
  const errors=[],calls=[],effects=[];let listener;
  const modules={react:{useRef:value=>({current:value}),useState:()=>[undefined,()=>{}],useEffect:effect=>effects.push(effect)},'@tauri-apps/api/core':{isTauri:()=>true,invoke:async(name,args)=>{calls.push({name,args});if(reject)throw new Error('audio monitor unavailable');}},'@tauri-apps/api/event':{listen:async(_name,callback)=>{listener=callback;calls.push({name:'listen'});return()=>{};}}};
  const sandbox={exports:{},module:{exports:{}},require:name=>modules[name],crypto:{randomUUID:()=> 'test-token'},queueMicrotask,console};vm.runInNewContext(result.outputFiles[0].text,sandbox);
  const run=config=>{sandbox.module.exports.useMeetingAutomation(config,{id:'',recording:false,paused:false,busy:false},{start:async()=>undefined,stop:async()=>false,error:value=>errors.push(value)});return effects.at(-1)();};
  return {errors,calls,run,sample:payload=>listener({payload:{token:'test-token',sampledAt:Date.now(),input:false,output:false,...payload}})};
}
test('first settings save never starts disabled audio automation or raises an audio error',async()=>{
  for(const config of [undefined,{enabled:false,browser:true,feishu:true}]){
    const state=harness(),stop=state.run(config);await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(state.errors,[],'disabled automation cannot report failure to enable');
    assert.ok(!state.calls.some(call=>call.name==='listen'),'disabled automation must not register a listener');stop?.();
  }
});
test('an explicitly enabled audio automation still reports native configuration errors',async()=>{
  const state=harness(),stop=state.run({enabled:true,browser:true,feishu:true});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(state.errors.length,1);assert.match(state.errors[0],/音频调用监听/);stop?.();
});

test('a transient first audio sample does not raise a settings popup; sustained failures remain visible',async()=>{
  const state=harness({reject:false}),stop=state.run({enabled:true,browser:true,feishu:true});await new Promise(resolve=>setImmediate(resolve));
  await state.sample({error:'audio_activity_unavailable'});assert.deepEqual(state.errors,[]);
  await state.sample({});assert.deepEqual(state.errors,[]);
  for(let i=0;i<3;i++)await state.sample({error:'audio_activity_unavailable'});
  assert.equal(state.errors.length,1);assert.match(state.errors[0],/自动联动已暂停/);
  await state.sample({error:'audio_activity_unavailable'});assert.equal(state.errors.length,1);stop?.();
});
