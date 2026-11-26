import { forwardRef, memo, useCallback, useEffect, useLayoutEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowClockwise, CircleNotch, DeviceMobile, FileText, Headphones, Keyhole, Link, MagnifyingGlass, Microphone, Moon, Pause, Play, Trash, User, WifiSlash, CaretRight } from '@phosphor-icons/react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import type { Minutes, MinutesItem } from '../model';
import type { CopySummary, MeetingAnnotations, MeetingCopy } from '../sync/journal';
import { api } from '../api';
import type { MobileRecording } from '../sync/mobile-library';
import { MobileAccountDevices, MobileAccountFactor, loadMobileDevices, loadMobileFactor } from './MobileAccountPanels';
import { Brand } from './Brand';
import { Button } from './ui';
import { MobileSheet } from './MobileSheet';
import { MobileAbout } from './MobileAbout';
import { MobileAudioNotice } from './MobileAudioNotice';
import { MinutesVisuals } from './MinutesVisuals';
import { SummaryTables } from './SummaryTables';
import './MobileWorkspace.css';

export type MobilePage = 'record' | 'meetings' | 'account';
type TranscriptLine = { id: string; speaker: string; startMs: number; text: string };
type Usage = { meetings: number; audio: number; quota: number };
type Entry = { id: string; title: string; at: number; saved?: MobileRecording; cloud?: CopySummary };
const pages = [['record', '记录', Microphone], ['meetings', '会议', FileText], ['account', '我的', User]] as const;
const playbackRates = [1, 1.25, 1.5, 2];
const oneGiB = 1024 ** 3;
const detailTabs = [['minutes', '纪要'], ['transcript', '原文'], ['notes', '手记']] as const;
const date = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clock = (seconds: number) => [Math.floor(seconds / 60), seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
const recordedAt = (entry: Entry) => entry.saved?.at ?? entry.cloud?.recordedAt ?? entry.at;
const recordTitle = (entry: Entry) => (entry.saved || entry.cloud?.fromPhone)
  && /^手机录音 · (?:\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日)\s+\d{1,2}:\d{2}$/u.test(entry.title) ? '手机录音' : entry.title;

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
  return entries.sort((a, b) => recordedAt(b) - recordedAt(a));
}

