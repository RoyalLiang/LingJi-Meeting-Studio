import {SpeakerPanel} from './SpeakerPanel';
import { createPortal } from 'react-dom';
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { CorrectionSuggestions } from './CorrectionSuggestions';
import { ArrowDown, Check, PencilSimple, TextAlignLeft, X } from '@phosphor-icons/react';
import { Button, Empty } from './ui';
import { Select } from './Select';
import { topicTone } from './TopicMap';
import type { RecordDetail, Segment, Topic } from '../model';
import { timecode } from '../model';
import { useTranscriptFollow } from './useTranscriptFollow';
import { cleanSpeechDisplay } from '../../../../packages/records/src/learning-display.mjs';
import {VirtualSegments} from './VirtualSegments';
type TranscriptProps = { changed?:()=>void; visible?:boolean; record: RecordDetail; highlighted: string; save: (s: Segment, text: string, speaker: string) => Promise<boolean> };

type TranscriptSegmentsProps = {
  segments:Segment[];topicIndex:{first:Map<string,Topic>;members:Map<Topic,Set<string>>};
  sourceLabels:Map<string,string>;translationTarget?:string;highlighted:string;concise:boolean;
  editing:Segment|null;text:string;speaker:string;busy:boolean;knownSpeakers:string[];resetKey:string;
  setEditing:(value:Segment|null)=>void;setText:(value:string)=>void;setSpeaker:(value:string)=>void;setBusy:(value:boolean)=>void;
  save:TranscriptProps['save'];onVoice:(segment:Segment)=>void;
};
const TranscriptSegments=memo(function TranscriptSegments({segments,topicIndex,sourceLabels,translationTarget,highlighted,concise,editing,text,speaker,busy,knownSpeakers,resetKey,setEditing,setText,setSpeaker,setBusy,save,onVoice}:TranscriptSegmentsProps){
  return <VirtualSegments className="segments" segments={segments} pinned={editing?.id} highlighted={highlighted} resetKey={resetKey}>{(segment,index)=>{
      const topic=topicIndex.first.get(`${segment.id}:${segment.revision}`);
      const previous=segments[index-1], startsTopic=topic && (!previous || !topicIndex.members.get(topic)?.has(`${previous.id}:${previous.revision}`));
      return <article data-tone={topic ? topicTone(topic) : undefined} id={`segment-${segment.id}`} key={segment.id} className={`segment ${highlighted===segment.id ? 'highlighted' : ''}`}>
        {startsTopic && <header className="transcript-topic"><h3>{topic.title}</h3><p>{topic.summary}</p></header>}
        <div className="segment-meta"><button type="button" className="speaker-annotation-trigger" aria-label={`标注 ${segment.speaker||'说话人'}`} onClick={()=>onVoice(segment)}><span className="avatar">{segment.speaker.match(/\d+$/)?.[0] || (segment.speaker ? segment.speaker[0] : '?')}</span><b>{segment.speaker || '说话人待确认'}</b></button>{!segment.speaker && <span className="source-badge">{sourceLabels.get(segment.sourceId) || '导入转录'} · 尚无身份信息</span>}<time>{segment.sourceId==='text-import' ? '文本' : timecode(segment.startMs)}</time>{segment.languageDetection && <span className="muted" title="原音批次的模型识别语种；混语句仍完整翻译">{({zh:'中文',en:'English',ja:'日本語',ko:'한국어',yue:'粤语'} as Record<string,string>)[segment.languageDetection.language] || segment.languageDetection.language}</span>}{segment.overlappingSpeech&&<span className="muted">重叠发言 · 身份待确认</span>}{segment.edited && <span className="muted">{segment.correction?.revision===segment.revision ? '已校对' : '已编辑'}</span>}<Button variant="ghost" className="edit-segment" aria-label="编辑转录与说话人" onClick={()=>{setEditing(segment);setText(segment.text);setSpeaker(segment.speaker);}}><PencilSimple size={16}/></Button></div>
        {editing?.id===segment.id ? <div className="segment-editor"><label>归属说话人<Select label="归属说话人" value={speaker} onChange={setSpeaker} options={[{value:'',label:'待确认'},...knownSpeakers.map(value=>({value,label:value}))]}/></label><label>说话人名称<input aria-label="说话人名称" value={speaker} onChange={e=>setSpeaker(e.target.value)} placeholder="例如：说话人 1" maxLength={80}/></label><label>转录内容<textarea value={text} onChange={e=>setText(e.target.value)} maxLength={8000}/></label><div className="actions"><Button disabled={busy || !text.trim()} variant="primary" onClick={async()=>{setBusy(true);try{if(await save(editing,text,speaker))setEditing(null);}finally{setBusy(false);}}}><Check size={16}/>保存</Button><Button onClick={()=>setEditing(null)}><X size={16}/>取消</Button><Button disabled={busy||editing.sourceId==='text-import'} onClick={()=>onVoice(editing)}>声纹库</Button></div></div> : <><p>{concise && !segment.edited ? cleanSpeechDisplay(segment.text) : segment.text}</p>{concise && !segment.edited && cleanSpeechDisplay(segment.text)!==segment.text && <details className="transcript-original"><summary>识别原文</summary><p>{segment.text}</p></details>}{segment.recognitionText && segment.recognitionText!==segment.text && <details className="transcript-original"><summary>识别原文</summary><p>{segment.recognitionText}</p></details>}{segment.translation && segment.translationLanguage===translationTarget && <p className="translation" lang={translationTarget}>{segment.translation}</p>}</>}
      </article>;}}</VirtualSegments>;
});

