import { memo, useEffect, useState } from 'react';
import { CorrectionSuggestions } from './CorrectionSuggestions';
import { ArrowDown, Check, PencilSimple, TextAlignLeft, X } from '@phosphor-icons/react';
import { Button, Empty } from './ui';
import { Select } from './Select';
import { topicTone } from './TopicMap';
import type { RecordDetail, Segment } from '../model';
import { timecode } from '../model';
import { useTranscriptFollow } from './useTranscriptFollow';
import { cleanSpeechDisplay } from '../../../../packages/records/src/learning-display.mjs';
type TranscriptProps = { record: RecordDetail; highlighted: string; save: (s: Segment, text: string, speaker: string) => Promise<boolean> };
export const TranscriptHistory = memo(function TranscriptHistory({record, save, changed}: Pick<TranscriptProps,'record'|'save'> & {changed:()=>void}) {
  const [loaded,setLoaded]=useState(false);
  // Keep mounted after the first opening so collapsing never discards an edit draft.
  return <details className="transcript-disclosure" onToggle={event=>{if(event.currentTarget.open)setLoaded(true);}}>
    <summary role="button" tabIndex={0} aria-label={`逐字记录与纠错 · ${record.segments.length} 段`} title={`逐字记录与纠错 · ${record.segments.length} 段`}><TextAlignLeft size={18}/></summary>
    {loaded && <><CorrectionSuggestions record={record} changed={changed}/><Transcript record={record} highlighted="" save={save}/></>}
  </details>;
});
export function Transcript({ record, highlighted, save }: TranscriptProps) {
  const [query, setQuery] = useState(''), [editing, setEditing] = useState<Segment | null>(null);
  const [concise, setConcise] = useState(true);
  const [text, setText] = useState(''), [speaker, setSpeaker] = useState(''), [busy, setBusy] = useState(false);
  const previews = record.sources.filter(source=>source.asr?.preview?.text);
  const follow = useTranscriptFollow(`${record.transcriptRevision}:${previews.map(source=>source.asr!.preview!.text).join('|')}`, Boolean(query || editing));
  useEffect(() => { if(highlighted)follow.pause(); }, [highlighted,follow.pause]);
  useEffect(() => { if(record.capture==='recording')follow.enable(); }, [record.capture,follow.enable]);
  const segments = [...record.segments].sort((a,b)=>a.startMs-b.startMs).filter(s=>`${s.text} ${cleanSpeechDisplay(s.text)} ${s.speaker}`.toLowerCase().includes(query.toLowerCase()));
  const topics = (record.liveMinutes?.transcriptRevision === record.transcriptRevision ? record.liveMinutes : record.minutes || record.liveMinutes)?.topics || [];
  const knownSpeakers = [...new Set([...(record.speakers||[]).map(s=>s.label),...record.segments.map(s=>s.speaker)].filter(Boolean))];
  return <section ref={follow.root} className="transcript" aria-label="会议转录">
    <div className="section-heading"><div><h2>逐字记录 <span>{record.segments.length}</span></h2><p>每一段，都有来处。</p></div>{record.segments.length>0 && <><Button variant="ghost" onClick={()=>setConcise(!concise)}>{concise ? '显示识别原文' : '简洁阅读'}</Button><input className="transcript-search" aria-label="搜索本次转录" placeholder="查找本次会议…" value={query} onChange={e=>setQuery(e.target.value)}/></>}</div>
    {record.sources.some(s=>s.asr) && <p className="speaker-help">同一音轨复用说话人编号。重连或新音轨无法确认的身份，可在片段中指定。</p>}
    {!segments.length && <Empty icon={<TextAlignLeft size={32}/>} title={query ? '没有匹配片段' : record.capture==='recording' ? '正在聆听' : '对话，留在这里'}>开始录音或导入文件，文字会在这里出现。</Empty>}
    <div className="segments">{segments.map((segment,index)=>{
      const topic=topics.find(t=>t.evidence.some(ref=>ref.segmentId===segment.id && ref.revision===segment.revision));
      const previous=segments[index-1], startsTopic=topic && !topic.evidence.some(ref=>ref.segmentId===previous?.id && ref.revision===previous?.revision);
      return <article data-tone={topic ? topicTone(topic) : undefined} id={`segment-${segment.id}`} key={segment.id} className={`segment ${highlighted===segment.id ? 'highlighted' : ''}`}>
        {startsTopic && <header className="transcript-topic"><h3>{topic.title}</h3><p>{topic.summary}</p></header>}
        <div className="segment-meta"><span className="avatar">{segment.speaker.match(/\d+$/)?.[0] || (segment.speaker ? segment.speaker[0] : '?')}</span><b>{segment.speaker || '说话人待确认'}</b>{!segment.speaker && <span className="source-badge">{record.sources.find(s=>s.id===segment.sourceId)?.label || '导入转录'} · 尚无身份信息</span>}<time>{segment.sourceId==='text-import' ? '文本' : timecode(segment.startMs)}</time>{segment.languageDetection && <span className="muted" title="原音批次的模型识别语种；混语句仍完整翻译">{({zh:'中文',en:'English',ja:'日本語',ko:'한국어',yue:'粤语'} as Record<string,string>)[segment.languageDetection.language] || segment.languageDetection.language}</span>}{segment.edited && <span className="muted">{segment.correction?.revision===segment.revision ? '已校对' : '已编辑'}</span>}<Button variant="ghost" className="edit-segment" aria-label="编辑转录与说话人" onClick={()=>{setEditing(segment);setText(segment.text);setSpeaker(segment.speaker);}}><PencilSimple size={16}/></Button></div>
        {editing?.id===segment.id ? <div className="segment-editor"><label>归属说话人<Select label="归属说话人" value={speaker} onChange={setSpeaker} options={[{value:'',label:'待确认'},...knownSpeakers.map(value=>({value,label:value}))]}/></label><label>说话人名称<input aria-label="说话人名称" value={speaker} onChange={e=>setSpeaker(e.target.value)} placeholder="例如：说话人 1" maxLength={80}/></label><label>转录内容<textarea value={text} onChange={e=>setText(e.target.value)} maxLength={8000}/></label><div className="actions"><Button disabled={busy || !text.trim()} variant="primary" onClick={async()=>{setBusy(true);try{if(await save(editing,text,speaker))setEditing(null);}finally{setBusy(false);}}}><Check size={16}/>保存</Button><Button onClick={()=>setEditing(null)}><X size={16}/>取消</Button></div></div> : <><p>{concise && !segment.edited ? cleanSpeechDisplay(segment.text) : segment.text}</p>{concise && !segment.edited && cleanSpeechDisplay(segment.text)!==segment.text && <details className="transcript-original"><summary>识别原文</summary><p>{segment.text}</p></details>}{segment.recognitionText && segment.recognitionText!==segment.text && <details className="transcript-original"><summary>识别原文</summary><p>{segment.recognitionText}</p></details>}{segment.translation && segment.translationLanguage===record.translationTarget && <p className="translation" lang={record.translationTarget}>{segment.translation}</p>}</>}
      </article>;})}</div>
    {previews.map(source=><section className="live-transcript" key={source.id} aria-label="实时转录草稿"><div className="live-transcript-heading"><span className="live-dot"/><b>实时转录</b><span>说话人确认中</span></div><p role="status" aria-live="polite" aria-atomic="true">{source.asr!.preview!.text}</p><small>草稿随识别修正，确认后归入逐字记录。</small></section>)}
    {(segments.length>0 || previews.length>0) && <div ref={follow.end} className="transcript-end"/>}
    {!follow.following && !query && !editing && <div className="transcript-follow"><Button onClick={follow.resume}><ArrowDown size={16}/>回到最新转录</Button></div>}
  </section>;
}
