import { useState } from 'react';
import { Check, PencilSimple, TextAlignLeft, X } from '@phosphor-icons/react';
import { Button, Empty } from './ui';
import type { RecordDetail, Segment } from '../model';
import { timecode } from '../model';
export function Transcript({ record, highlighted, save }: { record: RecordDetail; highlighted: string; save: (s: Segment, text: string, speaker: string) => Promise<boolean> }) {
  const [query, setQuery] = useState(''); const [editing, setEditing] = useState<Segment | null>(null);
  const [text, setText] = useState(''), [speaker, setSpeaker] = useState(''), [busy, setBusy] = useState(false);
  const segments = [...record.segments].sort((a, b) => a.startMs - b.startMs).filter(s => `${s.text} ${s.speaker}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="transcript" aria-label="会议转录"><div className="section-heading"><div><h2>逐字记录 <span>{record.segments.length}</span></h2><p>每一段，都有来处。</p></div>
    {record.segments.length > 0 && <input className="transcript-search" aria-label="搜索本次转录" placeholder="查找本次会议…" value={query} onChange={e => setQuery(e.target.value)}/>}</div>
    {!segments.length && <Empty icon={<TextAlignLeft size={32}/>} title={query ? '没有匹配片段' : record.capture === 'recording' ? '正在聆听' : '留住讨论的每一个细节'}>
      {query ? '试试其他关键词。' : '选择声音来源开始记录，也可以导入音频或已有转录。'}</Empty>}
    <div className="segments">{segments.map(segment => <article id={`segment-${segment.id}`} key={segment.id} className={`segment ${highlighted === segment.id ? 'highlighted' : ''}`}>
      <div className="segment-meta"><span className="avatar">{(segment.speaker || '声')[0]}</span><b>{segment.speaker || (record.sources.find(s => s.id === segment.sourceId)?.label || '导入转录')}</b>
        <time>{segment.sourceId === 'text-import' ? '文本' : timecode(segment.startMs)}</time>{segment.edited && <span className="muted">已编辑</span>}
        <Button variant="ghost" className="edit-segment" aria-label="编辑转录与说话人" onClick={() => { setEditing(segment); setText(segment.text); setSpeaker(segment.speaker); }}><PencilSimple size={16}/></Button></div>
      {editing?.id === segment.id ? <div className="segment-editor"><label>说话人<input value={speaker} onChange={e => setSpeaker(e.target.value)} placeholder="未标注" maxLength={80}/></label><label>转录内容<textarea value={text} onChange={e => setText(e.target.value)} maxLength={8000}/></label>
        <div className="actions"><Button disabled={busy || !text.trim()} variant="primary" onClick={async () => { setBusy(true); try { if (await save(editing, text, speaker)) setEditing(null); } finally { setBusy(false); } }}><Check size={16}/>保存</Button><Button onClick={() => setEditing(null)}><X size={16}/>取消</Button></div></div>
        : <><p>{segment.text}</p>{segment.translation && <p className="translation">{segment.translation}</p>}</>}
    </article>)}</div></section>;
}
