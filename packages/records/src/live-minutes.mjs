import { orderMinutesTimelines } from './minutes-quality.mjs';
import { createHash } from 'node:crypto';
// Keep live input incremental without treating prior summaries as new evidence.
const identity = ref => `${ref.segmentId ?? ref.id}:${ref.revision}`;
const uniqueRefs = refs => [...new Map(refs.map(ref => [identity(ref), ref])).values()];
const textKey = text => String(text || '').trim().replace(/\s+/g, ' ');
export const minutesItemId = item => `fact-${createHash('sha256').update(JSON.stringify([item.text, [...item.evidence].map(identity).sort()])).digest('hex').slice(0,20)}`;
export const chronologicalSegments = segments => [...segments].sort((a,b)=>(a.startMs || 0)-(b.startMs || 0) || (a.endMs || 0)-(b.endMs || 0));
function mergeItems(previous = [], incoming = []) {
  const items = new Map();
  for (const item of [...previous, ...incoming]) {
    const key = minutesItemId(item), old = items.get(key);
    items.set(key, old ? { ...old, ...item, evidence: uniqueRefs([...old.evidence, ...item.evidence]) } : { ...item });
  }
  return [...items.values()];
}
export function liveBaseline(record) {
  const previous = record.liveMinutes;
  if (!previous || previous.notesRevision !== record.notesRevision || previous.template === undefined) return null;
  const current = new Set(record.segments.map(identity));
  return previous.evidenceSnapshot?.every(segment => current.has(identity(segment))) ? previous : null;
}
export function liveInput(record, template) {
  const previous = liveBaseline(record);
  const ordered = chronologicalSegments(record.segments);
  if (!previous || previous.template !== template) return ordered;
  const covered = new Set(previous.evidenceSnapshot.map(identity));
  const fresh = ordered.filter(segment=>!covered.has(identity(segment)));
  if (!fresh.length) return ordered.slice(-2);
  const ranges=[],neighbors=new Set();
  ordered.forEach((segment,index)=>{
    if(covered.has(identity(segment)))return;
    if(segment.endMs>segment.startMs){
      const start=segment.startMs-300000,end=segment.endMs+300000,last=ranges.at(-1);
      if(last&&start<=last.end)last.end=Math.max(last.end,end);else ranges.push({start,end});
    }else for(let offset=-2;offset<=2;offset++)neighbors.add(index+offset);
  });
  let range=0;
  return ordered.filter((segment,index)=>{
    while(range<ranges.length&&ranges[range].end<=segment.startMs)range++;
    return !covered.has(identity(segment))||neighbors.has(index)||(segment.endMs>segment.startMs&&range<ranges.length&&segment.endMs>ranges[range].start&&segment.startMs<ranges[range].end);
  });
}
export function minutesContext(previous, snapshot=[]) {
  if (!previous) return undefined;
  const budget = 12000, outlineBudget = 6000, bytes = value => Buffer.byteLength(JSON.stringify(value));
  const freshText=snapshot.filter(segment=>segment.contextOnly!==true).map(segment=>segment.text).join('\n');
  const context = { title: previous.title.slice(0, 100), topics: (previous.topics || []).map(({ id, title }) => ({ id, title })), headings: [], items:[], recentPoints:[] };
  const summaries=new Map(context.topics.map((topic,index)=>[topic,previous.topics[index].summary]));
  // Stable IDs survive even when unusually long display titles need shortening.
  while (bytes(context) > outlineBudget) {
    const longest = context.topics.filter(topic => topic.title.length > 24).sort((a, b) => b.title.length - a.title.length)[0];
    if (!longest) break;
    longest.title = longest.title.slice(0, Math.max(24, longest.title.length - 16));
  }
  while(bytes(context)>outlineBudget&&context.topics.length){
    const unrelated=context.topics.findIndex(topic=>!freshText.includes(topic.title));
    context.topics.splice(unrelated<0?0:unrelated,1);
  }
  for (const heading of new Set(previous.sections.map(section => section.heading))) {
    context.headings.push(heading);
    if (bytes(context) > outlineBudget) context.headings.pop();
  }
  for (let index = 0; index < context.topics.length; index++) {
    context.topics[index].summary = (summaries.get(context.topics[index]) || '').slice(0, 480);
    if (bytes(context) > outlineBudget) delete context.topics[index].summary;
  }
  const entries=[...(previous.decisions || []).map(item=>({...item,kind:'decision'})),...(previous.actions || []).map(item=>({...item,kind:'action'})),...(previous.highlights || []).map(item=>({...item,kind:'item',heading:'关键结论'})),...previous.sections.flatMap(section=>section.items.map(item=>({...item,kind:'item',heading:section.heading})))];
  const relevant=new Set(snapshot.map(identity)), seen=new Set();
  const related=new Set((previous.topics || []).filter(topic=>freshText.includes(topic.title)).flatMap(topic=>(topic.evidence || []).map(identity)));
  const score=item=>Number(item.evidence.some(ref=>related.has(identity(ref))))*10+Number(item.evidence.some(ref=>relevant.has(identity(ref))));
  const times=new Map((previous.evidenceSnapshot || []).map(segment=>[identity(segment),segment.endMs || 0]));
  const time=item=>Math.max(0,...item.evidence.map(ref=>times.get(identity(ref)) || 0));
  entries.sort((a,b)=>score(b)-score(a) || time(b)-time(a));
  for(const item of entries){
    const id=minutesItemId(item);if(seen.has(id))continue;seen.add(id);
    const next={id,kind:item.kind,text:item.text.slice(0,1000),evidence:item.evidence.slice(0,5),...(item.heading?{heading:item.heading}:{}),...(item.kind==='action'?{owner:item.owner??null,due:item.due??null}:{})};
    context.items.push(next);if(bytes(context)>budget)context.items.pop();
    if(context.items.length>=60)break;
  }
  context.recentPoints = [];
  const recent = [...previous.sections.flatMap(section => section.items).map(item => ({ text: item.text.slice(0, 240), topicId: item.topicId })), ...(previous.actions || []).map(item => ({ text: item.text.slice(0, 240), owner: item.owner, due: item.due }))].reverse();
  for (const item of recent.slice(0, 24)) {
    context.recentPoints.push(item);
    if (bytes(context) > budget) { context.recentPoints.pop(); break; }
  }
  return context;
}
export function mergeLiveMinutes(previous, incoming, snapshot) {
  let base = previous || { sections: [], topics: [], actions: [], decisions: [], speakerSummaries: [], tables: [], evidenceSnapshot: [] };
  const history=[...(base.correctionHistory || [])];
  const allEvidence=new Map([...base.evidenceSnapshot,...snapshot].map(segment=>[identity(segment),segment]));
  const freshEvidence=new Map(snapshot.filter(segment=>segment.contextOnly!==true).map(segment=>[identity(segment),segment]));
  const time=(item,sources=allEvidence)=>Math.max(0,...(item?.evidence || []).map(ref=>sources.get(identity(ref))?.endMs || 0));
  const facts=()=>[...base.sections.flatMap(section=>section.items),...(base.decisions || []),...(base.actions || []),...(base.highlights || [])];
  const targetFor=correction=>facts().find(item=>minutesItemId(item)===correction.targetId) || [...history].reverse().find(entry=>entry.targetId===correction.targetId)?.previous;
  const rootFor=(correction,target)=>target.correctionOf || correction.targetId;
  const latestFor=root=>[...history].reverse().find(entry=>(entry.canonicalTargetId || entry.targetId)===root);
  const review=(item,root,reason,stateThroughMs)=>({...item,correctionOf:item.correctionOf || minutesItemId(item),relatedTo:root,stateThroughMs:Math.max(item.stateThroughMs || 0,stateThroughMs),text:item.relatedTo===root&&item.text.startsWith('待复核')?item.text:`待复核（${reason}）：${item.text}${item.owner!==undefined?`（负责人：${item.owner || '未确认'}；时间：${item.due || '未确认'}）`:''}`});
  let guardRoot='',guardTime=0;
  let outdated=false;
  for(const correction of incoming.corrections || []){
    const target=targetFor(correction);if(!target)continue;
    const root=rootFor(correction,target),latest=latestFor(root);
    const through=Math.max(target.stateThroughMs ?? time(target),latest?.eventTimeMs ?? time(latest));
    if(time(correction,freshEvidence)<through){guardRoot=root;guardTime=Math.max(guardTime,through);outdated=true;}
  }
  if(outdated){
    const visualItems=(incoming.visuals || []).flatMap(visual=>visual.entries.map(entry=>({text:`${visual.title}：${entry.label} ${entry.text || `${entry.valueText}${visual.unit || ''}`}`,evidence:entry.evidence})));
    const items=[...incoming.sections.flatMap(section=>section.items),...(incoming.decisions || []),...(incoming.actions || []),...(incoming.highlights || []),...visualItems,...(incoming.corrections || [])];
    incoming={...incoming,sections:[{heading:'迟到内容待复核',items:items.map(item=>review(item,guardRoot,'早于当前有效状态，未更改已有决定',guardTime))}],decisions:[],actions:[],topics:[],tables:[],visuals:[],highlights:[],speakerSummaries:[],currentDiscussion:[],corrections:[]};
  }
  const applied=new Map(), related=[];
  for(const correction of [...(incoming.corrections || [])].sort((a,b)=>time(a,freshEvidence)-time(b,freshEvidence))){
    const target=targetFor(correction);if(!target)continue;
    const root=rootFor(correction,target), affected=new Set(target.evidence.map(identity));
    const keep=item=>minutesItemId(item)!==correction.targetId&&item.correctionOf!==root;
    const touches=item=>item.evidence?.some(ref=>affected.has(identity(ref)));
    const active=items=>(items || []).filter(item=>{
      if(!keep(item))return false;
      if(touches(item)){related.push(review(item,root,'与已更正事实共享引用，原内容保留',time(correction,freshEvidence)));return false;}
      return true;
    });
    base={...base,
      sections:base.sections.map(section=>({...section,items:section.items.filter(keep).map(item=>touches(item)?review(item,root,'与已更正事实共享引用，原内容保留',time(correction,freshEvidence)):item)})),
      decisions:active(base.decisions),actions:active(base.actions),
      highlights:active(base.highlights),
      topics:(base.topics || []).map(topic=>touches(topic)?{...topic,summary:''}:topic),
      tables:(base.tables || []).filter(table=>!table.rows.some(touches)),
      visuals:(base.visuals || []).filter(visual=>!visual.entries.some(touches)),
      speakerSummaries:(base.speakerSummaries || []).filter(item=>!touches(item))
    };
    history.push({...correction,canonicalTargetId:root,eventTimeMs:time(correction,freshEvidence),previous:target});
    applied.set(root,correction);
  }
  const corrections=[...applied].map(([root,correction])=>({correctionOf:root,stateThroughMs:time(correction,freshEvidence),text:`${{withdrawn:'已撤回',corrected:'已更正',pending:'待确认'}[correction.status]}：${correction.text}`,evidence:correction.evidence}));
  incoming={...incoming,sections:[...incoming.sections,...(corrections.length||related.length?[{heading:'更正与待确认',items:[...corrections,...related]}]:[])]};
  const topics = base.topics?.map(topic => ({ ...topic })) || [], aliases = new Map();
  for (const topic of incoming.topics || []) {
    const index = topics.findIndex(old => textKey(old.title) === textKey(topic.title));
    if (index < 0) {
      let id=topic.id;
      if(id&&topics.some(old=>old.id===id)){
        id=`topic-${createHash('sha256').update(JSON.stringify([topic.title,topic.evidence.map(identity)])).digest('hex').slice(0,20)}`;
        aliases.set(topic.id,id);
      }
      topics.push({...topic,...(id?{id}:{} )});
    }
    else {
      const old = topics[index]; if (topic.id && old.id) aliases.set(topic.id, old.id);
      topics[index] = { ...old, summary: topic.summary || old.summary, evidence: uniqueRefs([...old.evidence, ...topic.evidence]) };
    }
  }
  // Tables and speaker digests are compact views; prose retains the accumulated facts.
  const remapItem = item => item.topicId && aliases.has(item.topicId) ? { ...item, topicId: aliases.get(item.topicId) } : item;
  const retained=new Set(related),headings=new Map();
  for(const section of base.sections)headings.set(section.heading,mergeItems(headings.get(section.heading),section.items));
  for(const section of incoming.sections)headings.set(section.heading,mergeItems(headings.get(section.heading),section.items.map(item=>retained.has(item)?item:remapItem(item))));
  const sections=[...headings].flatMap(([heading,items])=>Array.from({length:Math.ceil(items.length/100)},(_,index)=>({heading,items:items.slice(index*100,(index+1)*100)})));
  if(!sections.length)sections.push({heading:incoming.sections[0]?.heading || '待确认',items:[]});
  const tables = new Map(base.tables?.map(table => [`${table.topicId}:${table.title}`, table]) || []);
  for (const table of incoming.tables || []) {
    const next = { ...table, topicId: aliases.get(table.topicId) || table.topicId };
    tables.set(`${next.topicId}:${next.title}`, next);
  }
  const visuals = new Map((base.visuals || []).map(visual => [`${visual.topicId}:${visual.kind}:${visual.title}:${visual.unit || ''}`, visual]));
  for (const visual of incoming.visuals || []) {
    const next = { ...visual, ...(visual.topicId ? { topicId: aliases.get(visual.topicId) || visual.topicId } : {}) };
    const key = `${next.topicId}:${next.kind}:${next.title}:${next.unit || ''}`, old = visuals.get(key);
    const entries = new Map();
    for (const entry of [...(old?.entries || []), ...next.entries]) {
      const id = next.kind === 'bar' ? entry.label : `${entry.label}:${entry.text}`;
      const prior = entries.get(id);
      entries.set(id, { ...entry, evidence: uniqueRefs([...(prior?.evidence || []), ...entry.evidence]) });
    }
    visuals.set(key, { ...next, entries: [...entries.values()].slice(-12) });
  }
  const speakers = new Map(base.speakerSummaries?.map(speaker => [speaker.speakerId || speaker.speaker, speaker]) || []);
  for (const speaker of incoming.speakerSummaries || []) speakers.set(speaker.speakerId || speaker.speaker, speaker);
  return orderMinutesTimelines({
    ...incoming, title: incoming.title, sections, topics,
    actions: mergeItems(base.actions, (incoming.actions || []).map(remapItem)), decisions: mergeItems(base.decisions, (incoming.decisions || []).map(remapItem)),
    speakerSummaries: [...speakers.values()], tables: [...tables.values()].slice(-6),
    highlights: mergeItems(incoming.highlights?.map(remapItem), base.highlights), visuals: [...visuals.values()].slice(-4),
    ...(incoming.currentDiscussion ? {currentDiscussion:incoming.currentDiscussion.map(remapItem)} : {}),
    evidenceSnapshot: uniqueRefs([...base.evidenceSnapshot, ...snapshot]),
    correctionHistory:history.slice(-100), corrections:[]
  }, uniqueRefs([...base.evidenceSnapshot, ...snapshot]));
}
