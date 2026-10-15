import { useCallback, useEffect, useRef } from 'react';
import { ChatCircleDots } from '@phosphor-icons/react';
import type { Job, Minutes, RecordDetail } from '../model';
import './CurrentDiscussion.css';
import { recognitionStatus } from '../audio/recognition-status';

function DiscussionPulse({ activity, active }: { activity: string; active: boolean }) {
  const element = useRef<HTMLSpanElement>(null);
  const previous = useRef(activity);
  const animations = useRef<Animation[]>([]);
  const reduced = useRef<MediaQueryList | null>(null);
  const stop = useCallback(() => {
    animations.current.forEach(animation => animation.cancel());
    animations.current = [];
  }, []);
  useEffect(() => {
    const preference = reduced.current = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => { if (preference.matches) stop(); };
    preference.addEventListener('change', change);
    return () => { preference.removeEventListener('change', change); stop(); };
  }, [stop]);
  useEffect(() => {
    const changed = previous.current !== activity;
    previous.current = activity;
    if (!active) { stop(); return; }
    if (!changed || reduced.current?.matches || animations.current.some(animation => animation.playState === 'running')) return;
    stop();
    animations.current = Array.from(element.current?.children || []).map((dot, index) => dot.animate([
      { transform: 'translateY(0) scale(1)' },
      { transform: 'translateY(-6px) scale(1.08)', offset: .35 },
      { transform: 'translateY(1px) scale(.93)', offset: .65 },
      { transform: 'translateY(-1px) scale(1.02)', offset: .82 },
      { transform: 'translateY(0) scale(1)' },
    ], { duration: 520, delay: index * 85, iterations: 2, easing: 'cubic-bezier(.22,.61,.36,1)' }));
  }, [activity, active, stop]);
  return <span ref={element} className={`discussion-activity${active ? ' is-active' : ''}`} aria-hidden="true"><span/><span/><span/></span>;
}

export function CurrentDiscussion({ record, minutes, job, modelReady }: { record: RecordDetail; minutes: Minutes | null; job?: Job; modelReady: boolean }) {
  const running = ['queued', 'running'].includes(job?.status || '');
  const live = record.capture !== 'completed' || running;
  const protectedMinutes = Boolean(record.minutes?.edited);
  const pending = record.transcriptRevision > (minutes?.transcriptRevision || 0);
  const status = recognitionStatus(record) || (protectedMinutes ? '人工版本已保护'
    : job?.status === 'failed' ? '本轮整理未完成，可重试'
    : !modelReady ? '尚未连接纪要模型'
    : running ? job?.progress && job.progress.total > 1 ? `正在整理 AI 纪要 · ${job.progress.completed}/${job.progress.total}` : '正在整理 AI 纪要…'
    : live && !record.autoMinutes?.enabled ? '自动 AI 纪要未开启'
    : pending ? '新发言已接收，等待整理'
    : minutes ? 'AI 纪要已更新' : '等待对话开始');
  const active = record.capture !== 'paused' && (record.capture === 'recording' || running);
  const activity = [record.capture, record.usage?.samples ?? 0, record.transcriptRevision, minutes?.revision ?? 0, job?.id || '', job?.progress?.completed ?? 0, status].join(':');
  const captureState = record.capture === 'recording' ? '正在记录' : record.capture === 'paused' ? '已暂停' : record.capture === 'completed' ? '已完成' : record.capture === 'sealed' ? '整理中' : '待开始';
  return <section className="current-discussion discussion-dock" aria-label={live ? '当前正在聊' : '本场纪要'}>
    <header><div><ChatCircleDots size={18}/><h3>{live ? '当前正在聊' : '本场纪要'}</h3></div><span className="discussion-capture-state">{captureState}</span></header>
    <div className="discussion-status-row"><DiscussionPulse activity={activity} active={active}/><span className="discussion-status" role="status" aria-live="polite" aria-atomic="true">{status}</span></div>
  </section>;
}
