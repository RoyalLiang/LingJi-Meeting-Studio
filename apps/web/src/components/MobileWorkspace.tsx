import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowClockwise, FileText, Headphones, Link, Microphone, Moon, ShieldCheck, User, WifiSlash } from '@phosphor-icons/react';
import type { Minutes } from '../model';
import type { CopySummary, MeetingCopy } from '../sync/journal';
import type { MobileRecording } from '../sync/mobile-library';
import { Brand } from './Brand';
import { Button } from './ui';
import './MobileWorkspace.css';

export type MobilePage = 'record' | 'meetings' | 'account';
type TranscriptLine = { id: string; speaker: string; startMs: number; text: string };
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
  return <ul className="mobile-record-list">{entries.map(entry => <li key={entry.id}>
    <button type="button" className="mobile-record-card" onClick={() => select(entry)}>
      <strong>{entry.title}</strong>
      <span className="mobile-record-badge">{entry.cloud ? '已同步' : '本机录音'}</span>
      <span className="mobile-record-meta">
        <time dateTime={new Date(entry.at).toISOString()}>{date.format(entry.at)}</time>
        {entry.saved && <><span>{clock(entry.saved.seconds)}</span><span><Headphones size={14} aria-hidden="true"/> 回听</span></>}
      </span>
    </button>
  </li>)}</ul>;
}

function MobileMeeting({ entry, back, read, play }: {
  entry: Entry; back: () => void; read: (id: string) => Promise<MeetingCopy | null>; play: (id: string) => Promise<Blob | null>;
}) {
  const [tab, setTab] = useState<(typeof detailTabs)[number][0]>('minutes');
  const [copy, setCopy] = useState<MeetingCopy | null>();
  const [audio, setAudio] = useState('');
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
  async function playLocal() {
    if (!entry.saved || audioLoading) return;
    setAudioLoading(true);
    try {
      const blob = await play(entry.saved.id);
      if (!mounted.current) return;
      if (!blob) throw new Error('本机没有保存这段音频');
      setAudio(URL.createObjectURL(blob));
    } catch (failure) { if (mounted.current) setError((failure as Error).message); }
    finally { if (mounted.current) setAudioLoading(false); }
  }
  const content = copy?.content;
  const lines = (content?.segments || []) as TranscriptLine[];
  const minutes = content?.minutes as Minutes | null | undefined;
  return <section aria-label="会议详情">
    <header className="mobile-detail-header">
      <Button variant="ghost" aria-label="返回会议列表" onClick={back}><ArrowLeft size={20}/></Button>
      <h1>{entry.title}</h1>
      <span className="mobile-record-badge">{entry.cloud ? '已同步' : '本机录音'}</span>
    </header>
    <nav className="mobile-detail-tabs" aria-label="会议内容">
      {detailTabs.map(([id, label]) => <button key={id} type="button" aria-current={id === tab ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>)}
    </nav>
    {entry.saved && <div className="mobile-playback">
      {audio ? <audio controls autoPlay src={audio} aria-label="本机录音"/> :
        <Button variant="ghost" disabled={audioLoading} onClick={playLocal}><Headphones size={17}/> {audioLoading ? '正在打开' : '回听录音'}<span>{clock(entry.saved.seconds)}</span></Button>}
    </div>}
    {error && <p role="alert" className="mobile-empty">{error}</p>}
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
          {minutes.actions.map((item, i) => <article className="mobile-card" key={i}>{item.text}{item.owner && <small>{item.owner}</small>}</article>)}
        </section>}
      </> : (!entry.cloud || copy !== undefined) && <p className="mobile-empty">暂无纪要</p>}
    </>}
    {tab === 'transcript' && (lines.length ? lines.map(line => <article className="mobile-card mobile-line" id={'mobile-line-' + line.id} data-highlight={highlight === line.id} key={line.id}>
      <header><strong>{line.speaker}</strong><time>{clock(Math.floor(line.startMs / 1000))}</time></header><p>{line.text}</p>
    </article>) : (!entry.cloud || copy !== undefined) && <p className="mobile-empty">等待电脑同步转录</p>)}
    {tab === 'notes' && <>
      {copy?.notes && <p className="mobile-card mobile-notes">{copy.notes}</p>}
      {entry.saved?.marks.length ? <section className="mobile-detail-group"><h2>录音重点</h2>
        <ul className="mobile-record-list">{entry.saved.marks.map(mark => <li className="mobile-card" key={mark}>{clock(mark)}</li>)}</ul>
      </section> : !copy?.notes && <p className="mobile-empty">暂无手记</p>}
    </>}
    <dialog ref={dialog} className="mobile-source-sheet" onClose={() => setCitation(undefined)}>
      {citation && <><h2>来源原文</h2><p>{citation.text}</p><div className="mobile-sheet-actions">
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
  page, setPage, online, unlocked, automatic, setAutomatic, copies, saved, recorder, account, refresh, read, play, search
}: {
  page: MobilePage; setPage: (page: MobilePage) => void; online: boolean; unlocked: boolean;
  automatic: boolean; setAutomatic: (enabled: boolean) => void;
  copies: CopySummary[]; saved: MobileRecording[]; recorder: ReactNode; account: ReactNode;
  refresh: () => void; read: (id: string) => Promise<MeetingCopy | null>;
  play: (id: string) => Promise<Blob | null>; search: (query: string) => Promise<CopySummary[]>;
}) {
  const [detail, setDetail] = useState<Entry | null>(null);
  const [query, setQuery] = useState('');
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
  const opened = detail && (entries.find(item => detail.saved ? item.saved?.id === detail.saved.id : item.id === detail.id) || detail);
  const filtered = searchTerm ? combined(matches || copies.filter(item => item.title.toLowerCase().includes(searchTerm)),
    saved.filter(item => item.title.toLowerCase().includes(searchTerm) || matches?.some(copy => copy.sourceId === item.id))) : entries;
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
    {page === 'meetings' && (opened ? <MobileMeeting key={opened.saved?.id || opened.id} entry={opened} back={() => navigate('meetings')} read={read} play={play}/> : <section aria-label="会议列表">
      <div className="mobile-list-tools">
        <input type="search" aria-label="搜索会议" placeholder="搜索标题、纪要或原文" value={query} onChange={event => setQuery(event.target.value)}/>
        <Button variant="ghost" disabled={!online || !unlocked} aria-label="同步会议" onClick={refresh}><ArrowClockwise size={19}/></Button>
      </div>
      <RecordCards entries={filtered} select={select} empty={searchTerm ? '没有匹配的会议' : '暂无已同步会议'}/>
    </section>)}
    {page === 'account' && <>
      {account}
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
        <div><FileText size={17}/><span>已同步会议</span><small>{copies.length} 条</small></div>
        <div><Headphones size={17}/><span>本机回听</span><small>{saved.length} 条</small></div>
      </div>
    </>}
    <nav className="mobile-nav" aria-label="底部菜单" data-page={page}>
      <span className="mobile-nav-lens" aria-hidden="true"/>
      {pages.map(([id, label, Icon]) => <button type="button" key={id} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}>
        <Icon size={20} aria-hidden="true"/>{label}</button>)}
    </nav>
  </div>;
}
