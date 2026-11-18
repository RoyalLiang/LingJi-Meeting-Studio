import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {transform} from 'esbuild';

async function component(file,name,request=async()=>({})) {
  const source=await readFile(new URL('../apps/web/src/components/'+file,import.meta.url),'utf8');
  const code=(await transform(source,{loader:'tsx',jsx:'automatic',format:'cjs'})).code;
  const slots=[],effects=[];let cursor=0;
  const changed=(a,b)=>!a||!b||a.length!==b.length||a.some((value,i)=>!Object.is(value,b[i]));
  const react={
    useId:()=>`field-${cursor++}`,
    useState:value=>{const i=cursor++;if(!(i in slots))slots[i]=typeof value==='function'?value():value;return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},
    useRef:value=>{const i=cursor++;return slots[i]??={current:value};},
    useCallback:(fn,deps)=>{const i=cursor++;if(!slots[i]||changed(slots[i].deps,deps))slots[i]={fn,deps};return slots[i].fn;},
    useEffect:(fn,deps)=>{const i=cursor++,previous=slots[i];if(!previous||changed(previous.deps,deps))effects.push(()=>{previous?.cleanup?.();slots[i]={deps,cleanup:fn()};});},
    lazy:()=> 'Lazy',Suspense:'Suspense'
  };
  const jsx=(type,props)=>({type,props}),exports={};
  const sandbox={exports,module:{exports},AbortController,document:{querySelector:()=>null},require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='../api'?{api:request,messageOf:error=>error.message}:new Proxy({},{get:(_target,key)=>String(key)})};
  vm.runInNewContext(code,sandbox);
  return props=>{cursor=0;const tree=sandbox.module.exports[name](props);effects.splice(0).forEach(fn=>fn());return tree;};
}
function nodes(tree){return !tree||typeof tree!=='object'?[]:[tree,...[tree.props?.children].flat(Infinity).flatMap(nodes)];}
function words(tree){return typeof tree==='string'?tree:!tree||typeof tree!=='object'?'':[tree.props?.children].flat(Infinity).map(words).join('');}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const settings={mode:'manual',url:'http://127.0.0.1:7890',username:'fixture-user',hasPassword:true};

async function network(request) {
  let save;const props={registerSave:value=>{save=value;}};
  const render=await component('NetworkSettings.tsx','NetworkSettings',request);
  render(props);await tick();
  return {render:()=>render(props),save:()=>save()};
}

test('first settings tab registers network in the shared save chain without a separate network tab',async()=>{
  const render=await component('SettingsPage.tsx','SettingsPage');
  const tree=render({boot:{canConfigure:true,providers:{asrProvider:'sensevoice-local',minutesMode:'asr-llm'}},updates:{},record:null});
  const all=nodes(tree),provider=all.find(n=>n.type==='ProviderSettings'),network=all.find(n=>n.type==='NetworkSettings');
  assert.ok(network?.props.registerSave);assert.equal(network.props.actionsTarget,undefined);
  assert.ok(!all.some(n=>n.type==='button'&&words(n)==='网络'));
  const order=[];network.props.registerSave(async()=>{order.push('network');});
  all.find(n=>n.type==='Lazy').props.registerSave(async()=>{order.push('backup');});
  all.find(n=>n.type==='VocabularySettings').props.registerSave(async()=>{order.push('vocabulary');});
  await provider.props.beforeSave();assert.deepEqual(order,['network','backup','vocabulary']);
});

test('failed network save stops the shared settings save chain',async()=>{
  const render=await component('SettingsPage.tsx','SettingsPage');
  const all=nodes(render({boot:{canConfigure:true,providers:{}},updates:{},record:null}));
  const order=[];all.find(n=>n.type==='NetworkSettings').props.registerSave(async()=>{order.push('network');throw new Error('proxy_save_failed');});
  all.find(n=>n.type==='Lazy').props.registerSave(async()=>{order.push('backup');});
  await assert.rejects(all.find(n=>n.type==='ProviderSettings').props.beforeSave(),/proxy_save_failed/);
  assert.deepEqual(order,['network']);
});

test('network mode saves preserve the password unless clear is explicitly selected',async()=>{
  const writes=[];const h=await network(async(_path,method='GET',body)=>{
    if(method==='GET')return {...settings};writes.push(JSON.parse(JSON.stringify(body)));return {...settings,mode:body.mode,hasPassword:!body.clearPassword};
  });
  let tree=h.render();assert.ok(!nodes(tree).some(n=>n.type==='form'));
  await h.save();assert.equal(writes.length,0);
  nodes(tree).find(n=>n.type==='Select').props.onChange('direct');h.render();await h.save();
  assert.equal(writes[0].password,'');assert.equal(writes[0].clearPassword,false);
  tree=h.render();nodes(tree).find(n=>n.type==='Select').props.onChange('manual');tree=h.render();
  nodes(tree).find(n=>n.type==='Button'&&words(n)==='清除密码').props.onClick();tree=h.render();
  assert.equal(nodes(tree).find(n=>n.type==='input'&&n.props.type==='password').props.disabled,true);
  await h.save();assert.equal(writes[1].clearPassword,true);
  assert.ok(!nodes(h.render()).some(n=>n.type==='Button'&&words(n)==='清除密码'));
});

test('concurrent shared saves reuse the request and failed proxy writes retain the draft for retry',async()=>{
  let reject,failed=true;const wait=new Promise((_resolve,fail)=>{reject=fail;}),writes=[];
  const h=await network(async(_path,method='GET',body)=>{if(method==='GET')return {...settings};writes.push(JSON.parse(JSON.stringify(body)));return failed?wait:{...settings};});
  let tree=h.render();nodes(tree).find(n=>n.type==='input'&&n.props.type==='password').props.onChange({target:{value:'fixture-draft-secret'}});h.render();
  const first=h.save(),second=h.save();assert.equal(first,second);assert.equal(writes.length,1);
  const errors=Promise.all([assert.rejects(first,/proxy_save_failed/),assert.rejects(second,/proxy_save_failed/)]);reject(new Error('proxy_save_failed'));await errors;
  tree=h.render();assert.equal(nodes(tree).find(n=>n.type==='input'&&n.props.type==='password').props.value,'fixture-draft-secret');
  assert.match(words(nodes(tree).find(n=>n.props?.role==='alert')),/proxy_save_failed/);
  failed=false;await h.save();tree=h.render();assert.equal(writes.length,2);assert.equal(nodes(tree).find(n=>n.type==='input'&&n.props.type==='password').props.value,'');
});
