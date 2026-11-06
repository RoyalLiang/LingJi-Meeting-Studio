import { randomUUID } from 'node:crypto';

// Preserve complete segments and their original identities. A single unusually
// large segment remains one shard; its existing paged reader stays in charge.
export function meetingShards(snapshots, limit=48000) {
  if(snapshots.length===1&&JSON.stringify(snapshots).length<=limit)return [];
  const shards=[];
  for(const snapshot of snapshots){
    let from=0,to=0,size=0;
    const flush=()=>{if(to===from)return;shards.push({jobKey:randomUUID(),recordId:snapshot.recordId,from,to});from=to;size=0;};
    for(const segment of snapshot.segments){const bytes=JSON.stringify(segment).length;if(to>from&&size+bytes>limit)flush();to++;size+=bytes;}
    flush();
    if(!snapshot.segments.length)shards.push({jobKey:randomUUID(),recordId:snapshot.recordId,from:0,to:0});
  }
  return shards;
}

export function shardSnapshot(shard,snapshots){
  const source=snapshots.find(snapshot=>snapshot.recordId===shard.recordId);
  let segments=source.segments.slice(shard.from,shard.to);
  // The first extraction also owns the human-edited minutes and saved notes.
  // Keep their original cited segments even when they cross a shard boundary.
  if(shard.from===0&&source.minutes){
    const refs=new Set();const visit=value=>{if(!value||typeof value!=='object')return;for(const [key,child] of Object.entries(value)){if(key==='evidence'&&Array.isArray(child))for(const ref of child)refs.add(`${ref.segmentId}:${ref.revision}`);else if(key!=='evidenceSnapshot')visit(child);}};visit(source.minutes);
    segments=[...new Map([...segments,...source.segments.filter(segment=>refs.has(`${segment.id}:${segment.revision}`))].map(segment=>[`${segment.id}:${segment.revision}`,segment])).values()];
  }
  return {...source,segments,minutes:shard.from===0?source.minutes:null,...(shard.from===0?{}:{notes:''})};
}

export function extractionPages(extractions,recordId,limit=12000){
  const source=JSON.stringify({recordId,extractions:extractions.filter(item=>item.recordId===recordId).map(({result})=>result)});
  if(source.length<=limit)return [source];
  const parts=[];for(let start=0;start<source.length;){let end=Math.min(start+limit,source.length);if(end<source.length&&/[\uD800-\uDBFF]/.test(source[end-1]))end--;parts.push(source.slice(start,end));start=end;}
  return parts.map((content,page)=>JSON.stringify({recordId,format:'json-fragment',page,totalPages:parts.length,...(page+1<parts.length?{nextPage:page+1}:{}),content}));
}
