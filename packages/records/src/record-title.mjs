const placeholders = /^(?:未命名会议|未命名记录|新会议|会议纪要|智能会议纪要|会议总结|untitled(?: meeting)?|new meeting|meeting minutes)$/i;
const ignored = new Set(('今天 明天 昨天 现在 这个 那个 我们 你们 他们 大家 自己 可以 需要 应该 进行 讨论 决定 确认 会议 问题 事情 一下 然后 就是 所以 因为 还有 是否 怎么 什么 已经 没有 时候 之前 之后 完成 the and this that with from about should would could have will meeting discuss').split(' '));
const words = new Intl.Segmenter('zh',{granularity:'word'});

export function keywordRecordTitle(segments) {
 const counts=new Map();let index=0;
 // Bound the optional title pass independently of the full evidence retained for minutes.
 let text='';
 for(const segment of segments) {
  text+=`${segment.text || ''}\n`.slice(0,96000-text.length);
  if(text.length===96000)break;
 }
 for(const token of words.segment(text)) {
  const value=token.segment.trim(),key=value.toLowerCase();
  if(!token.isWordLike || value.length<2 || value.length>20 || ignored.has(key) || /^\d+$/.test(value))continue;
  const entry=counts.get(key) || {value,count:0,index:index++};entry.count++;counts.set(key,entry);
 }
 return [...counts.values()].sort((a,b)=>b.count-a.count || a.index-b.index).slice(0,3).sort((a,b)=>a.index-b.index).map(entry=>entry.value).join(' · ').slice(0,60);
}

export function automaticRecordTitle(record,preferredTitle) {
 if(record.deleted || record.capture!=='completed' || record.titleEdited)return '';
 const current=String(record.title || '').trim();
 if(current && !placeholders.test(current) && current!==record.autoTitle)return '';
 // Only a validated final model title may refine our previous keyword title.
 const preferred=typeof preferredTitle==='string' ? preferredTitle.trim().replace(/\s+/g,' ').slice(0,160) : '';
 if(preferred && !placeholders.test(preferred))return preferred;
 if(record.autoTitle===current)return '';
 return keywordRecordTitle(record.segments || []);
}
