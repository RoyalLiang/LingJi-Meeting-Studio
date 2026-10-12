// Isolated synthetic read-path comparison; never loads .env, providers or business data.
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir,cpus} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord,emit,publicRecord} from '../packages/records/src/record.mjs';
delete process.env.RECORD_S3_BUCKET;
const root=await mkdtemp(join(tmpdir(),'record-feed-bench-')),repo=await createRepository({root,databaseUrl:''});
try{
  const record=createRecord('synthetic',{title:'Synthetic 60 minute dual source'});record.gcAt=Date.now();
  for(let source=0;source<2;source++){
    const id=randomUUID(),epoch=randomUUID(),sessionId=randomUUID();record.sources.push({id,epoch,sessionId,kind:source?'display':'microphone',watermark:3599,stopped:false,lastSequence:null});
    for(let sequence=0;sequence<3600;sequence++){record.chunks.push({key:`${id}:${epoch}:${sequence}`,sourceId:id,epoch,sessionId,sequence,sampleOffset:sequence*16000,sampleCount:16000,sampleRate:16000,digest:'a'.repeat(64),state:'done',acceptedAt:Date.now()});if(sequence%5===0)record.segments.push({id:randomUUID(),revision:1,sourceId:id,startMs:sequence*1000,endMs:(sequence+5)*1000,text:'Synthetic transcript '.repeat(8)});}
  }
  record.transcriptRevision=1440;emit(record,'synthetic');await repo.insert(record);const after=record.cursor;
  const started=performance.now();await repo.change(record.id,r=>{r.segments[0].text+=' edited';r.segments[0].revision++;r.transcriptRevision++;emit(r,'transcript.edited',{});});const writeMs=performance.now()-started;
  async function measure(operation){const times=[];let bytes;for(let i=0;i<23;i++){const start=performance.now();const value=await operation(),duration=performance.now()-start;bytes=Buffer.byteLength(JSON.stringify(value));if(i>=3)times.push(duration);}times.sort((a,b)=>a-b);return{samples:20,p50Ms:times[9],p95Ms:times[18],p99Ms:times[19],bytes};}
  const fullPoll=await measure(()=>repo.get(record.id)),feedPoll=await measure(()=>repo.eventsAfter(record.id,after)),snapshot=publicRecord(await repo.get(record.id));
  const fanout=[];
  for(const readers of [1,5,20])fanout.push({readers,full:await measure(()=>Promise.all(Array.from({length:readers},()=>repo.get(record.id)))),feed:await measure(()=>Promise.all(Array.from({length:readers},()=>repo.eventsAfter(record.id,after))))});
  const output={at:new Date().toISOString(),fanout,node:process.version,cpu:cpus()[0].model,scenario:'60m dual source, 7200 receipts, 1440 transcript segments, one edit; warm SQLite, 20 samples',fullPoll,feedPoll,writeMs,snapshotBytes:Buffer.byteLength(JSON.stringify(snapshot)),deltaBytes:Buffer.byteLength(JSON.stringify((await repo.eventsAfter(record.id,after)).events[0])),limits:'Local synthetic read comparison; excludes network, browser render, production concurrency and PG/S3. Projection maintenance adds write CPU and storage.'};
  if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output,null,2));
}finally{await repo.close();await rm(root,{recursive:true,force:true});}
