import {randomUUID} from 'node:crypto';
import {digest,emit,editSegments,publicRecord,requireThat} from '../../../packages/records/src/record.mjs';
import {voiceprints,voiceprintEntryId} from './voiceprints.mjs';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const validName=name=>typeof name==='string'&&name.trim().length>0&&name.trim().length<=80&&!/[\u0000-\u001f\u007f]/u.test(name);
const cleanClip=segment=>segment.sourceId!=='text-import'&&!segment.overlappingSpeech&&segment.endMs-segment.startMs>=2000&&segment.endMs-segment.startMs<=30000;
const originActive=(job,record)=>{const origin=job.origin||job.source;return record?.owner===job.owner&&!record.deleted&&Date.parse(record.deleteAt)>Date.now()&&record.segments.some(segment=>segment.id===origin.segmentId&&segment.revision===origin.revision&&segment.personId===job.personId&&segment.speakerConfirmed);};
const cluster=segment=>segment.speakerAnchorId||segment.speakerId||segment.speakerHash;
const retained=record=>record.retainAudio&&!record.audioPurged&&!record.audioCleanup;
const automaticJobId=(source,person)=>{
  const hash=digest(JSON.stringify(['voiceprint-automatic',source,person.id,person.autoLearnKey]));
  return [hash.slice(0,8),hash.slice(8,12),hash.slice(12,16),hash.slice(16,20),hash.slice(20,32)].join('-');
};
export function voiceLearning(repo,{library=voiceprints(repo)}={}){
  async function person(owner,id){const value=await repo.get(id);requireThat(value?.kind==='voice-person'&&value.owner===owner&&!value.deleted,'voiceprint_not_found',404);requireThat(!await library.personDeleted(owner,id),'voiceprint_not_found',404);return value;}
  async function people(owner){
    const [saved,state]=await Promise.all([repo.list('voice-person'),library.list(owner,'all')]),{disabledPeople=[],deletedPeople=[],...bank}=state;
    const disabled=new Set(disabledPeople),deleted=new Set([...deletedPeople,...saved.filter(row=>row.owner===owner&&row.deleted).map(row=>row.id)]);
    bank.entries=bank.entries.filter(entry=>!deleted.has(entry.personId||entry.id));
    const profiles=new Map(saved.filter(row=>row.owner===owner&&!row.deleted&&!deleted.has(row.id)).map(row=>[row.id,{id:row.id,name:row.name,recognitionEnabled:row.recognitionEnabled!==false&&!disabled.has(row.id),automaticLearning:Boolean(row.autoLearnKey)&&!disabled.has(row.id),canAutoLearn:true,samples:0,entries:[]}]));
    for(const entry of bank.entries){const id=entry.personId||entry.id,profile=profiles.get(id)||{id,name:entry.name,recognitionEnabled:!entry.recognitionDisabled&&!disabled.has(id),samples:0,entries:[]};profile.samples++;profile.entries.push(entry);profiles.set(id,profile);}
    const jobs=(await repo.list('voiceprint-job')).filter(row=>row.owner===owner&&profiles.has(row.personId)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(-50);
    return {...bank,people:[...profiles.values()],jobs:jobs.map(({id,personId,status,error})=>({id,personId,status,error}))};
  }
  async function savePerson(owner,input){
    requireThat(uuid.test(input?.id)&&validName(input.name),'invalid_voiceprint_name',400);
    requireThat(!await library.personDeleted(owner,input.id),'voiceprint_not_found',404);
    let value=await repo.get(input.id);
    if(!value){try{await repo.insert({id:input.id,kind:'voice-person',owner,name:input.name.trim(),createdAt:new Date().toISOString()});}catch(error){if(error.code!=='already_exists')throw error;}}
    await repo.change(input.id,row=>{requireThat(row.kind==='voice-person'&&row.owner===owner&&!row.deleted,'voiceprint_not_found',404);row.name=input.name.trim();});
    return person(owner,input.id);
  }
  async function sources(owner,id){
    const profile=(await people(owner)).people.find(profile=>profile.id===id);requireThat(profile,'voiceprint_not_found',404);
    const records=new Map();
    for(const entry of profile.entries)if(entry.source&&!records.has(entry.source.recordId))records.set(entry.source.recordId,await repo.get(entry.source.recordId));
    return {sources:profile.entries.map(entry=>{
      const reference=entry.source,record=records.get(reference?.recordId),segment=record?.segments?.find(segment=>segment.id===reference.segmentId&&segment.revision===reference.revision);
      if(record?.kind!=='record'||record.owner!==owner||record.deleted||!(Date.parse(record.deleteAt)>Date.now())||!segment)return {id:entry.id,available:false};
      return {id:entry.id,available:true,recordId:record.id,title:record.title,startMs:segment.startMs,endMs:segment.endMs,text:segment.text.slice(0,2000),audioAvailable:Boolean(retained(record)),automatic:Boolean(entry.automatic)};
    })};
  }
  async function candidates(owner,id,recordId){
    requireThat((await people(owner)).people.some(profile=>profile.id===id),'voiceprint_not_found',404);
    requireThat(uuid.test(recordId),'invalid_voiceprint_source',400);
    const record=await repo.get(recordId);requireThat(record?.kind==='record'&&record.owner===owner&&!record.deleted&&Date.parse(record.deleteAt)>Date.now(),'record_not_found',404);
    const clips=record.retainAudio&&!record.audioPurged&&!record.audioCleanup?record.segments.filter(segment=>segment.personId===id&&segment.speakerConfirmed&&cleanClip(segment)).slice(0,40):[];
    return {clips:clips.map(({id,revision,startMs,endMs,text})=>({id,revision,startMs,endMs,text:text.slice(0,300)}))};
  }
  async function recognition(owner,id,input){
    requireThat(typeof input?.enabled==='boolean'&&Number.isSafeInteger(input.libraryRevision),'invalid_voiceprint',400);
    requireThat(!input.enabled||input.consent===true,'voiceprint_consent_required',400);
    const state=await people(owner),profile=state.people.find(profile=>profile.id===id);requireThat(profile,'voiceprint_not_found',404);
    requireThat(state.revision===input.libraryRevision,'voiceprint_library_changed',409);
    const stored=await repo.get(id);if(stored)await person(owner,id);
    const banks=(await repo.list('voiceprints')).filter(bank=>bank.owner===owner);
    await repo.changeMany([...(stored?[id]:[]),...banks.map(bank=>bank.id)],rows=>{
      const current=rows.find(row=>row.id===id),global=rows.find(row=>row.kind==='voiceprints'&&row.scope==='all');
      requireThat(!current||current.owner===owner&&!current.deleted,'voiceprint_not_found',404);
      requireThat(global?.revision===input.libraryRevision,'voiceprint_library_changed',409);
      if(current){current.recognitionEnabled=input.enabled;if(!input.enabled)delete current.autoLearnKey;}
      global.disabledPeople=input.enabled?(global.disabledPeople||[]).filter(value=>value!==id):[...new Set([...(global.disabledPeople||[]),id])];
      for(const bank of rows.filter(row=>row.kind==='voiceprints')){let changed=false;for(const entry of bank.entries)if((entry.personId||voiceprintEntryId(bank,entry))===id){entry.recognitionDisabled=!input.enabled;if(input.enabled)entry.consentVersion=2;changed=true;}if(changed&&bank.id!==global.id)bank.revision=(bank.revision||0)+1;}
      global.revision++;
    });
    return people(owner);
  }
  async function automaticLearning(owner,id,input){
    requireThat(typeof input?.enabled==='boolean'&&Number.isSafeInteger(input.libraryRevision),'invalid_voiceprint',400);
    requireThat(!input.enabled||input.consent===true,'voiceprint_consent_required',400);
    const profile=await person(owner,id),state=await people(owner);
    const global=(await repo.list('voiceprints')).find(row=>row.owner===owner&&row.scope==='all');
    await repo.changeMany([profile.id,global.id],rows=>{
      const current=rows.find(row=>row.id===id),bank=rows.find(row=>row.id===global.id);
      requireThat(current.owner===owner&&!current.deleted&&!bank.deletedPeople?.includes(id),'voiceprint_not_found',404);
      requireThat(bank.revision===input.libraryRevision,'voiceprint_library_changed',409);
      if(input.enabled){
        requireThat(current.recognitionEnabled!==false&&!bank.disabledPeople?.includes(id)&&state.people.some(row=>row.id===id&&row.entries.some(entry=>entry.global)),'voiceprint_recognition_required',409);
        current.autoLearnKey ||= randomUUID();
      }else delete current.autoLearnKey;
      bank.revision++;
    });
    return people(owner);
  }
  async function annotate(owner,recordId,input){
    requireThat(uuid.test(recordId)&&uuid.test(input?.segmentId)&&Number.isSafeInteger(input.revision)&&validName(input.name),'invalid_voiceprint_source',400);
    const before=await repo.get(recordId);requireThat(before?.kind==='record'&&before.owner===owner&&!before.deleted&&Date.parse(before.deleteAt)>Date.now(),'record_not_found',404);
    const original=before.segments.find(segment=>segment.id===input.segmentId);requireThat(original?.revision===input.revision,'segment_revision_conflict',409);
    const id=input.personId||input.requestId;requireThat(uuid.test(id),'invalid_voiceprint',400);
    const existing=await repo.get(id);
    const profile=existing?await person(owner,id):await savePerson(owner,{id,name:input.name});
    const label=input.name.trim();
    const banks=(await repo.list('voiceprints')).filter(bank=>bank.owner===owner);
    await repo.changeMany([recordId,...banks.map(bank=>bank.id)],rows=>{
      const record=rows.find(row=>row.id===recordId);
      requireThat(record.owner===owner&&!record.deleted&&Date.parse(record.deleteAt)>Date.now(),'record_not_found',404);
      const selected=record.segments.find(segment=>segment.id===input.segmentId);requireThat(selected?.revision===input.revision,'segment_revision_conflict',409);
      const key=cluster(selected),targets=record.segments.filter(segment=>{
        if(segment.id===selected.id)return !segment.speakerConfirmed||segment.personId!==id||segment.speaker!==label;
        return key&&cluster(segment)===key&&!segment.speakerConfirmed&&!segment.edited;
      });
      if(!targets.length)return;
      editSegments(record,targets.map(segment=>({id:segment.id,revision:segment.revision,text:segment.text,speaker:label})));
      for(const segment of targets){segment.personId=id;segment.speakerConfirmed=true;delete segment.speakerMatch;}
      if(profile.autoLearnKey&&record.capture==='completed'&&retained(record)){
        const matching=['queued','running'].includes(record.voiceMatch?.status)&&!record.voiceMatch.learningOnly;
        record.voiceMatch={status:'queued',revision:record.transcriptRevision,learningOnly:!matching,...(matching?{expiresAt:record.voiceMatch.expiresAt}:{})};
      }
      let removed=false;
      for(const bank of rows.filter(row=>row.kind==='voiceprints')){const count=bank.entries.length;bank.entries=bank.entries.filter(entry=>!targets.some(segment=>entry.source?.recordId===recordId&&entry.source.segmentId===segment.id||entry.origin?.recordId===recordId&&entry.origin.segmentId===segment.id)||(entry.personId||voiceprintEntryId(bank,entry))===id);if(count!==bank.entries.length){bank.revision=(bank.revision||0)+1;removed=true;}}
      const global=rows.find(row=>row.kind==='voiceprints'&&row.scope==='all');if(removed&&global)global.revision=(global.revision||0)+1;
    });
    return publicRecord(await repo.get(recordId));
  }
  async function learn(owner,input){
    requireThat(input?.consent===true&&uuid.test(input.requestId)&&uuid.test(input.personId),'voiceprint_consent_required',400);
    const profile=await person(owner,input.personId);
    const record=await repo.get(input.recordId);requireThat(record?.owner===owner&&!record.deleted&&Date.parse(record.deleteAt)>Date.now(),'record_not_found',404);
    const selected=record.segments.find(segment=>segment.id===input.segmentId);requireThat(selected?.revision===input.revision,'voiceprint_source_changed',409);
    const key=cluster(selected),sample=cleanClip(selected)?selected:record.segments.find(segment=>key&&cluster(segment)===key&&segment.personId===input.personId&&cleanClip(segment));
    const job={id:input.requestId,kind:'voiceprint-job',owner,personId:input.personId,name:profile.name,createdAt:new Date().toISOString(),status:sample?'queued':'waiting',origin:{recordId:record.id,segmentId:selected.id,revision:selected.revision},anchor:cluster(selected),source:{recordId:record.id,segmentId:sample?.id||selected.id,revision:sample?.revision||selected.revision}};
    const existing=await repo.get(job.id);
    if(existing){requireThat(existing.owner===owner&&existing.kind===job.kind&&existing.personId===job.personId&&existing.source.recordId===job.source.recordId&&existing.source.segmentId===job.source.segmentId&&existing.source.revision===job.source.revision,'voiceprint_request_conflict',409);return {id:existing.id,status:existing.status};}
    await repo.insert(job);return {id:job.id,status:job.status};
  }
  async function remove(owner,id){
    requireThat(uuid.test(id),'voiceprint_not_found',404);
    const stored=await repo.get(id),initial=await library.list(owner,'all');
    if(stored)requireThat(stored.kind==='voice-person'&&stored.owner===owner,'voiceprint_not_found',404);
    else requireThat(initial.deletedPeople?.includes(id)||initial.entries.some(entry=>(entry.personId||entry.id)===id),'voiceprint_not_found',404);
    for(let attempt=0;;attempt++){
      const state=await library.list(owner,'all'),banks=(await repo.list('voiceprints')).filter(bank=>bank.owner===owner);
      try{await repo.changeMany([...(stored?[id]:[]),...banks.map(bank=>bank.id)],rows=>{
        const current=rows.find(row=>row.id===id),global=rows.find(row=>row.kind==='voiceprints'&&row.scope==='all');
        requireThat(!current||current.owner===owner,'voiceprint_not_found',404);requireThat(global?.revision===state.revision,'voiceprint_library_changed',409);
        if(current){current.deleted=true;current.recognitionEnabled=false;delete current.autoLearnKey;}
        global.deletedPeople=[...new Set([...(global.deletedPeople||[]),id])];global.disabledPeople=[...new Set([...(global.disabledPeople||[]),id])];
        for(const bank of rows.filter(row=>row.kind==='voiceprints')){let changed=false;for(const entry of bank.entries)if((entry.personId||voiceprintEntryId(bank,entry))===id){entry.recognitionDisabled=true;changed=true;}if(changed&&bank.id!==global.id)bank.revision=(bank.revision||0)+1;}
        global.revision++;
      });break;}catch(error){if(error.code!=='voiceprint_library_changed'||attempt>=2)throw error;}
    }
    for(;;){const bank=await library.list(owner,'all'),entry=bank.entries.find(entry=>(entry.personId||entry.id)===id);if(!entry)break;await library.revoke(owner,'all',entry.id,bank.revision);}
    return people(owner);
  }
  async function run(){
    const pending=await repo.listDueJobs('voiceprint-job');
    for(const job of pending.filter(row=>row.status==='waiting'&&(row.retryAt||0)<Date.now()).slice(0,10)){
      const record=await repo.get(job.source.recordId);let active=true;
      try{await person(job.owner,job.personId);}catch(error){if(error.code!=='voiceprint_not_found')throw error;active=false;}
      if(!active||!originActive(job,record)){await repo.change(job.id,current=>{if(current.status==='waiting'){current.status='cancelled';current.error='voiceprint_source_changed';}});continue;}
      const sample=record.segments.find(segment=>segment.personId===job.personId&&segment.speakerConfirmed&&(job.anchor?cluster(segment)===job.anchor:segment.id===(job.origin||job.source).segmentId)&&cleanClip(segment));
      await repo.change(job.id,current=>{if(current.status!=='waiting')return;if(sample){current.source={recordId:record.id,segmentId:sample.id,revision:sample.revision};current.status='queued';job.status='queued';job.source=current.source;}else current.retryAt=Date.now()+30000;});
    }
    const jobs=pending.filter(row=>row.status==='queued'||row.status==='running'&&row.lease<Date.now()).slice(0,2);
    for(const candidate of jobs){
      const fence=randomUUID();let claimed=false;
      await repo.change(candidate.id,job=>{if(job.status==='queued'||job.status==='running'&&job.lease<Date.now()){job.status='running';job.fence=fence;job.lease=Date.now()+180000;claimed=true;}});
      if(!claimed)continue;
      try{
        const profile=await person(candidate.owner,candidate.personId);
        requireThat(originActive(candidate,await repo.get(candidate.source.recordId)),'voiceprint_source_changed',409);
        for(let attempt=0;;attempt++){
          const bank=await library.list(candidate.owner,'all');
          try{
            requireThat(!candidate.autoLearnKey||bank.entries.some(entry=>entry.personId===profile.id&&entry.global),'voiceprint_auto_learning_stopped',409);
            await library.enroll(candidate.owner,'all',{...candidate.source,origin:candidate.origin||candidate.source,personId:profile.id,name:candidate.name||profile.name,requestId:candidate.id,consent:true,libraryRevision:bank.revision},{autoLearnKey:candidate.autoLearnKey});
            break;
          }
          catch(error){if(error.code!=='voiceprint_library_changed'||attempt>=2)throw error;}
        }
        await repo.change(candidate.id,job=>{if(job.fence===fence){job.status='ready';delete job.error;delete job.lease;}});
      }catch(error){await repo.change(candidate.id,job=>{if(job.fence===fence){job.status=['voiceprint_source_changed','voiceprint_auto_learning_stopped','voiceprint_auto_learning_duplicate'].includes(error.code)?'cancelled':'failed';job.error=/^voiceprint_|^local_asr_/.test(error.code||'')?error.code:'voiceprint_learning_failed';delete job.lease;}});}
    }
  }
  async function queueAutomaticSamples(record,bank){
    if(!bank.available||!retained(record)||!(Date.parse(record.deleteAt)>Date.now()))return;
    const eligible=new Map(bank.people.filter(profile=>profile.automaticLearning&&profile.recognitionEnabled&&profile.samples<8&&profile.entries.some(entry=>entry.global)&&!profile.entries.some(entry=>entry.source?.recordId===record.id)).map(profile=>[profile.id,profile]));
    for(const segment of record.segments){
      if(!eligible.size)break;
      if(!segment.speakerConfirmed||!cleanClip(segment)||!eligible.has(segment.personId))continue;
      eligible.delete(segment.personId);
      const profile=await repo.get(segment.personId);
      if(!profile?.autoLearnKey||profile.deleted||profile.owner!==record.owner)continue;
      const source={recordId:record.id,segmentId:segment.id,revision:segment.revision},id=automaticJobId(source,profile);
      const job={id,kind:'voiceprint-job',owner:record.owner,personId:profile.id,name:profile.name,createdAt:new Date().toISOString(),status:'queued',source,origin:source,autoLearnKey:profile.autoLearnKey};
      try{await repo.insert(job);}catch(error){if(error.code!=='already_exists')throw error;}
    }
  }
  async function matchRecord(candidate){
    const record=await repo.get(candidate.id);if(!record?.voiceMatch||record.capture!=='completed'||record.deleted)return;
    const revision=record.transcriptRevision,fence=randomUUID();let claimed=false;
    await repo.change(record.id,current=>{const job=current.voiceMatch;if(job.status==='queued'||job.status==='running'&&job.lease<Date.now()){Object.assign(job,{status:'running',fence,lease:Date.now()+180000});claimed=true;}});
    if(!claimed)return;
    try{
      const bank=await people(record.owner),groups=new Map(),matches=[];
      await queueAutomaticSamples(record,bank);
      if(!record.voiceMatch.learningOnly)for(const segment of record.segments){const key=cluster(segment);if(key&&!segment.edited&&!segment.speakerConfirmed&&cleanClip(segment)&&!groups.has(key))groups.set(key,segment);}
      if(bank.people.length)for(const [key,segment] of groups){
        const found=await library.match(record.owner,'all',{recordId:record.id,segmentId:segment.id,revision:segment.revision}),byPerson=new Map();
        for(const entry of found.matches){const id=entry.personId||entry.id,old=byPerson.get(id);if(!old||old.similarity<entry.similarity)byPerson.set(id,entry);}
        const ranked=[...byPerson].sort((a,b)=>b[1].similarity-a[1].similarity),best=ranked[0];
        // Candidate threshold 0.6 is only for review; automatic attribution requires a separate margin.
        if(best&&best[1].similarity>=0.86&&best[1].similarity-(ranked[1]?.[1].similarity??0)>=0.12)matches.push({key,id:best[0],entryId:best[1].id});
      }
      const active=await people(record.owner),banks=(await repo.list('voiceprints')).filter(row=>row.owner===record.owner),profiles=(await repo.list('voice-person')).filter(row=>row.owner===record.owner);
      await repo.changeMany([record.id,...banks.map(row=>row.id),...profiles.map(row=>row.id)],rows=>{
        const current=rows.find(row=>row.id===record.id);
        if(current.voiceMatch?.fence!==fence)return;
        if(current.deleted||current.transcriptRevision!==revision){current.voiceMatch.status='skipped';return;}
        if(rows.find(row=>row.kind==='voiceprints'&&row.scope==='all')?.revision!==bank.revision){current.voiceMatch.status='queued';delete current.voiceMatch.lease;return;}
        let changed=false;
        for(const match of matches){const profile=active.people.find(profile=>profile.id===match.id&&profile.entries.some(entry=>entry.id===match.entryId&&entry.global));const saved=rows.find(row=>row.id===match.id);
          const allowed=rows.some(bank=>bank.kind==='voiceprints'&&bank.entries.some(entry=>voiceprintEntryId(bank,entry)===match.entryId&&!entry.recognitionDisabled&&(bank.scope==='all'||entry.consentVersion===2)));
          if(!profile||saved?.deleted||!allowed)continue;
          for(const segment of current.segments)if(cluster(segment)===match.key&&!segment.edited&&!segment.speakerConfirmed&&!segment.overlappingSpeech){const {versions,...previous}=segment;segment.versions=[...(versions||[]),previous].slice(-20);segment.revision++;segment.speaker=saved?.name||profile.name;segment.personId=profile.id;segment.speakerMatch='automatic';changed=true;}
        }
        if(changed){current.transcriptRevision++;emit(current,'transcript.speakers-matched',{transcriptRevision:current.transcriptRevision});}
        Object.assign(current.voiceMatch,{status:'ready',revision:current.transcriptRevision});delete current.voiceMatch.lease;
      });
    }catch(error){await repo.change(record.id,current=>{if(current.voiceMatch?.fence===fence){current.voiceMatch.status='failed';current.voiceMatch.error=error.code||'voiceprint_matching_failed';delete current.voiceMatch.lease;}});}
  }
  return {people,savePerson,sources,candidates,recognition,automaticLearning,annotate,learn,remove,run,matchRecord};
}
