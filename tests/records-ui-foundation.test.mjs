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
