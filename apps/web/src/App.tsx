import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowSquareOut, Check, CloudCheck, CloudSlash, FileText, GearSix, Microphone, Moon,
  Plus, MagnifyingGlass, ShareNetwork, SignOut, Sparkle, Sun, Trash, WarningCircle, X, CaretRight } from '@phosphor-icons/react';
import { api, messageOf, setCsrf, ApiError } from './api';
import { subscribeToRecord, type ConnectionState } from './record-subscription';
import type { Bootstrap, RecordDetail, RecordListItem, Segment, Minutes, Evidence } from './model';
import { timecode } from './model';
import { Brand } from './components/Brand';
import { ScrollToTop } from './components/ScrollToTop';
import { Select } from './components/Select';
import { AudioPlayer } from './components/AudioPlayer';
import { ProviderSettings } from './components/ProviderSettings';
import { DeviceSettings } from './components/DeviceSettings';
import { MeetingControls } from './components/MeetingControls';
import { MeetingFinish } from './components/MeetingFinish';
import { RecordTitle } from './components/RecordTitle';
import { CaptureSetup } from './components/CaptureSetup';
import { Insights } from './components/Insights';
import { Button, Modal, Status, Empty, Download } from './components/ui';
import { Transcript } from './components/Transcript';
import { MinutesPanel } from './components/Minutes';
import { Notes } from './components/Notes';
import { CaptureController, capabilities, importAudio, type CaptureIssue } from './audio/capture';
import type { CaptureSignal } from './audio/signal';
import { clearRecordAudio, drainQueue, localManifests, pendingCount, setQueueRecords, downloadPendingAudio } from './audio/queue';

