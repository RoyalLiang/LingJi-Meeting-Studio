import {KnowledgeQuestion} from './KnowledgeQuestion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, CaretLeft, CaretRight, Check, MagnifyingGlass, Sparkle } from '@phosphor-icons/react';
import type {KnowledgeReference} from '../model';
import { api, messageOf } from '../api';
import { Button } from './ui';
import { Select } from './Select';
import { FeedbackNotice } from './FeedbackNotice';

type Entry = {
  id: string; kind: string; text: string; owner: string; due: string; topic: string;
  recordId: string; title: string; minutesRevision: number; transcriptRevision: number;
  evidence: { segmentId: string; revision: number }[];
  status: 'candidate' | 'confirmed' | 'dismissed' | 'retracted'; reviewRevision: number;
  highlights: { start: number; end: number }[];
};
type KnowledgePage = { entries: Entry[]; total: number; offset: number; hasMore: boolean; conflicts: { topic: string; entries: string[] }[] };
const labels: Record<string, string> = { decision: '决策', action: '行动', risk: '风险', term: '术语', candidate: '待确认', confirmed: '已确认', dismissed: '已忽略', retracted: '来源已修订' };

export function KnowledgeLibrary({ scope, disabled, open, refreshKey = '', modelReady=true, compact=false }: { scope: string; compact?:boolean; modelReady?:boolean; refreshKey?: string; disabled: boolean; open: (id: string,reference?:KnowledgeReference) => void }) {
  const [expanded,setExpanded]=useState(false),[askOpen,setAskOpen]=useState(false);
  const [query, setQuery] = useState(''), [kind, setKind] = useState(''), [status, setStatus] = useState(''), [offset, setOffset] = useState(0);
  const [page, setPage] = useState<KnowledgePage | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [saving, setSaving] = useState('');
  const generation = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const current = ++generation.current; setLoading(true);
    try {
      const params = new URLSearchParams({ q: query, kind, status, offset: String(offset) });
      const result = await api<KnowledgePage>(`/workspaces/${scope}/knowledge?${params}`, 'GET', undefined, signal);
      if (current === generation.current && !signal?.aborted) { setPage(result); setError(''); if (offset >= result.total && offset > 0) setOffset(Math.max(0, Math.floor((result.total - 1) / 40) * 40)); }
    } catch (cause) { if (current === generation.current && !signal?.aborted) setError(messageOf(cause)); }
    finally { if (current === generation.current && !signal?.aborted) setLoading(false); }
  }, [scope, query, kind, status, offset]);
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => {
    const controller = new AbortController(), timer = setTimeout(() => void refresh(controller.signal), 200);
    return () => { clearTimeout(timer); controller.abort(); generation.current++; };
  }, [refresh,refreshKey]);
  async function review(entry: Entry, next: Entry['status']) {
    setSaving(entry.id); setError('');
    try { await api(`/workspaces/${scope}/knowledge/${entry.id}`, 'PATCH', { status: next, revision: entry.reviewRevision }); await refreshRef.current(); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setSaving(''); }
  }
  return <section className={`knowledge-library ${compact?'is-compact':''}`} aria-label="目录知识" aria-busy={loading}>
    <header className="section-heading"><div><h2>{compact?'项目资料':'目录知识'}</h2></div><div className="actions">{compact&&<Button aria-expanded={askOpen} onClick={()=>setAskOpen(value=>!value)}><Sparkle size={14}/>{askOpen?'收起提问':'问项目'}</Button>}<Button variant="ghost" disabled={loading || Boolean(saving)} onClick={() => void refresh()}>刷新</Button><Button variant="ghost" aria-expanded={expanded} onClick={()=>{setExpanded(value=>!value);if(expanded){setQuery('');setKind('');setStatus('');setOffset(0);}}}>{expanded?'收起':'查看全部'}</Button></div></header>
    <div hidden={compact&&!askOpen} className="project-question"><KnowledgeQuestion scope={scope} open={open} modelReady={modelReady} refreshKey={refreshKey}/></div>
    {expanded && <div className="knowledge-filters">
      <label className="knowledge-search"><span className="sr-only">搜索知识条目</span><MagnifyingGlass size={17} aria-hidden="true"/><input type="search" maxLength={200} value={query} placeholder="搜索决策、行动与术语" onChange={event => { setQuery(event.target.value); setOffset(0); }}/></label>
      <Select label="知识类型" value={kind} onChange={value => { setKind(value); setOffset(0); }} options={[{ value: '', label: '全部类型' }, ...['decision', 'action', 'risk', 'term'].map(value => ({ value, label: labels[value] }))]}/>
      <Select label="确认状态" value={status} onChange={value => { setStatus(value); setOffset(0); }} options={[{ value: '', label: '当前条目' }, ...['candidate', 'confirmed', 'dismissed', 'retracted'].map(value => ({ value, label: labels[value] }))]}/>
    </div>}
    {error && <FeedbackNotice message={error} error/>}
    {page?.conflicts.length ? <p className="knowledge-review-hint">待核对：{page.conflicts.slice(0, 3).map(group => group.topic).join('、')}在不同会议中出现了不同决定。请结合出处确认。</p> : null}
    {!page && loading ? <p className="directory-quiet" role="status">正在读取目录知识…</p> : <>
      <p className="fine-print" role="status">{loading ? '正在更新…' : `${!expanded && (page?.total||0)>4 ? '最近 4 条 · 共 ' : ''}${page?.total || 0} 条${status ? labels[status] : '当前'}知识`}</p>
      <div className="knowledge-entries">{page?.entries.slice(0,expanded?40:4).map(entry => <article key={entry.id} data-kind={entry.kind}>
        <div className="knowledge-entry-meta"><span>{labels[entry.kind]}</span><span>{labels[entry.status]}</span>{entry.topic && <span>{entry.topic}</span>}</div>
        <p>{entry.highlights.length ? <>{entry.text.slice(0, entry.highlights[0].start)}<mark>{entry.text.slice(entry.highlights[0].start, entry.highlights[0].end)}</mark>{entry.text.slice(entry.highlights[0].end)}</> : entry.text}</p>
        {entry.kind === 'action' && (entry.owner || entry.due) && <p className="fine-print">{entry.owner || '负责人待确认'}{entry.due ? ` · ${entry.due}` : ''}</p>}
        <div className="knowledge-entry-footer"><button className="knowledge-source" onClick={() => open(entry.recordId,entry)} title={`转录 v${entry.transcriptRevision} · 纪要 v${entry.minutesRevision} · ${entry.evidence.length} 段原文`}><span>{entry.title}</span><span>纪要 v{entry.minutesRevision}</span><ArrowUpRight size={14}/></button>
          {entry.status !== 'retracted' && <div className="actions"><Button variant="ghost" disabled={disabled || Boolean(saving)} onClick={() => void review(entry, entry.status === 'confirmed' ? 'candidate' : 'confirmed')}>{entry.status === 'confirmed' ? '撤回确认' : <><Check size={14}/>确认</>}</Button><Button variant="ghost" disabled={disabled || Boolean(saving)} onClick={() => void review(entry, entry.status === 'dismissed' ? 'candidate' : 'dismissed')}>{entry.status === 'dismissed' ? '恢复待确认' : '忽略'}</Button></div>}
        </div>
      </article>)}</div>
      {!page?.entries.length && !loading && !error && <p className="directory-quiet">{query || kind || status ? '没有符合条件的条目。调整搜索或筛选后重试。' : '会议结束并保存纪要后，有原文依据的条目会出现在这里。'}</p>}
      {expanded && page && (offset > 0 || page.hasMore) && <div className="knowledge-pagination"><Button variant="ghost" aria-label="上一页知识" disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 40))}><CaretLeft size={16}/>上一页</Button><span>{offset + 1}–{offset + page.entries.length} / {page.total}</span><Button variant="ghost" aria-label="下一页知识" disabled={loading || !page.hasMore} onClick={() => setOffset(value => value + 40)}>下一页<CaretRight size={16}/></Button></div>}
    </>}
  </section>;
}