const RecordRow = memo(function RecordRow({ entry, opened, reveal, select, remove }: {
  entry: Entry; opened: boolean; reveal: (id: string | null) => void;
  select: (entry: Entry) => void; remove?: (entry: Entry) => void;
}) {
    const tracking = useRef<{ x: number; y: number; horizontal: boolean } | undefined>(undefined);
    const suppressClick = useRef(false);
    const seconds = entry.saved?.seconds ?? (entry.cloud?.durationMs === undefined ? null : Math.floor(entry.cloud.durationMs / 1000));
    const at = recordedAt(entry);
    return <li className="mobile-record-row" data-revealed={opened}>
      {remove && <button type="button" className="mobile-row-delete" tabIndex={opened ? 0 : -1} aria-hidden={!opened}
        onClick={() => { reveal(null); remove(entry); }}><Trash size={18}/>移除</button>}
      <div className="mobile-record-slide" style={{ transform: `translateX(${opened ? -76 : 0}px)` }}
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
          event.currentTarget.dataset.dragging = 'true';
          event.currentTarget.style.transform = `translateX(${Math.min(0, Math.max(-88, (opened ? -76 : 0) + dx))}px)`;
        }}
        onPointerUp={event => {
          const start = tracking.current;
          let next = opened;
          if (start?.horizontal) {
            const dx = event.clientX - start.x;
            next = opened ? dx < 26 : dx < -34;
            reveal(next ? entry.id : null);
          }
          tracking.current = undefined;
          delete event.currentTarget.dataset.dragging;
          event.currentTarget.style.transform = `translateX(${next ? -76 : 0}px)`;
        }}
        onPointerCancel={event => {
          tracking.current = undefined;
          delete event.currentTarget.dataset.dragging;
          event.currentTarget.style.transform = `translateX(${opened ? -76 : 0}px)`;
        }}
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
  play: (id: string, signal: AbortSignal) => Promise<Blob | null>;
  onError: (message: string) => void;
}>(function MobileAudioPlayer({ saved, play, onError }, ref) {
  const [audio, setAudio] = useState('');
  const player = useRef<HTMLAudioElement>(null);
  const requestedTime = useRef(0);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rateIndex, setRateIndex] = useState(0);
  const speed = playbackRates[rateIndex];
  const [audioLoading, setAudioLoading] = useState(false);
  const loading = useRef<AbortController | null>(null);
  useEffect(() => () => loading.current?.abort(), []);
  useEffect(() => {
    const element = player.current;
    if (!audio || !element) return;
    let active = true;
    void element.play().catch(() => {
      if (active) onError('无法播放录音，请重试');
    }).finally(() => {
      if (active) setAudioLoading(false);
    });
    return () => {
      active = false;
      URL.revokeObjectURL(audio);
    };
  }, [audio, onError]);

  const seek = useCallback((seconds: number) => {
    const element = player.current;
    if (!element || !Number.isFinite(element.duration)) return;
    element.currentTime = Math.min(Math.max(0, seconds), element.duration);
    setPosition(element.currentTime);
  }, []);

  const playLocal = useCallback(async (seconds = 0) => {
    if (audioLoading || loading.current) return;
    onError('');
    if (player.current) {
      seek(seconds);
      void player.current.play().catch(() => onError('无法播放录音，请重试'));
      return;
    }
    requestedTime.current = seconds;
    const controller = new AbortController();
    loading.current = controller;
    setAudioLoading(true);
    try {
      const blob = await play(saved.id, controller.signal);
      if (controller.signal.aborted) return;
      if (!blob) throw new Error('本机没有保存这段音频');
      setAudio(URL.createObjectURL(blob));
    } catch (failure) {
      if (!controller.signal.aborted) {
        onError(failure instanceof Error ? failure.message : '无法播放录音');
        setAudioLoading(false);
      }
    } finally {
      loading.current = null;
    }
  }, [audioLoading, onError, play, saved.id, seek]);

  useImperativeHandle(ref, () => ({ playAt: seconds => { void playLocal(seconds); } }), [playLocal]);

  return <div className="mobile-playback">
    {audio && <audio ref={player} src={audio} preload="metadata"
      onLoadedMetadata={event => {
        const element = event.currentTarget;
        if (Number.isFinite(element.duration)) setDuration(element.duration);
        if (element.playbackRate !== speed) element.playbackRate = speed;
        seek(requestedTime.current);
      }}
      onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
      onError={() => {
        setAudio('');
        setDuration(0);
        setPosition(0);
        setPlaying(false);
        setAudioLoading(false);
        onError('无法播放录音，请重试');
      }}/>}
    <div className="mobile-player" role="group" aria-label="录音回听">
      <Button variant="secondary" className="mobile-player-play" aria-busy={audioLoading}
        aria-label={audioLoading ? '正在打开录音' : playing ? '暂停回听' : '播放录音'} disabled={audioLoading} onClick={() => {
          const element = player.current;
          if (!element) void playLocal();
          else if (!element.paused) element.pause();
          else {
            onError('');
            void element.play().catch(() => onError('无法播放录音，请重试'));
          }
        }}>{audioLoading ? <CircleNotch className="mobile-player-spinner" size={20} aria-hidden="true"/>
          : playing ? <Pause size={20} weight="fill" aria-hidden="true"/> : <Play size={20} weight="fill" aria-hidden="true"/>}</Button>
      <div className="mobile-player-times">
        <span>{clock(Math.floor(position))}</span>
        <span><span className="mobile-player-time-separator" aria-hidden="true">/</span>{clock(Math.floor(duration || saved.seconds))}</span>
      </div>
      <div className="mobile-player-track">
        <div aria-hidden="true" className="mobile-player-rail">
          <span style={{ width: `${duration ? Math.min(100, position / duration * 100) : 0}%` }}/>
        </div>
        <input type="range" aria-label="回听进度" min={0} max={duration || saved.seconds} step={0.1} value={position}
          aria-valuetext={clock(Math.floor(position))} disabled={!audio || !duration} onChange={event => seek(event.currentTarget.valueAsNumber)}/>
      </div>
      <button type="button" className="mobile-player-rate" data-adjusted={rateIndex !== 0} aria-label={`播放速度 ${speed} 倍，点按切换`} onClick={() => {
        const next = (rateIndex + 1) % playbackRates.length;
        setRateIndex(next);
        if (player.current && player.current.playbackRate !== playbackRates[next]) player.current.playbackRate = playbackRates[next];
      }}><span>{speed}×</span></button>
    </div>
  </div>;
}));

