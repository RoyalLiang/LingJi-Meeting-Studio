import { useEffect, useState } from 'react';
import { Button } from './ui';
import { MarkdownPreview } from './MarkdownPreview';
import type { RecordDetail } from '../model';
export function Notes({ record, save }: { record: RecordDetail; save: (text: string, revision: number) => Promise<boolean> }) {
  const [value, setValue] = useState(record.notes), [revision, setRevision] = useState(record.notesRevision), [busy, setBusy] = useState(false);
  useEffect(() => { setValue(record.notes); setRevision(record.notesRevision); }, [record.id]);
  const changed = value !== record.notes;
  const [pane,setPane]=useState<'edit'|'preview'>('edit');
  return <section className="notes-block notes-workbench"><div className="notes-toolbar"><strong>Markdown <small>实时预览</small></strong><div className="notes-pane-switch" aria-label="手记展示"><Button aria-pressed={pane==='edit'} onClick={()=>setPane('edit')}>编辑</Button><Button aria-pressed={pane==='preview'} onClick={()=>setPane('preview')}>预览</Button></div><span className="muted">{changed ? '尚未保存' : '已保存'}</span>
    <Button disabled={busy||!changed} onClick={async () => { setBusy(true); try { if (await save(value, revision)) setRevision(revision + 1); } finally { setBusy(false); } }}>保存笔记</Button></div>
    <div className="notes-layout" data-pane={pane}><div className="notes-source"><label htmlFor={`notes-${record.id}`}>编辑</label><textarea id={`notes-${record.id}`} aria-label="会议随手笔记" placeholder="记下你的观察、疑问，或补充背景…" value={value} maxLength={19999} onChange={e => setValue(e.target.value)}/></div><section className="notes-preview" aria-label="手记实时预览"><h3>实时预览</h3>{value.trim()?<MarkdownPreview text={value}/>:<p className="muted">输入 Markdown，这里会即时呈现。</p>}</section></div>
  </section>;
}
