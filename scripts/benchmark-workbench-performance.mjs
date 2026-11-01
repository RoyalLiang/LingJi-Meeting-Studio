import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createRepository } from '../services/records/src/repository.mjs';
import { exportMinutesMarkdown } from '../services/records/src/markdown-export.mjs';

const samples=5,count=3000,segments=Array.from({length:count},(_,index)=>({id:`s${index}`,revision:1,text:`Synthetic source ${index}: review the delivery and confirm the next step.`,startMs:index*1000}));
const items=segments.map(segment=>({text:`Decision ${segment.id}`,evidence:[{segmentId:segment.id,revision:1}]}));
const record={id:'fixture',title:'Synthetic minutes performance fixture',capture:'completed',notes:'',segments,minutes:{title:'Synthetic minutes performance fixture',revision:1,transcriptRevision:1,edited:true,evidenceSnapshot:segments,sections:[{heading:'Decisions',items}],actions:[]}};
const measure=async action=>{await action();const times=[];let value;for(let index=0;index<samples;index++){const started=performance.now();value=await action();times.push(performance.now()-started);}times.sort((a,b)=>a-b);return {medianMs:times[Math.floor(times.length/2)],maxMs:times.at(-1),bytes:Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value))};};
const markdown=exportMinutesMarkdown(record);assert.match(markdown,/s2999@1/);const hash=createHash('sha256').update(markdown).digest('hex');
const root=await mkdtemp(join(tmpdir(),'lingji-perf-')),repo=await createRepository({root,databaseUrl:''});
try{
  for(let index=0;index<80;index++)await repo.insert({id:`export-${index}`,kind:'feishu-export',owner:'fixture-owner',createdAt:index,status:'draft',title:`Synthetic export ${index}`,markdown:'Synthetic private source. '.repeat(8000)});
  const result={fixture:{segments:count,exportDrafts:80,samples},markdown:{...await measure(()=>exportMinutesMarkdown(record)),sha256:hash},
    fullList:await measure(()=>repo.list('feishu-export')),metadataList:await measure(()=>repo.listMetadata('feishu-export','fixture-owner',['title','status','createdAt']))};
  const metadata=await repo.listMetadata('feishu-export','fixture-owner',['title','status']);assert.equal(metadata.length,80);assert.ok(metadata.every(item=>!('markdown'in item)));assert.equal((await repo.listMetadata('feishu-export','other',['title'])).length,0);
  result.metadataList.speedup=result.fullList.medianMs/result.metadataList.medianMs;result.metadataList.byteReduction=1-result.metadataList.bytes/result.fullList.bytes;
  if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await repo.close();await rm(root,{recursive:true,force:true});}
