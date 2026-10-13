import { useClientUpdates } from './useClientUpdates';
import { ClientUpdatesPanel } from './components/ClientUpdates';
import { useNativeMenuBar } from './useNativeMenuBar';
import { trace, traceCommit } from './telemetry';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowSquareOut, Folder, FolderPlus, House, Check, CloudCheck, CloudSlash, FileText, GearSix, Microphone, Moon,
  Plus, Translate, MagnifyingGlass, ShareNetwork, SignOut, Sparkle, Sun, Trash, WarningCircle, X, CaretRight } from '@phosphor-icons/react';
import { api, messageOf, setCsrf, setAudioTransport, ApiError } from './api';
import { applyRecordDelta, subscribeToRecord, type ConnectionState } from './record-subscription';
import type { Bootstrap, RecordDetail, RecordListItem, Segment, Minutes, Evidence } from './model';
import { timecode } from './model';
import type { WorkspaceDirectory } from './workspace-model';
import { WorkspaceHome } from './components/WorkspaceHome';
import { WorkspaceEditor, ArchiveRecords } from './components/WorkspaceDialogs';
import { Toast } from './components/Toast';
import { Brand } from './components/Brand';
import { ScrollToTop } from './components/ScrollToTop';
import { Select } from './components/Select';
import { RecordingPlayback } from './components/RecordingPlayback';
import { ProviderSettings } from './components/ProviderSettings';
import { TranslationSettings } from './components/TranslationSettings';
import { DeviceSettings } from './components/DeviceSettings';
import { MeetingControls } from './components/MeetingControls';
import { MeetingFinish } from './components/MeetingFinish';
import { RecordTitle } from './components/RecordTitle';
import { CaptureSetup } from './components/CaptureSetup';
import { Button, Modal, Status, Empty, Download } from './components/ui';
import { TranslationPanel } from './components/TranslationPanel';
import { MinutesPanel } from './components/Minutes';
import { CurrentDiscussion } from './components/CurrentDiscussion';
import { Notes } from './components/Notes';
import { CaptureController, capabilities, importAudio, type CaptureIssue } from './audio/controller';
import type { CaptureSignal } from './audio/signal';
import { clearRecordAudio, setLocalQueueBackend, drainQueue, localManifests, pendingCount, setQueueRecords, downloadPendingAudio } from './audio/queue';

