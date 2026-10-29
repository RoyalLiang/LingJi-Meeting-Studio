import type { Job, Minutes } from '../model';
import { Button, CloseButton } from './ui';

export function MeetingHighlights({ minutes, ended, job, close, retry, busy, id }: { minutes: Minutes | null; ended: boolean; job?: Job; close: () => void; retry: () => void; busy: boolean; id: string }) {
  const waiting = ended && ['queued','running'].includes(job?.status || '');
  const failed = ended && job?.status === 'failed';
  const points = minutes?.highlights?.length ? minutes.highlights : (minutes?.topics || []).filter(topic => topic.summary?.trim()).map(topic => ({ text: topic.summary, evidence: topic.evidence }));
  const questions = minutes?.sections.flatMap(section => section.items.filter(item => item.kind === 'risk' || item.kind === 'question')) || [];
  return <aside id={id} className="meeting-highlights" aria-label="会议重点" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
    <header><div><h3>重点速览</h3><p>{ended ? '最终纪要' : '会中草稿'}</p></div><CloseButton label="收起会议重点" onClick={close}/></header>
    <div className="meeting-highlights-content">
      {failed ? <div className="meeting-highlights-state" role="status"><p>最终重点尚未整理完成，会议内容已保留。</p><Button disabled={busy} onClick={retry}>重新整理</Button></div> : waiting ? <p className="meeting-highlights-state" role="status">正在整理最终重点…</p> : !minutes ? <div className="meeting-highlights-state"><p>{ended ? '尚未生成最终纪要。' : '有纪要后，这里会显示会议重点。'}</p>{ended && <Button disabled={busy} onClick={retry}>整理会议重点</Button>}</div> : <>
        <section className="meeting-highlights-summary"><h4>关键结论</h4>{points.length ? <><p className="meeting-highlights-lead">{points[0].text}</p>{points.length > 1 && <ul>{points.slice(1).map((point,index)=><li key={index}>{point.text}</li>)}</ul>}</> : <p className="muted">本版纪要尚未提供重点。</p>}</section>
        {questions.length > 0 && <section className="meeting-highlights-questions"><h4>待核实</h4><ul>{questions.map((item,index)=><li key={index}>{item.text}</li>)}</ul></section>}
        <section className="meeting-highlights-actions"><h4>下一步</h4>{minutes.actions.length ? <ul>{minutes.actions.map((item,index)=><li key={index}>{item.text}<small>{item.owner || '负责人待确认'} · {item.due || '时间待确认'}</small></li>)}</ul> : <p className="muted">本场没有明确安排的行动候选。</p>}</section>
      </>}
    </div><footer>{failed ? '整理未完成' : waiting ? '正在整理' : ended ? minutes ? '基于本场最终纪要' : '尚无最终纪要' : '会中内容仍会更新'}</footer>
  </aside>;
}
