import { useCallback, useEffect, useRef, useState } from 'react';
import { Translate } from '@phosphor-icons/react';
import { api, messageOf } from '../api';
import { Select } from './Select';
import { Toast } from './Toast';

export function TranslationSettings({ recordId, value, saved }: { recordId: string; value: string; saved: (target: string) => void }) {
  const [selected, setSelected] = useState(value), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const pending = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (!pending.current) setSelected(value); }, [value]);
  const dismiss = useCallback(() => { setError(''); setNotice(''); }, []);
  async function choose(target: string) {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    setSelected(target); setError(''); setNotice('');
    try {
      await api(`/records/${recordId}`, 'PATCH', { translationTarget: target });
      if (active.current) { saved(target); setNotice('翻译设置已保存。'); }
    } catch (error) {
      if (active.current) { setSelected(value); setError(messageOf(error)); }
    } finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <div className="settings-section settings-inline"><div className="section-title"><Translate size={19}/><h3>自动翻译</h3></div><Select readOnly={busy} label="翻译目标语言" value={selected} onChange={target => void choose(target)} options={[{value:'',label:'关闭'},{value:'en',label:'English'},{value:'zh',label:'中文'},{value:'ja',label:'日本語'},{value:'es',label:'Español'},{value:'fr',label:'Français'},{value:'de',label:'Deutsch'}]}/><Toast message={error || notice} error={Boolean(error)} dismiss={dismiss}/></div>;
}
