import { useState } from 'react';
import { Play } from '@phosphor-icons/react';
import type { RecordDetail } from '../model';
import { AudioPlayer } from './AudioPlayer';
import { recordingAudioUrl, recordingPlaybackState } from '../audio/recording-playback';
import { Button } from './ui';

export function RecordingPlayback({ record }: { record: RecordDetail }) {
  const [opened,setOpened]=useState(false);
  if (!['sealed', 'completed'].includes(record.capture)) return null;
  const playback = recordingPlaybackState(record);
  if (!playback.available) return <div className="recording-playback-unavailable" title={playback.message}>
    <Button className="player-control" disabled aria-label={playback.label}><Play size={17} weight="fill" aria-hidden="true"/></Button>
    <span>{playback.label}</span>
  </div>;
  if(!opened)return <div className="recording-playback-unavailable"><Button className="player-control" onClick={()=>setOpened(true)} aria-label="打开原音回放"><Play size={17} weight="fill" aria-hidden="true"/></Button><span>原音已保存 · 点击加载回放</span></div>;
  return <div className="recording-playback" role="group" aria-label="原音回放">
    <AudioPlayer sources={playback.sources.map(source => ({ id: source.id, src: recordingAudioUrl(record.id, source.id), label: source.label }))}/>
  </div>;
}
