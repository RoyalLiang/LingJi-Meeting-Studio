import { manualMinutesContent } from '../../../packages/records/src/minutes-quality.mjs';
import { ConnectionStatus } from './components/ConnectionStatus';
import { useRecordingWidget } from './useRecordingWidget';
import { capturedDurationMs } from './audio/signal';
import { useRecordingDuration } from './useRecordingDuration';
import {useLearningService} from './useLearningService';
import {LearningReview} from './components/LearningReview';
import { TranscriptionNotice } from './components/TranscriptionNotice';
import { FeedbackNotice } from './components/FeedbackNotice';
import { useClientUpdates } from './useClientUpdates';
import { ClientVersion, ClientUpdatesPanel } from './components/ClientUpdates';
import { useNativeMenuBar } from './useNativeMenuBar';
import { trace, traceCommit } from './telemetry';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Archive, ArrowDown, ArrowSquareOut, Folder, FolderPlus, House, Check, FileText, GearSix, Microphone, Moon,
  Plus, Translate, MagnifyingGlass, ShareNetwork, SignOut, Sparkle, Sun, Trash, WarningCircle, X, CaretRight } from '@phosphor-icons/react';
import { api, messageOf, setCsrf, setAudioTransport, ApiError } from './api';
import { applyRecordDelta, subscribeToRecord, type ConnectionState } from './record-subscription';
import type { Bootstrap, RecordDetail, RecordListItem, Segment, Evidence } from './model';
import { timecode } from './model';
import type { WorkspaceDirectory } from './workspace-model';
import { WorkspaceHome } from './components/WorkspaceHome';
import { WorkspaceEditor, ArchiveRecords } from './components/WorkspaceDialogs';
import { Toast } from './components/Toast';
import { Brand } from './components/Brand';
import { ScrollToTop } from './components/ScrollToTop';
import { Select } from './components/Select';
import { RecordingPlayback } from './components/RecordingPlayback';
import { ExportDialog } from './components/ExportDialog';
import { CitationContext } from './components/CitationContext';
import type { CitationSelection } from './citation-context';
import { ShareDialog } from './components/ShareDialog';
import { SharedMeeting, type SharedMeetingData } from './components/SharedMeeting';
import { currentMinutesJob } from './minutes-views';
import { ProviderSettings } from './components/ProviderSettings';
import { VocabularySettings } from './components/VocabularySettings';
import { TranscriptHistory } from './components/Transcript';
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
  const [data, setData] = useState<SharedMeetingData>(), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); let loading = false;
    const load = async () => {
      if (loading) return; loading = true;
      try { const result = await api<SharedMeetingData>(`/shared/${token}`, 'GET', undefined, controller.signal); if (!controller.signal.aborted) { setData(result); setError(''); } }
      catch (error) { if (!controller.signal.aborted) { setError(messageOf(error)); setData(undefined); } }
      finally { loading = false; }
    };
    void load(); const timer = setInterval(() => void load(), 15000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [token]);
  return <SharedMeeting data={data} error={error}/>;
}
export default function App() {
  const shared = location.pathname.match(/^\/share\/([A-Za-z0-9_-]+)$/);
  return shared ? <SharedView token={shared[1]}/> : <Workspace/>;
}
function Workspace() {
  const [boot, setBoot] = useState<Bootstrap | null>(null), [authReady, setAuthReady] = useState(false), [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<RecordListItem[]>([]), [query, setQuery] = useState(''), [id, setId] = useState(new URLSearchParams(location.search).get('record') || ''), [record, setRecord] = useState<RecordDetail | null>(null);
  const learningService=useLearningService(Boolean(authReady && boot?.learning?.enabled));
  const [uploadIssue, setUploadIssue] = useState('');
  const [localAudio, setLocalAudio] = useState<{recordId:string;manifests:Awaited<ReturnType<typeof localManifests>>}>({recordId:'',manifests:[]});
  const uploadingNow = useRef(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [translationOpen, setTranslationOpen] = useState(false);
  const [capturePhase, setCapturePhase] = useState<'idle' | 'starting' | 'stopping'>('idle');
  const [minutesSettingsOpen, setMinutesSettingsOpen] = useState(false), [noticeVersion, setNoticeVersion] = useState(0);
  useEffect(() => { setMinutesSettingsOpen(false); }, [id]);
  const [toast, setToast] = useState({ message: '', key: 0 });
  const dismissToast = useCallback(() => { setToast(current => ({ ...current, message: '' })); setError(''); }, []);
  const showToast = useCallback((message: string) => { setError(''); setToast(current => ({ message, key: current.key + 1 })); }, []);
  const selectRecord = useCallback((next: string) => { dismissToast(); setId(next); }, [dismissToast]);
  const [directories,setDirectories] = useState<WorkspaceDirectory[]>([]), [scope,setScope] = useState(() => { const value=new URLSearchParams(location.search).get('workspace') || 'all'; return /^(all|[a-f0-9-]{36})$/.test(value) ? value : 'all'; });
  const [archiveIds,setArchiveIds] = useState<string[]>([]), [archiveInitial,setArchiveInitial] = useState<string|null>(null), [editingDirectory,setEditingDirectory] = useState<WorkspaceDirectory|undefined>(), [homeVersion,setHomeVersion] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const recordCache = useRef(new Map<string, RecordDetail>());
  const cacheEpoch = useRef(0);
  const listRequest = useRef(0), listView = useRef({query, scope});
  listView.current = {query, scope};
  const [retryVersion, setRetryVersion] = useState(0);
  const rememberRecord = useCallback((detail: RecordDetail) => {
    const cache = recordCache.current; cache.delete(detail.id); cache.set(detail.id, detail);
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
    if (mounted.current && activeId.current === detail.id) setRecord(detail);
  }, []);
  const [minutesActions,setMinutesActions]=useState<HTMLDivElement|null>(null);
  const [focusTarget,setFocusTarget]=useState<HTMLDivElement|null>(null);
  const [settingsActions, setSettingsActions] = useState<HTMLDivElement | null>(null);
  const [modal, setModal] = useState<'new' | 'settings' | 'share' | 'export' | 'delete' | 'import-text' | 'capture' | 'finish' | 'directory' | 'archive' | 'learning' | null>(null), [theme, setTheme] = useState(localStorage.getItem('meeting-theme') || 'light');
  const [signals, setSignals] = useState<CaptureSignal[]>([]);
  const [captureIssues, setCaptureIssues] = useState<CaptureIssue[]>([]);
  const [recording, setRecording] = useState(false), [pending, setPending] = useState(0), [online, setOnline] = useState(navigator.onLine);
  const localBackend = Boolean(boot?.localAccount);
  const [evidence, setEvidence] = useState<CitationSelection | null>(null), [importProgress, setImportProgress] = useState<number | null>(null);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const stopping = useRef(false), capture = useRef<CaptureController | null>(null), activeId = useRef(''), mounted = useRef(true), fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('meeting-theme', theme); }, [theme]);
  useNativeMenuBar({ authenticated: authReady, recordTitle: record?.title || '', capture: record?.capture || 'idle', recording, busy: busy || stopping.current,
    connection: !online && !localBackend ? 'offline' : !id ? 'idle' : connectionState }, {
    pause: () => { if (!stopping.current) void stopCapture('pause'); },
    resume: () => { void startCapture('meeting'); },
    finish: () => { setError(''); setModal('finish'); },
    settings: () => { setModal('settings'); },
    microphone: () => { void toggleMicrophone(); }
  });
  const audioDurationMs = capturedDurationMs(record?.durationMs||0,record?.sources||[],signals,localAudio.recordId===record?.id?localAudio.manifests:[]);
  const displayDurationMs = useRecordingDuration(record?.id || '',audioDurationMs,recording);
  useRecordingWidget({recording,microphoneOn:signals.some(signal=>signal.kind==='microphone'),paused:!recording && record?.capture==='paused',canResume:!!record && record.sources.every(source=>source.watermark===source.lastSequence),busy:busy || stopping.current,durationMs:displayDurationMs,rms:Math.max(0,...signals.map(signal=>Math.min(1,signal.rms)))},setError,record?.id||'');
  const updates = useClientUpdates({ authenticated: authReady, recording, paused: record?.capture === 'paused', busy: busy || stopping.current });
  const bootRequest = useRef<Promise<boolean> | null>(null);
  const loadBoot = useCallback(() => {
    if (bootRequest.current) return bootRequest.current;
    const request = (async () => {
    cacheEpoch.current++; recordCache.current.clear(); setError(''); try { const b = await api<Bootstrap>('/bootstrap'); setCsrf(b.csrf); setAudioTransport(b.audioTransport); setLocalQueueBackend(Boolean(b.localAccount)); const [list, folders] = await Promise.all([api<{records: RecordListItem[]}>('/records'), api<{workspaces:WorkspaceDirectory[]}>('/workspaces')]);
        setQueueRecords(list.records.map(r => r.id)); setDirectories(folders.workspaces); setBoot(b); setAuthReady(true); return true; }
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
  const loadList = useCallback(async (signal?: AbortSignal) => {
    if (listView.current.query !== query || listView.current.scope !== scope) return;
    const version = ++listRequest.current, epoch = cacheEpoch.current;
    const result = await api<{ records: RecordListItem[] }>(`/records?q=${encodeURIComponent(query)}&workspace=${encodeURIComponent(scope)}`, 'GET', undefined, signal);
    if (!signal?.aborted && version === listRequest.current && epoch === cacheEpoch.current && listView.current.query === query && listView.current.scope === scope) setRecords(result.records);
  }, [query,scope]);
  const refresh = useCallback(async () => {
    const current = activeId.current; if (!current) return;
    const epoch = cacheEpoch.current; const detail = await api<RecordDetail>(`/records/${current}`); if (epoch === cacheEpoch.current) rememberRecord(detail);
  }, [rememberRecord]);
  useEffect(() => {
    if (!authReady) return; const controller = new AbortController(); const timer = setTimeout(() => { loadList(controller.signal).catch(e => { if (e.name !== 'AbortError') setError(messageOf(e)); }); }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [loadList, authReady]);
  useEffect(() => {
    if (activeId.current !== id || !authReady) { void capture.current?.stop(); capture.current = null; setSignals([]); }
    activeId.current = id; if (!authReady) { cacheEpoch.current++; recordCache.current.clear(); } setRecord(recordCache.current.get(id) || null); setTranslationOpen(false); setEvidence(null);
  }, [id, authReady]);
  useEffect(() => { const params=new URLSearchParams({workspace:scope});if(id)params.set('record',id); history.replaceState(null,'',`?${params}`); }, [id,scope]);
  useEffect(() => {
    if (!id || !authReady) { setConnectionState('idle'); return; }
    const epoch = cacheEpoch.current;
    return subscribeToRecord<RecordDetail>({
      recordId: id, localBackend,
      applyDelta: applyRecordDelta,
      loadRecord: signal => api<RecordDetail>(`/records/${id}`, 'GET', undefined, signal),
      onRecord: detail => { if (epoch === cacheEpoch.current && mounted.current && activeId.current === id){trace('view.received',{recordId:detail.id,cursor:detail.cursor});rememberRecord(detail);} },
      onState: setConnectionState,
      onFatal: error => { recordCache.current.delete(id); setRecord(null); setError(messageOf(error)); if (error instanceof ApiError && error.status === 401) setAuthReady(false); }
    });
  }, [id, authReady, online, localBackend, retryVersion, rememberRecord]);
  useEffect(() => {
    if (!authReady || id) return;
    const controller = new AbortController();
    const probe = async () => {
      try { await api('/health', 'GET', undefined, controller.signal); if (!controller.signal.aborted) setConnectionState('connected'); }
      catch { if (!controller.signal.aborted) setConnectionState('unavailable'); }
    };
    void probe(); const timer = setInterval(() => void probe(), 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [authReady, id, online, retryVersion]);
  const refreshLocalAudio = useCallback(async () => {
    const recordId=activeId.current;
    const [count,manifests]=await Promise.all([pendingCount(recordId),localManifests(recordId)]);
    if(activeId.current===recordId) {setPending(count);setLocalAudio({recordId,manifests});}
  },[]);
  const upload = useCallback(async () => {
    if(uploadingNow.current) return;
    uploadingNow.current=true;
    try { await drainQueue(()=>{void refreshLocalAudio();}); await refreshLocalAudio();setUploadIssue(''); }
    catch(e) {
      if(e instanceof ApiError && (e.code==='service_unavailable'||e.status>=500)) setUploadIssue('记录服务连接中断，音频正缓存在本机，将自动重试保存。请保持应用开启。');
      else if(navigator.onLine||localBackend) setError(messageOf(e));
    } finally {uploadingNow.current=false;}
  },[localBackend,refreshLocalAudio]);
  useEffect(()=>{if(authReady&&id)void refreshLocalAudio().catch(e=>setError(messageOf(e)));},[id,authReady,refreshLocalAudio]);
  useEffect(() => {
    if (!authReady) return; const network = () => { setOnline(navigator.onLine); if (navigator.onLine || localBackend) void upload(); };
    addEventListener('online', network); addEventListener('offline', network); const timer = setInterval(upload, 2500); void upload();
    return () => { removeEventListener('online', network); removeEventListener('offline', network); clearInterval(timer); };
  }, [authReady, upload, localBackend]);
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (recording || pending) { event.preventDefault(); event.returnValue = ''; } }; addEventListener('beforeunload', warn); return () => removeEventListener('beforeunload', warn); }, [recording, pending]);
  useEffect(() => { const escape = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) setTranslationOpen(false); }; addEventListener('keydown', escape); return () => removeEventListener('keydown', escape); }, []);
  useEffect(() => { if(record) traceCommit(record.id,record.cursor); }, [record?.cursor]);
  useEffect(() => {
    if (!record) return;
    setRecords(current => {
      const item = current.find(item => item.id === record.id);
      if (!item || (item.title === record.title && item.capture === record.capture && item.hasMinutes === Boolean(record.minutes || record.liveMinutes))) return current;
      return current.map(item => item.id === record.id ? { ...item, title: record.title, capture: record.capture, hasMinutes: Boolean(record.minutes || record.liveMinutes) } : item);
    });
  }, [record?.id, record?.title, record?.capture, record?.minutesRevision, record?.liveMinutes]);
  useEffect(() => { if (!authReady) dismissToast(); }, [authReady, dismissToast]);
  const mutate = useCallback(async (path: string, method: string, body?: unknown, blocking = true) => {
    if (blocking) setBusy(true); setError(''); try { await api(path, method, body); try { await Promise.all([method === 'DELETE' && path === `/records/${activeId.current}` ? Promise.resolve() : refresh(), loadList()]); } catch { showToast('修改已保存，页面更新暂时失败；连接恢复后将自动刷新。'); } return true; }
    catch (e) { setError(messageOf(e)); return false; } finally { if (blocking) setBusy(false); }
  }, [refresh,loadList,showToast]);
  const saveTranscript = useCallback((segment: Segment,text: string,speaker: string) => mutate(`/records/${id}/segments/${segment.id}`, 'PATCH', {revision:segment.revision,text,speaker}), [id,mutate]);
  const refreshTranscript = useCallback(() => void refresh().catch(e => setError(messageOf(e))), [refresh]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true); setError('');
    try { const r = await api<RecordDetail>('/records', 'POST', { workspaceId: scope==='all'?null:scope, title: form.get('title'), language: form.get('language'), retentionDays: Number(form.get('retentionDays')), retainAudio: true, autoMinutes: form.has('autoMinutes'), realtimeAudioConsent: form.has('autoMinutes') && ['openai-realtime', 'doubao-audio', 'doubao-audio-only'].includes(boot?.providers.minutesMode || '') });
      const list = await api<{records: RecordListItem[]}>('/records'); setQueueRecords(list.records.map(r => r.id)); await loadList(); selectRecord(r.id); setModal(null); await loadList(); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  async function stopCapture(mode: 'pause' | 'seal' = 'seal', title = '', interrupted = false) {
    if (stopping.current) return false;
    stopping.current = true; setBusy(true); setCapturePhase('stopping'); setError('');
    try {
      const controller = capture.current;
      try {
        if (mode === 'pause' && controller && 'pause' in controller) await controller.pause();
        else await controller?.stop();
      } catch (error) { if (!interrupted) throw error; }
      setRecording(false);
      if (!activeId.current) return false;
      const current = await api<RecordDetail>(`/records/${activeId.current}`, 'GET', undefined, AbortSignal.timeout(15000));
      const manifests = await localManifests(current.id);
      if (title.trim() && title.trim() !== current.title) await api(`/records/${current.id}`, 'PATCH', {title:title.trim()}, AbortSignal.timeout(15000));
      const saved = await api<RecordDetail>(`/records/${current.id}/${mode}`, 'POST', {
        sources: current.sources.map(source => ({ sourceId: source.id, epoch: source.epoch, lastSequence: source.lastSequence ?? manifests.find(m => m.sourceId === source.id)?.lastSequence ?? source.watermark }))
      }, AbortSignal.timeout(15000));
      setRecord(saved); setModal(null);
      // Local persistence and sealing are the finish barrier. Network upload
      // and ASR continue independently, including after a lost connection.
      void upload().catch(e => setError(messageOf(e)));
      void Promise.allSettled([refresh(), loadList()]);
      showToast(mode === 'pause' ? '已暂停' : '会议已结束');
      return true;
    } catch (e) { setError(messageOf(e)); return false; }
    finally { stopping.current = false; setRecording(false); setBusy(false); setCapturePhase('idle'); if (mode === 'seal') capture.current = null; }
  }
  function captureAllowed() {
    if (!boot?.providers.asr && !boot?.providers.fixture) { setError(boot?.providers.minutesMode === 'doubao-audio-only' ? '请先在设置中连接豆包音频模型。' : boot?.providers.asrProvider === 'sensevoice-local' ? '本地模型未安装或尚未就绪。请选择云端转录服务，或重新安装并勾选本地模型。' : '请先在设置中连接转录服务。'); return false; }
    if (!capabilities().secure || !capabilities().worklet) { setError('当前环境不支持安全音频采集，请使用 HTTPS 的现代浏览器或导入文件。'); return false; }
    return true;
  }
  function controllerFor(recordId: string | Promise<string>) {
    const controller = new CaptureController(recordId, () => {}, (error, continuing) => {
      if (capture.current !== controller) return;
      if (continuing) { setRecording(controller.active); setError(messageOf(error)); return; }
      setRecording(false);
      void stopCapture('pause', '', true).finally(() => { if (capture.current === controller) setError(messageOf(error)); });
      setError(messageOf(error));
    }, () => { void refreshLocalAudio().catch(e=>setError(messageOf(e))); void upload(); }, () => {
      if (capture.current === controller) void stopCapture('pause');
    }, setSignals);
    return controller;
  }
  async function quickRecord() {
    if (recording || busy || !captureAllowed()) return;
    setError(''); setCaptureIssues([]); setBusy(true); setCapturePhase('starting');
    void capture.current?.stop(); capture.current = null;
    const audioMode = ['openai-realtime', 'doubao-audio', 'doubao-audio-only'].includes(boot?.providers.minutesMode || '');
    const created = api<RecordDetail>('/records', 'POST', { workspaceId: scope==='all'?null:scope, retainAudio: true, autoMinutes: Boolean(boot?.providers.minutes) && !audioMode, realtimeAudioConsent: false });
    const controller = capture.current = controllerFor(created.then(next => next.id));
    // Request permissions in this click, before waiting for the new record ID.
    const started = controller.startMeeting();
    try {
      const next = await created;
      activeId.current = next.id; selectRecord(next.id); setRecord(next); setModal(null);
      const list = await api<{records: RecordListItem[]}>('/records');
      setQueueRecords(list.records.map(item => item.id)); await loadList();
      const issues = await started; setCaptureIssues(issues); setRecording(controller.active);
      if (issues.length) {
        if (controller.active) setError(issues.map(issue => issue.message).join('；'));
        else setModal('capture');
      }
      await refresh();
    } catch (e) {
      await started; await controller.stop(); capture.current = null; setRecording(false); setError(messageOf(e));
    } finally { setBusy(false); setCapturePhase('idle'); if (!controller.active) capture.current = null; }
  }
  async function startCapture(kind: 'microphone' | 'display' | 'meeting') {
    if (!record || busy || !captureAllowed()) return;
    if (record.capture === 'sealed' || record.capture === 'completed') { void quickRecord(); return; }
    setError(''); dismissToast();
    const controller = capture.current ||= controllerFor(record.id);
    const started = kind === 'meeting' ? controller.startMeeting() : controller.start(kind);
    setBusy(true); setCapturePhase('starting');
    try {
      const result = await started;
      const issues = kind === 'meeting' ? result as CaptureIssue[] : [];
      setCaptureIssues(issues); setRecording(controller.active);
      if (issues.length) setError(issues.map(issue => issue.message).join('；')); else if (modal === 'capture') setModal(null);
    } catch (e) {
      setCaptureIssues([{ kind: kind === 'microphone' ? 'microphone' : 'display', message: messageOf(e) }]);
      setError(messageOf(e)); setRecording(controller.active);
    } finally { setBusy(false); setCapturePhase('idle'); if (controller.active) void refresh().catch(e => setError(messageOf(e))); else capture.current = null; }
  }
  async function toggleMicrophone() {
    if (busy) return;
    const controller = capture.current;
    if (!controller?.sources.some(source => source.kind === 'microphone')) { await startCapture('microphone'); return; }
    setBusy(true); setError('');
    try {
      await controller.disconnect('microphone');
      if (!controller.active) await stopCapture('pause');
      else showToast('麦克风已关闭，继续记录系统／会议音频。');
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  async function onImport(file: File) {
    if (!record) return; setBusy(true); setImportProgress(0); setError('');
    try { await importAudio(file, record, setImportProgress); await stopCapture(); }
    catch (e) { setError(messageOf(e)); await refresh(); } finally { setBusy(false); setImportProgress(null); }
  }
  const currentEvidenceSnapshot=record?.minutes?.evidenceSnapshot;
  const cite=useCallback((ref: Evidence, snapshotOverride?: Segment[], transcriptRevision?: number)=>{
    window.dispatchEvent(new Event('meeting:pause-follow'));
    const snapshot = snapshotOverride || currentEvidenceSnapshot || [];
    setEvidence({ reference: { ...ref }, snapshot: structuredClone(snapshot), transcriptRevision });
  },[currentEvidenceSnapshot]);
  const directoryName = scope==='all'?'所有会议':directories.find(w=>w.id===scope)?.name || '工作目录';
  const chooseScope = (next:string) => { setScope(next);selectRecord('');setQuery('');scrollRoot.current?.scrollTo({top:0,behavior:'instant'}); };
  const newDirectory = () => {setEditingDirectory(undefined);setModal('directory');};
  const openArchive = (ids:string[]) => {setArchiveIds(ids);setArchiveInitial(record?.workspaceId || (scope==='all'?null:scope));setModal('archive');};
  async function saveDirectory(name:string,description:string) {
    try {
      const directory=await api<WorkspaceDirectory>(editingDirectory?`/workspaces/${editingDirectory.id}`:'/workspaces',editingDirectory?'PATCH':'POST',{name,description});
      const list=await api<{workspaces:WorkspaceDirectory[]}>('/workspaces');setDirectories(list.workspaces);setHomeVersion(v=>v+1);
      if(archiveIds.length){setArchiveInitial(directory.id);setModal('archive');}else{setModal(null);chooseScope(directory.id);}
      showToast(editingDirectory?'目录已保存。':'工作目录已创建。');
    }catch(e){throw new Error(messageOf(e));}
  }
  async function saveArchive(workspaceId:string|null) {
    try {
      await api('/workspaces/archive','POST',{recordIds:archiveIds,workspaceId});
      for (const recordId of archiveIds) { const cached = recordCache.current.get(recordId); if (cached) rememberRecord({...cached, workspaceId}); }
      let refreshed = true; try { await Promise.all([loadList(),refresh()]); } catch { refreshed = false; }
      setHomeVersion(v=>v+1);showToast(refreshed ? `已归档 ${archiveIds.length} 场会议。` : '归档已保存，列表将在连接恢复后更新。');setArchiveIds([]);setModal(null);
    }catch(e){throw new Error(messageOf(e));}
  }
  if (loading) return <main className="loading-page" role="status"><Brand markOnly/><p>正在打开会议空间…</p></main>;
  if (!authReady || !boot) return <Auth ready={loadBoot}/>;
  const sourceReady = boot.providers.asr || boot.providers.fixture;
  return <div className="app-shell"><a className="skip-link" href="#workspace">跳到会议内容</a>
    <aside className="sidebar glass"><Brand/>
      <Button variant="primary" className="new-record" onClick={() => void quickRecord()} disabled={recording || busy || !sourceReady}><Plus size={18}/>快速记录</Button>
      <Button className="prepare-record" variant="ghost" onClick={() => setModal('new')} disabled={recording || busy}>提前准备会议</Button>
      <div className="workspace-switch"><div><span>工作目录</span><Button variant="ghost" aria-label="新建工作目录" onClick={newDirectory} disabled={recording||busy}><FolderPlus size={17}/></Button></div><Select label="选择工作目录" value={scope} onChange={chooseScope} disabled={recording||busy} options={[{value:'all',label:'所有会议'},...directories.map(w=>({value:w.id,label:w.name}))]}/><Button className={`directory-home-link ${!id?'selected':''}`} variant="ghost" disabled={recording||busy} onClick={()=>chooseScope(scope)}><House size={16}/>目录概览</Button></div>
      <div className="rail-heading">我的记录 <span>{records.length}</span></div><nav className="record-list" aria-label="会议记录">{records.map(r => <button key={r.id} className={`record-row ${r.id === id ? 'selected' : ''}`} disabled={(recording || busy) && r.id !== id} onClick={() => selectRecord(r.id)}>
        <span className="record-icon">{r.hasMinutes ? <FileText size={18}/> : <Microphone size={18}/>}</span><span><b>{r.title}</b><small>{new Date(r.createdAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {r.capture === 'recording' ? '记录中' : `${Math.ceil(r.seconds / 60)} 分钟`}</small></span><CaretRight size={14}/></button>)}
        {!records.length && <p className="rail-empty">{query ? '没有匹配记录' : '你的第一场对话，值得留住。'}</p>}</nav>
      <footer className="rail-footer"><div className="rail-version"><ClientVersion status={updates.status}/></div><div className="account"><span className="avatar">{localBackend ? '聆' : boot.email[0].toUpperCase()}</span><span><b>{localBackend ? '本机空间' : boot.email.split('@')[0]}</b><small>个人会议空间</small></span></div><div className="actions rail-tools">{record && <Download href={`/api/records/${id}/export?format=json`} iconLabel="备份记录" disabled={recording}><ArrowDown size={19}/></Download>}<Button variant="ghost" aria-label="设置与诊断" onClick={() => { setModal('settings'); }}><GearSix size={19}/></Button><Button variant="ghost" aria-label={theme === 'light' ? '切换深色' : '切换浅色'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={19}/> : <Sun size={19}/>}</Button>{!boot.localAccount && <Button variant="ghost" aria-label="退出登录" disabled={recording} onClick={async () => { try { await api('/auth/logout', 'POST'); setQueueRecords([]); setAuthReady(false); selectRecord(''); } catch (e) { setError(messageOf(e)); } }}><SignOut size={19}/></Button>}</div></footer>
    </aside>
    <main id="workspace" className={`workspace ${translationOpen ? 'with-translation' : ''}`}><header className="topbar glass"><div className="workspace-breadcrumb"><button className="breadcrumb" disabled={recording||busy} onClick={()=>chooseScope(scope)}>{directoryName}</button><CaretRight size={14}/><span>{record ? '记录详情' : '目录概览'}</span></div><div className="search-box topbar-search"><MagnifyingGlass size={18}/><input type="search" aria-label="搜索当前目录会议内容" placeholder="搜索当前目录的会议、纪要与内容" value={query} onChange={e => setQuery(e.target.value)}/></div><div className="sync-state" title="页面与记录服务的连接状态；与语音、AI 模型服务连接无关" data-connection-state={connectionState}><ConnectionStatus state={connectionState} localBackend={localBackend} online={online} pending={pending}/><ScrollToTop root={scrollRoot}/></div></header>
      <div className="workspace-body"><div className="workspace-reading-row"><div className="meeting-highlights-slot" ref={setFocusTarget}/><div ref={scrollRoot} className="workspace-scroll" tabIndex={0} aria-label="会议内容滚动区">
      {uploadIssue && !error && <FeedbackNotice key="audio-upload-retry" message={uploadIssue} action={{label:'立即重试',run:()=>void upload()}}/>}
      {id && !uploadIssue && connectionState==='reconnecting' && <FeedbackNotice key="connection-retry" message="实时更新暂时中断，正在重连记录服务。"/>}
      {id && record && connectionState==='unavailable' && <FeedbackNotice key="connection-unavailable" message="记录服务暂时不可用，正在自动重试。" action={{label: '重新连接', run: () => setRetryVersion(v=>v+1)}}/>}
      {boot.providers.fixture && <div className="fixture-notice">开发测试模式 · 识别与纪要为测试数据</div>}
      {!id ? <WorkspaceHome key={`${scope}:${homeVersion}`} scope={scope} records={records} query={query} modelReady={boot.providers.textMinutes ?? boot.providers.minutes} disabled={recording||busy} open={selectRecord} archive={openArchive} create={newDirectory} edit={()=>{setEditingDirectory(directories.find(w=>w.id===scope));setModal('directory');}} quick={()=>void quickRecord()}/> : !record ? <div className="empty" role="status">{connectionState==='unavailable' ? <><p>记录服务暂时不可用，正在自动重试。</p><Button onClick={()=>setRetryVersion(v=>v+1)}>重新连接</Button></> : connectionState==='inaccessible' ? '当前记录不可访问，请选择其他记录。' : '正在读取记录…'}</div> : <><section className="meeting-header glass" aria-label="会议头部"><div className="record-heading"><div className="record-heading-main">
          <RecordTitle key={record.id} title={record.title} save={async title => { const saved = await mutate(`/records/${id}`, 'PATCH', {title}); if (saved) { await loadList(); showToast('会议标题已保存。'); } return saved; }}/></div><div className="record-heading-toolbar"><div className="record-meta" title={`${new Date(records.find(r=>r.id===id)?.createdAt || Date.now()).toLocaleDateString('zh-CN')} · 转录 v${record.transcriptRevision} · ${record.retentionDays} 天留存 · ${new Date(record.deleteAt).toLocaleDateString('zh-CN')} 到期 · ${directories.find(w=>w.id===record.workspaceId)?.name || '未归档'}`}><Status tone={recording ? 'live' : ''}>{recording ? '正在记录' : record.capture === 'completed' ? '已完成' : record.capture === 'sealed' ? '整理中' : record.capture === 'paused' ? '已暂停' : '待开始'}</Status>{['blocked','failed'].includes(record.transcription) && <Button className="record-warning" variant="ghost" aria-label="查看语音处理提示" title="查看语音处理提示" onClick={()=>setNoticeVersion(value=>value+1)}><WarningCircle size={15}/></Button>}<time className="record-duration" aria-label="录音进度，含本机待保存音频">{timecode(displayDurationMs)}</time></div>
          <div className="actions meeting-actions">{boot.learning?.enabled && <Button className="meeting-icon" aria-label="学习评审" title={!learningService.available ? learningService.status==='checking' ? '正在检测学习评审服务' : '学习评审服务未连接，恢复后自动启用' : record.learning?.status==='ready' ? `学习评审 · ${record.learning.groups}` : record.learning?.status==='running' || record.learning?.status==='queued' ? '待标注准备中' : '学习评审'} disabled={busy || !learningService.available || record.capture!=='completed'} onClick={()=>setModal('learning')}><Sparkle size={17}/></Button>}<Button className="meeting-icon" aria-label="导出" title="导出" disabled={busy} onClick={()=>setModal('export')}><ArrowDown size={17}/></Button><Button className="meeting-icon" aria-label="分享" title="分享" disabled={busy} onClick={()=>setModal('share')}><ShareNetwork size={17}/></Button><Button className="meeting-icon" aria-label="实时翻译" title="实时翻译" aria-expanded={translationOpen} onClick={()=>setTranslationOpen(!translationOpen)}><Translate size={17}/>{record.translationTarget && <span className="live-dot"/>}</Button><Button className="meeting-icon" aria-label="归档" title={recording ? '录音结束后可归档' : '归档'} disabled={recording||busy} onClick={()=>openArchive([id])}><Archive size={17}/></Button><Button className="meeting-icon" aria-label="整理设置" title="整理设置" aria-expanded={minutesSettingsOpen} aria-controls="minutes-settings" onClick={()=>setMinutesSettingsOpen(!minutesSettingsOpen)}><GearSix size={17}/></Button><Button className="meeting-icon" variant="danger" aria-label="删除本次记录" disabled={recording||busy} onClick={() => setModal('delete')}><Trash size={18}/></Button></div></div></div>
        <RecordingPlayback key={record.id} record={record}/>
        <MeetingControls record={record} recording={recording} busy={busy} phase={capturePhase} ready={sourceReady} signals={signals} progress={importProgress !== null ? `正在导入音频 ${Math.round(importProgress * 100)}%` : undefined}
      start={kind => void startCapture(kind)} quick={() => void quickRecord()} sources={() => setModal('capture')}
        microphone={() => void toggleMicrophone()}
        finish={() => { setError(''); setModal('finish'); }} importAudio={() => fileInput.current?.click()}/></section>
      {!sourceReady && <FeedbackNotice key={`provider:${id}`} message="语音服务尚未配置。可先导入已有转录；录音前请在设置与诊断中配置服务。" action={{label: boot.canConfigure ? '检查配置' : '导入转录', run: () => setModal(boot.canConfigure ? 'settings' : 'import-text')}}/>}
        {record.capture === 'recording' && !recording && <FeedbackNotice key={`recovery:${id}`} message="检测到上次未结束的采集。可继续录音，或封存本机已保存的片段。" action={{label: '整理本场记录', disabled: busy, run: () => setModal('finish')}}/>}
          <TranscriptionNotice active={['blocked', 'failed'].includes(record.transcription)} key={`transcription:${record.id}`} recordId={record.id} issue={record.transcriptionIssue} reopenVersion={noticeVersion} audioOnly={boot.providers.minutesMode === 'doubao-audio-only'} busy={busy} retained={record.retainAudio && !record.audioPurged && record.usage.samples > 0} retry={() => mutate(`/records/${id}/retry`, 'POST')} configure={boot.canConfigure ? () => setModal('settings') : undefined}/>
    <div className="record-processing">
        {!recording && <div className="processing-summary">
        {!recording && <div className="sub-actions">{!['sealed','completed'].includes(record.capture) && <Button variant="ghost" onClick={() => setModal('import-text')}><FileText size={16}/>导入文字</Button>}</div>}
        </div>}
      </div>
        {record.capture === 'completed' && record.usage.samples > 0 && record.pendingChunks === 0 && record.segments.length === 0 && <FeedbackNotice key={`empty:${id}:${record.transcriptRevision}`} message="音频已处理完成，但未识别出可用语音。请检查麦克风输入、系统权限或共享音轨，再开始一段试录。"/>}<MinutesPanel focusTarget={focusTarget} focusSuspended={translationOpen} historyActionsRef={setMinutesActions} key={`minutes:${record.id}`} audioOnly={boot.providers.minutesMode === 'doubao-audio-only'} inline settingsOpen={minutesSettingsOpen} closeSettings={() => setMinutesSettingsOpen(false)} modelReady={boot.providers.minutes} realtimeMode={['openai-realtime', 'doubao-audio', 'doubao-audio-only'].includes(boot.providers.minutesMode || '')} automate={async (enabled, intervalSeconds) => { await mutate(`/records/${id}/automation`, 'PATCH', {enabled,intervalSeconds,realtimeAudioConsent: enabled && ['openai-realtime', 'doubao-audio', 'doubao-audio-only'].includes(boot.providers.minutesMode || '')}); }} record={record} busy={busy} onClose={()=>{}} cite={cite} generate={async (template,mode) => { await mutate(`/records/${id}/minutes`, 'POST', { template,mode,scope: record.capture === 'completed' ? 'final' : 'live',retry:true,realtimeAudioConsent: mode === 'model' && ['openai-realtime', 'doubao-audio', 'doubao-audio-only'].includes(boot.providers.minutesMode || '') }, false); }} edit={async minutes => { return mutate(`/records/${id}/minutes`, 'PATCH', { revision: minutes.revision, minutes:manualMinutesContent(minutes) }); }}/>
        <TranscriptHistory actionsTarget={minutesActions} key={`transcript:${record.id}`} record={record} changed={refreshTranscript} save={saveTranscript}/>
          <Notes key={`notes:${record.id}`} record={record} save={async (notes, notesRevision) => { return mutate(`/records/${id}`, 'PATCH', { notes, notesRevision }); }}/>

      </>}
      </div></div><div className="content-follow-actions" data-content-follow-actions/></div>
      {id && record && !['sealed','completed'].includes(record.capture) && <CurrentDiscussion audioOnly={boot.providers.minutesMode === 'doubao-audio-only'} key={`discussion:${record.id}`} record={record} minutes={(record.liveMinutes || record.minutes) || null} job={currentMinutesJob(record)} modelReady={boot.providers.minutes}/>}
      {record && translationOpen && <TranslationPanel key={`translation:${record.id}`} record={record} ready={boot.providers.translation ?? boot.providers.minutes} close={()=>setTranslationOpen(false)} configure={()=>{setTranslationOpen(false);setModal('settings');}} save={async target=>{const recordId=record.id;const saved=await api<RecordDetail>(`/records/${recordId}`,'PATCH',{translationTarget:target});setRecord(current=>current?.id===recordId && (current.translationRevision||0)<=(saved.translationRevision||0)?{...current,translationTarget:saved.translationTarget,translationRevision:saved.translationRevision}:current);}} inspect={segment=>cite({segmentId:segment.id,revision:segment.revision},record.segments,record.transcriptRevision)}/>}
    </main><input ref={fileInput} className="sr-only" type="file" accept="audio/*" aria-label="导入音频文件" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void onImport(file); }}/>
      <Toast message={error || toast.message} error={Boolean(error)} messageKey={error || toast.key} dismiss={dismissToast}/>
    {modal === 'directory' && <WorkspaceEditor directory={editingDirectory} save={saveDirectory} close={()=>{setModal(archiveIds.length?'archive':null);}}/>}
    {modal === 'archive' && <ArchiveRecords key={archiveInitial||'inbox'} directories={directories} count={archiveIds.length} initial={archiveInitial} save={saveArchive} close={()=>{setModal(null);setArchiveIds([]);}} create={newDirectory}/>}
{modal === 'capture' && <CaptureSetup connected={signals.map(source => source.kind)} signals={signals} issues={captureIssues} busy={busy} onConnect={kind => void startCapture(kind)} onMicrophoneOff={() => void toggleMicrophone()} onClose={() => setModal(null)}/>}
    {modal === 'export' && record && <ExportDialog key={record.id} record={record} close={()=>setModal(null)}/>}
    {modal === 'finish' && record && <MeetingFinish title={record.title} paused={record.capture === 'paused'} busy={busy} error={error} pause={title => void stopCapture('pause',title)} finish={title => void stopCapture('seal',title)} close={() => setModal(null)}/>}
    {modal === 'new' && <Modal title="新建一段记录" initialFocus="field" onClose={() => setModal(null)}><form onSubmit={create}><label><span className="field-label">记录标题 <span className="muted">可稍后填写</span></span><input autoFocus name="title" maxLength={160} placeholder="例如：产品周会"/></label><div className="form-grid"><label>识别语言<Select label="识别语言" name="language" defaultValue="auto" options={boot.providers.asrProvider === "sensevoice-local" ? [{value:"auto",label:"自动识别 · 中英日韩粤"}] : [{value:"auto",label:"自动识别"},{value:"zh",label:"中文"},{value:"en",label:"English"},{value:"ja",label:"日本語"},{value:"ko",label:"한국어"},{value:"yue",label:"粤语"}]}/></label><label>记录留存<Select label="记录留存" name="retentionDays" defaultValue="30" options={[{"value": "1", "label": "1 天"}, {"value": "7", "label": "7 天"}, {"value": "30", "label": "30 天"}, {"value": "90", "label": "90 天"}]}/></label></div><label className="checkbox-label"><input type="checkbox" name="autoMinutes" defaultChecked={boot.providers.minutes && !['openai-realtime', 'doubao-audio', 'doubao-audio-only'].includes(boot.providers.minutesMode || '')} disabled={!boot.providers.minutes}/><span>自动生成 AI 纪要<small>{['openai-realtime', 'doubao-audio', 'doubao-audio-only'].includes(boot.providers.minutesMode || '') ? '允许将本场音频直接发送到已配置的音频纪要模型；转录并行留证，结束后整理终稿。' : '会中持续归纳主题，停止后整理终稿；转录和笔记将发送到已配置模型。'}</small></span></label><Button disabled={busy} variant="primary" type="submit"><Plus size={18}/>创建记录</Button></form></Modal>}
    {modal === 'settings' && <Modal wide className="settings-modal" headerActions={<><ClientVersion status={updates.status}/><Button variant="ghost" className="settings-diagnostics" aria-label="下载诊断信息" title="下载诊断信息" onClick={() => { const blob = new Blob([JSON.stringify({ capabilities: capabilities(), storage: boot.storage, providers: boot.providers, pending, capture: record?.capture, transcription: record?.transcription }, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'meeting-diagnostics.json'; link.click(); URL.revokeObjectURL(url); }}><WarningCircle size={18}/></Button></>} footer={<>{record && pending>0 && <Button onClick={() => void downloadPendingAudio(record.id).catch(e => setError(messageOf(e)))}>备份待传音频</Button>}<div ref={setSettingsActions}/></>} title="设置与录音环境" onClose={() => setModal(null)}><ClientUpdatesPanel updates={updates}/>{boot.canConfigure && <ProviderSettings saved={refreshProviders} actionsTarget={settingsActions} initialProvider={boot.providers.asrProvider === 'doubao-audio-only' ? undefined : boot.providers.asrProvider} initialMinutesMode={boot.providers.minutesMode}/>}<VocabularySettings actionsTarget={settingsActions}/><DeviceSettings disabled={recording}/>{record && <div className="settings-section settings-inline"><div className="section-title"><Translate size={19}/><h3>识别语言</h3></div><Select label="当前记录识别语言" readOnly={boot.providers.asrProvider === "sensevoice-local" || busy || ["recording","sealed"].includes(record.capture) || record.pendingChunks>0} value={boot.providers.asrProvider === "sensevoice-local" ? "auto" : record.language} onChange={language => void mutate(`/records/${id}`,"PATCH",{language})} options={boot.providers.asrProvider === "sensevoice-local" ? [{value:"auto",label:"自动识别 · 中英日韩粤"}] : [{value:"auto",label:"自动识别"},{value:"zh",label:"中文"},{value:"en",label:"English"},{value:"ja",label:"日本語"},{value:"ko",label:"한국어"},{value:"yue",label:"粤语"}]}/></div>}{record && <TranslationSettings key={record.id} recordId={record.id} value={record.translationTarget || ''} saved={target => setRecord(current => current?.id === record.id ? {...current,translationTarget:target} : current)}/>}
</Modal>}
    {modal === 'delete' && record && <Modal title="删除这条记录？" onClose={() => setModal(null)}><p>“{record.title}”将立即停止访问，分享链接与旧处理任务失效；后台随后清理原音。</p><div className="actions"><Button variant="danger" disabled={busy} onClick={async () => { const deletedId = id; if (await mutate(`/records/${id}`, 'DELETE')) { selectRecord(''); setModal(null); try { await clearRecordAudio(deletedId); } catch { setError('云端已禁访；本机音频缓冲清理失败，请在浏览器设置中清理此站点数据。'); } await loadList(); } }}>删除记录</Button><Button onClick={() => setModal(null)}>保留记录</Button></div></Modal>}
    {modal === 'import-text' && record && <Modal title="导入已有转录" onClose={() => setModal(null)} wide><form onSubmit={async e => { e.preventDefault(); const text = new FormData(e.currentTarget).get('text'); if (await mutate(`/records/${id}/import-text`, 'POST', { text })) setModal(null); }}><label>转录正文<textarea name="text" rows={12} required maxLength={100000} placeholder="按自然段粘贴已有转录。导入文本不会生成虚构的音频时间。"/></label><Button disabled={busy} variant="primary" type="submit">导入文字</Button></form></Modal>}
    {modal === 'learning' && record && <LearningReview record={record} service={learningService} close={()=>setModal(null)}/>}
    {modal === 'share' && record && <ShareDialog key={record.id} record={record} localAccount={localBackend} close={() => setModal(null)} notify={showToast}/>}
    {evidence && <CitationContext key={`${evidence.reference.segmentId}:${evidence.reference.revision}`} selection={evidence} close={() => setEvidence(null)}/>}
  </div>;
}
