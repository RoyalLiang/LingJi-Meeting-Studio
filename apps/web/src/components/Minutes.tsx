import { TopicMap } from './TopicMap';
import { useEffect, useRef, useState } from 'react';
import { ArrowClockwise, ArrowSquareOut, Check, Sparkle, X, PencilSimple } from '@phosphor-icons/react';
import type { Evidence, Minutes as MinutesModel, RecordDetail, Segment } from '../model';
import { api, messageOf } from '../api';
import { Select } from './Select';
import { Button, Download, Empty, Status } from './ui';
export function MinutesPanel({ record, busy, onClose, generate, edit, cite, automate }: { record: RecordDetail; busy: boolean; onClose: () => void;
  automate: (enabled: boolean, intervalSeconds: number) => Promise<void>;
  generate: (template: string, mode: string) => Promise<void>; edit: (minutes: MinutesModel) => Promise<boolean>; cite: (evidence: Evidence, snapshot?: Segment[]) => void }) {
  const panel = useRef<HTMLElement>(null);
  const [mobile,setMobile] = useState(() => matchMedia('(max-width: 1100px)').matches);
  useEffect(() => { const media=matchMedia('(max-width: 1100px)'); const change=()=>setMobile(media.matches); media.addEventListener('change',change); return()=>media.removeEventListener('change',change); }, []);
  useEffect(() => {
    if (!mobile) return;
    const children = Array.from(document.querySelectorAll<HTMLElement>('.workspace > :not(.minutes-panel), .sidebar'));
    children.forEach(element => { element.inert = true; });
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a, select, textarea') || []);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { children.forEach(element => { element.inert = false; }); document.removeEventListener('keydown', trap); document.querySelector<HTMLButtonElement>('[aria-expanded]')?.focus(); };
  }, [mobile]);
  const [mode,setMode] = useState(record.autoMinutes?.enabled ? 'model' : 'extractive');
  const [template, setTemplate] = useState('meeting'), [draft, setDraft] = useState<MinutesModel | null>(null);
  const [historical, setHistorical] = useState<MinutesModel | null>(null), [historyError, setHistoryError] = useState('');
  const [view,setView] = useState('minutes');
  const [settingsOpen,setSettingsOpen] = useState(false);
  const job = record.jobs.at(-1), running = ['queued', 'running'].includes(job?.status || ''); const minutes = historical || (record.capture === 'completed' ? record.minutes || record.liveMinutes : record.liveMinutes || record.minutes);
  const formal = minutes === record.minutes && Boolean(minutes); const runtime = running ? job?.runtime : minutes?.runtime;
  return <aside ref={panel} role={mobile ? 'dialog' : undefined} aria-modal={mobile || undefined} className="minutes-panel glass" aria-label="会议纪要"><header><div className="heading-icon"><Sparkle size={20}/><h2>会议纪要</h2></div><Button variant="ghost" aria-label="收起纪要" onClick={onClose}><X size={20}/></Button></header>
    <div className="minutes-content"><div className="minutes-control-bar"><Status>{record.autoMinutes?.enabled ? '自动整理已开启' : '手动整理'}</Status><Button variant="ghost" aria-expanded={settingsOpen} aria-controls="minutes-settings" onClick={()=>setSettingsOpen(!settingsOpen)}>{settingsOpen ? '收起设置' : '整理设置'}</Button></div>{settingsOpen && <section id="minutes-settings" className="minutes-settings"><section className="automation-card"><label className="checkbox-label"><input type="checkbox" checked={record.autoMinutes?.enabled || false} disabled={busy} onChange={e => void automate(e.target.checked, record.autoMinutes?.intervalSeconds || 30)}/><span>自动 AI 纪要<small>会中草稿 · 结束后自动整理终稿</small></span></label><Select label="自动纪要刷新间隔" value={String(record.autoMinutes?.intervalSeconds || 30)} disabled={busy || !record.autoMinutes?.enabled} onChange={v => void automate(true,Number(v))} options={[{value:'15',label:'每 15 秒 · 更及时'},{value:'30',label:'每 30 秒 · 推荐'},{value:'60',label:'每 1 分钟'},{value:'120',label:'每 2 分钟'}]}/><p className="fine-print">启用后，转录和笔记会发送到已配置模型；只在内容变化时生成。人工修订后自动暂停覆盖。</p>{record.minutes?.edited && <Status>人工版本已保护</Status>}</section>{record.minuteVersions?.length > 1 && <label className="history-select">纪要版本<Select label="纪要版本" value={String(historical?.revision || record.minutesRevision)} onChange={async value => { const revision = Number(value); setDraft(null); setHistoryError(''); try { setHistorical(revision === record.minutesRevision ? null : await api<MinutesModel>(`/records/${record.id}/minutes/versions/${revision}`)); } catch (e) { setHistoryError(messageOf(e)); } }} options={[...record.minuteVersions].reverse().map(version => ({value:String(version.revision),label:`v${version.revision} · ${version.edited ? '人工修订' : 'AI 草稿'}${version.revision === record.minutesRevision ? ' · 当前' : ''}`}))}/></label>}{historyError && <p role="alert">{historyError}</p>}<div className="minutes-mode"><Select label="纪要处理方式" value={mode} onChange={setMode} options={[{value:'extractive',label:'本地提取 · 无需模型'},{value:'model',label:'AI 整理 · 使用已配置模型'}]}/><p className="fine-print">{mode === 'model' ? '转录与笔记将发送到已配置模型。' : '按规则引用原文，不发送到云端；不等同于 AI 总结。'}</p></div><div className="minutes-toolbar"><label className="sr-only" htmlFor="template">纪要模板</label><Select label="纪要模板" value={template} onChange={setTemplate} options={[{value:'meeting',label:'会议纪要'},{value:'interview',label:'访谈整理'},{value:'lecture',label:'学习笔记'}]}/>
      <Button disabled={busy || running || record.capture !== 'completed'} onClick={() => void generate(template,mode)}><ArrowClockwise size={16}/>{running ? '整理中…' : minutes ? '重新整理' : '生成纪要'}</Button></div>
      </section>}{runtime && <p className="model-timing">{runtime.firstTokenMs != null ? `模型首字 ${(runtime.firstTokenMs/1000).toFixed(1)} 秒` : '等待模型首字'}{runtime.durationMs != null && ` · 完成 ${(runtime.durationMs/1000).toFixed(1)} 秒`}{runtime.streamed === false && ' · 服务端未提供流式响应'}</p>}{running && <section className="streaming-minutes" aria-busy="true"><div className="streaming-status" role="status"><span className="live-dot"/>{job?.scope === 'live' ? '正在归纳会中主题' : '正在整理会议终稿'}</div>{job?.preview?.length ? job.preview.map((block,i) => block.kind === 'title' || block.kind === 'heading' ? <h4 key={i}>{block.text}</h4> : <p key={i}>{block.text}</p>) : <p className="muted">等待模型输出…</p>}<small>实时草稿 · 引用将在完整结果校验后显示</small></section>}{job?.status === 'failed' && <div className="notice error" role="alert">整理未完成（{job.error}）。检查模型配置后可重新生成。</div>}
      {job?.status === 'stale' && <div className="notice">转录或人工内容已变化，本次旧结果已隔离，请重新整理。</div>}
      {minutes && minutes.transcriptRevision !== record.transcriptRevision && <div className="notice">此纪要引用转录 v{minutes.transcriptRevision}，当前为 v{record.transcriptRevision}。请重新核对。</div>}
      {!minutes ? <Empty icon={<Sparkle size={32}/>} title={running ? '正在梳理讨论脉络' : '从讨论，到共识'}>{record.capture === 'completed' ? '选择模板，整理重点与行动候选。每条内容都会保留转录引用。' : '结束录音并完成转录后，即可生成纪要。'}</Empty>
        : <><div className="minutes-title"><h3>{minutes.title}</h3><Status>{minutes.edited ? '人工修订' : minutes.method === 'extractive' ? '本地提取' : !formal ? '会中草稿' : 'AI 草稿'}{formal ? ` · v${minutes.revision}` : ''}</Status></div>
          <div className="actions"><Button disabled={Boolean(historical)} onClick={() => setDraft(structuredClone(minutes))}><PencilSimple size={16}/>修订</Button>{formal && <Download href={`/api/records/${record.id}/export?format=markdown`}><ArrowSquareOut size={16}/>导出</Download>}</div>
          <div className="segmented-control" role="group" aria-label="纪要视图"><button aria-pressed={view==='minutes'} onClick={()=>setView('minutes')}>纪要正文</button><button aria-pressed={view==='topics'} onClick={()=>setView('topics')}>主题树与时长</button></div>{view==='topics' && <TopicMap minutes={minutes}/>}
        {view==='minutes' && (draft || minutes).sections.map((section, sectionIndex) => <section className="minutes-section" key={sectionIndex}><h4>{section.heading}</h4>{section.items.map((item, itemIndex) => <div className="minute-item" key={itemIndex}>
            {draft ? <textarea aria-label={`${section.heading}第 ${itemIndex + 1} 项`} value={item.text} onChange={e => { const next = structuredClone(draft); next.sections[sectionIndex].items[itemIndex].text = e.target.value; setDraft(next); }}/>
              : <p>{item.text}</p>}
            <div className="citations">{item.evidence.map((ref, i) => <button key={i} onClick={() => cite(ref, minutes.evidenceSnapshot)} aria-label={`查看来源 ${i + 1}`}>来源 {i + 1}</button>)}</div>
          </div>)}</section>)}
          {draft && <div className="actions"><Button variant="primary" disabled={busy} onClick={async () => { if (await edit(draft)) setDraft(null); }}><Check size={16}/>保存修订</Button><Button disabled={Boolean(historical)} onClick={() => setDraft(null)}>取消</Button></div>}
          {minutes.actions.length > 0 && <section className="minutes-section"><h4>行动候选</h4><p className="muted">请人工确认负责人和日期。下载不会发送给他人。</p>{minutes.actions.map((action, i) => <div className="action-candidate" key={i}><span className="checkbox-mark"/><div><p>{action.text}</p><small>{action.owner || '负责人待定'} · {action.due || '日期待定'}</small><div className="citations">{action.evidence.map((ref, j) => <button key={j} onClick={() => cite(ref, minutes.evidenceSnapshot)}>来源 {j + 1}</button>)}</div></div></div>)}{formal && <Download href={`/api/records/${record.id}/export?format=ics`}>下载待办日历文件</Download>}</section>}
          {formal && minutes.actions.length > 0 && <Download href={`/api/records/${record.id}/export?format=issues`}>下载工单候选 JSON</Download>}
          <p className="fine-print">AI 可能遗漏或误解。请沿引用核对原文后使用纪要。</p>
        </>}
    </div></aside>;
}
