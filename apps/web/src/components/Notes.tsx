import { useEffect, useState } from 'react';
import { Button } from './ui';
import type { RecordDetail } from '../model';
export function Notes({ record, save }: { record: RecordDetail; save: (text: string, revision: number) => Promise<boolean> }) {
  const [value, setValue] = useState(record.notes), [revision, setRevision] = useState(record.notesRevision), [busy, setBusy] = useState(false);
  useEffect(() => { setValue(record.notes); setRevision(record.notesRevision); }, [record.id]);
  const changed = value !== record.notes;
  return <section className="notes-block"><div className="section-heading"><h2>随手笔记</h2><span className="muted">{changed ? '尚未保存' : '已保存'}</span></div>
    <textarea aria-label="会议随手笔记" placeholder="记下你的观察、疑问，或补充背景…" value={value} maxLength={19999} onChange={e => setValue(e.target.value)}/>
    {changed && <Button disabled={busy} onClick={async () => { setBusy(true); try { if (await save(value, revision)) setRevision(revision + 1); } finally { setBusy(false); } }}>保存笔记</Button>}
  </section>;
}
