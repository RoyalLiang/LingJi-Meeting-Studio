import { useEffect, useRef, useState } from 'react';
import { api, messageOf } from '../api';
import type { Segment } from '../model';
import { Button, Modal } from './ui';
import { FeedbackNotice } from './FeedbackNotice';

type Entry = { id: string; name: string; createdAt: string; global?:boolean;source:{recordId:string;segmentId:string;revision:number} };
type Match = { id: string; name: string; similarity: number };
type Props = { scope: string; close: () => void; source?: { recordId: string; segment: Segment }; onUse?: (name: string) => void };
export function VoiceprintDialog({ close, source, onUse }: Props) {
  const [value, setValue] = useState<{ available: boolean; revision: number; entries: Entry[] } | null>(null);
  const [name, setName] = useState(source?.segment.speaker || ''), [consent, setConsent] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [matches, setMatches] = useState<Match[] | null>(null);
  const requestId = useRef(crypto.randomUUID()), alive = useRef(true);
  const path = '/workspaces/all/voiceprints';
  useEffect(() => {
    alive.current = true; const controller = new AbortController();
    api<{ available: boolean; revision: number; entries: Entry[] }>(path, 'GET', undefined, controller.signal).then(value => { if (alive.current) setValue(value); }).catch(error => { if (!controller.signal.aborted) setError(messageOf(error)); });
    return () => { alive.current = false; controller.abort(); };
  }, [path]);
  const validClip = Boolean(source && source.segment.sourceId !== 'text-import' && !source.segment.overlappingSpeech && source.segment.endMs - source.segment.startMs >= 2000 && source.segment.endMs - source.segment.startMs <= 30000);
  const reference = source ? { recordId: source.recordId, segmentId: source.segment.id, revision: source.segment.revision } : undefined;
  const run = async (label: string, action: () => Promise<void>) => {
    if (busy) return; setBusy(label); setError(''); setNotice('');
    try { await action(); } catch (error) { if (alive.current) setError(messageOf(error)); } finally { if (alive.current) setBusy(''); }
  };
  return <Modal title="声纹库" onClose={() => { if (!busy) close(); }} className="voiceprint-modal">
    <div aria-busy={Boolean(busy)} className="voiceprint-content">
      <p className="voiceprint-intro">声音特征加密保存在当前记录服务，供当前账户的所有会议使用。旧条目确认后才跨项目识别。</p>
      {error && <FeedbackNotice key={error} message={error} error inline persistent/>}
      {notice && <p role="status">{notice}</p>}
      {!value && !error && <p role="status">正在读取声纹库…</p>}
      {source && <section className="voiceprint-enroll" aria-label="当前发言声音">
        <h3>当前发言</h3><blockquote>{source.segment.text}</blockquote>{validClip&&<audio controls preload="none" aria-label="试听当前发言" src={`/api${path}/clip?${new URLSearchParams({recordId:source.recordId,segmentId:source.segment.id,revision:String(source.segment.revision)})}`} onError={()=>setError('这段原音已过期或不可用。')}/>}
        {!validClip ? <p>请选择 2–30 秒、没有重叠声音的独立发言片段。</p> : <>
          {value && !value.available && <p>识别模型尚未就绪；仍可试听和管理声音。</p>}
          <Button disabled={Boolean(busy) || !value?.available || !value.entries.length} onClick={() => void run('正在查找相似声音…', async () => {
            const result = await api<{ matches: Match[] }>(`${path}/match`, 'POST', reference); if (alive.current) setMatches(result.matches);
          })}>查找相似声音</Button>
          {matches && <div className="voiceprint-matches" aria-live="polite">{matches.length ? <><p>相似声音仅供参考，请确认后使用名称。</p>{matches.map(match => <div key={match.id}><span>{match.name}</span><Button disabled={Boolean(busy)} aria-label={`使用 ${match.name} 作为发言人名称`} onClick={() => onUse?.(match.name)}>使用名称</Button></div>)}</> : <p>暂未找到相似声音，可以加入新的声音特征。</p>}</div>}
          <label className="voiceprint-name">发言人名称<input value={name} maxLength={80} autoComplete="off" disabled={Boolean(busy)} onChange={event => setName(event.target.value)} /></label>
          <label className="voiceprint-consent"><input type="checkbox" checked={consent} disabled={Boolean(busy)} onChange={event => setConsent(event.target.checked)} /><span>我已获得此发言人的同意，允许保存声音特征并在当前账户的所有会议中识别。</span></label>
          <Button variant="primary" disabled={Boolean(busy) || !value?.available || !consent || !name.trim()} onClick={() => void run('正在保存声音特征…', async () => {
            await api(path, 'POST', { ...reference, name: name.trim(), consent: true, libraryRevision: value?.revision, requestId: requestId.current });
            const next = await api<{ available: boolean; revision: number; entries: Entry[] }>(path);
            if (alive.current) { setValue(next); setConsent(false); setNotice('声音特征已保存。'); requestId.current = crypto.randomUUID(); }
          })}>保存声音特征</Button>
        </>}
      </section>}
      {value && <section className="voiceprint-library" aria-label="已保存的声音"><h3>已保存的声音 <span>{value.entries.length}</span></h3>{!value.entries.length ? <p>尚未保存声音。可在逐字记录中编辑发言片段，打开声纹库后选择加入。</p> : <ul>{value.entries.map(entry => <li key={entry.id}><div className="voiceprint-entry"><span>{entry.name}</span><span className="summary-pill" data-global={entry.global?'true':'false'}>{entry.global?'全局':'待确认全局'}</span><audio controls preload="none" aria-label={`试听 ${entry.name} 的原音`} src={`/api${path}/clip?id=${encodeURIComponent(entry.id)}`} onError={()=>setError('这段原音已过期或不可用。')}/></div>{!entry.global&&<label className="voiceprint-global-consent"><input type="checkbox" disabled={Boolean(busy)} onChange={event=>{if(!event.target.checked)return;event.target.checked=false;void run('正在确认全局范围…',async()=>{const next=await api<NonNullable<typeof value>>(`${path}/${entry.id}`,'PATCH',{consent:true,libraryRevision:value.revision});if(alive.current)setValue(next);});}}/><span>已获同意，启用全局识别</span></label>}<Button disabled={Boolean(busy)} aria-label={`删除 ${entry.name} 的声音特征`} onClick={() => void run('正在删除声音特征…', async () => {
        const result = await api<{ revision: number }>(`${path}/${entry.id}`, 'DELETE', { libraryRevision: value.revision });
        if (alive.current) { setValue(current => current ? { ...current, revision: result.revision, entries: current.entries.filter(item => item.id !== entry.id) } : current); setMatches(null); setNotice('声音特征已删除。'); }
      })}>删除</Button></li>)}</ul>}</section>}
      {busy && <p role="status">{busy}</p>}
    </div>
  </Modal>;
}
