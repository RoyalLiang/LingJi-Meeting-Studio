import { telemetry } from './telemetry.mjs';
import { randomUUID } from 'node:crypto';
import { commitSpeakerTurns, finishSpeakerSource, updateTranscriptPreview } from '../../../packages/records/src/speakers.mjs';
import { emit } from '../../../packages/records/src/record.mjs';
import { createDoubaoSpeakerStream } from './doubao.mjs';
import { canRecoverSpeechSource, canStartSpeechSource, retryableSpeechError } from './asr-recovery.mjs';

const owners=new WeakMap();
function streamsFor(repo){if(!owners.has(repo))owners.set(repo,new Map());return owners.get(repo);}
export function closeSpeakerStreams(repo,recordId){const streams=streamsFor(repo);for(const [key,entry] of streams){if(!recordId || entry.recordId===recordId){entry.client.close();streams.delete(key);}}}

// Short ticks retain connection ownership without blocking other records or model lanes.
export async function processSpeakerSources(repo,candidate,config,createStream=createDoubaoSpeakerStream){
  const streams=streamsFor(repo);
  async function processSource(source) {
    if(source.asr?.state==='completed' || (!candidate.chunks.some(c=>c.sourceId===source.id && c.state!=='done') && !source.asr))return;
    const key=`${candidate.id}:${source.id}`;
    let entry=streams.get(key);
    if(entry && entry.busy)return;
    if(entry && (source.asr?.fence!==entry.fence || candidate.generation!==entry.generation)){entry.client.close();streams.delete(key);entry=null;}
    if(!entry){
      if(!canStartSpeechSource(candidate,source))return;
      const limit=Math.max(1,Math.min(32,Number(process.env.RECORD_ASR_MAX_STREAMS||8)||8));
      // Leave room for a new meeting while older saved audio recovers.
      const capacity=candidate.capture==='recording' && !source.stopped ? limit : Math.max(1,limit-2);
      if(streams.size>=capacity)return;
      streams.set(key,{recordId:candidate.id,busy:true,client:{close(){}}});
      let claim;
      try { await repo.change(candidate.id,r=>{
        const current=r.sources.find(s=>s.id===source.id),asr=current.asr;
        if(streams.size>limit || !canStartSpeechSource(r,current))return;
        // A recovered connection must also remain claimable after a worker restart.
        if(canRecoverSpeechSource(r,current))for(const chunk of r.chunks.filter(c=>c.sourceId===source.id && c.state!=='done')){chunk.attempts=0;delete chunk.retryAt;}
        r.speakerOriginSourceId ||= source.id;
        current.asr={state:'running',fence:randomUUID(),lease:Date.now()+90000,attempts:asr?.attempts||0,lastFedSequence:-1,speakerMap:{},mayAllocate:r.speakerOriginSourceId===source.id && !r.speakers?.length && !r.segments.some(s=>s.sourceId===source.id)};
        r.transcription=r.sources.some(s=>s.asr?.state==='failed')?'blocked':'processing';
        // Only the very first connection may allocate identities; reconnects must anchor to prior audio.
        if(asr && !r.speakers?.length && r.speakerOriginSourceId===source.id)current.asr.mayAllocate=true;
        claim={recordId:r.id,sourceId:source.id,fence:current.asr.fence,generation:r.generation,language:r.language};
      }); } catch(error) { streams.delete(key);throw error; }
      if(!claim){streams.delete(key);return;}
      let client;
      const onUpdate=state=>{
        if(!entry || Date.now()-(entry.lastPreviewAt||0)<150)return;
        entry.lastPreviewAt=Date.now();
        if(!entry.firstPreview){entry.firstPreview=true;telemetry.event('asr.first-text',{recordId:candidate.id,sourceId:source.id,durationMs:state.runtime?.firstTextMs});}
        entry.previewPending=structuredClone({preview:state.preview,runtime:state.runtime||{}});
        if(entry.previewWork)return;
        entry.previewWork=(async()=>{
          while(entry.previewPending){
            const next=entry.previewPending;entry.previewPending=null;
            await repo.change(candidate.id,r=>updateTranscriptPreview(r,source.id,entry.fence,next.preview,next.runtime,entry.generation));
          }
        })().catch(()=>{}).finally(()=>{entry.previewWork=null;});
      };
      try { client=createStream(claim.language,config,{onUpdate}); } catch(error) { client={state:{error},ready:Promise.resolve(),close(){}}; }
      entry={...claim,client,busy:false};streams.set(key,entry);
    }
    entry.busy=true;
    try{
      await entry.client.ready;
      let active=await repo.get(candidate.id),current=active?.sources.find(s=>s.id===source.id);
      if(active.deleted || active.generation!==entry.generation || current?.asr?.fence!==entry.fence){entry.client.close();streams.delete(key);return;}
      if(entry.client.state.error)throw entry.client.state.error;
      await repo.change(candidate.id,r=>{const s=r.sources.find(s=>s.id===source.id);if(!r.deleted && s.asr?.fence===entry.fence)s.asr.lease=Date.now()+90000;});
      const chunk=active.chunks.find(c=>c.sourceId===source.id && c.sequence===current.asr.lastFedSequence+1 && c.sequence<=current.watermark);
      if(chunk && !current.asr.ended){
        await entry.client.write(await repo.readAudio(chunk.object));
        await repo.change(candidate.id,r=>{
          const s=r.sources.find(s=>s.id===source.id);if(r.deleted || r.generation!==entry.generation || s.asr?.fence!==entry.fence)return;
          const c=r.chunks.find(c=>c.key===chunk.key);c.state='streaming';s.asr.lastFedSequence=chunk.sequence;
        });
      }
      active=await repo.get(candidate.id);current=active.sources.find(s=>s.id===source.id);
      if(current.stopped && current.watermark===current.lastSequence && current.asr.lastFedSequence===current.lastSequence && !current.asr.ended){
        await repo.change(candidate.id,r=>{const s=r.sources.find(s=>s.id===source.id);if(!r.deleted && s.asr?.fence===entry.fence)s.asr.ended=true;});entry.client.end();
      }
      await entry.previewWork;
      await repo.change(candidate.id,r=>updateTranscriptPreview(r,source.id,entry.fence,entry.client.state.preview,entry.client.state.runtime||{},entry.generation));
      const turns=entry.client.state.latest;entry.client.state.latest=null;
      if(turns?.length){await repo.change(candidate.id,r=>commitSpeakerTurns(r,source.id,entry.fence,turns,entry.generation));telemetry.event('asr.confirmed',{recordId:candidate.id,sourceId:source.id,durationMs:entry.client.state.runtime?.firstConfirmedMs});}
      if(entry.client.state.error)throw entry.client.state.error;
      if(entry.client.state.complete){
        let finished=false;await repo.change(candidate.id,r=>{finished=finishSpeakerSource(r,source.id,entry.fence,entry.generation);});
        if(!finished)throw Object.assign(new Error('unexpected_asr_completion'),{code:'unexpected_asr_completion'});
        entry.client.close();streams.delete(key);
      }
    }catch(error){
      entry.client.close();streams.delete(key);await entry.previewWork;
      await repo.change(candidate.id,r=>{
        const s=r.sources.find(s=>s.id===source.id);if(r.deleted || r.generation!==entry.generation || s.asr?.fence!==entry.fence)return;
        const attempts=(s.asr.attempts||0)+1;
        Object.assign(s.asr,{state:'failed',preview:null,attempts,error:error.code||'doubao_stream_failed',retryable:retryableSpeechError(error.code||'doubao_stream_failed'),retryAt:Date.now()+Math.min(300000,2000*2**Math.min(attempts,8))});
        if(error.transportCode)s.asr.transportCode=error.transportCode;delete s.asr.lease;
        for(const c of r.chunks.filter(c=>c.sourceId===source.id && c.state!=='done')){c.state='pending';c.attempts=attempts;c.error=s.asr.error;c.retryAt=s.asr.retryAt;delete c.lease;}
        r.transcription=attempts>=5?'failed':'blocked';emit(r,'transcription.blocked',{error:s.asr.error,sourceId:source.id});
      });
    }finally{entry.busy=false;}
  }
  let next=0;
  await Promise.all(Array.from({length:2},async()=>{while(next<candidate.sources.length)await processSource(candidate.sources[next++]);}));
}
