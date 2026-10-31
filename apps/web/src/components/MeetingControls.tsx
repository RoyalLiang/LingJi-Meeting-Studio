import { Headphones, Microphone, MicrophoneSlash, Play, Plus, Record, Square, FileAudio } from '@phosphor-icons/react';
import type { RecordDetail } from '../model';
import type { CaptureSignal } from '../audio/signal';
import { Button } from './ui';
import { CaptureSignals } from './CaptureSignals';

export function MeetingControls({ record, recording, busy, phase = 'idle', ready, signals, progress, start, quick, sources, microphone, finish, importAudio }: {
  record: RecordDetail; recording: boolean; busy: boolean; phase?: 'idle' | 'starting' | 'stopping'; ready: boolean; signals: CaptureSignal[]; progress?: string;
  start: (kind: 'meeting' | 'microphone') => void; quick: () => void; sources: () => void;
  microphone: () => void; finish: () => void; importAudio: () => void;
}) {
  const ended = record.capture === 'sealed' || record.capture === 'completed';
  const paused = record.capture === 'paused';
  const repairing = paused && record.sources.some(s => s.watermark !== s.lastSequence);
  const microphoneOn = signals.some(signal => signal.kind === 'microphone');
  const job = record.jobs?.filter(job=>['queued','running'].includes(job.status)).at(-1);
  const latest = record.jobs?.filter(job=>job.status!=='cancelled').at(-1);
  const failed = ['failed','stale'].includes(latest?.status || '') && latest?.transcriptRevision===record.transcriptRevision && !(latest?.status==='stale' && record.minutes?.edited);
  const audioFailed = ended && record.transcription==='failed';
  const awaitingSummary = !audioFailed && record.autoMinutes?.enabled && Boolean(record.segments?.length) && !record.minutes?.edited && (!record.minutes || record.minutes.transcriptRevision!==record.transcriptRevision) && !failed;
  const finishing = ended && (Boolean(job) || (!audioFailed && (record.capture==='sealed' || record.pendingChunks > 0 || awaitingSummary)));
  const nodes = job?.progress?.total ? `（${job.progress.completed}/${job.progress.total} 个节点）` : '';
  const title = recording ? '对话正在被记住' : audioFailed ? '录音已结束，尾段转录待重试' : finishing ? '录音已结束，正在后台收尾' : ended && failed ? '录音已结束，纪要待重试' : ended ? '本场已收好，留住每一个共识' : paused ? '先停一停，随时接着聊' : '想说的，现在就记';
  const summaryProgress = job?.status==='queued' ? '纪要与重点速览已排队，可继续使用应用。' : job?.progress?.stage==='synthesis' ? `正在汇总${job.scope==='live' ? '本轮纪要' : '会议终稿'}与重点速览${nodes}，可继续使用应用。` : `正在整理纪要与重点速览${nodes}，可继续使用应用。`;
  const description = repairing ? '音频补传完成后即可继续。' : progress || (audioFailed ? job ? `尾段转录已暂停。${summaryProgress}请在转录提示中重试。` : '尾段转录已暂停，已完成的转录和重点仍可查看。请在转录提示中重试。' : finishing ? record.pendingChunks > 0 ? `正在处理尾段转录（${record.pendingChunks} 个音频包），纪要与重点速览将继续更新。` : record.capture==='sealed' ? '正在补传与转录已保存的尾段音频，已开启的总结会继续更新。' : summaryProgress : ended && failed ? '整理未完成，已保存的转录和重点仍可查看。' : record.pendingChunks > 0 ? '正在处理音频…' : recording ? '正在聆听' : '');
  return <section className={`meeting-controls glass${finishing ? ' is-processing' : ''}${ended && (audioFailed || failed) ? ' is-blocked' : ''}`} aria-label="会议录音控制">
    <div className="meeting-controls-main">
      <div className="capture-status"><span className={`record-indicator ${recording ? 'on' : ''}`}><Record size={22} weight="fill"/></span><div><b>{title}</b>{description && <small role="status" title={record.pendingChunks > 0 ? `${record.pendingChunks} 个音频包${audioFailed ? '等待重试' : '正在处理'}` : undefined}>{description}</small>}</div></div>
      {recording && <div className="meeting-source-strip"><CaptureSignals signals={signals}/></div>}
      <div className="capture-controls">
        {phase === 'stopping' ? <Button disabled aria-live="polite"><Square size={16} weight="fill"/>正在收尾…</Button> : recording ? <><Button disabled={busy} variant="ghost" aria-label="音频来源" title="音频来源" onClick={sources}><Headphones size={17}/><span className="capture-action-label">音频来源</span></Button><Button disabled={busy} aria-pressed={microphoneOn} aria-label={microphoneOn ? '关闭麦克风' : '开启麦克风'} title={microphoneOn ? '关闭麦克风' : '开启麦克风'} onClick={microphone}>{microphoneOn ? <MicrophoneSlash size={17}/> : <Microphone size={17}/>}<span className="capture-action-label">{microphoneOn ? '关闭麦克风' : '开启麦克风'}</span></Button><Button aria-label="暂停或结束会议" title="暂停 / 结束" disabled={busy} onClick={finish}><Square size={16} weight="fill"/><span className="capture-finish-label">暂停 / 结束</span></Button></> : ended ? <Button variant="primary" disabled={busy || !ready} onClick={quick}><Plus size={17}/>开启新会议</Button> : <>
          <Button variant="primary" disabled={busy || !ready || repairing} onClick={() => start('meeting')}>{paused ? <Play size={17} weight="fill"/> : <Headphones size={17}/>}<span>{phase === 'starting' ? '正在接入声音…' : paused ? '继续本场会议' : '开始聆记'}</span></Button>
          {paused ? <Button disabled={busy} onClick={finish}><Square size={16}/>结束本场</Button> : <><Button variant="ghost" disabled={busy || !ready} onClick={() => start('microphone')}><Microphone size={17}/>仅麦克风</Button><Button variant="ghost" disabled={busy} onClick={importAudio}><FileAudio size={17}/>导入</Button></>}
        </>}
      </div>
    </div>
  </section>;
}
