import { Headphones, Microphone, MicrophoneSlash, Play, Plus, Record, Square, FileAudio } from '@phosphor-icons/react';
import type { RecordDetail } from '../model';
import type { CaptureSignal } from '../audio/signal';
import { Button } from './ui';
import { CaptureSignals } from './CaptureSignals';

export function MeetingControls({ record, recording, busy, ready, signals, start, quick, sources, microphone, finish, importAudio }: {
  record: RecordDetail; recording: boolean; busy: boolean; ready: boolean; signals: CaptureSignal[];
  start: (kind: 'meeting' | 'microphone') => void; quick: () => void; sources: () => void;
  microphone: () => void; finish: () => void; importAudio: () => void;
}) {
  const ended = record.capture === 'sealed' || record.capture === 'completed';
  const paused = record.capture === 'paused';
  const repairing = paused && record.sources.some(s => s.watermark !== s.lastSequence);
  const microphoneOn = signals.some(signal => signal.kind === 'microphone');
  const title = recording ? '对话正在被记住' : ended ? '本场已收好，留住每一个共识' : paused ? '先停一停，随时接着聊' : '想说的，现在就记';
  const description = repairing ? '音频补传完成后即可继续。' : '';
  return <section className="meeting-controls glass" aria-label="会议录音控制">
    <div className="meeting-controls-main">
      <div className="capture-status"><span className={`record-indicator ${recording ? 'on' : ''}`}><Record size={22} weight="fill"/></span><div><b>{title}</b>{description && <small>{description}</small>}</div></div>
      <div className="capture-controls">
        {recording ? <><Button disabled={busy} variant="ghost" onClick={sources}><Headphones size={17}/>音频来源</Button><Button disabled={busy} aria-pressed={microphoneOn} onClick={microphone}>{microphoneOn ? <MicrophoneSlash size={17}/> : <Microphone size={17}/>}<span>{microphoneOn ? '关闭麦克风' : '开启麦克风'}</span></Button><Button aria-label="暂停或结束会议" disabled={busy} onClick={finish}><Square size={16} weight="fill"/>暂停 / 结束</Button></> : ended ? <Button variant="primary" disabled={busy || !ready} onClick={quick}><Plus size={17}/>开启新会议</Button> : <>
          <Button variant="primary" disabled={busy || !ready || repairing} onClick={() => start('meeting')}>{paused ? <Play size={17} weight="fill"/> : <Headphones size={17}/>}<span>{busy ? '正在接入声音…' : paused ? '继续本场会议' : '开始聆记'}</span></Button>
          {paused ? <Button disabled={busy} onClick={finish}><Square size={16}/>结束本场</Button> : <><Button variant="ghost" disabled={busy || !ready} onClick={() => start('microphone')}><Microphone size={17}/>仅麦克风</Button><Button variant="ghost" disabled={busy} onClick={importAudio}><FileAudio size={17}/>导入</Button></>}
        </>}
      </div>
    </div>
    {recording && <div className="meeting-source-strip"><CaptureSignals signals={signals}/><span className="source-scope-note">{microphoneOn ? '麦克风独立录音；会议软件静音不会关闭此音源' : '仅系统／会议音频 · 麦克风未开启'}</span></div>}
  </section>;
}