function Auth({ ready }: { ready: () => void }) {
  const [register, setRegister] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [development, setDevelopment] = useState<{email:string;password:string|null}|null>(null);
  useEffect(() => { api<{email:string;password:string|null}>('/development-account').then(setDevelopment).catch(() => {}); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); const form = new FormData(event.currentTarget);
    try { const response = await api<{ csrf: string }>(`/auth/${register ? 'register' : 'login'}`, 'POST', Object.fromEntries(form)); setCsrf(response.csrf); ready(); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  return <main className="auth-page"><section className="auth-story"><Brand/>
    <div><p className="kicker">让注意力，回到对话</p><h1>好好听。<br/>值得记住的，<br/><em>交给聆记。</em></h1><p>实时转录，梳理共识。<br/>从一句话，追溯每一个决定。</p></div><span className="auth-foot">浏览器打开即用 · 数据按账户隔离</span></section>
    <section className="auth-card glass"><p className="kicker">你的会议空间</p><h2>{register ? '创建账户' : '欢迎回来'}</h2><p className="muted">{register ? '记录、回看与整理，从这里开始。' : '继续上次的讨论，或开始一场新对话。'}</p>
      <form onSubmit={submit}><label>用户名 / 邮箱<input name="email" type="email" autoComplete="email" required placeholder="you@example.com"/></label><label>密码<input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={10} maxLength={128} required placeholder="至少 10 个字符"/></label>
        {register && <label>邀请码 <span className="muted">如服务要求</span><input name="inviteCode" autoComplete="off"/></label>}
        {error && <p className="notice error" role="alert">{error}</p>}<Button variant="primary" disabled={busy} type="submit">{busy ? '请稍候…' : register ? '创建账户并进入' : '进入会议空间'}<CaretRight size={18}/></Button></form>
      <Button variant="ghost" onClick={() => { setRegister(!register); setError(''); }}>{register ? '已有账户？登录' : '还没有账户？创建一个'}</Button>{development && <div className="development-account"><Status>本地开发账户</Status><p>用户名 <b>{development.email}</b></p><p>密码 <code>{development.password || '使用本机自定义密码'}</code></p>{development.password && <Button onClick={async () => { setBusy(true); try { const d = await api<{csrf:string}>('/auth/login','POST',development); setCsrf(d.csrf); ready(); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); } }}>使用开发账户进入</Button>}</div>}<p className="fine-print">录制前请告知参会者并取得适用的许可。登录不会自动启用麦克风或屏幕共享。</p>
    </section></main>;
}
function SharedView({ token }: { token: string }) {
  const [data, setData] = useState<{ title: string; minutes: Minutes | null; segments?: Segment[] }>(), [error, setError] = useState('');
  useEffect(() => { const load = () => api<typeof data>(`/shared/${token}`).then(setData).catch(e => { setError(messageOf(e)); setData(undefined); }); void load(); const timer = setInterval(load, 15000); return () => clearInterval(timer); }, [token]);
  return <main className="shared-page glass"><Brand/><p className="kicker">聆记 · 只读分享</p>{error ? <p role="alert">{error}</p> : !data ? <p role="status">正在读取分享…</p> : <><h1>{data.title}</h1><p className="muted">内容会随记录更新；链接有效期最长 24 小时。</p>{data.minutes?.sections.map((s, i) => <section key={i}><h2>{s.heading}</h2>{s.items.map((item, j) => <p key={j}>{item.text}</p>)}</section>)}{data.segments && <section><h2>转录</h2>{data.segments.map(s => <p key={s.id}>{s.speaker && `${s.speaker}：`}{s.text}</p>)}</section>}</>}</main>;
}
export default function App() {
  const shared = location.pathname.match(/^\/share\/([A-Za-z0-9_-]+)$/);
  return shared ? <SharedView token={shared[1]}/> : <Workspace/>;
}
function Workspace() {
  const [boot, setBoot] = useState<Bootstrap | null>(null), [authReady, setAuthReady] = useState(false), [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<RecordListItem[]>([]), [query, setQuery] = useState(''), [id, setId] = useState(new URLSearchParams(location.search).get('record') || ''), [record, setRecord] = useState<RecordDetail | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [minutesOpen, setMinutesOpen] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [modal, setModal] = useState<'new' | 'settings' | 'share' | 'delete' | 'import-text' | 'capture' | 'finish' | null>(null), [theme, setTheme] = useState(localStorage.getItem('meeting-theme') || 'light');
  const [signals, setSignals] = useState<CaptureSignal[]>([]);
  const [captureIssues, setCaptureIssues] = useState<CaptureIssue[]>([]);
  const [recording, setRecording] = useState(false), [pending, setPending] = useState(0), [online, setOnline] = useState(navigator.onLine);
  const [highlight, setHighlight] = useState(''), [evidence, setEvidence] = useState<Segment | null>(null), [importProgress, setImportProgress] = useState<number | null>(null);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const stopping = useRef(false), capture = useRef<CaptureController | null>(null), activeId = useRef(''), mounted = useRef(true), fileInput = useRef<HTMLInputElement>(null);
  const [deletions, setDeletions] = useState<{ id: string; cleanup: string }[]>([]);
  const [shares, setShares] = useState<{ id: string; scope: string; expires: number; revoked: boolean }[]>([]), [shareUrl, setShareUrl] = useState('');
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('meeting-theme', theme); }, [theme]);
  const loadBoot = useCallback(async () => {
    setLoading(true); try { const b = await api<Bootstrap>('/bootstrap'); setCsrf(b.csrf); const list = await api<{records: RecordListItem[]}>('/records'); setQueueRecords(list.records.map(r => r.id)); setBoot(b); setAuthReady(true); }
    catch (e) { if (!(e instanceof ApiError && e.status === 401)) setError(messageOf(e)); setAuthReady(false); } finally { setLoading(false); }
  }, []);
  const refreshProviders = useCallback(async () => {
    const next = await api<Bootstrap>('/bootstrap'); setCsrf(next.csrf); setBoot(next);
  }, []);
  useEffect(() => { void loadBoot(); mounted.current = true; return () => { mounted.current = false; void capture.current?.stop(); }; }, [loadBoot]);
  const loadList = useCallback(async () => { const result = await api<{ records: RecordListItem[] }>(`/records?q=${encodeURIComponent(query)}`); setRecords(result.records); }, [query]);
  const refresh = useCallback(async () => {
    const current = activeId.current; if (!current) return;
    const detail = await api<RecordDetail>(`/records/${current}`); if (mounted.current && activeId.current === current) setRecord(detail);
  }, []);
  useEffect(() => {
    if (!authReady) return; const controller = new AbortController(); const timer = setTimeout(() => { api<{ records: RecordListItem[] }>(`/records?q=${encodeURIComponent(query)}`, 'GET', undefined, controller.signal).then(d => setRecords(d.records)).catch(e => { if (e.name !== 'AbortError') setError(messageOf(e)); }); }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, authReady]);
  useEffect(() => {
    activeId.current = id; history.replaceState(null, '', id ? `?record=${encodeURIComponent(id)}` : '/'); setRecord(null); setMinutesOpen(false); setHighlight('');
  }, [id, authReady]);
  useEffect(() => {
    if (!id || !authReady) { setConnectionState('idle'); return; }
    return subscribeToRecord<RecordDetail>({
      recordId: id,
      loadRecord: signal => api<RecordDetail>(`/records/${id}`, 'GET', undefined, signal),
      onRecord: detail => { if (mounted.current && activeId.current === id) setRecord(detail); },
      onState: setConnectionState,
      onFatal: error => { setRecord(null); setError(messageOf(error)); if (error instanceof ApiError && error.status === 401) setAuthReady(false); }
    });
  }, [id, authReady, online]);
  const upload = useCallback(async () => { try { await drainQueue(() => { void pendingCount(activeId.current).then(setPending); }); setPending(await pendingCount(activeId.current)); }
    catch (e) { if (navigator.onLine) setError(messageOf(e)); } }, []);
  useEffect(() => {
    if (!authReady) return; const network = () => { setOnline(navigator.onLine); if (navigator.onLine) void upload(); };
    addEventListener('online', network); addEventListener('offline', network); const timer = setInterval(upload, 2500); void upload();
    return () => { removeEventListener('online', network); removeEventListener('offline', network); clearInterval(timer); };
  }, [authReady, upload]);
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (recording || pending) { event.preventDefault(); event.returnValue = ''; } }; addEventListener('beforeunload', warn); return () => removeEventListener('beforeunload', warn); }, [recording, pending]);
  useEffect(() => { const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setMinutesOpen(false); }; addEventListener('keydown', escape); return () => removeEventListener('keydown', escape); }, []);
  useEffect(() => {
    if (record?.capture === 'completed' && notice === '录音已结束，正在补传和处理剩余片段。可以稍后回来查看。') setNotice('');
  }, [record?.capture, notice]);
  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true); setError(''); try { await api(path, method, body); await Promise.all([method === 'DELETE' && path === `/records/${activeId.current}` ? Promise.resolve() : refresh(), loadList()]); return true; }
    catch (e) { setError(messageOf(e)); return false; } finally { setBusy(false); }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true); setError('');
    try { const r = await api<RecordDetail>('/records', 'POST', { title: form.get('title'), language: form.get('language'), retentionDays: Number(form.get('retentionDays')), retainAudio: form.has('retainAudio'), autoMinutes: form.has('autoMinutes') });
      const list = await api<{records: RecordListItem[]}>('/records'); setQueueRecords(list.records.map(r => r.id)); setId(r.id); setModal(null); await loadList(); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  async function stopCapture(mode: 'pause' | 'seal' = 'seal', title = '') {
    if (stopping.current) return false;
    stopping.current = true; setBusy(true); setError('');
    try {
      await capture.current?.stop(); setRecording(false);
      if (!activeId.current) return false;
      const current = await api<RecordDetail>(`/records/${activeId.current}`), manifests = await localManifests(current.id);
      if (title.trim() && title.trim() !== current.title) await api(`/records/${current.id}`, 'PATCH', {title:title.trim()});
      const saved = await api<RecordDetail>(`/records/${current.id}/${mode}`, 'POST', {
        sources: current.sources.map(source => ({ sourceId: source.id, epoch: source.epoch, lastSequence: source.lastSequence ?? manifests.find(m => m.sourceId === source.id)?.lastSequence ?? source.watermark }))
      });
      setRecord(saved); setModal(null); await upload(); await refresh(); await loadList();
      setNotice(mode === 'pause' ? '已暂停。回来后可继续本场会议。' : '本场会议已结束，剩余音频会继续处理。下一段对话可开启新会议。');
      return true;
    } catch (e) { setError(messageOf(e)); return false; }
    finally { stopping.current = false; setRecording(false); setBusy(false); capture.current = null; }
  }
  function captureAllowed() {
    if (!boot?.providers.asr && !boot?.providers.fixture) { setError('请先在设置中连接转录服务。'); return false; }
    if (!capabilities().secure || !capabilities().worklet) { setError('当前环境不支持安全音频采集，请使用 HTTPS 的现代浏览器或导入文件。'); return false; }
    return true;
  }
  function controllerFor(recordId: string | Promise<string>) {
    return new CaptureController(recordId, () => {}, e => { setError(messageOf(e)); setRecording(false); },
      () => { void upload(); }, () => { void stopCapture('pause'); }, setSignals);
  }
  async function quickRecord() {
    if (recording || busy || !captureAllowed()) return;
    setError(''); setCaptureIssues([]); setBusy(true);
    const created = api<RecordDetail>('/records', 'POST', { autoMinutes: Boolean(boot?.providers.minutes) });
    const controller = capture.current = controllerFor(created.then(next => next.id));
    // Request permissions in this click, before waiting for the new record ID.
    const started = controller.startMeeting();
    try {
      const next = await created;
      activeId.current = next.id; setId(next.id); setRecord(next); setModal(null);
      const list = await api<{records: RecordListItem[]}>('/records');
      setQueueRecords(list.records.map(item => item.id)); setRecords(list.records);
      const issues = await started; setCaptureIssues(issues); setRecording(controller.active);
      if (issues.length) setModal('capture');
      await refresh();
    } catch (e) {
      await started; await controller.stop(); capture.current = null; setRecording(false); setError(messageOf(e));
    } finally { setBusy(false); if (!controller.active) capture.current = null; }
  }
  async function startCapture(kind: 'microphone' | 'display' | 'meeting') {
    if (!record || busy || !captureAllowed()) return;
    if (record.capture === 'sealed' || record.capture === 'completed') { void quickRecord(); return; }
    setError('');
    const controller = capture.current ||= controllerFor(record.id);
    const started = kind === 'meeting' ? controller.startMeeting() : controller.start(kind);
    setBusy(true);
    try {
      const result = await started;
      const issues = kind === 'meeting' ? result as CaptureIssue[] : [];
      setCaptureIssues(issues); setRecording(controller.active);
      if (issues.length) setModal('capture'); else if (modal === 'capture') setModal(null);
    } catch (e) {
      setCaptureIssues([{ kind: kind === 'microphone' ? 'microphone' : 'display', message: messageOf(e) }]);
      setModal('capture'); setRecording(controller.active);
    } finally { setBusy(false); if (controller.active) await refresh().catch(e => setError(messageOf(e))); else capture.current = null; }
  }
  async function onImport(file: File) {
    if (!record) return; setBusy(true); setImportProgress(0); setError('');
    try { await importAudio(file, record, setImportProgress); await stopCapture(); }
    catch (e) { setError(messageOf(e)); await refresh(); } finally { setBusy(false); setImportProgress(null); }
  }
  function cite(ref: Evidence, snapshotOverride?: Segment[]) {
    const snapshot = (snapshotOverride || record?.minutes?.evidenceSnapshot)?.find(s => s.id === ref.segmentId && s.revision === ref.revision);
    setEvidence(snapshot || null); setHighlight(ref.segmentId); document.getElementById(`segment-${ref.segmentId}`)?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  async function openShare() { if (!record) return; setShareUrl(''); setModal('share'); try { setShares((await api<{ shares: typeof shares }>(`/records/${record.id}/shares`)).shares); } catch (e) { setError(messageOf(e)); } }
  if (loading) return <main className="loading-page" role="status"><Brand markOnly/><p>正在打开会议空间…</p></main>;
  if (!authReady || !boot) return <Auth ready={() => void loadBoot()}/>;
  const sourceReady = boot.providers.asr || boot.providers.fixture;
  return <div className="app-shell"><a className="skip-link" href="#workspace">跳到会议内容</a>
    <aside className="sidebar glass"><Brand/>
      <Button variant="primary" className="new-record" onClick={() => void quickRecord()} disabled={recording || busy || !sourceReady}><Plus size={18}/>快速记录</Button>
      <Button className="prepare-record" variant="ghost" onClick={() => setModal('new')} disabled={recording || busy}>提前准备会议</Button>
      <div className="search-box"><MagnifyingGlass size={17}/><input aria-label="搜索所有会议内容" placeholder="搜索会议与内容" value={query} onChange={e => setQuery(e.target.value)}/></div>
      <div className="rail-heading">我的记录 <span>{records.length}</span></div><nav className="record-list" aria-label="会议记录">{records.map(r => <button key={r.id} className={`record-row ${r.id === id ? 'selected' : ''}`} disabled={(recording || busy) && r.id !== id} onClick={() => setId(r.id)}>
        <span className="record-icon">{r.hasMinutes ? <FileText size={18}/> : <Microphone size={18}/>}</span><span><b>{r.title}</b><small>{new Date(r.createdAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {r.capture === 'recording' ? '记录中' : `${Math.ceil(r.seconds / 60)} 分钟`}</small></span><CaretRight size={14}/></button>)}
        {!records.length && <p className="rail-empty">{query ? '没有匹配记录' : '你的第一场对话，值得留住。'}</p>}</nav>
      <footer className="rail-footer"><div className="account"><span className="avatar">{boot.email[0].toUpperCase()}</span><span><b>{boot.email.split('@')[0]}</b><small>个人会议空间</small></span></div><div className="actions"><Button variant="ghost" aria-label="设置与诊断" onClick={() => { setModal('settings'); void api<{deletions: typeof deletions}>('/deletions').then(d => setDeletions(d.deletions)).catch(e => setError(messageOf(e))); }}><GearSix size={19}/></Button><Button variant="ghost" aria-label={theme === 'light' ? '切换深色' : '切换浅色'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={19}/> : <Sun size={19}/>}</Button><Button variant="ghost" aria-label="退出登录" disabled={recording} onClick={async () => { try { await api('/auth/logout', 'POST'); setQueueRecords([]); setAuthReady(false); setId(''); } catch (e) { setError(messageOf(e)); } }}><SignOut size={19}/></Button></div></footer>
    </aside>
    <main id="workspace" className={`workspace ${minutesOpen ? 'with-minutes' : ''}`}><header className="topbar glass"><div><span className="breadcrumb">会议空间</span><CaretRight size={14}/><span>{record ? '记录详情' : '所有记录'}</span></div><div className="sync-state" data-connection-state={connectionState}>{online && (!id || connectionState==='connected') ? <CloudCheck size={18}/> : <CloudSlash size={18}/>}<span>{!online ? '离线 · 本地保留' : !id ? '网络可用' : connectionState!=='connected' ? ({idle:'未连接',connecting:'连接中',reconnecting:'正在重连',offline:'离线',unavailable:'连接不可用'}[connectionState]) : pending ? `${pending} 段待上传` : '已连接'}</span></div></header>
      <div ref={scrollRoot} className="workspace-scroll" tabIndex={0} aria-label="会议内容滚动区">
      {error && <div className="global-message error" role="alert"><WarningCircle size={19}/><span>{error}</span><button aria-label="关闭错误提示" onClick={() => setError('')}><X size={17}/></button></div>}
      {id && connectionState==='reconnecting' && <div className="global-message" role="status"><span>实时连接中断，正在自动重连；本地音频仍会保留。</span></div>}
      {notice && <div className="global-message" role="status"><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice('')}><X size={17}/></button></div>}
      {boot.providers.fixture && <div className="fixture-notice">开发测试模式 · 识别与纪要为测试数据</div>}
      {!id ? <div className="welcome"><p className="kicker">给对话多一点空间</p><h1>专注此刻，<br/><em>记住重要的事。</em></h1><p>不用先起标题，即刻记录对话，把共识与下一步清晰留下。</p><div className="actions"><Button variant="primary" disabled={busy || !sourceReady} onClick={() => void quickRecord()}><Plus size={18}/>即刻聆记</Button><Button onClick={() => { setModal('settings'); void api<{deletions: typeof deletions}>('/deletions').then(d => setDeletions(d.deletions)).catch(e => setError(messageOf(e))); }}><GearSix size={18}/>检查录音环境</Button></div>
        <div className="welcome-features"><div><Microphone size={24}/><h3>声音成为文字</h3><p>麦克风、共享音轨或音频文件。</p></div><div><Sparkle size={24}/><h3>让共识更清楚</h3><p>纪要和行动候选，保留原文引用。</p></div><div><CloudCheck size={24}/><h3>从断点继续</h3><p>本地缓冲、补传与明确保存状态。</p></div></div>
        <p className="fine-print">关闭页面会停止采集。共享来源是否包含音频取决于浏览器、系统与所选来源。</p></div>
        : !record ? <div className="empty" role="status">{connectionState==='unavailable' ? '当前记录无法访问，请重新登录或选择其他记录。' : '正在读取记录…'}</div> : <><div className="record-heading"><div><p className="kicker">{new Date(records.find(r => r.id === id)?.createdAt || Date.now()).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
          <RecordTitle key={record.id} title={record.title} save={async title => { const saved = await mutate(`/records/${id}`, 'PATCH', {title}); if (saved) { await loadList(); setNotice('会议标题已保存。'); } return saved; }}/><div className="record-meta"><Status tone={recording ? 'live' : ''}>{recording ? '正在记录' : record.capture === 'completed' ? '已完成' : record.capture === 'sealed' ? '整理中' : record.capture === 'paused' ? '已暂停' : '待开始'}</Status><span>{timecode(record.usage.samples / 16)} 音频 · 转录 v{record.transcriptRevision}</span><span>{record.retentionDays} 天留存</span></div></div>
          <div className="actions"><Button disabled={!record.minutes || recording} onClick={() => void openShare()}><ShareNetwork size={17}/><span>分享</span></Button><Button aria-expanded={minutesOpen} onClick={() => setMinutesOpen(!minutesOpen)}><Sparkle size={17}/>纪要</Button><Button variant="ghost" aria-label="删除本次记录" disabled={recording} onClick={() => setModal('delete')}><Trash size={18}/></Button></div></div>
        <MeetingControls record={record} recording={recording} busy={busy} ready={sourceReady} signals={signals}
        start={kind => void startCapture(kind)} quick={() => void quickRecord()} sources={() => setModal('capture')}
        finish={() => { setError(''); setModal('finish'); }} importAudio={() => fileInput.current?.click()}/>
      {!sourceReady && <div className="notice">语音服务尚未配置。维护者配置服务后即可录音；现在可以<Button variant="ghost" onClick={() => setModal('import-text')}>导入已有转录</Button>体验整理流程。</div>}
        {!recording && <div className="sub-actions">{!['sealed','completed'].includes(record.capture) && <Button variant="ghost" onClick={() => setModal('import-text')}><FileText size={16}/>导入文字</Button>}<Download href={`/api/records/${id}/export?format=json`}><ArrowDown size={15}/>备份记录</Download></div>}
        {importProgress !== null && <div className="notice" role="status">正在解码与保存音频：{Math.round(importProgress * 100)}%</div>}
        {record.capture === 'recording' && !recording && <div className="notice">检测到上次未结束的采集。可继续录音，或封存本机已保存的片段。<Button disabled={busy} onClick={() => setModal('finish')}>整理本场记录</Button></div>}
        {['blocked', 'failed'].includes(record.transcription) && <div className="notice error">语音处理受阻，音频仍在保存期内。检查服务配置后<Button disabled={busy} onClick={() => void mutate(`/records/${id}/retry`, 'POST')}>重新处理</Button></div>}
        {record.pendingChunks > 0 && <div className="processing-line" role="status">正在处理音频 · {record.pendingChunks} 个音频包<span>音频包会合并识别为发言，不代表待识别的语音段落</span></div>}
        <Insights record={record} cite={cite} modelReady={boot.providers.minutes} analyze={() => void mutate(`/records/${id}/insights`, 'POST', {})}/>{record.capture === 'completed' && record.usage.samples > 0 && record.pendingChunks === 0 && record.segments.length === 0 && <div className="notice audio-empty-result" role="status">音频已处理完成，但未识别出可用语音。请检查麦克风输入、系统权限或共享音轨，再开始一段试录。</div>}<Transcript key={`transcript:${record.id}`} record={record} highlighted={highlight} save={async (s, text, speaker) => { return mutate(`/records/${id}/segments/${s.id}`, 'PATCH', { revision: s.revision, text, speaker }); }}/>
        <Notes key={`notes:${record.id}`} record={record} save={async (notes, notesRevision) => { return mutate(`/records/${id}`, 'PATCH', { notes, notesRevision }); }}/>
        {record.retainAudio && record.capture === 'completed' && !record.audioPurged && <section className="audio-replay"><h2>原音回放</h2>{record.sources.map(source => <div key={source.id}><p className="audio-source-label">{source.label}</p><AudioPlayer src={`/api/records/${id}/audio/${source.id}`} label={`${source.label}原音回放`}/></div>)}</section>}<footer className="record-footer"><span>{record.audioPurged ? '临时原音已清理' : record.retainAudio ? '原音随记录留存' : '转录完成后清理临时原音'} · {new Date(record.deleteAt).toLocaleDateString('zh-CN')} 到期</span><Download href={`/api/records/${id}/export?format=markdown`}>导出 Markdown<ArrowSquareOut size={15}/></Download></footer>
      </>}
      </div>
      {record && minutesOpen && <MinutesPanel automate={async (enabled, intervalSeconds) => { await mutate(`/records/${id}/automation`, 'PATCH', {enabled,intervalSeconds}); }} record={record} busy={busy} onClose={() => setMinutesOpen(false)} cite={cite} generate={async (template,mode) => { await mutate(`/records/${id}/minutes`, 'POST', { template,mode }); }} edit={async minutes => { return mutate(`/records/${id}/minutes`, 'PATCH', { revision: minutes.revision, minutes }); }}/>}
    <ScrollToTop root={scrollRoot}/></main><input ref={fileInput} className="sr-only" type="file" accept="audio/*" aria-label="导入音频文件" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void onImport(file); }}/>
  {modal === 'capture' && <CaptureSetup connected={signals.map(source => source.kind)} signals={signals} issues={captureIssues} busy={busy} onRetry={() => void startCapture('meeting')} onClose={() => setModal(null)}/>}
    {modal === 'finish' && record && <MeetingFinish title={record.title} paused={record.capture === 'paused'} busy={busy} error={error} pause={title => void stopCapture('pause',title)} finish={title => void stopCapture('seal',title)} close={() => setModal(null)}/>}
    {modal === 'new' && <Modal title="新建一段记录" onClose={() => setModal(null)}><form onSubmit={create}><label>记录标题 <span className="muted">可稍后填写</span><input autoFocus name="title" maxLength={160} placeholder="例如：产品周会"/></label><div className="form-grid"><label>主要语言<Select label="主要语言" name="language" options={[{"value": "zh", "label": "中文"}, {"value": "en", "label": "English"}, {"value": "ja", "label": "日本語"}]}/></label><label>记录留存<Select label="记录留存" name="retentionDays" defaultValue="30" options={[{"value": "1", "label": "1 天"}, {"value": "7", "label": "7 天"}, {"value": "30", "label": "30 天"}, {"value": "90", "label": "90 天"}]}/></label></div><label className="checkbox-label"><input type="checkbox" name="autoMinutes" defaultChecked={boot.providers.minutes} disabled={!boot.providers.minutes}/><span>自动生成 AI 纪要<small>会中持续归纳主题，停止后整理终稿；转录和笔记将发送到已配置模型。</small></span></label><label className="checkbox-label"><input type="checkbox" name="retainAudio"/>保留原始音频至记录到期</label><p className="fine-print">默认只保留处理所需的临时音频，完成转录后清理；失败片段最长保留 24 小时。以上设置不替代参会者知情与录音许可。</p><Button disabled={busy} variant="primary" type="submit"><Plus size={18}/>创建记录</Button></form></Modal>}
    {modal === 'settings' && <Modal title="设置与录音环境" onClose={() => setModal(null)}>{boot.canConfigure && <ProviderSettings saved={refreshProviders}/>}<DeviceSettings disabled={recording}/><div className="settings-section"><h3>浏览器能力检测</h3><dl className="capability-list">{Object.entries(capabilities()).filter(([k]) => k !== 'browser').map(([key, value]) => <div key={key}><dt>{{ secure: '安全环境', microphone: '麦克风 API', display: '共享来源 API', worklet: '音频处理', indexedDB: '本地补传存储', online: '网络连接' }[key]}</dt><dd>{value ? <Check size={17}/> : <X size={17}/>}</dd></div>)}</dl><p className="fine-print">API 可用不代表所选来源有声音。请在真实会议前试录并核对转录。浏览器无法保证关页或休眠后持续录音。</p></div>
      {deletions.length > 0 && <div className="settings-section"><h3>删除清理</h3><p>已禁访 {deletions.length} 条记录 · 物理清理完成 {deletions.filter(d => d.cleanup === 'completed').length} 条 · 等待清理 {deletions.filter(d => d.cleanup !== 'completed').length} 条</p><p className="fine-print">清理需要后台处理器运行，不包含服务外的备份副本。</p></div>}{record && <div className="settings-section"><h3>本次同步翻译</h3><label>目标语言<Select label="翻译目标语言" value={record.translationTarget || ''} onChange={value => void mutate(`/records/${id}`, 'PATCH', { translationTarget: value })} options={[{"value": "", "label": "关闭"}, {"value": "en", "label": "English"}, {"value": "zh", "label": "中文"}, {"value": "ja", "label": "日本語"}, {"value": "es", "label": "Español"}]}/></label><p className="fine-print">新片段通过纪要模型翻译；失败不影响转录保存。</p></div>}
      <div className="settings-section"><h3>使用与诊断</h3>{record && <Button onClick={() => void downloadPendingAudio(record.id).catch(e => setError(messageOf(e)))}>下载本机待传音频备份</Button>}<p>每条记录最多两小时音频，每账户最多 200 条记录。多音轨分别计量。</p>{record && <p>本次音频 {Math.ceil(record.usage.samples / 16000)} 秒 · 模型 {record.usage.llmTokens} tokens</p>}<p className="fine-print">以上为本地计量，并非供应商账单。诊断文件不含音频、正文、邮箱或密钥。</p><Button onClick={() => { const blob = new Blob([JSON.stringify({ capabilities: capabilities(), storage: boot.storage, providers: boot.providers, pending, capture: record?.capture, transcription: record?.transcription }, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'meeting-diagnostics.json'; link.click(); URL.revokeObjectURL(url); }}>下载诊断信息</Button></div></Modal>}
    {modal === 'delete' && record && <Modal title="删除这条记录？" onClose={() => setModal(null)}><p>“{record.title}”将立即停止访问，分享链接与旧处理任务失效；后台随后清理原音。</p><div className="actions"><Button variant="danger" disabled={busy} onClick={async () => { const deletedId = id; if (await mutate(`/records/${id}`, 'DELETE')) { setId(''); setModal(null); try { await clearRecordAudio(deletedId); } catch { setError('云端已禁访；本机音频缓冲清理失败，请在浏览器设置中清理此站点数据。'); } await loadList(); } }}>删除记录</Button><Button onClick={() => setModal(null)}>保留记录</Button></div></Modal>}
    {modal === 'import-text' && record && <Modal title="导入已有转录" onClose={() => setModal(null)} wide><form onSubmit={async e => { e.preventDefault(); const text = new FormData(e.currentTarget).get('text'); if (await mutate(`/records/${id}/import-text`, 'POST', { text })) setModal(null); }}><label>转录正文<textarea name="text" rows={12} required maxLength={100000} placeholder="按自然段粘贴已有转录。导入文本不会生成虚构的音频时间。"/></label><Button disabled={busy} variant="primary" type="submit">导入文字</Button></form></Modal>}
    {modal === 'share' && record && <Modal title="分享会议内容" onClose={() => setModal(null)}><p className="muted">任何持有链接的人都可阅读选定内容。24 小时后失效，可随时撤销。</p><form onSubmit={async e => { e.preventDefault(); const scope = new FormData(e.currentTarget).get('scope'); try { const share = await api<{ token: string }>(`/records/${id}/shares`, 'POST', { scope }); setShareUrl(`${location.origin}/share/${share.token}`); setShares((await api<{ shares: typeof shares }>(`/records/${id}/shares`)).shares); } catch (e) { setError(messageOf(e)); } }}><label>分享范围<Select label="分享范围" name="scope" options={[{"value": "minutes", "label": "仅纪要（含引用快照）"}, {"value": "full", "label": "纪要与全部转录"}]}/></label><Button type="submit" variant="primary">生成分享链接</Button></form>
      {shareUrl && <div className="share-result"><label>分享链接<input readOnly value={shareUrl} onFocus={e => e.target.select()}/></label><Button onClick={async () => { try { await navigator.clipboard.writeText(shareUrl); setNotice('链接已复制。'); } catch { setNotice('自动复制未成功，请选中链接手动复制。'); } }}>复制链接</Button></div>}
      <h3>已生成的链接</h3>{shares.filter(s => !s.revoked).map(s => <div key={s.id} className="share-row"><span>{s.scope === 'minutes' ? '仅纪要' : '完整转录'} · {new Date(s.expires).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 到期</span><Button onClick={async () => { if (await mutate(`/records/${id}/shares/${s.id}`, 'DELETE')) setShares(shares.map(item => item.id === s.id ? { ...item, revoked: true } : item)); }}>撤销</Button></div>)}</Modal>}
    {evidence && <Modal title="纪要引用的原文" onClose={() => setEvidence(null)}><Status>片段 v{evidence.revision}</Status><p className="evidence-quote">{evidence.text}</p><p className="fine-print">这是生成纪要时的转录快照，可能与当前人工修订版本不同。</p></Modal>}
  </div>;
}
