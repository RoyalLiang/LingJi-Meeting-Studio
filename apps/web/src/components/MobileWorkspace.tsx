import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowClockwise, FileText, Headphones, Link, Microphone, Moon, ShieldCheck, User, WifiSlash, HardDrives, DeviceMobile, Pause, Play, CaretRight } from '@phosphor-icons/react';
import type { Minutes } from '../model';
import type { CopySummary, MeetingAnnotations, MeetingCopy } from '../sync/journal';
import { api } from '../api';
import type { MobileRecording } from '../sync/mobile-library';
import { Brand } from './Brand';
import { Button } from './ui';
import './MobileWorkspace.css';

export type MobilePage = 'record' | 'meetings' | 'account';
type TranscriptLine = { id: string; speaker: string; startMs: number; text: string };
type Usage = { meetings: number; audio: number; quota: number };
type Entry = { id: string; title: string; at: number; saved?: MobileRecording; cloud?: CopySummary };
const pages = [['record', '记录', Microphone], ['meetings', '会议', FileText], ['account', '我的', User]] as const;
const detailTabs = [['minutes', '纪要'], ['transcript', '原文'], ['notes', '手记']] as const;
const date = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const clock = (seconds: number) => [Math.floor(seconds / 60), seconds % 60].map(value => String(value).padStart(2, '0')).join(':');

function combined(copies: CopySummary[], saved: MobileRecording[]): Entry[] {
  const entries: Entry[] = copies.map(cloud => ({
    ...cloud, cloud, saved: saved.find(entry => entry.id === cloud.sourceId)
  }));
  return [...entries, ...saved.filter(entry => !entries.some(item => item.saved?.id === entry.id)).map(entry => ({
    ...entry, saved: entry
  }))].sort((a, b) => b.at - a.at);
}

function RecordCards({ entries, select, empty }: { entries: Entry[]; select: (entry: Entry) => void; empty: string }) {
  if (!entries.length) return <p className="mobile-empty">{empty}</p>;
  return <ul className="mobile-record-list">{entries.map(entry => {
    const seconds = entry.saved?.seconds ?? (entry.cloud?.durationMs === undefined ? null : Math.floor(entry.cloud.durationMs / 1000));
    return <li key={entry.id}>
      <button type="button" className="mobile-record-card" onClick={() => select(entry)}>
        <strong>{entry.title}</strong>
        <span className="mobile-record-badge">{entry.cloud?.pending ? '待同步' : entry.cloud ? '已同步' : '本机录音'}</span>
        <span className="mobile-record-meta">
          <time dateTime={new Date(entry.at).toISOString()}>{date.format(entry.at)}</time>
          <span>{entry.cloud?.workspace?.name || '个人空间'}</span>
        {seconds !== null && <span>{clock(seconds)}</span>}
        {entry.saved ? <span><Headphones size={14} aria-hidden="true"/> 回听</span>
          : entry.cloud?.fromPhone !== undefined && <span>{entry.cloud.fromPhone ? '手机录音' : '电脑记录'}</span>}
        </span>
      </button>
    </li>;
  })}</ul>;
}

