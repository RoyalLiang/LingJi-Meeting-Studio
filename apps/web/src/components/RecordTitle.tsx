import { useState } from 'react';
import { PencilSimple } from '@phosphor-icons/react';
import { Button, Modal } from './ui';

export function RecordTitle({ title, save }: { title: string; save: (title: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false), [value, setValue] = useState(''), [saving, setSaving] = useState(false), [error, setError] = useState('');
  return <><div className="record-title"><h1>{title}</h1><Button variant="ghost" aria-label="修改会议标题" onClick={() => { setValue(title === '未命名会议' ? '' : title); setError(''); setOpen(true); }}><PencilSimple size={18}/></Button></div>
    {open && <Modal title="给对话一个名字" onClose={() => { if (!saving) setOpen(false); }}><form onSubmit={async event => {
      event.preventDefault(); if (!value.trim()) return; setSaving(true); setError('');
      try { if (await save(value.trim())) setOpen(false); else setError('标题未能保存，请检查连接后重试。'); } catch { setError('标题未能保存，请检查连接后重试。'); } finally { setSaving(false); }
    }}><label>会议标题<input autoFocus value={value} onChange={event => setValue(event.target.value)} maxLength={160} required placeholder="例如：产品方向讨论" disabled={saving}/></label>{error && <p className="inline-error" role="alert">{error}</p>}<Button variant="primary" type="submit" disabled={saving || !value.trim()}>{saving ? '正在保存…' : '保存标题'}</Button></form></Modal>}
  </>;
}