function Auth({ ready }: { ready: () => Promise<boolean> }) {
  const [register, setRegister] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [development, setDevelopment] = useState<{email:string;password:string|null}|null>(null);
  const submitting = useRef(false);
  useEffect(() => { api<{email:string;password:string|null}>('/development-account').then(setDevelopment).catch(() => {}); }, []);
  async function authenticate(path: string, body: unknown) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const response = await api<{csrf:string}>(path, 'POST', body); setCsrf(response.csrf);
      if (!await ready()) setError('会议空间暂未加载，请重试。');
    } catch (e) { setError(messageOf(e)); }
    finally { submitting.current = false; setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    return authenticate(`/auth/${register ? 'register' : 'login'}`, Object.fromEntries(new FormData(event.currentTarget)));
  }
  return <main className="auth-page"><section className="auth-story"><Brand/>
    <div><p className="kicker">让注意力，回到对话</p><h1>好好听。<br/>值得记住的，<br/><em>交给聆记。</em></h1><p>实时转录，梳理共识。<br/>从一句话，追溯每一个决定。</p></div><span className="auth-foot">浏览器打开即用 · 数据按账户隔离</span></section>
    <section className="auth-card glass"><p className="kicker">你的会议空间</p><h2>{register ? '创建账户' : '欢迎回来'}</h2><p className="muted">{register ? '记录、回看与整理，从这里开始。' : '继续上次的讨论，或开始一场新对话。'}</p>
      <form onSubmit={submit}><label>用户名 / 邮箱<input name="email" type="email" autoComplete="email" required placeholder="you@example.com"/></label><label>密码<input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={10} maxLength={128} required placeholder="至少 10 个字符"/></label>
        {register && <label>邀请码 <span className="muted">如服务要求</span><input name="inviteCode" autoComplete="off"/></label>}
        {error && <p className="notice error" role="alert">{error}</p>}<Button variant="primary" disabled={busy} type="submit">{busy ? '请稍候…' : register ? '创建账户并进入' : '进入会议空间'}<CaretRight size={18}/></Button></form>
      <Button variant="ghost" disabled={busy} onClick={() => { setRegister(!register); setError(''); }}>{register ? '已有账户？登录' : '还没有账户？创建一个'}</Button>{development && <div className="development-account"><Status>本地开发账户</Status><p>用户名 <b>{development.email}</b></p><p>密码 <code>{development.password || '使用本机自定义密码'}</code></p>{development.password && <Button disabled={busy} onClick={() => authenticate('/auth/login', development)}>使用开发账户进入</Button>}</div>}<p className="fine-print">录制前请告知参会者并取得适用的许可。登录不会自动启用麦克风或屏幕共享。</p>
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
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [translationOpen, setTranslationOpen] = useState(false);
  const [workspaceToast,setWorkspaceToast] = useState('');
  const dismissWorkspaceToast=useCallback(()=>setWorkspaceToast(''),[]);
  const [directories,setDirectories] = useState<WorkspaceDirectory[]>([]), [scope,setScope] = useState(() => { const value=new URLSearchParams(location.search).get('workspace') || 'all'; return /^(all|[a-f0-9-]{36})$/.test(value) ? value : 'all'; });
  const [archiveIds,setArchiveIds] = useState<string[]>([]), [archiveInitial,setArchiveInitial] = useState<string|null>(null), [editingDirectory,setEditingDirectory] = useState<WorkspaceDirectory|undefined>(), [homeVersion,setHomeVersion] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [modal, setModal] = useState<'new' | 'settings' | 'share' | 'delete' | 'import-text' | 'capture' | 'finish' | 'directory' | 'archive' | null>(null), [theme, setTheme] = useState(localStorage.getItem('meeting-theme') || 'light');
  const [signals, setSignals] = useState<CaptureSignal[]>([]);
  const [captureIssues, setCaptureIssues] = useState<CaptureIssue[]>([]);
  const [recording, setRecording] = useState(false), [pending, setPending] = useState(0), [online, setOnline] = useState(navigator.onLine);
  const localBackend = Boolean(boot?.localAccount);
  const [, setHighlight] = useState(''), [evidence, setEvidence] = useState<Segment | null>(null), [importProgress, setImportProgress] = useState<number | null>(null);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const stopping = useRef(false), capture = useRef<CaptureController | null>(null), activeId = useRef(''), mounted = useRef(true), fileInput = useRef<HTMLInputElement>(null);
  const [deletions, setDeletions] = useState<{ id: string; cleanup: string }[]>([]);
  const [shares, setShares] = useState<{ id: string; scope: string; expires: number; revoked: boolean }[]>([]), [shareUrl, setShareUrl] = useState('');
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('meeting-theme', theme); }, [theme]);
  useNativeMenuBar({ authenticated: authReady, recordTitle: record?.title || '', capture: record?.capture || 'idle', recording, busy: busy || stopping.current,
    connection: !online && !localBackend ? 'offline' : !id ? 'idle' : connectionState }, {
    pause: () => { if (!stopping.current) void stopCapture('pause'); },
    resume: () => { void startCapture('meeting'); },
    finish: () => { setError(''); setModal('finish'); },
    settings: () => { setModal('settings'); void api<{deletions: typeof deletions}>('/deletions').then(d => setDeletions(d.deletions)).catch(e => setError(messageOf(e))); }
  });
  const updates = useClientUpdates({ authenticated: authReady, recording, paused: record?.capture === 'paused', busy: busy || stopping.current });
  const bootRequest = useRef<Promise<boolean> | null>(null);
  const loadBoot = useCallback(() => {
    if (bootRequest.current) return bootRequest.current;
    const request = (async () => {
    setError(''); try { const b = await api<Bootstrap>('/bootstrap'); setCsrf(b.csrf); setAudioTransport(b.audioTransport); setLocalQueueBackend(Boolean(b.localAccount)); const list = await api<{records: RecordListItem[]}>('/records'); setQueueRecords(list.records.map(r => r.id)); const folders=await api<{workspaces:WorkspaceDirectory[]}>('/workspaces');setDirectories(folders.workspaces); setBoot(b); setAuthReady(true); return true; }
    catch (e) { if (!(e instanceof ApiError && e.status === 401)) setError(messageOf(e)); setAuthReady(false); return false; } finally { setLoading(false); }
    })();
    bootRequest.current = request;
    void request.then(() => { if (bootRequest.current === request) bootRequest.current = null; });
    return request;
  }, []);
  const refreshProviders = useCallback(async () => {
    const next = await api<Bootstrap>('/bootstrap'); setCsrf(next.csrf); setAudioTransport(next.audioTransport); setLocalQueueBackend(Boolean(next.localAccount)); setBoot(next);
  }, []);
  useEffect(() => { void loadBoot(); mounted.current = true; return () => { mounted.current = false; void capture.current?.stop(); }; }, [loadBoot]);
  const loadList = useCallback(async () => { const result = await api<{ records: RecordListItem[] }>(`/records?q=${encodeURIComponent(query)}&workspace=${encodeURIComponent(scope)}`); setRecords(result.records); }, [query,scope]);
  const refresh = useCallback(async () => {
    const current = activeId.current; if (!current) return;
    const detail = await api<RecordDetail>(`/records/${current}`); if (mounted.current && activeId.current === current) setRecord(detail);
  }, []);
  useEffect(() => {
    if (!authReady) return; const controller = new AbortController(); const timer = setTimeout(() => { api<{ records: RecordListItem[] }>(`/records?q=${encodeURIComponent(query)}&workspace=${encodeURIComponent(scope)}`, 'GET', undefined, controller.signal).then(d => setRecords(d.records)).catch(e => { if (e.name !== 'AbortError') setError(messageOf(e)); }); }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, scope, authReady]);
  useEffect(() => {
    if (activeId.current !== id || !authReady) { void capture.current?.stop(); capture.current = null; setSignals([]); }
    activeId.current = id; setRecord(null); setTranslationOpen(false); setHighlight('');
  }, [id, authReady]);
  useEffect(() => { const params=new URLSearchParams({workspace:scope});if(id)params.set('record',id); history.replaceState(null,'',`?${params}`); }, [id,scope]);
  useEffect(() => {
    if (!id || !authReady) { setConnectionState('idle'); return; }
    return subscribeToRecord<RecordDetail>({
      recordId: id, localBackend,
      applyDelta: applyRecordDelta,
      loadRecord: signal => api<RecordDetail>(`/records/${id}`, 'GET', undefined, signal),
      onRecord: detail => { if (mounted.current && activeId.current === id){trace('view.received',{recordId:detail.id,cursor:detail.cursor});setRecord(detail);} },
      onState: setConnectionState,
      onFatal: error => { setRecord(null); setError(messageOf(error)); if (error instanceof ApiError && error.status === 401) setAuthReady(false); }
    });
  }, [id, authReady, online, localBackend]);
  const upload = useCallback(async () => { try { await drainQueue(() => { void pendingCount(activeId.current).then(setPending); }); setPending(await pendingCount(activeId.current)); }
    catch (e) { if (navigator.onLine || localBackend) setError(messageOf(e)); } }, []);
  useEffect(() => {
    if (!authReady) return; const network = () => { setOnline(navigator.onLine); if (navigator.onLine || localBackend) void upload(); };
    addEventListener('online', network); addEventListener('offline', network); const timer = setInterval(upload, 2500); void upload();
    return () => { removeEventListener('online', network); removeEventListener('offline', network); clearInterval(timer); };
  }, [authReady, upload, localBackend]);
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (recording || pending) { event.preventDefault(); event.returnValue = ''; } }; addEventListener('beforeunload', warn); return () => removeEventListener('beforeunload', warn); }, [recording, pending]);
  useEffect(() => { const escape = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) setTranslationOpen(false); }; addEventListener('keydown', escape); return () => removeEventListener('keydown', escape); }, []);
  useEffect(() => { if(record) traceCommit(record.id,record.cursor); }, [record?.cursor]);
  useEffect(() => {
    if (record?.capture === 'completed' && notice === '录音已结束，正在补传和处理剩余片段。可以稍后回来查看。') setNotice('');
  }, [record?.capture, notice]);
  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true); setError(''); try { await api(path, method, body); await Promise.all([method === 'DELETE' && path === `/records/${activeId.current}` ? Promise.resolve() : refresh(), loadList()]); return true; }
    catch (e) { setError(messageOf(e)); return false; } finally { setBusy(false); }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true); setError('');
    try { const r = await api<RecordDetail>('/records', 'POST', { workspaceId: scope==='all'?null:scope, title: form.get('title'), language: form.get('language'), retentionDays: Number(form.get('retentionDays')), retainAudio: form.has('retainAudio'), autoMinutes: form.has('autoMinutes') });
      const list = await api<{records: RecordListItem[]}>('/records'); setQueueRecords(list.records.map(r => r.id)); await loadList(); setId(r.id); setModal(null); await loadList(); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  async function stopCapture(mode: 'pause' | 'seal' = 'seal', title = '') {
    if (stopping.current) return false;
    stopping.current = true; setBusy(true); setError('');
    try {
      const controller = capture.current;
      if (mode === 'pause' && controller && 'pause' in controller) await controller.pause();
      else await controller?.stop();
      setRecording(false);
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
    finally { stopping.current = false; setRecording(false); setBusy(false); if (mode === 'seal') capture.current = null; }
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
    void capture.current?.stop(); capture.current = null;
    const created = api<RecordDetail>('/records', 'POST', { workspaceId: scope==='all'?null:scope, autoMinutes: Boolean(boot?.providers.minutes) });
    const controller = capture.current = controllerFor(created.then(next => next.id));
    // Request permissions in this click, before waiting for the new record ID.
    const started = controller.startMeeting();
    try {
      const next = await created;
      activeId.current = next.id; setId(next.id); setRecord(next); setModal(null);
      const list = await api<{records: RecordListItem[]}>('/records');
      setQueueRecords(list.records.map(item => item.id)); await loadList();
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
    setError(''); setNotice('');
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
  async function toggleMicrophone() {
    if (busy) return;
    const controller = capture.current;
    if (!controller?.sources.some(source => source.kind === 'microphone')) { await startCapture('microphone'); return; }
    setBusy(true); setError('');
    try {
      await controller.disconnect('microphone');
      if (!controller.active) await stopCapture('pause');
      else setNotice('麦克风已关闭，继续记录系统／会议音频。');
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  async function onImport(file: File) {
    if (!record) return; setBusy(true); setImportProgress(0); setError('');
    try { await importAudio(file, record, setImportProgress); await stopCapture(); }
    catch (e) { setError(messageOf(e)); await refresh(); } finally { setBusy(false); setImportProgress(null); }
  }
  function cite(ref: Evidence, snapshotOverride?: Segment[]) {
    window.dispatchEvent(new Event('meeting:pause-follow'));
    const snapshot = (snapshotOverride || record?.minutes?.evidenceSnapshot)?.find(s => s.id === ref.segmentId && s.revision === ref.revision);
    setEvidence(snapshot || null); setHighlight(ref.segmentId); document.getElementById(`segment-${ref.segmentId}`)?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  async function openShare() { if (!record) return; setShareUrl(''); setModal('share'); try { setShares((await api<{ shares: typeof shares }>(`/records/${record.id}/shares`)).shares); } catch (e) { setError(messageOf(e)); } }
  const directoryName = scope==='all'?'所有会议':directories.find(w=>w.id===scope)?.name || '工作目录';
  const chooseScope = (next:string) => { setScope(next);setId('');setQuery('');scrollRoot.current?.scrollTo({top:0,behavior:'instant'}); };
  const newDirectory = () => {setEditingDirectory(undefined);setModal('directory');};
  const openArchive = (ids:string[]) => {setArchiveIds(ids);setArchiveInitial(record?.workspaceId || (scope==='all'?null:scope));setModal('archive');};
  async function saveDirectory(name:string,description:string) {
    try {
      const directory=await api<WorkspaceDirectory>(editingDirectory?`/workspaces/${editingDirectory.id}`:'/workspaces',editingDirectory?'PATCH':'POST',{name,description});
      const list=await api<{workspaces:WorkspaceDirectory[]}>('/workspaces');setDirectories(list.workspaces);setHomeVersion(v=>v+1);setWorkspaceToast(editingDirectory?'目录已保存。':'工作目录已创建。');
      if(archiveIds.length){setArchiveInitial(directory.id);setModal('archive');}else{setModal(null);chooseScope(directory.id);}
    }catch(e){throw new Error(messageOf(e));}
  }
  async function saveArchive(workspaceId:string|null) {
    try {await api('/workspaces/archive','POST',{recordIds:archiveIds,workspaceId});await Promise.all([loadList(),refresh()]);setHomeVersion(v=>v+1);setWorkspaceToast(`已归档 ${archiveIds.length} 场会议。`);setArchiveIds([]);setModal(null);}catch(e){throw new Error(messageOf(e));}
  }
  if (loading) return <main className="loading-page" role="status"><Brand markOnly/><p>正在打开会议空间…</p></main>;
  if (!authReady || !boot) return <Auth ready={loadBoot}/>;
  const sourceReady = boot.providers.asr || boot.providers.fixture;
  return <div className="app-shell"><a className="skip-link" href="#workspace">跳到会议内容</a>
    <aside className="sidebar glass"><Brand/>
      <Button variant="primary" className="new-record" onClick={() => void quickRecord()} disabled={recording || busy || !sourceReady}><Plus size={18}/>快速记录</Button>
      <Button className="prepare-record" variant="ghost" onClick={() => setModal('new')} disabled={recording || busy}>提前准备会议</Button>
      <div className="workspace-switch"><div><span>工作目录</span><Button variant="ghost" aria-label="新建工作目录" onClick={newDirectory} disabled={recording||busy}><FolderPlus size={17}/></Button></div><Select label="选择工作目录" value={scope} onChange={chooseScope} disabled={recording||busy} options={[{value:'all',label:'所有会议'},...directories.map(w=>({value:w.id,label:w.name}))]}/><Button className={`directory-home-link ${!id?'selected':''}`} variant="ghost" disabled={recording||busy} onClick={()=>chooseScope(scope)}><House size={16}/>目录概览</Button></div>
      <div className="rail-heading">我的记录 <span>{records.length}</span></div><nav className="record-list" aria-label="会议记录">{records.map(r => <button key={r.id} className={`record-row ${r.id === id ? 'selected' : ''}`} disabled={(recording || busy) && r.id !== id} onClick={() => setId(r.id)}>
        <span className="record-icon">{r.hasMinutes ? <FileText size={18}/> : <Microphone size={18}/>}</span><span><b>{r.title}</b><small>{new Date(r.createdAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {r.capture === 'recording' ? '记录中' : `${Math.ceil(r.seconds / 60)} 分钟`}</small></span><CaretRight size={14}/></button>)}
        {!records.length && <p className="rail-empty">{query ? '没有匹配记录' : '你的第一场对话，值得留住。'}</p>}</nav>
      <footer className="rail-footer"><div className="account"><span className="avatar">{localBackend ? '聆' : boot.email[0].toUpperCase()}</span><span><b>{localBackend ? '本机空间' : boot.email.split('@')[0]}</b><small>个人会议空间</small></span></div><div className="actions"><Button variant="ghost" aria-label="设置与诊断" onClick={() => { setModal('settings'); void api<{deletions: typeof deletions}>('/deletions').then(d => setDeletions(d.deletions)).catch(e => setError(messageOf(e))); }}><GearSix size={19}/></Button><Button variant="ghost" aria-label={theme === 'light' ? '切换深色' : '切换浅色'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={19}/> : <Sun size={19}/>}</Button>{!boot.localAccount && <Button variant="ghost" aria-label="退出登录" disabled={recording} onClick={async () => { try { await api('/auth/logout', 'POST'); setQueueRecords([]); setAuthReady(false); setId(''); } catch (e) { setError(messageOf(e)); } }}><SignOut size={19}/></Button>}</div></footer>
    </aside>
    <main id="workspace" className={`workspace ${translationOpen ? 'with-translation' : ''}`}><header className="topbar glass"><div className="workspace-breadcrumb"><button className="breadcrumb" disabled={recording||busy} onClick={()=>chooseScope(scope)}>{directoryName}</button><CaretRight size={14}/><span>{record ? '记录详情' : '目录概览'}</span></div><div className="search-box topbar-search"><MagnifyingGlass size={18}/><input type="search" aria-label="搜索当前目录会议内容" placeholder="搜索当前目录的会议、纪要与内容" value={query} onChange={e => setQuery(e.target.value)}/></div><div className="sync-state" data-connection-state={connectionState}>{(online || localBackend) && (!id || connectionState==='connected') ? <CloudCheck size={18}/> : <CloudSlash size={18}/>}<span>{localBackend && (!id || connectionState==='connected') ? (pending ? `${pending} 段待保存` : online ? '本机已连接' : '本机已连接 · 云端离线') : !online && !localBackend ? '离线 · 本地保留' : !id ? '网络可用' : connectionState!=='connected' ? ({idle:'未连接',connecting:'连接中',reconnecting:'正在重连',offline:'离线',unavailable:'连接不可用'}[connectionState]) : pending ? `${pending} 段待上传` : '已连接'}</span><ScrollToTop root={scrollRoot}/></div></header>
      <div className="workspace-body"><div ref={scrollRoot} className="workspace-scroll" tabIndex={0} aria-label="会议内容滚动区">
      {error && <div className="global-message error" role="alert"><WarningCircle size={19}/><span>{error}</span><button aria-label="关闭错误提示" onClick={() => setError('')}><X size={17}/></button></div>}
      {id && connectionState==='reconnecting' && <div className="global-message" role="status"><span>实时连接中断，正在自动重连；本地音频仍会保留。</span></div>}
      {notice && <div className="global-message" role="status"><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice('')}><X size={17}/></button></div>}
      {boot.providers.fixture && <div className="fixture-notice">开发测试模式 · 识别与纪要为测试数据</div>}
      {!id ? <WorkspaceHome key={`${scope}:${homeVersion}`} scope={scope} records={records} query={query} modelReady={boot.providers.minutes} disabled={recording||busy} open={setId} archive={openArchive} create={newDirectory} edit={()=>{setEditingDirectory(directories.find(w=>w.id===scope));setModal('directory');}} quick={()=>void quickRecord()}/> : !record ? <div className="empty" role="status">{connectionState==='unavailable' ? '当前记录无法访问，请重新登录或选择其他记录。' : '正在读取记录…'}</div> : <><div className="record-heading"><div><p className="kicker">{new Date(records.find(r => r.id === id)?.createdAt || Date.now()).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
          <RecordTitle key={record.id} title={record.title} save={async title => { const saved = await mutate(`/records/${id}`, 'PATCH', {title}); if (saved) { await loadList(); setNotice('会议标题已保存。'); } return saved; }}/><div className="record-meta"><Status tone={recording ? 'live' : ''}>{recording ? '正在记录' : record.capture === 'completed' ? '已完成' : record.capture === 'sealed' ? '整理中' : record.capture === 'paused' ? '已暂停' : '待开始'}</Status><span>{timecode(record.usage.samples / 16)} 音频 · 转录 v{record.transcriptRevision}</span><span>{record.retentionDays} 天留存</span><span>{directories.find(w=>w.id===record.workspaceId)?.name || '未归档'}</span></div></div>
          <div className="actions meeting-actions"><RecordingPlayback key={record.id} record={record}/><Button disabled={!record.minutes || recording} onClick={() => void openShare()}><ShareNetwork size={17}/><span>分享</span></Button><Button aria-expanded={translationOpen} onClick={() => setTranslationOpen(!translationOpen)}><Translate size={17}/>实时翻译{record.translationTarget && <span className="live-dot"/>}</Button><Button disabled={recording||busy} onClick={()=>openArchive([id])}><Folder size={17}/>归档</Button><Button variant="ghost" aria-label="删除本次记录" disabled={recording} onClick={() => setModal('delete')}><Trash size={18}/></Button></div></div>
        <MeetingControls record={record} recording={recording} busy={busy} ready={sourceReady} signals={signals}
        start={kind => void startCapture(kind)} quick={() => void quickRecord()} sources={() => setModal('capture')}
        microphone={() => void toggleMicrophone()}
        finish={() => { setError(''); setModal('finish'); }} importAudio={() => fileInput.current?.click()}/>
      {!sourceReady && <div className="notice">语音服务尚未配置。维护者配置服务后即可录音；现在可以<Button variant="ghost" onClick={() => setModal('import-text')}>导入已有转录</Button>体验整理流程。</div>}
        {!recording && <div className="sub-actions">{!['sealed','completed'].includes(record.capture) && <Button variant="ghost" onClick={() => setModal('import-text')}><FileText size={16}/>导入文字</Button>}<Download href={`/api/records/${id}/export?format=json`}><ArrowDown size={15}/>备份记录</Download></div>}
        {importProgress !== null && <div className="notice" role="status">正在解码与保存音频：{Math.round(importProgress * 100)}%</div>}
        {record.capture === 'recording' && !recording && <div className="notice">检测到上次未结束的采集。可继续录音，或封存本机已保存的片段。<Button disabled={busy} onClick={() => setModal('finish')}>整理本场记录</Button></div>}
        {['blocked', 'failed'].includes(record.transcription) && <div className="notice error">语音处理受阻，音频仍在保存期内。检查服务配置后<Button disabled={busy} onClick={() => void mutate(`/records/${id}/retry`, 'POST')}>重新处理</Button></div>}
        {record.pendingChunks > 0 && <div className="processing-line" role="status">正在处理音频 · {record.pendingChunks} 个音频包<span>音频包会合并识别为发言，不代表待识别的语音段落</span></div>}
        {record.capture === 'completed' && record.usage.samples > 0 && record.pendingChunks === 0 && record.segments.length === 0 && <div className="notice audio-empty-result" role="status">音频已处理完成，但未识别出可用语音。请检查麦克风输入、系统权限或共享音轨，再开始一段试录。</div>}<MinutesPanel inline modelReady={boot.providers.minutes} automate={async (enabled, intervalSeconds) => { await mutate(`/records/${id}/automation`, 'PATCH', {enabled,intervalSeconds}); }} record={record} busy={busy} onClose={()=>{}} cite={cite} generate={async (template,mode) => { await mutate(`/records/${id}/minutes`, 'POST', { template,mode }); }} edit={async minutes => { return mutate(`/records/${id}/minutes`, 'PATCH', { revision: minutes.revision, minutes }); }}/>
        <Notes key={`notes:${record.id}`} record={record} save={async (notes, notesRevision) => { return mutate(`/records/${id}`, 'PATCH', { notes, notesRevision }); }}/>
        <footer className="record-footer"><span>{record.audioPurged ? '临时原音已清理' : record.retainAudio ? '原音随记录留存' : '转录完成后清理临时原音'} · {new Date(record.deleteAt).toLocaleDateString('zh-CN')} 到期</span><Download href={`/api/records/${id}/export?format=markdown`}>导出 Markdown<ArrowSquareOut size={15}/></Download></footer>
      </>}
      </div></div>
      {id && record && <CurrentDiscussion key={record.id} record={record} minutes={(record.capture === 'completed' ? record.minutes || record.liveMinutes : record.liveMinutes || record.minutes) || null} job={record.jobs.at(-1)} modelReady={boot.providers.minutes}/>}
      {record && translationOpen && <TranslationPanel key={record.id} record={record} ready={boot.providers.translation ?? boot.providers.minutes} close={()=>setTranslationOpen(false)} configure={()=>{setTranslationOpen(false);setModal('settings');}} save={async target=>{const recordId=record.id;await api(`/records/${recordId}`,'PATCH',{translationTarget:target});setRecord(current=>current?.id===recordId?{...current,translationTarget:target}:current);}} inspect={segment=>cite({segmentId:segment.id,revision:segment.revision},record.segments)}/>}
    </main><input ref={fileInput} className="sr-only" type="file" accept="audio/*" aria-label="导入音频文件" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void onImport(file); }}/>
      <Toast message={workspaceToast} dismiss={dismissWorkspaceToast}/>
    {modal === 'directory' && <WorkspaceEditor directory={editingDirectory} save={saveDirectory} close={()=>{setModal(archiveIds.length?'archive':null);}}/>}
    {modal === 'archive' && <ArchiveRecords key={archiveInitial||'inbox'} directories={directories} count={archiveIds.length} initial={archiveInitial} save={saveArchive} close={()=>{setModal(null);setArchiveIds([]);}} create={newDirectory}/>}
{modal === 'capture' && <CaptureSetup connected={signals.map(source => source.kind)} signals={signals} issues={captureIssues} busy={busy} onConnect={kind => void startCapture(kind)} onMicrophoneOff={() => void toggleMicrophone()} onClose={() => setModal(null)}/>}
    {modal === 'finish' && record && <MeetingFinish title={record.title} paused={record.capture === 'paused'} busy={busy} error={error} pause={title => void stopCapture('pause',title)} finish={title => void stopCapture('seal',title)} close={() => setModal(null)}/>}
    {modal === 'new' && <Modal title="新建一段记录" onClose={() => setModal(null)}><form onSubmit={create}><label><span className="field-label">记录标题 <span className="muted">可稍后填写</span></span><input autoFocus name="title" maxLength={160} placeholder="例如：产品周会"/></label><div className="form-grid"><label>主要语言<Select label="主要语言" name="language" options={[{"value": "zh", "label": "中文"}, {"value": "en", "label": "English"}, {"value": "ja", "label": "日本語"}]}/></label><label>记录留存<Select label="记录留存" name="retentionDays" defaultValue="30" options={[{"value": "1", "label": "1 天"}, {"value": "7", "label": "7 天"}, {"value": "30", "label": "30 天"}, {"value": "90", "label": "90 天"}]}/></label></div><label className="checkbox-label"><input type="checkbox" name="autoMinutes" defaultChecked={boot.providers.minutes} disabled={!boot.providers.minutes}/><span>自动生成 AI 纪要<small>会中持续归纳主题，停止后整理终稿；转录和笔记将发送到已配置模型。</small></span></label><label className="checkbox-label"><input type="checkbox" name="retainAudio"/>保留原始音频至记录到期</label><p className="fine-print">默认只保留处理所需的临时音频，完成转录后清理；失败片段最长保留 24 小时。以上设置不替代参会者知情与录音许可。</p><Button disabled={busy} variant="primary" type="submit"><Plus size={18}/>创建记录</Button></form></Modal>}
    {modal === 'settings' && <Modal wide explicitCloseOnly title="设置与录音环境" onClose={() => setModal(null)}><ClientUpdatesPanel updates={updates}/>{boot.canConfigure && <ProviderSettings saved={refreshProviders}/>}<DeviceSettings disabled={recording}/><div className="settings-section"><h3>浏览器能力检测</h3><dl className="capability-list">{Object.entries(capabilities()).filter(([k]) => k !== 'browser').map(([key, value]) => <div key={key}><dt>{{ secure: '安全环境', microphone: '麦克风 API', display: '共享来源 API', worklet: '音频处理', indexedDB: '本地补传存储', online: '网络连接' }[key]}</dt><dd>{value ? <Check size={17}/> : <X size={17}/>}</dd></div>)}</dl><p className="fine-print">API 可用不代表所选来源有声音。请在真实会议前试录并核对转录。浏览器无法保证关页或休眠后持续录音。</p></div>
      {deletions.length > 0 && <div className="settings-section"><h3>删除清理</h3><p>已禁访 {deletions.length} 条记录 · 物理清理完成 {deletions.filter(d => d.cleanup === 'completed').length} 条 · 等待清理 {deletions.filter(d => d.cleanup !== 'completed').length} 条</p><p className="fine-print">清理需要后台处理器运行，不包含服务外的备份副本。</p></div>}{record && <TranslationSettings key={record.id} recordId={record.id} value={record.translationTarget || ''} saved={target => setRecord(current => current?.id === record.id ? {...current,translationTarget:target} : current)}/>}
      <div className="settings-section"><h3>使用与诊断</h3>{record && <Button onClick={() => void downloadPendingAudio(record.id).catch(e => setError(messageOf(e)))}>下载本机待传音频备份</Button>}<p>每条记录最多两小时音频，每账户最多 200 条记录。多音轨分别计量。</p>{record && <p>本次音频 {Math.ceil(record.usage.samples / 16000)} 秒 · 模型 {record.usage.llmTokens} tokens</p>}<p className="fine-print">以上为本地计量，并非供应商账单。诊断文件不含音频、正文、邮箱或密钥。</p><Button onClick={() => { const blob = new Blob([JSON.stringify({ capabilities: capabilities(), storage: boot.storage, providers: boot.providers, pending, capture: record?.capture, transcription: record?.transcription }, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'meeting-diagnostics.json'; link.click(); URL.revokeObjectURL(url); }}>下载诊断信息</Button></div></Modal>}
    {modal === 'delete' && record && <Modal title="删除这条记录？" onClose={() => setModal(null)}><p>“{record.title}”将立即停止访问，分享链接与旧处理任务失效；后台随后清理原音。</p><div className="actions"><Button variant="danger" disabled={busy} onClick={async () => { const deletedId = id; if (await mutate(`/records/${id}`, 'DELETE')) { setId(''); setModal(null); try { await clearRecordAudio(deletedId); } catch { setError('云端已禁访；本机音频缓冲清理失败，请在浏览器设置中清理此站点数据。'); } await loadList(); } }}>删除记录</Button><Button onClick={() => setModal(null)}>保留记录</Button></div></Modal>}
    {modal === 'import-text' && record && <Modal title="导入已有转录" onClose={() => setModal(null)} wide><form onSubmit={async e => { e.preventDefault(); const text = new FormData(e.currentTarget).get('text'); if (await mutate(`/records/${id}/import-text`, 'POST', { text })) setModal(null); }}><label>转录正文<textarea name="text" rows={12} required maxLength={100000} placeholder="按自然段粘贴已有转录。导入文本不会生成虚构的音频时间。"/></label><Button disabled={busy} variant="primary" type="submit">导入文字</Button></form></Modal>}
    {modal === 'share' && record && <Modal title="分享会议内容" onClose={() => setModal(null)}><p className="muted">任何持有链接的人都可阅读选定内容。24 小时后失效，可随时撤销。</p><form onSubmit={async e => { e.preventDefault(); const scope = new FormData(e.currentTarget).get('scope'); try { const share = await api<{ token: string }>(`/records/${id}/shares`, 'POST', { scope }); setShareUrl(`${location.origin}/share/${share.token}`); setShares((await api<{ shares: typeof shares }>(`/records/${id}/shares`)).shares); } catch (e) { setError(messageOf(e)); } }}><label>分享范围<Select label="分享范围" name="scope" options={[{"value": "minutes", "label": "仅纪要（含引用快照）"}, {"value": "full", "label": "纪要与全部转录"}]}/></label><Button type="submit" variant="primary">生成分享链接</Button></form>
      {shareUrl && <div className="share-result"><label>分享链接<input readOnly value={shareUrl} onFocus={e => e.target.select()}/></label><Button onClick={async () => { try { await navigator.clipboard.writeText(shareUrl); setNotice('链接已复制。'); } catch { setNotice('自动复制未成功，请选中链接手动复制。'); } }}>复制链接</Button></div>}
      <h3>已生成的链接</h3>{shares.filter(s => !s.revoked).map(s => <div key={s.id} className="share-row"><span>{s.scope === 'minutes' ? '仅纪要' : '完整转录'} · {new Date(s.expires).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 到期</span><Button onClick={async () => { if (await mutate(`/records/${id}/shares/${s.id}`, 'DELETE')) setShares(shares.map(item => item.id === s.id ? { ...item, revoked: true } : item)); }}>撤销</Button></div>)}</Modal>}
    {evidence && <Modal title="纪要引用的原文" onClose={() => setEvidence(null)}><Status>片段 v{evidence.revision}</Status><p className="evidence-quote">{evidence.text}</p><p className="fine-print">这是生成纪要时的转录快照，可能与当前人工修订版本不同。</p></Modal>}
  </div>;
}
