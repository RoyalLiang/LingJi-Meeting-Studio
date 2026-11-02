import {execFileSync} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve,dirname,relative} from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {exportMinutesMarkdown} from '../services/records/src/markdown-export.mjs';
import {sharedMinutes} from '../packages/records/src/shared-content.mjs';
const baseline='0abd66e',baseDir=resolve('.agent-runtime/benchmarks/minutes-reading');
await mkdir(baseDir,{recursive:true});
for(const [name,file] of [['markdown','services/records/src/markdown-export.mjs'],['shared','packages/records/src/shared-content.mjs']]){
 let source=execFileSync('git',['show',`${baseline}:${file}`],{encoding:'utf8'});
 source=source.replace(/from '([^']+)'/g,(_,target)=>`from '${pathToFileURL(resolve(dirname(file),target)).href}'`);
 await writeFile(`${baseDir}/baseline-${name}.mjs`,source);
}
const oldMarkdown=(await import(`${pathToFileURL(baseDir).href}/baseline-markdown.mjs`)).exportMinutesMarkdown;
const oldShared=(await import(`${pathToFileURL(baseDir).href}/baseline-shared.mjs`)).sharedMinutes;
const evidence=[{segmentId:'s',revision:1}],topics=Array.from({length:30},(_,i)=>({id:`t${i}`,title:`合成议题${i}`,summary:`议题${i}的结论`,evidence}));
const sections=topics.map(topic=>({heading:topic.title,items:Array.from({length:20},(_,j)=>({text:`规则${topic.id}-${j}，保留前置条件与异常处理。`,topicId:topic.id,evidence}))}));
for(let i=0;i<40;i++)sections.push({heading:`讨论过程 · 窗口${i}`,items:Array.from({length:100},(_,j)=>({text:`窗口旧草稿${i}-${j}，已由终稿归并。`,label:'过程记录',evidence}))});
const minutes={title:'合成长纪要',revision:1,transcriptRevision:1,edited:false,topics,sections,actions:[],tables:[],evidenceSnapshot:[]};
const record={title:minutes.title,capture:'completed',minutes},before=JSON.stringify(record);
const measure=fn=>{for(let i=0;i<5;i++)fn();const times=[];let output;for(let i=0;i<25;i++){const t=performance.now();output=fn();times.push(performance.now()-t);}times.sort((a,b)=>a-b);return {medianMs:times[12],p95Ms:times[23],bytes:Buffer.byteLength(typeof output==='string'?output:JSON.stringify(output))};};
async function renderer(old){
 const override=new Set(['apps/web/src/components/MinutesViews.tsx','apps/web/src/minutes-views.ts']);
 const output=await build({entryPoints:['apps/web/src/components/MinutesViews.tsx'],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/jsx-runtime','react-dom'],plugins:old?[{name:'fixed-baseline',setup(build){build.onLoad({filter:/\.(tsx|ts)$/},args=>{const file=relative(resolve('.'),args.path).replaceAll('\\','/');if(override.has(file))return {contents:execFileSync('git',['show',`${baseline}:${file}`],{encoding:'utf8'}),loader:file.endsWith('tsx')?'tsx':'ts',resolveDir:dirname(args.path)};});}}]:[]});
 const module={exports:{}};vm.runInNewContext(output.outputFiles[0].text,{module,exports:module.exports,require:createRequire(resolve('package.json')),console});
 return ()=>renderToStaticMarkup(React.createElement(module.exports.MinutesTree,{minutes,cite:()=>{},speakerMap:new Map()}));
}
const oldRender=await renderer(true),newRender=await renderer(false);
const metrics={baseline,node:process.version,fixture:{topics:30,prose:600,process:4000,recordBytes:Buffer.byteLength(before)},markdown:{before:measure(()=>oldMarkdown(record,{includeEvidence:false})),after:measure(()=>exportMinutesMarkdown(record,{includeEvidence:false}))},share:{before:measure(()=>oldShared(minutes)),after:measure(()=>sharedMinutes(minutes))},renderSSR:{before:measure(oldRender),after:measure(newRender)},limits:'Synthetic CPU/size benchmark; SSR is not a browser frame or real audio throughput measurement.'};
assert.equal(JSON.stringify(record),before);
assert.doesNotMatch(exportMinutesMarkdown(record,{includeEvidence:false}),/窗口旧草稿/);
assert.ok(metrics.markdown.after.bytes<metrics.markdown.before.bytes);
assert.ok(metrics.share.after.bytes<metrics.share.before.bytes);
assert.ok(metrics.renderSSR.after.medianMs<metrics.renderSSR.before.medianMs*1.5+2);
await writeFile(`${baseDir}/metrics.json`,JSON.stringify(metrics,null,2)+'\n');
console.log(JSON.stringify(metrics));
