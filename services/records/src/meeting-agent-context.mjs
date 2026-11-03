import {meetingSourceWire} from './meeting-agent-wire.mjs';

export const MEETING_PAGE_CHARS=12000;
export const MEETING_COMPACTION='MEETING_SOURCE_CONTEXT_CHECKPOINT_V1';
export const meetingCompaction={enabled:true,reserveTokens:6000,keepRecentTokens:4000,backgroundTokens:0};

// Page the transport only. Durable snapshots and citation validation keep the complete source.
export function meetingSourcePages(snapshot,inlineLimit=60000){
  const wire=JSON.stringify(meetingSourceWire(snapshot));
  if(wire.length<=inlineLimit)return [wire];
  const pieces=[];
  for(let start=0;start<wire.length;){let end=Math.min(start+MEETING_PAGE_CHARS,wire.length);if(end<wire.length&&/[\uD800-\uDBFF]/.test(wire[end-1]))end--;pieces.push(wire.slice(start,end));start=end;}
  return pieces.map((content,page)=>JSON.stringify({recordId:snapshot.recordId,title:snapshot.title,format:'json-fragment',page,totalPages:pieces.length,...(page+1<pieces.length?{nextPage:page+1}:{}),content}));
}

export const meetingReadInstructions='Read every page of every selected meeting with read_selected_meeting {recordId,page:0}, then nextPage until no nextPage. Large sources are consecutive JSON fragments: join their meaning in page order, never treat a fragment as a complete source. Preserve exact recordId, segmentId and revision in citations. Do not answer before all pages are read.';
