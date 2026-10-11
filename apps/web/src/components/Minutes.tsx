import { useState } from 'react';
import { ArrowClockwise, ArrowSquareOut, Check, Sparkle, X, PencilSimple } from '@phosphor-icons/react';
import type { Evidence, Minutes as MinutesModel, RecordDetail } from '../model';
import { Button, Download, Empty, Status } from './ui';
export function MinutesPanel({ record, busy, onClose, generate, edit, cite }: { record: RecordDetail; busy: boolean; onClose: () => void;
  generate: (template: string) => Promise<void>; edit: (minutes: MinutesModel) => Promise<boolean>; cite: (evidence: Evidence) => void }) {
  const [template, setTemplate] = useState('meeting'), [draft, setDraft] = useState<MinutesModel | null>(null);
  const job = record.jobs.at(-1), running = ['queued', 'running'].includes(job?.status || ''); const minutes = record.minutes;
  return <aside className="minutes-panel glass" aria-label="会议纪要"><header><div className="heading-icon"><Sparkle size={20}/><h2>会议纪要</h2></div><Button variant="ghost" aria-label="收起纪要" onClick={onClose}><X size={20}/></Button></header>
    <div className="minutes-content"><div className="minutes-toolbar"><label className="sr-only" htmlFor="template">纪要模板</label><select id="template" value={template} onChange={e => setTemplate(e.target.value)}><option value="meeting">会议纪要</option><option value="interview">访谈整理</option><option value="lecture">学习笔记</option></select>
      <Button disabled={busy || running || record.capture !== 'completed'} onClick={() => void generate(template)}><ArrowClockwise size={16}/>{running ? '整理中…' : minutes ? '重新整理' : '生成纪要'}</Button></div>
      {job?.status === 'failed' && <div className="notice error" role="alert">整理未完成（{job.error}）。检查模型配置后可重新生成。</div>}
      {job?.status === 'stale' && <div className="notice">转录或人工内容已变化，本次旧结果已隔离，请重新整理。</div>}
      {minutes && minutes.transcriptRevision !== record.transcriptRevision && <div className="notice">此纪要引用转录 v{minutes.transcriptRevision}，当前为 v{record.transcriptRevision}。请重新核对。</div>}
      {!minutes ? <Empty icon={<Sparkle size={32}/>} title={running ? '正在梳理讨论脉络' : '从讨论，到共识'}>{record.capture === 'completed' ? '选择模板，整理重点与行动候选。每条内容都会保留转录引用。' : '结束录音并完成转录后，即可生成纪要。'}</Empty>
        : <><div className="minutes-title"><h3>{minutes.title}</h3><Status>{minutes.edited ? '人工修订' : 'AI 草稿'} · v{minutes.revision}</Status></div>
          <div className="actions"><Button onClick={() => setDraft(structuredClone(minutes))}><PencilSimple size={16}/>修订</Button><Download href={`/api/records/${record.id}/export?format=markdown`}><ArrowSquareOut size={16}/>导出</Download></div>
          {(draft || minutes).sections.map((section, sectionIndex) => <section className="minutes-section" key={sectionIndex}><h4>{section.heading}</h4>{section.items.map((item, itemIndex) => <div className="minute-item" key={itemIndex}>
            {draft ? <textarea aria-label={`${section.heading}第 ${itemIndex + 1} 项`} value={item.text} onChange={e => { const next = structuredClone(draft); next.sections[sectionIndex].items[itemIndex].text = e.target.value; setDraft(next); }}/>
              : <p>{item.text}</p>}
            <div className="citations">{item.evidence.map((ref, i) => <button key={i} onClick={() => cite(ref)} aria-label={`查看来源 ${i + 1}`}>来源 {i + 1}</button>)}</div>
          </div>)}</section>)}
          {draft && <div className="actions"><Button variant="primary" disabled={busy} onClick={async () => { if (await edit(draft)) setDraft(null); }}><Check size={16}/>保存修订</Button><Button onClick={() => setDraft(null)}>取消</Button></div>}
          {minutes.actions.length > 0 && <section className="minutes-section"><h4>行动候选</h4><p className="muted">请人工确认负责人和日期。下载不会发送给他人。</p>{minutes.actions.map((action, i) => <div className="action-candidate" key={i}><span className="checkbox-mark"/><div><p>{action.text}</p><small>{action.owner || '负责人待定'} · {action.due || '日期待定'}</small><div className="citations">{action.evidence.map((ref, j) => <button key={j} onClick={() => cite(ref)}>来源 {j + 1}</button>)}</div></div></div>)}<Download href={`/api/records/${record.id}/export?format=ics`}>下载待办日历文件</Download></section>}
          <p className="fine-print">AI 可能遗漏或误解。请沿引用核对原文后使用纪要。</p>
        </>}
    </div></aside>;
}
