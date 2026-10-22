import { useRef, useState } from 'react';
import { ArrowClockwise, GearSix, WarningCircle } from '@phosphor-icons/react';
import { Button } from './ui';

export function TranscriptionNotice({ busy, retained, retry, configure }: {
  busy: boolean; retained: boolean; retry: () => Promise<boolean>; configure?: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const submitting = useRef(false);
  async function reprocess() {
    if (submitting.current || busy) return;
    submitting.current = true; setRetrying(true);
    try { await retry(); }
    finally { submitting.current = false; setRetrying(false); }
  }
  return <div className="transcription-notice" role="status">
    <div className="transcription-notice-copy">
      <strong><WarningCircle size={18} aria-hidden="true"/>语音处理暂时受阻</strong>
      <p>{retained ? '保存期内的录音仍可播放或导出。' : '已保存的转录和笔记不受影响。'}请检查语音服务配置后重试。</p>
    </div>
    <div className="transcription-notice-actions">
      {configure && <Button variant="ghost" disabled={busy || retrying} onClick={configure}><GearSix size={16}/>检查配置</Button>}
      <Button disabled={busy || retrying} aria-busy={retrying} onClick={() => void reprocess()}><ArrowClockwise size={16}/>{retrying ? '正在提交…' : '重新处理'}</Button>
    </div>
  </div>;
}
