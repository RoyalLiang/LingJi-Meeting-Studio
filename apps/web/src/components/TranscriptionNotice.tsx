import { useRef, useState } from 'react';
import { ApiError } from '../api';
import { FeedbackNotice } from './FeedbackNotice';

export function TranscriptionNotice({ busy, retained, retry, configure, active = true, recordId, issue, reopenVersion = 0, audioOnly = false }: {
  busy: boolean; retained: boolean; retry: () => Promise<boolean>; configure?: () => void; active?: boolean;
  recordId: string; issue?: {code: string; identity: string}; reopenVersion?: number; audioOnly?: boolean;
}) {
  const [retrying, setRetrying] = useState(false);
  const submitting = useRef(false), initialReopen = useRef(reopenVersion);
  async function reprocess() {
    if (submitting.current || busy) return;
    submitting.current = true; setRetrying(true);
    try { await retry(); } finally { submitting.current = false; setRetrying(false); }
  }
  const previousAsr = audioOnly && issue?.code.startsWith('doubao_asr_');
  const reason = previousAsr
    ? '此前的转录服务处理失败，可用当前豆包音频模型重新处理。'
    : issue?.code ? new ApiError(issue.code, 502).message : configure ? '请在设置与诊断中检查语音服务配置后重试。' : '请联系维护者检查语音服务配置后重试。';
  const message = `语音处理未完成。${reason}${retained ? '保存期内的录音仍可播放或导出。' : '已保存的转录和笔记不受影响。'}`;
  const identity = `${recordId}:${issue?.identity || 'legacy'}`;
  return <FeedbackNotice key={`${identity}:${reopenVersion}`} dismissalKey={identity} forceOpen={reopenVersion !== initialReopen.current} open={active} message={message} action={{ label: retrying ? '正在提交…' : '重新处理', run: () => void reprocess(), disabled: busy || retrying, busy: retrying }}/>;
}
