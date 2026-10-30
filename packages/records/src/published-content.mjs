import { sharedMinutes, sharedSegments } from './shared-content.mjs';

export class ShareContentError extends Error {
  constructor(code = 'invalid_share_content', status = 400) { super(code); this.code = code; this.status = status; }
}
const check = condition => { if (!condition) throw new ShareContentError(); };
const text = (value, max = 100000) => { check(typeof value === 'string' && value.length <= max); return value; };
const list = (value = [], max = 10000) => { check(Array.isArray(value) && value.length <= max); return value; };
const revision = value => { check(Number.isSafeInteger(value) && value >= 0); return value; };
const object = value => { check(value && typeof value === 'object' && !Array.isArray(value)); return value; };
const segment = value => {
  object(value); text(value.id,128); check(value.id && revision(value.revision) > 0);
  check(Number.isFinite(value.startMs) && Number.isFinite(value.endMs) && value.startMs >= 0 && value.endMs >= value.startMs);
  return { id:value.id,revision:value.revision,text:text(value.text,100000),speaker:text(value.speaker ?? '',512),startMs:value.startMs,endMs:value.endMs };
};

export function normalizePublishedContent(input) {
  object(input); check(input.schemaVersion === 1 && ['minutes','full'].includes(input.scope));
  check(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.sourceRecordId));
  const title=text(input.title,5120);check(title.trim());check(typeof input.draft === 'boolean');
  let minutes=null;
  if(input.minutes != null) {
    const source=object(input.minutes), snapshot=list(source.evidenceSnapshot).map(segment);
    const keys=new Set(snapshot.map(s=>JSON.stringify([s.id,s.revision])));check(keys.size===snapshot.length);
    const refs = values => list(values,10000).map(ref=>{object(ref);text(ref.segmentId,128);check(keys.has(JSON.stringify([ref.segmentId,ref.revision])));return {segmentId:ref.segmentId,revision:ref.revision};});
    const item = value => {object(value);return {text:text(value.text),evidence:refs(value.evidence),...(value.topicId!==undefined?{topicId:text(value.topicId,128)}:{}),...(value.label!==undefined?{label:text(value.label,200)}:{})};};
    minutes={title:text(source.title || title,5120),sections:list(source.sections,1000).map(section=>({heading:text(object(section).heading,2000),items:list(section.items,10000).map(item)})),actions:list(source.actions,1000).map(value=>({...item(value),...(value.owner?{owner:text(value.owner,512)}:{}),...(value.due?{due:text(value.due,512)}:{})})),evidenceSnapshot:snapshot};
    if(source.revision!==undefined)minutes.revision=revision(source.revision);
    if(source.transcriptRevision!==undefined)minutes.transcriptRevision=revision(source.transcriptRevision);
    if(source.edited!==undefined){check(typeof source.edited==='boolean');minutes.edited=source.edited;}
    for(const key of ['highlights','decisions','currentDiscussion'])if(source[key]!==undefined)minutes[key]=list(source[key],1000).map(item);
    if(source.topics!==undefined)minutes.topics=list(source.topics,1000).map(value=>{object(value);return {...(value.id?{id:text(value.id,128)}:{}),title:text(value.title,2000),summary:text(value.summary),evidence:refs(value.evidence)};});
    if(source.tables!==undefined)minutes.tables=list(source.tables,100).map(value=>{object(value);const columns=list(value.columns,20).map(c=>text(c,2000));check(columns.length>0);return {title:text(value.title,2000),...(value.topicId?{topicId:text(value.topicId,128)}:{}),columns,rows:list(value.rows,10000).map(row=>{object(row);const cells=list(row.cells,20).map(c=>text(c));check(cells.length===columns.length);return {cells,evidence:refs(row.evidence)};})};});
    if(source.speakerSummaries!==undefined)minutes.speakerSummaries=list(source.speakerSummaries,1000).map(value=>{object(value);return {speaker:text(value.speaker,512),speakerId:null,summary:text(value.summary),evidence:refs(value.evidence)};});
    if(source.visuals!==undefined)minutes.visuals=list(source.visuals,100).map(value=>{object(value);check(['timeline','bar'].includes(value.kind));return {kind:value.kind,title:text(value.title,2000),...(value.topicId?{topicId:text(value.topicId,128)}:{}),...(value.kind==='bar'?{unit:text(value.unit,512)}:{}),entries:list(value.entries,1000).map(entry=>{object(entry);return {label:text(entry.label,2000),...(value.kind==='timeline'?{text:text(entry.text)}:{valueText:text(entry.valueText,512),quote:text(entry.quote || '',10000)}),evidence:refs(entry.evidence)};})};});
    minutes=sharedMinutes(minutes, { includeEvidence: true });
  }
  const segments=input.scope==='full'?list(input.segments).map(segment):[];
  check(minutes || segments.length);
  return {schemaVersion:1,sourceRecordId:input.sourceRecordId,title,scope:input.scope,draft:input.draft,minutes,...(input.scope==='full'?{segments:sharedSegments(segments)}:{})};
}

export function createPublishedContent(record, scope) {
  const minutes=record.capture==='completed'?record.minutes || record.liveMinutes:record.liveMinutes || record.minutes;
  return normalizePublishedContent({schemaVersion:1,sourceRecordId:record.id,title:record.title,scope,draft:!record.minutes || record.capture!=='completed',minutes:sharedMinutes(minutes, { includeEvidence: true }),...(scope==='full'?{segments:sharedSegments(record.segments)}:{})});
}
