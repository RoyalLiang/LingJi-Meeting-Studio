import { ChatCircleDots } from '@phosphor-icons/react';
import type { Evidence, Job, Minutes, RecordDetail, Segment } from '../model';
import { useContentFollow } from './useContentFollow';
import { Button } from './ui';

export function CurrentDiscussion({ record, minutes, job, cite, modelReady }: { record: RecordDetail; minutes: Minutes | null; job?: Job; modelReady: boolean; cite: (ref: Evidence, snapshot?: Segment[]) => void }) {
  const running = ['queued', 'running'].includes(job?.status || '');
  const live = record.capture !== 'completed' || running;
  const protectedMinutes = Boolean(record.minutes?.edited);
  const preview = running && !protectedMinutes ? job?.preview?.filter(block => !['title', 'heading'].includes(block.kind)).slice(-4) || [] : [];
  const structured = minutes?.method === 'extractive' ? [] : minutes?.currentDiscussion || [];
  const covered = new Set((minutes?.evidenceSnapshot || []).map(segment => `${segment.id}:${segment.revision}`));
  const pending = record.segments.some(segment => !covered.has(`${segment.id}:${segment.revision}`));
  const waiting = !preview.length && job?.status !== 'failed' && !protectedMinutes && modelReady && (running || (live && record.autoMinutes?.enabled && (pending || !minutes)));
  const follow = useContentFollow(JSON.stringify([preview,structured]), false, '.discussion-content', running);
  const message = job?.status === 'failed' ? `本轮总结未完成${job.progress ? `，已整理 ${job.progress.completed}/${job.progress.total} 部分` : ''}，可重试整理。`
    : protectedMinutes ? '人工修订已保护，自动总结已暂停。'
    : !modelReady ? '连接纪要模型后，这里会显示 agent 总结。'
    : waiting ? running ? job?.progress && job.progress.total>1 ? `已整理 ${job.progress.completed}/${job.progress.total} 部分，${job.progress.stage==='synthesis' ? '正在汇总讨论要点' : '继续整理中'}…` : 'Agent 正在梳理讨论要点…' : pending ? '已收到新发言，等待 agent 总结…' : '等待对话开始，agent 将自动归纳要点…'
    : live && !record.autoMinutes?.enabled ? '开启自动 AI 纪要后，这里会持续更新讨论要点。'
    : structured.length ? '' : '本场暂无 agent 总结。';
  return <section className="current-discussion discussion-dock" aria-label={live ? '当前正在聊' : '最后讨论'}>
    <header><div><ChatCircleDots size={20}/><h3>{live ? '当前正在聊…' : '最后讨论'}</h3></div><span className="discussion-status">{preview.length ? 'Agent 总结 · 生成中' : waiting ? '等待 Agent' : structured.length ? '已归纳要点' : '待总结'}</span>{running && !follow.following && <Button variant="ghost" onClick={follow.resume}>最新要点</Button>}</header>
    <div ref={node=>{follow.root.current=node;}} className="discussion-content" aria-busy={waiting || running}>
      {message && !preview.length && <div className="discussion-wait" role="status"><span className={`discussion-pulse ${waiting ? 'is-waiting' : ''}`} aria-hidden="true"><i/><i/><i/></span><p>{message}</p></div>}
      {preview.length ? <><ol>{preview.map((block, i) => <li key={i}><p>{block.text}</p></li>)}</ol><p className="fine-print">生成中草稿 · 完整结果核验后进入纪要</p></>
        : structured.length > 0 && <><p className="discussion-context">{waiting ? '上一轮讨论要点' : '最近讨论要点'}</p><ol>{structured.map((item, i) => <li key={i}><p>{item.text}</p><div className="citations">{item.evidence.map((ref, j) => <button key={j} onClick={() => cite(ref,minutes?.evidenceSnapshot)}>来源 {j + 1}</button>)}</div></li>)}</ol></>}
      <div ref={follow.end} className="content-follow-anchor" aria-hidden="true"/>
    </div>
  </section>;
}
