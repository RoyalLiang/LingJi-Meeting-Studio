import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';import {transform} from 'esbuild';
async function compile(path,require){const source=await readFile(new URL('../'+path,import.meta.url),'utf8'),code=(await transform(source,{loader:path.endsWith('tsx')?'tsx':'ts',format:'cjs',jsx:'automatic'})).code,module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,require,structuredClone,DOMException,Date,AbortController,setTimeout});return module.exports;}
test('settings cache coalesces reads, rejects stale auth and never revives pre-save settings',async()=>{
 const {createSettingsCache}=await compile('apps/web/src/settings-cache.ts');let generation=1,calls=0,finish;
 const cache=createSettingsCache(()=>generation),fetcher=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
 const controller=new AbortController(),first=cache.read('/settings/providers',fetcher,controller.signal),second=cache.read('/settings/providers',fetcher);controller.abort();await assert.rejects(first);finish({value:'old'});assert.equal((await second).value,'old');assert.equal(calls,1);
 cache.invalidate();const stale=cache.read('/settings/providers',fetcher);cache.invalidate();finish({value:'stale'});await stale;const fresh=cache.read('/settings/providers',fetcher);finish({value:'saved'});assert.equal((await fresh).value,'saved');assert.equal(calls,3);
 cache.invalidate();const oldAccount=cache.read('/settings/providers',fetcher);generation++;finish({value:'other-account'});await assert.rejects(oldAccount,{name:'AbortError'});
});
test('checking updates does not start downloading; download and installation are explicit separate actions',async()=>{
 const jsx=(type,props)=>({type,props:props||{}}),proxy=new Proxy({},{get:(_,name)=>name});
 const {ClientUpdateActions}=await compile('apps/web/src/components/ClientUpdates.tsx',id=>id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='react'?{useState:()=>[false,()=>{}]}:id.endsWith('package.json')?{version:'test'}:proxy);
 const nodes=tree=>!tree||typeof tree!=='object'?[]:[tree,...[tree.props?.children].flat(Infinity).flatMap(nodes)];let check=0,download=0,install=0;
 for(const phase of ['idle','available','ready']){const tree=ClientUpdateActions({updates:{native:true,status:{phase},check:()=>check++,download:()=>download++,install:()=>install++}}),buttons=nodes(tree).filter(node=>node.type==='Button');buttons[0].props.onClick();assert.equal(check,['idle','available','ready'].indexOf(phase)+1);if(phase==='available')buttons[1].props.onClick();if(phase==='ready')buttons[1].props.onClick();}
 assert.equal(download,1);assert.equal(install,1);
});

test('native download denial retries with a fresh URL through the same button and ignores stale results',async()=>{
 const source=await readFile(new URL('../apps/web/src/components/ui.tsx',import.meta.url),'utf8');
 const code=(await transform(source,{loader:'tsx',format:'cjs',jsx:'automatic'})).code;
 const states=[],effects=[],refs=[];let slot=0,ref=0,effect=0,listener,requests=0,serial=0;const clicked=[],revoked=[];
 const jsx=(type,props)=>({type,props:props||{}}),module={exports:{}};
 const hooks={useState(initial){const i=slot++;if(!(i in states))states[i]=initial;return [states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value;}];},useRef(initial){const i=ref++;return refs[i]||= {current:initial};},useCallback:fn=>fn,useEffect(fn,deps){const i=effect++,old=effects[i];if(old&&deps.every((v,n)=>v===old.deps[n]))return;old?.cleanup?.();effects[i]={deps,run:fn};}};
 const sandbox={module,exports:module.exports,require:id=>id==='react'?hooks:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@tauri-apps/api/core'?{isTauri:()=>true}:id==='@tauri-apps/api/event'?{listen:async(_event,fn)=>{listener=fn;return()=>{};}}:id==='../downloads'?{fetchDownload:async()=>{requests++;return {blob:new Blob(['minutes']),filename:'minutes.md'};}}:{},URL:{createObjectURL:()=>`blob:attempt-${++serial}`,revokeObjectURL:url=>revoked.push(url)},Blob,AbortController,clearTimeout,window:{setTimeout},document:{createElement:()=>({href:'',click(){clicked.push(this.href);},remove(){}}),body:{append(){}}}};
 vm.runInNewContext(code,sandbox);
 const render=()=>{slot=ref=effect=0;const tree=module.exports.Download({href:'/api/export',children:'下载'});for(const e of effects)if(e.run){const run=e.run;e.run=null;e.cleanup=run();}return tree;};
 const nodes=tree=>!tree||typeof tree!=='object'?[]:[tree,...[tree.props?.children].flat(Infinity).flatMap(nodes)];
 let tree=render();await Promise.resolve();tree=render();
 const click=async()=>{nodes(tree).find(n=>n.type===module.exports.Button).props.onClick();await new Promise(resolve=>setImmediate(resolve));tree=render();};
 await click();assert.equal(requests,1);listener({payload:{url:clicked[0],success:false}});tree=render();
 assert.equal(nodes(tree).find(n=>n.type===module.exports.Button).props.disabled,false);
 assert.equal(nodes(tree).some(n=>n.type==='a'),false);
 await click();assert.equal(requests,2);assert.notEqual(clicked[1],clicked[0]);
 listener({payload:{url:clicked[0],success:true}});tree=render();assert.equal(nodes(tree).find(n=>n.type===module.exports.Button).props.disabled,true);
 listener({payload:{url:clicked[1],success:true}});tree=render();assert.equal(nodes(tree).find(n=>n.type===module.exports.Button).props.disabled,false);
 assert.ok(revoked.includes(clicked[0]));for(const e of effects)e.cleanup?.();
});
