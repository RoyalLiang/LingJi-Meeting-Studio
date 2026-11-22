import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowClockwise, CaretDown, DeviceMobile, FileText, Headphones, Keyhole, Link, MagnifyingGlass, Microphone, Moon, Pause, Play, Trash, User, WifiSlash, CaretRight } from '@phosphor-icons/react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import type { Minutes } from '../model';
import type { CopySummary, MeetingAnnotations, MeetingCopy } from '../sync/journal';
import { api } from '../api';
import type { MobileRecording } from '../sync/mobile-library';
import { MobileAccountDevices, MobileAccountFactor, MobileBillingPlans, loadMobileDevices, loadMobileFactor } from './MobileAccountPanels';
import { Brand } from './Brand';
import { Button } from './ui';
import { MobileSheet } from './MobileSheet';
import './MobileWorkspace.css';

export type MobilePage = 'record' | 'meetings' | 'account';
type TranscriptLine = { id: string; speaker: string; startMs: number; text: string };
type Usage = { meetings: number; audio: number; quota: number };
type Entry = { id: string; title: string; at: number; saved?: MobileRecording; cloud?: CopySummary };
const pages = [['record', '记录', Microphone], ['meetings', '会议', FileText], ['account', '我的', User]] as const;
const detailTabs = [['minutes', '纪要'], ['transcript', '原文'], ['notes', '手记']] as const;
const date = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clock = (seconds: number) => [Math.floor(seconds / 60), seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
const recordedAt = (entry: Entry) => entry.saved?.at ?? entry.at;
const recordTitle = (entry: Entry) => entry.title === '手机录音 · ' + date.format(recordedAt(entry)) ? '手机录音' : entry.title;

function combined(copies: CopySummary[], saved: MobileRecording[]): Entry[] {
  const savedById = new Map(saved.map(item => [item.id, item]));
  const matchedSaved = new Set<string>();
  const entries: Entry[] = copies.map(cloud => {
    const local = savedById.get(cloud.sourceId);
    if (local) matchedSaved.add(local.id);
    return { ...cloud, cloud, saved: local };
  });
  for (const item of saved) {
    if (!matchedSaved.has(item.id)) entries.push({ ...item, saved: item });
  }
  return entries.sort((a, b) => b.at - a.at);
}

const RecordRow = memo(function RecordRow({ entry, opened, reveal, select, remove }: {
  entry: Entry; opened: boolean; reveal: (id: string | null) => void;
  select: (entry: Entry) => void; remove?: (entry: Entry) => void;
}) {
    const [drag, setDrag] = useState<number>();
    const tracking = useRef<{ x: number; y: number; horizontal: boolean } | undefined>(undefined);
    const suppressClick = useRef(false);
    const seconds = entry.saved?.seconds ?? (entry.cloud?.durationMs === undefined ? null : Math.floor(entry.cloud.durationMs / 1000));
    const at = recordedAt(entry);
    return <li className="mobile-record-row" data-revealed={opened}>
      {remove && <button type="button" className="mobile-row-delete" tabIndex={opened ? 0 : -1} aria-hidden={!opened}
        onClick={() => { reveal(null); remove(entry); }}><Trash size={18}/>移除</button>}
      <div className="mobile-record-slide" data-dragging={drag !== undefined} style={{ transform: `translateX(${drag ?? (opened ? -76 : 0)}px)` }}
        onPointerDown={event => {
          suppressClick.current = false;
          if (remove && event.isPrimary && event.button === 0) tracking.current = { x: event.clientX, y: event.clientY, horizontal: false };
        }}
        onPointerMove={event => {
          const start = tracking.current;
          if (!start) return;
          const dx = event.clientX - start.x, dy = event.clientY - start.y;
          if (!start.horizontal) {
            if (Math.abs(dy) > 9 && Math.abs(dy) >= Math.abs(dx)) { tracking.current = undefined; return; }
            if (Math.abs(dx) < 10 || Math.abs(dx) <= Math.abs(dy)) return;
            start.horizontal = true;
            suppressClick.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          setDrag(Math.min(0, Math.max(-88, (opened ? -76 : 0) + dx)));
        }}
        onPointerUp={event => {
          if (tracking.current?.horizontal) {
            const dx = event.clientX - tracking.current.x;
            reveal((opened ? dx < 26 : dx < -34) ? entry.id : null);
          }
          tracking.current = undefined;
          setDrag(undefined);
        }}
        onPointerCancel={() => { tracking.current = undefined; setDrag(undefined); }}
        onClickCapture={event => {
          if (suppressClick.current && event.detail > 0) { event.stopPropagation(); suppressClick.current = false; }
        }}>
      <button type="button" className="mobile-record-card" onClick={() => { if (opened) reveal(null); else select(entry); }}>
        <strong>{recordTitle(entry)}</strong>
        <span className="mobile-record-meta">
          <time dateTime={new Date(at).toISOString()}>{time.format(at)}</time>
          {entry.cloud?.workspace && <span>{entry.cloud.workspace.name}</span>}
          {entry.cloud?.pending && <span>待同步</span>}
        </span>
        <span className="mobile-record-duration">
          {entry.saved && <Headphones size={15} role="img" aria-label="可回听"/>}
          {seconds !== null && clock(seconds)}
        </span>
      </button>
      </div>
    </li>;
});

const RecordCards = memo(function RecordCards({ entries, select, empty, remove }: {
  entries: Entry[]; select: (entry: Entry) => void; empty: string; remove?: (entry: Entry) => void;
}) {
  const [opened, reveal] = useState<string | null>(null);
  const groups = useMemo(() => {
    const days = new Map<string, Entry[]>();
    for (const entry of [...entries].sort((a, b) => recordedAt(b) - recordedAt(a))) {
      const label = day.format(recordedAt(entry));
      const group = days.get(label);
      if (group) group.push(entry);
      else days.set(label, [entry]);
    }
    return [...days];
  }, [entries]);
  if (!entries.length) return <p className="mobile-empty">{empty}</p>;
  return <div className="mobile-record-groups">{groups.map(([label, items]) => <section key={label} aria-label={label}>
    <h2>{label}</h2>
    <ul className="mobile-record-list">{items.map(entry =>
      <RecordRow key={entry.id} entry={entry} opened={opened === entry.id} reveal={reveal} select={select} remove={remove}/>)}</ul>
  </section>)}</div>;
});

type PlayerHandle = { playAt: (seconds: number) => void };
const MobileAudioPlayer = memo(forwardRef<PlayerHandle, {
  saved: MobileRecording;
  play: (id: string) => Promise<Blob | null>;
  onError: (message: string) => void;
}>(function MobileAudioPlayer({ saved, play, onError }, ref) {
  const [audio, setAudio] = useState('');
  const player = useRef<HTMLAudioElement>(null);
  const requestedTime = useRef(0);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [audioLoading, setAudioLoading] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => () => { if (audio) URL.revokeObjectURL(audio); }, [audio]);

  const seek = useCallback((seconds: number) => {
    const element = player.current;
    if (!element || !Number.isFinite(element.duration)) return;
    element.currentTime = Math.min(Math.max(0, seconds), element.duration);
    setPosition(element.currentTime);
  }, []);

  const playLocal = useCallback(async (seconds = 0) => {
    if (audioLoading) return;
    onError('');
    if (player.current) {
      seek(seconds);
      void player.current.play().catch(() => onError('无法播放录音，请重试'));
      return;
    }
    requestedTime.current = seconds;
    setAudioLoading(true);
    try {
      const blob = await play(saved.id);
      if (!mounted.current) return;
      if (!blob) throw new Error('本机没有保存这段音频');
      setAudio(URL.createObjectURL(blob));
    } catch (failure) { if (mounted.current) onError((failure as Error).message); }
    finally { if (mounted.current) setAudioLoading(false); }
  }, [audioLoading, onError, play, saved.id, seek]);

  useImperativeHandle(ref, () => ({ playAt: seconds => { void playLocal(seconds); } }), [playLocal]);

  return <div className="mobile-playback">
    {audio && <audio ref={player} src={audio} autoPlay preload="metadata"
      onLoadedMetadata={event => {
        const element = event.currentTarget;
        if (Number.isFinite(element.duration)) setDuration(element.duration);
        element.playbackRate = speed;
        seek(requestedTime.current);
      }}
      onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
      onError={() => { setAudio(''); onError('无法播放录音，请重试'); }}/>}
    <div className="mobile-player" role="group" aria-label="录音回听">
      <Button variant="primary" className="mobile-player-play" aria-busy={audioLoading}
        aria-label={playing ? '暂停回听' : '播放录音'} disabled={audioLoading} onClick={() => {
          const element = player.current;
          if (!element) void playLocal();
          else if (!element.paused) element.pause();
          else void element.play().catch(() => onError('无法播放录音，请重试'));
        }}>{playing ? <Pause size={20} weight="fill"/> : <Play size={20} weight="fill"/>}</Button>
      <div className="mobile-player-times">
        <span>{clock(Math.floor(position))}</span>
        <span className="mobile-player-duration"> / {clock(Math.floor(duration || saved.seconds))}</span>
      </div>
      <div className="mobile-player-rate">
        <select aria-label="播放速度" value={speed} onChange={event => {
          const next = Number(event.target.value);
          if (player.current) player.current.playbackRate = next;
          setSpeed(next);
        }}>{[1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}</select>
        <CaretDown size={12} aria-hidden="true"/>
      </div>
      <div className="mobile-player-track">
        <div aria-hidden="true" className="mobile-player-rail">
          <span style={{ width: `${duration ? Math.min(100, position / duration * 100) : 0}%` }}/>
        </div>
        <input type="range" aria-label="回听进度" min={0} max={duration || saved.seconds} step={0.1} value={position}
          aria-valuetext={clock(Math.floor(position))} disabled={!audio || !duration} onChange={event => seek(event.currentTarget.valueAsNumber)}/>
      </div>
    </div>
  </div>;
}));

const MobileTranscriptList = memo(function MobileTranscriptList({ lines, highlight, hasLocal, onPlayAt }: {
  lines: TranscriptLine[]; highlight: string; hasLocal: boolean; onPlayAt: (seconds: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useWindowVirtualizer({
    count: lines.length,
    estimateSize: () => 96,
    overscan: 6,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });
  useEffect(() => {
    if (!highlight) return;
    const index = lines.findIndex(line => line.id === highlight);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' });
  }, [highlight, lines, virtualizer]);
  return <div ref={listRef} className="mobile-transcript-virtual" style={{ height: virtualizer.getTotalSize() }}>
    {virtualizer.getVirtualItems().map(item => {
      const line = lines[item.index];
      return <div key={line.id} data-index={item.index} ref={virtualizer.measureElement} className="mobile-transcript-row"
        style={{ transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)` }}>
        <article className="mobile-card mobile-line" id={'mobile-line-' + line.id} data-highlight={highlight === line.id}>
          <header><strong>{line.speaker}</strong>{hasLocal
            ? <button className="mobile-time-link" type="button" onClick={() => onPlayAt(line.startMs / 1000)}
                aria-label={`从 ${clock(Math.floor(line.startMs / 1000))} 回听`}>{clock(Math.floor(line.startMs / 1000))}</button>
            : <time>{clock(Math.floor(line.startMs / 1000))}</time>}</header><p>{line.text}</p>
        </article>
      </div>;
    })}
  </div>;
});

function MobileMeeting({ entry, back, read, play, saveAnnotations, remove }: {
  entry: Entry; back: () => void; read: (id: string) => Promise<MeetingCopy | null>; play: (id: string) => Promise<Blob | null>;
  saveAnnotations: (parent: string, changes: MeetingAnnotations) => Promise<void>;
  remove?: (entry: Entry) => void;
}) {
  const [tab, setTab] = useState<(typeof detailTabs)[number][0]>('minutes');
  const [copy, setCopy] = useState<MeetingCopy | null>();
  const playerRef = useRef<PlayerHandle>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState('');
  const [error, setError] = useState('');
  const [citation, setCitation] = useState<TranscriptLine>();
  const [highlight, setHighlight] = useState('');
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!entry.cloud) return;
    let active = true;
    void read(entry.cloud.id).then(value => {
      if (active) { setCopy(value); setError(''); }
    }).catch(() => { if (active) setError('无法读取此会议'); });
    return () => { active = false; };
  }, [entry.cloud?.id, read]);
  const playAt = useCallback((seconds: number) => {
    playerRef.current?.playAt(seconds);
  }, []);
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
  const lines = useMemo(() => (content?.segments || []) as TranscriptLine[], [content?.segments]);
  const linesById = useMemo(() => new Map(lines.map(line => [line.id, line])), [lines]);
  const minutes = content?.minutes as Minutes | null | undefined;
  return <section aria-label="会议详情">
    <header className="mobile-detail-header">
      <Button variant="ghost" aria-label="返回会议列表" onClick={back}><ArrowLeft size={18}/></Button>
      <div>
        <h2>{recordTitle(entry)}</h2>
        <p className="mobile-detail-meta">
          <time dateTime={new Date(recordedAt(entry)).toISOString()}>{date.format(recordedAt(entry))}</time>
          <span>{entry.cloud?.pending ? '待同步' : entry.cloud ? '已同步' : '本机录音'}</span>
        </p>
      </div>
    </header>
    {entry.saved && <MobileAudioPlayer ref={playerRef} saved={entry.saved} play={play} onError={setError}/>}

    <nav className="mobile-detail-tabs" aria-label="会议内容">
      {detailTabs.map(([id, label]) => <button key={id} type="button" aria-current={id === tab ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>)}
    </nav>
    {error && <p role="alert" className="mobile-empty">{error}</p>}
    {savedNotice && !error && <p role="status" className="mobile-save-status">{savedNotice}</p>}
    {entry.cloud && copy === undefined && <p role="status" className="mobile-empty">正在打开会议…</p>}
    {tab === 'minutes' && <>
      {minutes ? <>
        {minutes.sections.map((part, i) => <section className="mobile-detail-group" key={i}><h2>{part.heading}</h2>
          {part.items.map((item, j) => <article className="mobile-card" key={j}><p>{item.text}</p>
            {item.evidence.map((evidence, k) => {
              const line = linesById.get(evidence.segmentId);
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
    {tab === 'transcript' && (lines.length
      ? <MobileTranscriptList lines={lines} highlight={highlight} hasLocal={Boolean(entry.saved)} onPlayAt={playAt}/>
      : (!entry.cloud || copy !== undefined) && <p className="mobile-empty">等待电脑同步转录</p>)}
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
        <ul className="mobile-record-list">{entry.saved.marks.map(mark => <li className="mobile-card" key={mark}><button className="mobile-time-link" type="button"
          onClick={() => playAt(mark)} aria-label={`回听重点 ${clock(mark)}`}>{clock(mark)}</button></li>)}</ul>
      </section> : !copy && <p className="mobile-empty">暂无手记</p>}
    </>}
    {remove && <div className="mobile-detail-actions">
      <Button className="mobile-remove-link" variant="ghost" onClick={() => remove(entry)}>移除本机记录</Button>
    </div>}
    {citation && <MobileSheet title="来源原文" close={() => setCitation(undefined)}>
      <p className="mobile-sheet-note">{citation.speaker} · {clock(Math.floor(citation.startMs / 1000))}</p>
      <p>{citation.text}</p><div className="mobile-sheet-actions">
        <Button onClick={() => {
          setTab('transcript'); setHighlight(citation.id); setCitation(undefined);
        }}>在原文中定位</Button>
      </div>
    </MobileSheet>}
  </section>;
}

function MobileSwitch({ checked, disabled, change }: { checked: boolean; disabled?: boolean; change: (checked: boolean) => void }) {
  return <span className="mobile-switch">
    <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => change(event.target.checked)}/>
    <span className="mobile-switch-track" aria-hidden="true"/>
  </span>;
}

export function MobileWorkspace({
  page, setPage, online, unlocked, automatic, setAutomatic, copies, saved, hidden, recorder, account, read, play, search, saveAnnotations, deleteLocal, email, legacyAccount,
}: {
  email: string; legacyAccount: boolean;
  page: MobilePage; setPage: (page: MobilePage) => void; online: boolean; unlocked: boolean;
  automatic: boolean; setAutomatic: (enabled: boolean) => void;
  copies: CopySummary[]; saved: MobileRecording[]; hidden: ReadonlySet<string>; recorder: ReactNode; account: ReactNode;
  read: (id: string) => Promise<MeetingCopy | null>;
  play: (id: string) => Promise<Blob | null>;
  search: (query: string) => Promise<CopySummary[]>;
  saveAnnotations: (parent: string, changes: MeetingAnnotations) => Promise<string>;
  deleteLocal?: (id: string) => Promise<void>;
}) {
  const [detail, setDetail] = useState<Entry | null>(null);
  const [query, setQuery] = useState('');
  const [space, setSpace] = useState('');
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageError, setUsageError] = useState(false);
  const [sheet, setSheet] = useState<'plans' | 'devices' | 'factor' | null>(null);
  const [factorBusy, setFactorBusy] = useState(false);
  const [removing, setRemoving] = useState<Entry>();
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const chooseRemoval = useCallback((entry: Entry) => { setRemoveError(''); setRemoving(entry); }, []);
  useEffect(() => {
    if (page === 'account' && online) void Promise.allSettled([loadMobileDevices(), loadMobileFactor()]);
  }, [page, online]);
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
  const entries = useMemo(() => combined(copies, saved), [copies, saved]);
  const opened = detail && (entries.find(item => detail.cloud ? item.id === detail.id : item.saved?.id === detail.saved?.id)
    || entries.find(item => item.cloud && item.cloud.sourceId === detail.cloud?.sourceId) || detail);
  const workspaces = useMemo(() => [...new Map(copies.flatMap(copy => copy.workspace ? [[copy.workspace.id, copy.workspace] as const] : [])).values()]
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')), [copies]);
  const filtered = useMemo(() => {
    if (!searchTerm) return entries;
    const matchedIds = matches ? new Set(matches.map(copy => copy.sourceId)) : null;
    return combined(
      matches || copies.filter(item => item.title.toLowerCase().includes(searchTerm)),
      saved.filter(item => item.title.toLowerCase().includes(searchTerm) || Boolean(matchedIds?.has(item.id)))
    );
  }, [searchTerm, entries, matches, copies, saved]);
  const visibleEntries = useMemo(() => filtered.filter(entry => !hidden.has(entry.cloud?.sourceId || entry.id) &&
    (!space || (entry.cloud?.workspace?.id || 'personal') === space)), [filtered, hidden, space]);
  const formatSize = (value: number) => (value / (value >= 1073741824 ? 1073741824 : 1048576)).toLocaleString('zh-CN',
    { maximumFractionDigits: 2 }) + (value >= 1073741824 ? ' GiB' : ' MiB');
  const navigate = useCallback((next: MobilePage) => {
    setPage(next); setDetail(null);
    window.scrollTo(0, 0);
  }, [setPage]);
  const select = useCallback((entry: Entry) => {
    setPage('meetings'); setDetail(entry);
    window.scrollTo(0, 0);
  }, [setPage]);
  return <div className="mobile-workspace" data-page={page}>
    <header className="mobile-page-heading">
      <div className="mobile-space"><Brand markOnly/>
        <h1>{page === 'record' ? '记录' : page === 'meetings' ? '会议记录' : '个人中心'}</h1></div>
      <span className="mobile-sync-pill" data-offline={!online}>
        {!online ? <WifiSlash size={14} aria-hidden="true"/> : <i aria-hidden="true"/>}
        {!online ? '离线' : unlocked ? automatic ? '自动同步' : '手动同步' : '连接中'}
      </span>
    </header>
    {recorder}
    {page === 'meetings' && (opened ? <MobileMeeting key={opened.saved?.id || opened.cloud?.sourceId || opened.id} entry={opened}
          back={() => setDetail(null)} read={read} play={play} remove={deleteLocal && chooseRemoval} saveAnnotations={async (parent, changes) => {
            const id = await saveAnnotations(parent, changes);
            setDetail(current => current === detail && opened.cloud
              ? { ...opened, id, cloud: { ...opened.cloud, id } }
              : current);
          }}/> : <section aria-label="会议列表">
      <div className="mobile-list-tools">
        <MagnifyingGlass size={17} aria-hidden="true"/>
        <input type="search" aria-label="搜索会议" placeholder="搜索会议" value={query} onChange={event => setQuery(event.target.value)}/>
      </div>
      {(workspaces.length > 0 || space) && <div className="mobile-space-filters" role="group" aria-label="筛选工作空间">
          {[{ id: '', name: '全部' }, { id: 'personal', name: '个人空间' }, ...workspaces].map(item =>
            <button type="button" key={item.id} aria-pressed={space === item.id} onClick={() => setSpace(item.id)}>{item.name}</button>)}
        </div>}
        <RecordCards entries={visibleEntries} select={select} empty={searchTerm || space ? '没有匹配的会议' : '暂无已同步会议'}
          remove={deleteLocal && chooseRemoval}/>
    </section>)}
    {page === 'account' && <>
      {account}
      <section className="mobile-account-card mobile-quota" aria-label="同步存储">
        <header><h2>同步存储</h2>
          <Button variant="ghost" onClick={() => setSheet('plans')}>分级方案</Button>
        </header>
        {usage && usage.quota > 0 ? <div className="mobile-quota-list">
          <label><span>已使用</span><small>{formatSize(usage.meetings + usage.audio)} / {formatSize(usage.quota)}</small>
            <meter min={0} max={usage.quota} value={usage.meetings + usage.audio}/></label>
          <div><span>会议与纪要</span><small>{formatSize(usage.meetings)}</small></div>
          <div><span>手机录音</span><small>{formatSize(usage.audio)}</small></div>
        </div> : <p className="mobile-empty">{!online ? '联网后查看用量' : usageError ? '暂时无法查询用量' : unlocked ? '正在查询用量…' : '解锁后可查看用量'}</p>}
      </section>
      <section className="mobile-account-section" aria-labelledby="mobile-preferences">
        <h2 id="mobile-preferences">偏好</h2>
        <div className="mobile-account-group">
        <label><ArrowClockwise size={17} aria-hidden="true"/><span>自动同步会议与纪要</span><MobileSwitch disabled={!unlocked} checked={automatic} change={setAutomatic}/></label>
        <label><Moon size={17} aria-hidden="true"/><span>深色外观</span><MobileSwitch checked={dark} change={checked => {
          const value = checked ? 'dark' : 'light';
          document.documentElement.dataset.theme = value;
          setDark(checked);
          try { localStorage.setItem('meeting-theme', value); } catch {}
          document.dispatchEvent(new Event('meeting:theme'));
        }}/></label>
        </div>
      </section>
      <section className="mobile-account-section" aria-labelledby="mobile-security">
        <h2 id="mobile-security">账号安全</h2>
        <div className="mobile-account-group">
        <button type="button" onClick={() => setSheet('factor')}><Keyhole size={17} aria-hidden="true"/><span>双重验证</span>
          <CaretRight size={14} aria-hidden="true"/></button>
        <button type="button" aria-label="设备"  onClick={() => setSheet('devices')}><DeviceMobile size={17} aria-hidden="true"/><span>设备</span>
          <small>当前设备 <CaretRight size={14} aria-hidden="true"/></small></button>
        </div>
      </section>
      {sheet && <MobileSheet title={{ plans: '分级方案', devices: '绑定设备', factor: '双重验证' }[sheet]} closeDisabled={sheet === 'factor' && factorBusy} close={() => setSheet(null)}>
        {sheet === 'plans' && <MobileBillingPlans/>}
        {sheet === 'devices' && <MobileAccountDevices/>}
        {sheet === 'factor' && <MobileAccountFactor email={email} legacy={legacyAccount} onBusy={setFactorBusy} done={() => setSheet(null)}/>}
      </MobileSheet>}
    </>}
    {removing && <MobileSheet title="移除本机记录？" showClose={false} closeDisabled={removeBusy} close={() => setRemoving(undefined)}>
      <p className="mobile-remove-title">{removing.title}</p>
      <p className="mobile-sheet-note">此设备上的回听副本将被移除。云端及待同步副本会保留。</p>
      {removeError && <p role="alert">{removeError}</p>}
      <div className="mobile-sheet-actions mobile-sheet-paired">
        <Button autoFocus disabled={removeBusy} onClick={() => setRemoving(undefined)}>取消</Button>
        <Button variant="danger" disabled={removeBusy} onClick={async () => {
          if (!deleteLocal) return;
          setRemoveBusy(true);
          setRemoveError('');
          try {
            await deleteLocal(removing.cloud?.sourceId || removing.id);
            setRemoving(undefined);
            setDetail(null);
          } catch (error) { setRemoveError(error instanceof Error ? error.message : '无法移除本机记录'); }
          finally { setRemoveBusy(false); }
        }}>{removeBusy ? '正在移除…' : '移除'}</Button>
      </div>
    </MobileSheet>}
    <nav className="mobile-nav" aria-label="底部菜单" data-page={page}>
      <span className="mobile-nav-lens" aria-hidden="true"/>
      {pages.map(([id, label, Icon]) => <button type="button" key={id} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}>
        <Icon size={20} aria-hidden="true"/><span>{label}</span></button>)}
    </nav>
  </div>;
}
