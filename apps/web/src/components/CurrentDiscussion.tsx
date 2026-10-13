import { ChatCircleDots } from '@phosphor-icons/react';
import type { Job, Minutes, RecordDetail } from '../model';

export function CurrentDiscussion({ record, minutes, job, modelReady }: { record: RecordDetail; minutes: Minutes | null; job?: Job; modelReady: boolean }) {
  const running = ['queued', 'running'].includes(job?.status || '');
  const live = record.capture !== 'completed' || running;
  const protectedMinutes = Boolean(record.minutes?.edited);
  const pending = record.transcriptRevision > (minutes?.transcriptRevision || 0);
  const status = protectedMinutes ? '人工版本已保护'
    : job?.status === 'failed' ? '本轮整理未完成，可重试'
    : !modelReady ? '尚未连接纪要模型'
    : running ? job?.progress && job.progress.total > 1 ? `正在整理 AI 纪要 · ${job.progress.completed}/${job.progress.total}` : '正在整理 AI 纪要…'
    : live && !record.autoMinutes?.enabled ? '自动 AI 纪要未开启'
    : pending ? '新发言已接收，等待整理'
    : minutes ? 'AI 纪要已更新' : '等待对话开始';
  return <section className="current-discussion discussion-dock" aria-label={live ? '当前正在聊' : '本场纪要'}>
    <header><div><ChatCircleDots size={18}/><h3>{live ? '当前正在聊' : '本场纪要'}</h3></div><span className="discussion-status" role="status" aria-live="polite">{status}</span></header>
  </section>;
}
