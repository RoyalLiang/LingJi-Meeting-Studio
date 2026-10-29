import { build } from 'esbuild';
import { cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..'), output=resolve(root,'apps/site/dist');
await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
await cp(resolve(root,'apps/site/public'),output,{recursive:true});
await Promise.all(['worker','publish'].map(name=>build({entryPoints:[resolve(root,`apps/site/src/${name}.mjs`)],outfile:resolve(output,name==='worker'?'_worker.js':'publish.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'eof'})));
await writeFile(resolve(output,'_routes.json'),JSON.stringify({version:1,include:['/*'],exclude:[]}));
console.log('Cloudflare Pages build: apps/site/dist');
