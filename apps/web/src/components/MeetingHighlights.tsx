import { CaretDown, CaretUp, Sparkle, X } from '@phosphor-icons/react';
import type { Job, Minutes } from '../model';
import { Button } from './ui';

export function MeetingHighlights({ minutes, history, ended, job, collapsed, toggleCollapsed, close, retry, busy, id }: { minutes: Minutes | null; history?: Minutes | null; ended: boolean; job?: Job; collapsed: boolean; toggleCollapsed: () => void; close: () => void; retry: () => void; busy: boolean; id: string }) {
  const waiting = ['queued','running'].includes(job?.status || '');
  const failed = job?.status === 'failed';
  const points = minutes?.highlights?.length ? minutes.highlights : (minutes?.topics || []).filter(topic => topic.summary?.trim()).map(topic => ({ text: topic.summary, evidence: topic.evidence }));
  const questions = minutes?.sections.flatMap(section => section.items.filter(item => item.kind === 'risk' || item.kind === 'question')) || [];
  const headline = minutes?.title?.trim() || minutes?.topics?.map(topic=>topic.title).filter(Boolean).slice(0,3).join(' · ') || '会议重点';
  const lead = failed ? '整理未完成，转录已保留' : minutes ? headline : waiting ? '正在整理会议重点…' : '重点速览';
  const progress = job?.progress?.total ? `（${job.progress.completed}/${job.progress.total} 个节点${job.progress.stage==='synthesis' ? '，正在汇总' : ''}）` : '';
  return <aside id={id} className={`meeting-highlights${collapsed ? ' is-collapsed' : ''}`} aria-label="会议重点" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
    <header><div className="meeting-highlights-heading"><Sparkle size={20}/><h3>重点速览</h3>{((!ended && !collapsed) || waiting) && <span className="meeting-highlights-draft" role={waiting ? 'status' : undefined}>{waiting && ended ? '后台整理中' : '会中草稿'}</span>}{collapsed && <p className="meeting-highlights-inline-lead">{lead}</p>}</div><div className="meeting-highlights-tools"><button type="button" className="button ghost" aria-label={collapsed ? '展开重点内容' : '收起为一行'} aria-expanded={!collapsed} aria-controls={`${id}-content`} onClick={toggleCollapsed}>{collapsed ? <CaretDown size={17}/> : <CaretUp size={17}/>}</button><button type="button" className="button ghost" aria-label="收起会议重点" onClick={close}><X size={17}/></button></div></header>
    {!collapsed && <div id={`${id}-content`} className="meeting-highlights-content">
      {waiting && <p className="meeting-highlights-state" role="status">{minutes ? ended ? '录音已结束，后台仍在整理纪要与重点速览；以下保留已完成内容。' : '正在更新会议重点，以下保留上次整理内容。' : ended ? '正在整理最终重点…（录音已结束，后台处理继续）' : '正在整理会中重点…'}{progress}</p>}
      {!minutes ? !waiting && (failed ? <p className="meeting-highlights-state muted">尚无最终重点，可继续查看已保存的转录。</p> : <div className="meeting-highlights-state"><p>{ended ? '尚未生成最终纪要。' : '有纪要后，这里会显示会议重点。'}</p>{ended && <Button disabled={busy} onClick={retry}>整理会议重点</Button>}</div>) : <div className="meeting-highlights-grid">
        <section className="meeting-highlights-summary"><h4 className={failed || waiting ? '' : 'sr-only'}>{failed || waiting ? '上次整理的重点' : '关键结论'}</h4>{points.length ? <><p className="meeting-highlights-lead">{headline}</p><ul>{points.map((point,index)=><li key={index}>{point.text}</li>)}</ul></> : <p className="muted">本版纪要尚未提供重点。</p>}</section>
        {questions.length > 0 && <section className="meeting-highlights-questions"><h4>待核实</h4><ul>{questions.map((item,index)=><li key={index}>{item.text}</li>)}</ul></section>}
        {minutes.actions.length > 0 && <section className="meeting-highlights-actions"><h4>下一步</h4><ul>{minutes.actions.map((item,index)=><li key={index}>{item.text}<small>{item.owner || '负责人待确认'} · {item.due || '时间待确认'}</small></li>)}</ul></section>}
      </div>}
      {Boolean(history?.highlights?.length) && <details className="meeting-highlights-history"><summary>会中重点历史（{history!.highlights!.length}）</summary><p className="fine-print">保留会中整理过程，结论以最终纪要为准。</p><ul>{history!.highlights!.map((point,index)=><li key={index}>{point.text}</li>)}</ul></details>}
    </div>}
  </aside>;
}