function MobileMeeting({ entry, back, read, play, saveAnnotations }: {
  entry: Entry; back: () => void; read: (id: string) => Promise<MeetingCopy | null>; play: (id: string) => Promise<Blob | null>;
  saveAnnotations: (parent: string, changes: MeetingAnnotations) => Promise<void>;
}) {
  const [tab, setTab] = useState<(typeof detailTabs)[number][0]>('minutes');
  const [copy, setCopy] = useState<MeetingCopy | null>();
  const [audio, setAudio] = useState('');
  const player = useRef<HTMLAudioElement>(null);
  const requestedTime = useRef(0);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState('');
  const [error, setError] = useState('');
  const [audioLoading, setAudioLoading] = useState(false);
  const [citation, setCitation] = useState<TranscriptLine>();
  const [highlight, setHighlight] = useState('');
  const mounted = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!entry.cloud) return;
    let active = true;
    void read(entry.cloud.id).then(value => {
      if (active) setCopy(value);
    }).catch(() => { if (active) { setError('无法读取此会议'); setCopy(null); } });
    return () => { active = false; };
  }, [entry.cloud?.id, read]);
  useEffect(() => () => { if (audio) URL.revokeObjectURL(audio); }, [audio]);
  useEffect(() => {
    if (citation && !dialog.current?.open) dialog.current?.showModal();
  }, [citation]);
  useEffect(() => {
    if (tab === 'transcript' && highlight) document.getElementById('mobile-line-' + highlight)?.scrollIntoView({ block: 'center' });
  }, [highlight, tab]);
  function seek(seconds: number) {
    const element = player.current;
    if (!element || !Number.isFinite(element.duration)) return;
    element.currentTime = Math.min(Math.max(0, seconds), element.duration);
    setPosition(element.currentTime);
  }
  async function playLocal(seconds = 0) {
    if (!entry.saved || audioLoading) return;
    setError('');
    if (player.current) {
      seek(seconds);
      void player.current.play().catch(() => setError('无法播放录音，请重试'));
      return;
    }
    requestedTime.current = seconds;
    setAudioLoading(true);
    try {
      const blob = await play(entry.saved.id);
      if (!mounted.current) return;
      if (!blob) throw new Error('本机没有保存这段音频');
      setAudio(URL.createObjectURL(blob));
    } catch (failure) { if (mounted.current) setError((failure as Error).message); }
    finally { if (mounted.current) setAudioLoading(false); }
  }
  async function save(changes: MeetingAnnotations, notesChanged = false) {
    if (!entry.cloud || saving) return;
    setSaving(true);
    setError('');
    setSavedNotice('');
    try {
      await saveAnnotations(entry.cloud.id, changes);
      if (mounted.current) {
        setCopy(current => current && { ...current, ...changes });
        if (notesChanged) setDraft(null);
        setSavedNotice('已加密保存');
      }
    } catch (failure) {
      if (mounted.current) setError((failure as Error).message);
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  const content = copy?.content;
  const lines = (content?.segments || []) as TranscriptLine[];
  const minutes = content?.minutes as Minutes | null | undefined;
  return <section aria-label="会议详情">
    <header className="mobile-detail-header">
      <Button variant="ghost" aria-label="返回会议列表" onClick={back}><ArrowLeft size={20}/></Button>
      <h1>{entry.title}</h1>
      <span className="mobile-record-badge">{entry.cloud?.pending ? '待同步' : entry.cloud ? '已同步' : '本机录音'}</span>
    </header>
    <nav className="mobile-detail-tabs" aria-label="会议内容">
      {detailTabs.map(([id, label]) => <button key={id} type="button" aria-current={id === tab ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>)}
    </nav>
    {entry.saved && <div className="mobile-playback">
      {audio ? <>
        <audio ref={player} src={audio} autoPlay preload="auto"
          onLoadedMetadata={event => {
            const element = event.currentTarget;
            if (Number.isFinite(element.duration)) setDuration(element.duration);
            element.playbackRate = speed;
            seek(requestedTime.current);
          }}
          onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
          onError={() => setError('无法播放录音，请重试')}/>
        <div className="mobile-player">
          <Button variant="ghost" aria-label={playing ? '暂停回听' : '播放录音'} onClick={() => {
            const element = player.current;
            if (!element) return;
            if (!element.paused) element.pause();
            else void element.play().catch(() => setError('无法播放录音，请重试'));
          }}>{playing ? <Pause size={20} weight="fill"/> : <Play size={20} weight="fill"/>}</Button>
          <input type="range" aria-label="回听进度" min={0} max={duration} step={0.1} value={position}
            disabled={!duration} onChange={event => seek(event.currentTarget.valueAsNumber)}/>
          <select aria-label="播放速度" value={speed} onChange={event => {
            const next = Number(event.target.value);
            if (player.current) player.current.playbackRate = next;
            setSpeed(next);
          }}>{[1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}</select>
          <small>{clock(Math.floor(position))} / {clock(Math.floor(duration))}</small>
        </div>
      </> : <Button variant="ghost" disabled={audioLoading} onClick={() => void playLocal()}><Headphones size={17}/>{audioLoading ? '正在打开…' : '回听录音'}<span>{clock(entry.saved.seconds)}</span></Button>}
    </div>}
    {error && <p role="alert" className="mobile-empty">{error}</p>}
    {savedNotice && !error && <p role="status" className="mobile-save-status">{savedNotice}</p>}
    {entry.cloud && copy === undefined && <p role="status" className="mobile-empty">正在打开会议…</p>}
    {tab === 'minutes' && <>
      {minutes ? <>
        {minutes.sections.map((part, i) => <section className="mobile-detail-group" key={i}><h2>{part.heading}</h2>
          {part.items.map((item, j) => <article className="mobile-card" key={j}><p>{item.text}</p>
            {item.evidence.map((evidence, k) => {
              const line = lines.find(value => value.id === evidence.segmentId);
              return line && <button className="mobile-citation" type="button" key={k} onClick={() => setCitation(line)}><Link size={13}/>原文 {k + 1}</button>;
            })}
          </article>)}
        </section>)}
        {minutes.actions.length > 0 && <section className="mobile-detail-group"><h2>待跟进</h2>
          {minutes.actions.map((item, i) => <label className="mobile-card mobile-action" key={i}>
          <input type="checkbox" checked={copy?.completed?.includes(i) ?? false} disabled={saving} onChange={event => {
            if (!copy) return;
            const completed = (copy.completed || []).filter(index => index !== i);
            if (event.target.checked) completed.push(i);
            void save({ notes: copy.notes, completed });
          }}/>
          <span>{item.text}{(item.owner || item.due) && <small>{[item.owner, item.due].filter(Boolean).join(' · ')}</small>}</span>
        </label>)}
        </section>}
      </> : (!entry.cloud || copy !== undefined) && <p className="mobile-empty">暂无纪要</p>}
    </>}
    {tab === 'transcript' && (lines.length ? lines.map(line => <article className="mobile-card mobile-line" id={'mobile-line-' + line.id} data-highlight={highlight === line.id} key={line.id}>
      <header><strong>{line.speaker}</strong>{entry.saved
        ? <button className="mobile-time-link" type="button" disabled={audioLoading} onClick={() => void playLocal(line.startMs / 1000)}
            aria-label={`从 ${clock(Math.floor(line.startMs / 1000))} 回听`}>{clock(Math.floor(line.startMs / 1000))}</button>
        : <time>{clock(Math.floor(line.startMs / 1000))}</time>}</header><p>{line.text}</p>
    </article>) : (!entry.cloud || copy !== undefined) && <p className="mobile-empty">等待电脑同步转录</p>)}
    {tab === 'notes' && <>
      {copy && <form className="mobile-card mobile-notes-editor" onSubmit={event => {
        event.preventDefault();
        if (draft !== null) void save({ notes: draft, completed: copy.completed }, true);
      }}>
        <label htmlFor="mobile-meeting-notes">会议手记</label>
        <textarea id="mobile-meeting-notes" placeholder="记下你的想法" maxLength={100_000} value={draft ?? copy.notes}
          disabled={saving} onChange={event => setDraft(event.target.value)}/>
        <Button type="submit" variant="primary" disabled={saving || draft === null || draft === copy.notes}>保存手记</Button>
      </form>}
      {entry.saved?.marks.length ? <section className="mobile-detail-group"><h2>录音重点</h2>
        <ul className="mobile-record-list">{entry.saved.marks.map(mark => <li className="mobile-card" key={mark}><button className="mobile-time-link" type="button" disabled={audioLoading}
          onClick={() => void playLocal(mark)} aria-label={`回听重点 ${clock(mark)}`}>{clock(mark)}</button></li>)}</ul>
      </section> : !copy && <p className="mobile-empty">暂无手记</p>}
    </>}
    <dialog ref={dialog} className="mobile-source-sheet" onClose={() => setCitation(undefined)}>
      {citation && <><h2>来源原文</h2><p className="mobile-sheet-note">{citation.speaker} · {clock(Math.floor(citation.startMs / 1000))}</p>
      <p>{citation.text}</p><div className="mobile-sheet-actions">
        <Button variant="ghost" onClick={() => dialog.current?.close()}>关闭</Button>
        <Button onClick={() => {
          setTab('transcript'); setHighlight(citation.id); dialog.current?.close();
        }}>在原文中定位</Button>
      </div></>}
    </dialog>
  </section>;
}

function MobileSwitch({ checked, disabled, change }: { checked: boolean; disabled?: boolean; change: (checked: boolean) => void }) {
  return <span className="mobile-switch">
    <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => change(event.target.checked)}/>
    <span className="mobile-switch-track" aria-hidden="true"/>
  </span>;
}

export function MobileWorkspace({
  page, setPage, online, unlocked, automatic, setAutomatic, copies, saved, recorder, account, refresh, read, play, search, saveAnnotations,
}: {
  page: MobilePage; setPage: (page: MobilePage) => void; online: boolean; unlocked: boolean;
  automatic: boolean; setAutomatic: (enabled: boolean) => void;
  copies: CopySummary[]; saved: MobileRecording[]; recorder: ReactNode; account: ReactNode;
  refresh: () => void; read: (id: string) => Promise<MeetingCopy | null>;
  play: (id: string) => Promise<Blob | null>;
  search: (query: string) => Promise<CopySummary[]>;
  saveAnnotations: (parent: string, changes: MeetingAnnotations) => Promise<string>;
}) {
  const [detail, setDetail] = useState<Entry | null>(null);
  const [query, setQuery] = useState('');
  const [space, setSpace] = useState('');
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageError, setUsageError] = useState(false);
  const accountSheet = useRef<HTMLDialogElement>(null);
  const [sheet, setSheet] = useState<'plans' | 'devices' | null>(null);
  useEffect(() => {
    if (sheet && !accountSheet.current?.open) accountSheet.current?.showModal();
  }, [sheet]);
  useEffect(() => {
    if (page !== 'account' || !online || !unlocked) return;
    const controller = new AbortController();
    const signal = controller.signal;
    setUsageError(false);
    void api<Usage>('/private-sync/usage', 'GET', undefined, signal)
      .then(value => { if (!signal.aborted) setUsage(value); })
      .catch(() => { if (!signal.aborted) setUsageError(true); });
    return () => controller.abort();
  }, [page, online, unlocked, copies.length, saved.length]);
  const [matches, setMatches] = useState<CopySummary[] | null>(null);
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');
  const searchTerm = query.trim().toLowerCase();
  useEffect(() => {
    setMatches(null);
    if (!searchTerm || page !== 'meetings' || !unlocked) return;
    let active = true;
    const timer = window.setTimeout(() => void search(searchTerm).then(items => {
      if (active) setMatches(items);
    }).catch(() => { if (active) setMatches(copies.filter(item => item.title.toLowerCase().includes(searchTerm))); }), 170);
    return () => { active = false; clearTimeout(timer); };
  }, [searchTerm, copies, page, unlocked, search]);
  const entries = combined(copies, saved);
  const opened = detail && (entries.find(item => detail.cloud ? item.id === detail.id : item.saved?.id === detail.saved?.id) || detail);
  const workspaces = [...new Map(copies.flatMap(copy => copy.workspace ? [[copy.workspace.id, copy.workspace] as const] : [])).values()]
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  const filtered = searchTerm ? combined(matches || copies.filter(item => item.title.toLowerCase().includes(searchTerm)),
    saved.filter(item => item.title.toLowerCase().includes(searchTerm) || matches?.some(copy => copy.sourceId === item.id))) : entries;
  const visibleEntries = filtered.filter(entry => !space || (entry.cloud?.workspace?.id || 'personal') === space);
  const formatSize = (value: number) => (value / 1048576).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' MiB';
  function navigate(next: MobilePage) {
    setPage(next); setDetail(null);
    window.scrollTo(0, 0);
  }
  function select(entry: Entry) {
    navigate('meetings'); setDetail(entry);
  }
  return <div className="mobile-workspace">
    {(!detail || page !== 'meetings') && <header className="mobile-page-heading">
      {page === 'record' ? <div className="mobile-space"><Brand markOnly/><span>个人空间</span></div> :
        <h1>{page === 'meetings' ? '会议记录' : '个人中心'}</h1>}
      <span className="mobile-sync-pill" data-offline={!online}>
        {!online ? <WifiSlash size={14} aria-hidden="true"/> : <i aria-hidden="true"/>}
        {!online ? '离线' : unlocked ? automatic ? '自动同步' : '手动同步' : '连接中'}
      </span>
    </header>}
    {recorder}
    {page === 'record' && <section className="mobile-recent" aria-label="最近记录">
      <header><h2>最近记录</h2>{entries.length > 0 && <button type="button" onClick={() => navigate('meetings')}>全部</button>}</header>
      <RecordCards entries={entries.slice(0, 4)} select={select} empty="暂无记录"/>
    </section>}
    {page === 'meetings' && (opened ? <MobileMeeting key={opened.saved?.id || opened.cloud?.sourceId || opened.id} entry={opened}
          back={() => setDetail(null)} read={read} play={play} saveAnnotations={async (parent, changes) => {
            const id = await saveAnnotations(parent, changes);
            setDetail(current => current === detail && opened.cloud
              ? { ...opened, id, cloud: { ...opened.cloud, id } }
              : current);
          }}/> : <section aria-label="会议列表">
      <div className="mobile-list-tools">
        <input type="search" aria-label="搜索会议" placeholder="搜索标题、纪要或原文" value={query} onChange={event => setQuery(event.target.value)}/>
        <Button variant="ghost" disabled={!online || !unlocked} aria-label="同步会议" onClick={refresh}><ArrowClockwise size={19}/></Button>
      </div>
              <div className="mobile-space-filters" role="group" aria-label="筛选工作空间">
          {[{ id: '', name: '全部' }, { id: 'personal', name: '个人空间' }, ...workspaces].map(item =>
            <button type="button" key={item.id} aria-pressed={space === item.id} onClick={() => setSpace(item.id)}>{item.name}</button>)}
        </div>
        <RecordCards entries={visibleEntries} select={select} empty={searchTerm || space ? '没有匹配的会议' : '暂无已同步会议'}/>
    </section>)}
    {page === 'account' && <>
      {account}
      <section className="mobile-account-card mobile-quota" aria-label="同步存储">
        <header><h2><HardDrives size={18} aria-hidden="true"/>同步存储</h2>
          <Button variant="ghost" onClick={() => setSheet('plans')}>分级方案</Button>
        </header>
        {usage && usage.quota > 0 ? <div className="mobile-quota-list">
          <label><span>会议与纪要</span><small>{formatSize(usage.meetings)} / {formatSize(usage.quota)}</small>
            <meter min={0} max={usage.quota} value={usage.meetings}/></label>
          <label><span>手机录音</span><small>{formatSize(usage.audio)} / {formatSize(usage.quota)}</small>
            <meter min={0} max={usage.quota} value={usage.audio}/></label>
        </div> : <p className="mobile-empty">{!online ? '联网后查看用量' : usageError ? '暂时无法查询用量' : unlocked ? '正在查询用量…' : '解锁后可查看用量'}</p>}
      </section>
      <div className="mobile-account-group">
        <label><ArrowClockwise size={17}/><span>自动同步会议与纪要</span><MobileSwitch disabled={!unlocked} checked={automatic} change={setAutomatic}/></label>
        <label><Moon size={17}/><span>深色外观</span><MobileSwitch checked={dark} change={checked => {
          const value = checked ? 'dark' : 'light';
          document.documentElement.dataset.theme = value;
          setDark(checked);
          try { localStorage.setItem('meeting-theme', value); } catch {}
          document.dispatchEvent(new Event('meeting:theme'));
        }}/></label>
      </div>
      <div className="mobile-account-group">
        <div><ShieldCheck size={17}/><span>端到端加密</span><small>{unlocked ? '已解锁' : '等待解锁'}</small></div>
        <button type="button" aria-label="设备" onClick={() => setSheet('devices')}><DeviceMobile size={17}/><span>设备</span>
          <small>当前设备 <CaretRight size={14} aria-hidden="true"/></small></button>
        <div><FileText size={17}/><span>已同步会议</span><small>{copies.length} 条</small></div>
        <div><Headphones size={17}/><span>本机回听</span><small>{saved.length} 条</small></div>
      </div>
      <dialog ref={accountSheet} className="mobile-source-sheet" onClose={() => setSheet(null)}>
        {sheet === 'plans' ? <>
          <h2>分级方案</h2><p className="mobile-sheet-note">容量规划预览，购买暂未开放</p>
          <ul className="mobile-record-list">
            {['本机免费', '5 GB 标准空间', '20 GB 进阶空间', '100 GB 归档空间'].map(plan =>
              <li className="mobile-card" key={plan}>{plan}</li>)}
          </ul>
        </> : <>
          <h2>设备</h2>
          <div className="mobile-card"><strong>当前设备</strong><small>{unlocked ? '已登录 · 已解锁' : '已登录'}</small></div>
        </>}
        <div className="mobile-sheet-actions"><Button onClick={() => accountSheet.current?.close()}>关闭</Button></div>
      </dialog>
    </>}
    <nav className="mobile-nav" aria-label="底部菜单" data-page={page}>
      <span className="mobile-nav-lens" aria-hidden="true"/>
      {pages.map(([id, label, Icon]) => <button type="button" key={id} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}>
        <Icon size={20} aria-hidden="true"/>{label}</button>)}
    </nav>
  </div>;
}