const MobileTranscriptList = memo(function MobileTranscriptList({ lines, highlight, hasLocal, onPlayAt }: {
  lines: TranscriptLine[]; highlight: string; hasLocal: boolean; onPlayAt: (seconds: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => setMargin(list.getBoundingClientRect().top + window.scrollY);
    const observer = new ResizeObserver(measure);
    for (let node: HTMLElement | null = list; node?.parentElement; node = node.parentElement) {
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) observer.observe(sibling);
    }
    window.addEventListener('resize', measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const virtualizer = useWindowVirtualizer({
    count: lines.length,
    estimateSize: () => 96,
    overscan: 6,
    scrollMargin: margin,
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

function MobileMeeting({ entry, back, read, play, saveAnnotations, send, syncStatus }: {
  syncStatus?: string;
  send?: (entry: MobileRecording) => ReactNode;
  entry: Entry; back: () => void; read: (id: string) => Promise<MeetingCopy | null>; play: (id: string, signal: AbortSignal) => Promise<Blob | null>;
  saveAnnotations: (parent: string, changes: MeetingAnnotations) => Promise<void>;
}) {
  const [tab, setTab] = useState<(typeof detailTabs)[number][0]>('minutes');
  const [copy, setCopy] = useState<MeetingCopy>();
  const [readFailed, setReadFailed] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
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
      if (!active) return;
      if (value) setCopy(value);
      setReadFailed(value === null);
    }, () => { if (active) setReadFailed(true); });
    return () => { active = false; };
  }, [entry.cloud?.id, read, readAttempt]);
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
  const evidenceById = useMemo(() => new Map(minutes?.evidenceSnapshot.map(line => [`${line.id}:${line.revision}`, line])), [minutes]);
  function minuteItems(items: MinutesItem[]) {
    return <ul className="mobile-minutes-items">{items.map((item, index) => <li key={index}>
      <p>{item.text}</p>
      {item.evidence.map((evidence, i) => {
        const line = evidenceById.get(`${evidence.segmentId}:${evidence.revision}`);
        return line && <button type="button" className="mobile-citation" key={i} onClick={() => setCitation(line)}><Link size={13}/>原文 {i + 1}</button>;
      })}
    </li>)}</ul>;
  }
  return <section aria-label="会议详情">
    <header className="mobile-detail-header">
      <Button variant="ghost" aria-label="返回会议列表" onClick={back}><ArrowLeft size={18}/></Button>
      <div className="mobile-detail-title">
        <h2 title={recordTitle(entry)}>{recordTitle(entry)}</h2>
        <span className="mobile-detail-meta">
          <time dateTime={new Date(recordedAt(entry)).toISOString()}>{date.format(recordedAt(entry))}</time>
          <span>{entry.cloud?.pending ? '待同步' : entry.cloud ? '已同步' : '本机录音'}</span>
        </span>
      </div>
    </header>
    {entry.saved && <MobileAudioPlayer ref={playerRef} saved={entry.saved} play={play} onError={setError}/>}

    {entry.saved?.directReady && send?.(entry.saved)}
    {syncStatus && !entry.cloud?.hasMinutes && <p role="status" className="mobile-save-status">{syncStatus}</p>}
    <nav className="mobile-detail-tabs" aria-label="会议内容">
      {detailTabs.map(([id, label]) => <button key={id} type="button" aria-current={id === tab ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>)}
    </nav>
    {error && <p role="alert" className="mobile-empty">{error}</p>}
    {savedNotice && !error && <p role="status" className="mobile-save-status">{savedNotice}</p>}
    {entry.cloud && (readFailed ? <div className="mobile-empty">
      <p role="alert">无法读取此会议</p>
      <Button type="button" variant="ghost" onClick={() => { setReadFailed(false); setReadAttempt(value => value + 1); }}>重试</Button>
    </div> : !copy && <p role="status" className="mobile-empty">正在打开会议…</p>)}
    {tab === 'minutes' && <>
      {minutes ? <div className="mobile-minutes">
        {minutes.highlights && minutes.highlights.length > 0 && <section className="mobile-detail-group mobile-minutes-highlights">
          <h2>重点速览</h2>{minuteItems(minutes.highlights)}
        </section>}
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
        <MinutesVisuals visuals={minutes.visuals ?? []}/>
        {minutes.tables && minutes.tables.length > 0 && <SummaryTables minutes={minutes} tables={minutes.tables}/>}
        {minutes.topics && minutes.topics.length > 0 && <section className="mobile-detail-group"><h2>会议主题</h2>
          {minutes.topics.map((topic, index) => <section className="mobile-card mobile-minutes-topic" key={topic.id ?? index}>
            <h3>{topic.title}</h3>{topic.summary && minuteItems([{text: topic.summary, evidence: topic.evidence}])}
          </section>)}
        </section>}
        {minutes.sections.map((part, index) => <section className="mobile-detail-group mobile-minutes-section" key={index}>
          <h2>{part.heading}</h2>{minuteItems(part.items)}
        </section>)}
      </div> : (!entry.cloud || copy !== undefined) && <p className="mobile-empty">暂无纪要</p>}
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
      </section> : !entry.cloud && <p className="mobile-empty">暂无手记</p>}
    </>}
    {citation && <MobileSheet title="来源原文" close={() => setCitation(undefined)}>
      <p className="mobile-sheet-note">{citation.speaker} · {clock(Math.floor(citation.startMs / 1000))}</p>
      <p>{citation.text}</p>{linesById.has(citation.id) && <div className="mobile-sheet-actions">
        <Button onClick={() => {
          setTab('transcript'); setHighlight(citation.id); setCitation(undefined);
        }}>在原文中定位</Button>
      </div>}
    </MobileSheet>}
  </section>;
}

function MobileSwitch({ labelId, checked, disabled, change }: { labelId: string; checked: boolean; disabled?: boolean; change: (checked: boolean) => void }) {
  return <span className="mobile-switch">
    <input id={labelId + '-switch'} type="checkbox" role="switch" aria-labelledby={labelId} checked={checked} disabled={disabled} onChange={event => change(event.target.checked)}/>
    <span className="mobile-switch-track" aria-hidden="true"/>
  </span>;
}

export function MobileWorkspace({
  page, setPage, online, unlocked, automatic, setAutomatic, copies, saved, hidden, recorder, account, read, play, search, saveAnnotations, deleteLocal, email, legacyAccount, signOut, recording, direct, syncProgress,
}: {
  email: string; legacyAccount: boolean; signOut: () => Promise<void>; recording: boolean;
  page: MobilePage; setPage: (page: MobilePage) => void; online: boolean; unlocked: boolean;
  automatic: boolean; setAutomatic: (enabled: boolean) => void;
  copies: CopySummary[]; saved: MobileRecording[]; hidden: ReadonlySet<string>; recorder: ReactNode; account: (logout: ReactNode) => ReactNode;
  read: (id: string) => Promise<MeetingCopy | null>;
  play: (id: string, signal: AbortSignal) => Promise<Blob | null>;
  search: (query: string) => Promise<CopySummary[]>;
  saveAnnotations: (parent: string, changes: MeetingAnnotations) => Promise<string>;
  deleteLocal?: (id: string) => Promise<void>;
  syncProgress?: { id: string; status: string };
  direct?: { enabled: boolean; change: (enabled: boolean) => void; send: (entry: MobileRecording) => ReactNode };
}) {
  const [detail, setDetail] = useState<Entry | null>(null);
  const [query, setQuery] = useState('');
  const [space, setSpace] = useState('');
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageError, setUsageError] = useState(false);
  const [sheet, setSheet] = useState<'devices' | 'factor' | 'logout' | 'about' | 'about-notice' | null>(null);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState('');
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
  useEffect(() => {
    const syncTheme = () => setDark(document.documentElement.dataset.theme === 'dark');
    document.addEventListener('meeting:theme', syncTheme);
    syncTheme();
    return () => document.removeEventListener('meeting:theme', syncTheme);
  }, []);
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
  const formatSize = (value: number) => (value / (value >= oneGiB ? oneGiB : 1024 ** 2)).toLocaleString('zh-CN',
    { maximumFractionDigits: 2 }) + (value >= oneGiB ? ' GiB' : ' MiB');
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
          syncStatus={syncProgress?.id === opened.saved?.id ? syncProgress?.status : undefined}
          back={() => setDetail(null)} read={read} play={play} send={direct?.send} saveAnnotations={async (parent, changes) => {
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
      {account(<Button className="mobile-sign-out" variant="ghost" disabled={recording || !online} onClick={() => {
        setLogoutError(''); setSheet('logout');
      }}>退出登录</Button>)}
      <section className="mobile-account-card mobile-quota" aria-label="同步存储">
        <h2>同步存储</h2>
        {usage && usage.quota > 0 ? <><div className="mobile-quota-list">
          <label><span>已使用</span><small>{formatSize(usage.meetings + usage.audio)} / {formatSize(usage.quota)}</small>
            <meter min={0} max={usage.quota} value={usage.meetings + usage.audio}/></label>
          <div><span>会议与纪要</span><small>{formatSize(usage.meetings)}</small></div>
          <div><span>手机录音</span><small>{formatSize(usage.audio)}</small></div>
        </div>
        </> : <p className="mobile-empty">{!online ? '联网后查看用量' : usageError ? '暂时无法查询用量' : unlocked ? '正在查询用量…' : '解锁后可查看用量'}</p>}
      </section>
      <section className="mobile-account-section" aria-labelledby="mobile-preferences">
        <h2 id="mobile-preferences">偏好</h2>
        <div className="mobile-account-group">
        <div><ArrowClockwise size={17} aria-hidden="true"/><span id="mobile-sync-preference">自动同步会议与纪要</span>
          <MobileSwitch labelId="mobile-sync-preference" disabled={!unlocked} checked={automatic} change={setAutomatic}/></div>

        {direct && <div><Link size={17} aria-hidden="true"/><label id="mobile-direct-preference" htmlFor="mobile-direct-preference-switch">录完后手动配对直传</label>
          <MobileSwitch labelId="mobile-direct-preference" disabled={recording} checked={direct.enabled} change={direct.change}/></div>}
        <div><Moon size={17} aria-hidden="true"/><span id="mobile-theme-preference">深色外观</span>
          <MobileSwitch labelId="mobile-theme-preference" checked={dark} change={checked => {
          const value = checked ? 'dark' : 'light';
          document.documentElement.dataset.theme = value;
          try { localStorage.setItem('meeting-theme', value); } catch {}
          document.dispatchEvent(new Event('meeting:theme'));
        }}/></div>
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
      <div className="mobile-account-group mobile-about-link">
        <button type="button" onClick={() => setSheet('about')}><FileText size={17} aria-hidden="true"/><span>关于聆记</span><CaretRight size={14} aria-hidden="true"/></button>
      </div>
      {sheet === 'about' && <MobileSheet title="关于聆记" close={() => setSheet(null)}><MobileAbout openNotice={() => setSheet('about-notice')}/></MobileSheet>}
        {sheet === 'about-notice' && <MobileAudioNotice close={() => setSheet('about')}/>}
      {sheet === 'logout' && <MobileSheet title="退出登录？" placement="center" showClose={false}
        closeDisabled={logoutBusy} close={() => setSheet(null)}>
        <p className="mobile-sheet-note">本机录音会保留，再次登录同一账号后可继续使用。</p>
        {logoutError && <p role="alert">{logoutError}</p>}
        <div className="mobile-sheet-actions mobile-sheet-paired">
          <Button autoFocus disabled={logoutBusy} onClick={() => setSheet(null)}>取消</Button>
          <Button variant="danger" disabled={recording || logoutBusy || !online} onClick={async () => {
            setLogoutBusy(true);
            setLogoutError('');
            try { await signOut(); }
            catch { setLogoutError('暂时无法退出，请稍后重试'); setLogoutBusy(false); }
          }}>{logoutBusy ? '正在退出…' : '退出登录'}</Button>
        </div>
      </MobileSheet>}
      {(sheet === 'devices' || sheet === 'factor') && <MobileSheet title={sheet === 'devices' ? '绑定设备' : '双重验证'} closeDisabled={sheet === 'factor' && factorBusy} close={() => setSheet(null)}>
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
