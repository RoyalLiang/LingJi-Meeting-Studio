import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'..'), output=resolve(root,'apps/site/dist');
await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
await cp(resolve(root,'apps/site/public'),output,{recursive:true});
await Promise.all(['worker','publish','encrypted-reader','manage'].map(async name=>{
  const result=await build({entryPoints:[resolve(root,`apps/site/src/${name==='worker'?'entry':name}.mjs`)],outfile:resolve(output,name==='worker'?'_worker.js':`${name}.js`),bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'eof',metafile:true});
  if(name==='worker')assert.deepEqual(Object.values(result.metafile.outputs)[0].exports,['default'],'Pages entry must export only its handler.');
}));
const versions=await Promise.all(['landing.css','landing.js','downloads.js'].map(async name=>[name,createHash('sha256').update(await readFile(resolve(output,name))).digest('hex').slice(0,12)]));
for(const name of await readdir(output)){
  if(!name.endsWith('.html'))continue;
  let html=await readFile(resolve(output,name),'utf8');
  for(const [asset,version] of versions)html=html.replaceAll(`"/${asset}"`,`"/${asset}?v=${version}"`);
  await writeFile(resolve(output,name),html);
}
const landing=await readFile(resolve(output,'index.html'),'utf8');
for(const [asset,version] of versions)assert.ok(landing.includes(`"/${asset}?v=${version}"`),'Landing assets must use content versions to replace cached code.');
await writeFile(resolve(output,'_routes.json'),JSON.stringify({version:1,include:['/*'],exclude:[]}));
console.log('Cloudflare Pages build: apps/site/dist');
