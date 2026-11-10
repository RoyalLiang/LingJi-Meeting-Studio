import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { BookOpenText } from '@phosphor-icons/react';
import { api, messageOf } from '../api';
import { Button } from './ui';
import {FeedbackNotice} from './FeedbackNotice';

type Vocabulary = { terms: string; names: string; revision: number; builtin?: { available: boolean; version?: string; entries: number } };
export function VocabularySettings({ actionsTarget }: { actionsTarget: HTMLElement | null }) {
  const [value, setValue] = useState<Vocabulary | null>(null);
  const [message, setMessage] = useState(''), [error, setError] = useState(false), [busy, setBusy] = useState(false);
  const savedDraft=useRef('');
  const pending = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let live = true; setValue(null); setMessage('');
    api<Vocabulary>('/workspaces/all/vocabulary').then(result => { if (live) {savedDraft.current=JSON.stringify([result.terms,result.names]);setValue(result);} }).catch(e => { if (live) { setMessage(messageOf(e)); setError(true); } });
    return () => { live = false; };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!value || pending.current) return;
    pending.current = true; setBusy(true); setMessage('');
    try {
      const saved = await api<Vocabulary>('/workspaces/all/vocabulary', 'PUT', value);
      if (active.current) { savedDraft.current=JSON.stringify([saved.terms,saved.names]);setValue(saved); setMessage('词表已保存；新识别连接使用，已有原文可检查纠错。'); setError(false); }
    } catch (e) { if (active.current) { setMessage(messageOf(e)); setError(true); } }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  const dirty=Boolean(value)&&JSON.stringify([value?.terms,value?.names])!==savedDraft.current;
  return <section className="settings-section vocabulary-settings" aria-label="转录词表"><div className="section-title"><BookOpenText size={19}/><h3>转录词表</h3></div>
    <form id="vocabulary-settings" onSubmit={submit}><div className="vocabulary-fields">{(['terms','names'] as const).map(key => <label key={key}>{key === 'terms' ? '常见词语集' : '名称集'}<textarea name={key} rows={5} maxLength={12000} disabled={!value || busy} value={value?.[key] || ''} onChange={e => setValue(current => current ? {...current,[key]:e.target.value} : current)} placeholder={key === 'terms' ? '每行一个正确词语，可用 | 添加误识别写法\nRedis Sentinel | Redis 森提诺\n集装箱' : '每行一个正确名称，可用 | 添加误识别写法\n聆记 | 灵记\n王晓明 | 王小明'}/></label>)}</div>
      {message && <FeedbackNotice key={message} message={message} error={error} warning={false}/>}
      {actionsTarget && createPortal(<div className="actions"><span className="settings-save-state" role="status" data-dirty={dirty}>{busy?'正在保存…':dirty?'有未保存的更改':message&&!error?'已保存':''}</span><Button type="submit" form="vocabulary-settings" disabled={!value || busy}>保存设置</Button></div>, actionsTarget)}
    </form>
  </section>;
}
