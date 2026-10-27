import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { BookOpenText } from '@phosphor-icons/react';
import { api, messageOf } from '../api';
import type { WorkspaceDirectory } from '../workspace-model';
import { Button } from './ui';
import { Select } from './Select';

type Vocabulary = { terms: string; names: string; revision: number };
export function VocabularySettings({ scope, directories, actionsTarget }: { scope: string; directories: WorkspaceDirectory[]; actionsTarget: HTMLElement | null }) {
  const [selected, setSelected] = useState(scope), [value, setValue] = useState<Vocabulary | null>(null);
  const [message, setMessage] = useState(''), [error, setError] = useState(false), [busy, setBusy] = useState(false);
  const pending = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let live = true; setValue(null); setMessage('');
    api<Vocabulary>(`/workspaces/${selected}/vocabulary`).then(result => { if (live) setValue(result); }).catch(e => { if (live) { setMessage(messageOf(e)); setError(true); } });
    return () => { live = false; };
  }, [selected]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!value || pending.current) return;
    pending.current = true; setBusy(true); setMessage('');
    try {
      const saved = await api<Vocabulary>(`/workspaces/${selected}/vocabulary`, 'PUT', value);
      if (active.current) { setValue(saved); setMessage('词表已保存；新识别连接使用，已有原文可检查纠错。'); setError(false); }
    } catch (e) { if (active.current) { setMessage(messageOf(e)); setError(true); } }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <section className="settings-section vocabulary-settings" aria-label="转录词表"><div className="section-title"><BookOpenText size={19}/><h3>转录词表</h3></div>
    <label>使用范围<Select label="词表使用范围" value={selected} readOnly={busy} onChange={setSelected} options={[{value:'all',label:'通用 · 所有会议'},{value:'inbox',label:'未归档会议'},...directories.map(w => ({value:w.id,label:w.name}))]}/></label>
    <form id="vocabulary-settings" onSubmit={submit}><div className="vocabulary-fields">{(['terms','names'] as const).map(key => <label key={key}>{key === 'terms' ? '常见词语集' : '名称集'}<textarea name={key} rows={5} maxLength={12000} disabled={!value || busy} value={value?.[key] || ''} onChange={e => setValue(current => current ? {...current,[key]:e.target.value} : current)} placeholder={key === 'terms' ? '每行一个正确词语，可用 | 添加误识别写法\nRedis Sentinel | Redis 森提诺\n集装箱' : '每行一个正确名称，可用 | 添加误识别写法\n聆记 | 灵记\n王晓明 | 王小明'}/></label>)}</div>
      {message && <p role={error ? 'alert' : 'status'} className={error ? 'inline-error' : 'muted'}>{message}</p>}
      {actionsTarget && createPortal(<div className="actions"><Button type="submit" form="vocabulary-settings" disabled={!value || busy}>保存词表</Button></div>, actionsTarget)}
    </form>
  </section>;
}
