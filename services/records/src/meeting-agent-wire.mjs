// Transport deduplication leaves durable snapshots and their revision hashes unchanged.
export function meetingSourceWire(snapshot){
  if(!snapshot.minutes?.evidenceSnapshot)return snapshot;
  const current=new Map(snapshot.segments.map(segment=>[`${segment.id}:${segment.revision}`,segment]));
  const evidenceSnapshot=snapshot.minutes.evidenceSnapshot.map(({id,revision,text,sourceId,speakerId,speaker,speakerName,startMs,endMs})=>({id,revision,sourceId,speakerId,speaker,speakerName,startMs,endMs,...(current.get(`${id}:${revision}`)?.text===text?{}:{text})}));
  return {...snapshot,minutes:{...snapshot.minutes,evidenceSnapshot}};
}
