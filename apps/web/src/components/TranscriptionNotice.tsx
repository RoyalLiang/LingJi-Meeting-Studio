import { useRef, useState } from 'react';
import { FeedbackNotice } from './FeedbackNotice';

export function TranscriptionNotice({ busy, retained, retry, configure, active = true }: {
  busy: boolean; retained: boolean; retry: () => Promise<boolean>; configure?: () => void; active?: boolean;
}) {
  const [retrying, setRetrying] = useState(false);
  const submitting = useRef(false);
  async function reprocess() {
    if (submitting.current || busy) return;
    submitting.current = true; setRetrying(true);
    try { await retry(); }
    finally { submitting.current = false; setRetrying(false); }
  }
  const message = `语音处理暂时受阻。${retained ? '保存期内的录音仍可播放或导出。' : '已保存的转录和笔记不受影响。'}${configure ? '可在设置与诊断中检查语音服务配置后重试。' : '请联系维护者检查语音服务配置后重试。'}`;
  return <FeedbackNotice open={active} message={message} action={{ label: retrying ? '正在提交…' : '重新处理', run: () => void reprocess(), disabled: busy || retrying, busy: retrying }}/>;
}
