// Request-local references shorten JSON; storage always keeps original IDs and revisions.
export function compactMinutesPayload(job) {
 const reserved=new Set([...job.snapshot.flatMap(s=>[s.id,s.sourceId,s.speakerId]),...(job.liveContext?.items||[]).map(item=>item.id)]);
 function aliases(values,prefix){
  const forward=new Map(),backward=new Map();let next=0;
  for(const value of values){
   if(typeof value!=='string'||value.length<=12||forward.has(value))continue;
   let alias;do{alias=`@${prefix}${next++}`;}while(reserved.has(alias));
   forward.set(value,alias);backward.set(alias,value);
  }
  return {forward,backward};
 }
 const sources=aliases(job.snapshot.map(s=>s.sourceId),'a'),speakers=aliases(job.snapshot.map(s=>s.speakerId),'p'),facts=aliases((job.liveContext?.items||[]).map(item=>item.id),'f');
 const citations=[],indexes=new Map();
 function addCitation(segmentId,revision){const key=JSON.stringify([segmentId,revision]);if(typeof segmentId==='string'&&Number.isSafeInteger(revision)&&!indexes.has(key)){indexes.set(key,citations.length);citations.push({segmentId,revision});}}
 for(const segment of job.snapshot)addCitation(segment.id,segment.revision);
 function collect(value){if(!value||typeof value!=='object')return;if(typeof value.segmentId==='string')addCitation(value.segmentId,value.revision);for(const child of Object.values(value))collect(child);}
 collect(job.liveContext);collect(job.summaries);
 const fields={sourceId:sources,speakerId:speakers,targetId:facts};
 const indexOf=ref=>indexes.get(JSON.stringify([ref.segmentId,ref.revision]));
 function rewrite(value,direction){
  if(Array.isArray(value))return value.map(item=>rewrite(item,direction));
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).map(([key,item])=>{
   if(key==='evidence'&&Array.isArray(item))return [key,item.map(ref=>{
    if(direction==='forward')return ref&&typeof ref==='object'?(indexOf(ref)??rewrite(ref,direction)):ref;
    if(Number.isSafeInteger(ref))return citations[ref]?{...citations[ref]}:ref;
    if(ref&&Number.isSafeInteger(ref.segmentId)&&citations[ref.segmentId]?.revision===ref.revision)return {...citations[ref.segmentId]};
    return rewrite(ref,direction);
   })];
   const field=Object.hasOwn(fields,key)?fields[key]:null;
   return [key,typeof item==='string'&&field?field[direction].get(item)||item:rewrite(item,direction)];
  }));
 }
 const context=job.liveContext?{...job.liveContext,...(job.liveContext.items?{items:job.liveContext.items.map(item=>({...item,id:facts.forward.get(item.id)||item.id}))}:{})}:job.liveContext;
 const payload=rewrite({transcript:job.snapshot.map(segment=>({...segment,id:indexOf({segmentId:segment.id,revision:segment.revision})})),notes:job.notes,context,summaries:job.summaries,stage:job.stage,omittedEvidence:job.omittedEvidence},'forward');
 return {payload,restore:result=>rewrite(result,'backward')};
}
export function compactMinutesSchema(schema){
 if(Array.isArray(schema))return schema.map(compactMinutesSchema);
 if(!schema||typeof schema!=='object')return schema;
 return Object.fromEntries(Object.entries(schema).map(([key,value])=>[key,key==='evidence'&&value?.type==='array'?{type:'array',items:{type:'integer',minimum:0}}:compactMinutesSchema(value)]));
}