export const TranscriptHistory = memo(function TranscriptHistory({record, save, changed, actionsTarget, expanded=false, visible=true}: Pick<TranscriptProps,'record'|'save'> & {changed:()=>void;actionsTarget?:HTMLElement|null;expanded?:boolean;visible?:boolean}) {
  const [loaded,setLoaded]=useState(false),[open,setOpen]=useState(false);
  const details=useRef<HTMLDetailsElement>(null),visibleRecord=useRef(record),id=useId(),external=actionsTarget!==undefined;
  useEffect(()=>{if(expanded&&details.current){details.current.open=true;setLoaded(true);setOpen(true);}},[expanded]);
  if(!loaded || open)visibleRecord.current=record;
  // Keep mounted after the first opening so collapsing never discards an edit draft.
  return <details id={id} ref={details} className={`transcript-disclosure${external ? ' is-toolbar' : ''}`} onToggle={event=>{setOpen(event.currentTarget.open);if(event.currentTarget.open)setLoaded(true);}}>
    <summary role="button" tabIndex={0} aria-label={`逐字记录与纠错 · ${record.segments.length} 段`} title={`逐字记录与纠错 · ${record.segments.length} 段`}><TextAlignLeft size={18}/></summary>
    {loaded && <><CorrectionSuggestions record={visibleRecord.current} changed={changed} active={open}/><Transcript visible={visible} record={visibleRecord.current} highlighted="" save={save} changed={changed}/></>}
    {actionsTarget && !expanded && createPortal(<Button variant="ghost" aria-label={`逐字记录与纠错 · ${record.segments.length} 段`} title="逐字记录与纠错" aria-controls={id} aria-expanded={open} onClick={()=>{if(details.current)details.current.open=!details.current.open;}}><TextAlignLeft size={18}/></Button>,actionsTarget)}
  </details>;
});
export const Transcript = memo(function Transcript({ record, highlighted, save, changed, visible=true }: TranscriptProps) {
  const [query, setQuery] = useState(''), [editing, setEditing] = useState<Segment | null>(null);
  const [concise, setConcise] = useState(true);
  const [text, setText] = useState(''), [speaker, setSpeaker] = useState(''), [busy, setBusy] = useState(false);
  const [voiceSegment,setVoiceSegment]=useState<Segment|null>(null);
  useEffect(()=>setVoiceSegment(null),[record.id]);
  const previews = record.sources.filter(source=>source.asr?.preview?.text);
  const follow = useTranscriptFollow(`${record.transcriptRevision}:${previews.map(source=>source.asr!.preview!.text).join('|')}`, Boolean(!visible || query || editing));
  useEffect(() => { if(highlighted)follow.pause(); }, [highlighted,follow.pause]);
  useEffect(() => { if(record.capture==='recording')follow.enable(); }, [record.capture,follow.enable]);
  const sorted=useMemo(()=>[...record.segments].sort((a,b)=>a.startMs-b.startMs),[record.segments]);
  const segments=useMemo(()=>{if(!query)return sorted;const needle=query.toLowerCase();return sorted.filter(s=>`${s.text} ${cleanSpeechDisplay(s.text)} ${s.speaker}`.toLowerCase().includes(needle));},[sorted,query]);

  const topics = (record.liveMinutes?.transcriptRevision === record.transcriptRevision ? record.liveMinutes : record.minutes || record.liveMinutes)?.topics;
  const topicIndex=useMemo(()=>{
    const first=new Map<string,Topic>(),members=new Map<Topic,Set<string>>();
    for(const topic of topics || []){
      const keys=new Set<string>();
      for(const ref of topic.evidence){const key=`${ref.segmentId}:${ref.revision}`;keys.add(key);if(!first.has(key))first.set(key,topic);}
      members.set(topic,keys);
    }
    return {first,members};
  },[topics]);
  const knownSpeakers=useMemo(()=>[...new Set([...(record.speakers||[]).map(s=>s.label),...record.segments.map(s=>s.speaker)].filter(Boolean))],[record.speakers,record.segments]);
  const sourceLabelsKey=useMemo(()=>JSON.stringify(record.sources.map(source=>[source.id,source.label])),[record.sources]);
  const sourceLabels=useMemo(()=>{const labels=new Map<string,string>();for(const [id,label] of JSON.parse(sourceLabelsKey) as [string,string][])if(!labels.has(id))labels.set(id,label);return labels;},[sourceLabelsKey]);
  return <div className="transcript-annotation-layout" data-open={Boolean(voiceSegment)}><section ref={follow.root} className="transcript" aria-label="会议转录">
    <div className="section-heading"><div><h2>逐字记录 <span>{record.segments.length}</span></h2></div>{record.segments.length>0 && <><Button variant="ghost" onClick={()=>setConcise(!concise)}>{concise ? '显示识别原文' : '简洁阅读'}</Button><input className="transcript-search" aria-label="搜索本次转录" placeholder="查找本次会议…" value={query} disabled={Boolean(editing)} onChange={e=>setQuery(e.target.value)}/></>}</div>
    {record.sources.some(s=>s.asr) && <p className="speaker-help">同一音轨复用说话人编号。重连或新音轨无法确认的身份，可在片段中指定。</p>}
    {record.sources.some(source=>source.asr?.identityWarning==='local_diarization_unavailable')&&<p className="speaker-help" role="status">说话人识别暂时不可用，正文会继续更新，可手动指定发言人。</p>}
      {record.sources.some(source=>source.asr?.previewError)&&<p className="speaker-help" role="status">实时草稿暂时不可用，音频已保留。正文会按识别结果更新。</p>}
    {!segments.length && <Empty icon={<TextAlignLeft size={32}/>} title={query ? '没有匹配片段' : record.capture==='recording' ? '正在聆听' : '对话，留在这里'}>开始录音或导入文件，文字会在这里出现。</Empty>}
    <TranscriptSegments segments={segments} resetKey={query} topicIndex={topicIndex} sourceLabels={sourceLabels} translationTarget={record.translationTarget} highlighted={highlighted} concise={concise} editing={editing} text={text} speaker={speaker} busy={busy} knownSpeakers={knownSpeakers} setEditing={setEditing} setText={setText} setSpeaker={setSpeaker} setBusy={setBusy} save={save} onVoice={setVoiceSegment}/>

    {previews.map(source=><section className="live-transcript" key={source.id} aria-label="实时转录草稿"><div className="live-transcript-heading"><span className="live-dot"/><b>实时转录</b><span>说话人确认中</span></div><p role="status" aria-live="polite" aria-atomic="true">{source.asr!.preview!.text}</p><small>草稿随识别修正，确认后归入逐字记录。</small></section>)}
    {(segments.length>0 || previews.length>0) && <div ref={follow.end} className="transcript-end"/>}
    {!follow.following && !query && !editing && <div className="transcript-follow"><Button onClick={()=>{follow.resume();}}><ArrowDown size={16}/>回到最新转录</Button></div>}
  </section>{voiceSegment&&<SpeakerPanel key={`${record.id}:${voiceSegment.id}`} record={record} segment={record.segments.find(segment=>segment.id===voiceSegment.id)||voiceSegment} changed={changed} close={()=>setVoiceSegment(null)}/>}</div>;
},(previous,next)=>previous.visible===next.visible && previous.highlighted===next.highlighted && previous.save===next.save && previous.changed===next.changed &&
  (['id','segments','sources','speakers','capture','transcriptRevision','liveMinutes','minutes','translationTarget'] as const).every(key=>previous.record[key]===next.record[key]));
