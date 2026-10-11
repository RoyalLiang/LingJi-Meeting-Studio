import type { Minutes, Topic, Segment } from '../model';
export function topicTone(topic: Topic) { return Array.from(topic.evidence[0]?.segmentId || topic.title).reduce((n,c)=>(n+c.charCodeAt(0))%4,0); }
function coveredMs(topic:Topic, snapshot:Segment[]) {
 const intervals=topic.evidence.map(ref=>snapshot.find(s=>s.id===ref.segmentId && s.revision===ref.revision)).filter((s):s is Segment=>Boolean(s)).map(s=>[s.startMs,s.endMs]).sort((a,b)=>a[0]-b[0]);
 let total=0,end=0;for(const [a,b] of intervals){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}return total;
}
export function TopicMap({minutes}:{minutes:Minutes}) {
 const topics=minutes.topics || [];const durations=topics.map(t=>coveredMs(t,minutes.evidenceSnapshot || [])),max=Math.max(1,...durations);
 if(!topics.length)return <p className="fine-print">本版纪要尚无主题数据，下一次 AI 整理会生成。</p>;
 return <div className="topic-map"><p className="fine-print">主题树 · 依据转录引用组织，点击正文来源可核对。</p><ul><li className="topic-root">{minutes.title}<ul>{topics.map((topic,i)=><li key={i} data-tone={topicTone(topic)}><strong>{topic.title}</strong><p>{topic.summary}</p>{durations[i]>0 && <div className="topic-duration"><span style={{width:`${Math.max(2,durations[i]/max*100)}%`}}/><small>{(durations[i]/1000).toFixed(1)} 秒片段覆盖</small></div>}</li>)}</ul></li></ul><p className="fine-print">横条表示引用片段的覆盖时长；不代表说话人时长或整场会议占比。</p></div>;
}
