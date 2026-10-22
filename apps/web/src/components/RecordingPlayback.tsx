import { Play } from '@phosphor-icons/react';
import type { RecordDetail } from '../model';
import { AudioPlayer } from './AudioPlayer';
import { recordingAudioUrl, recordingPlaybackState } from '../audio/recording-playback';
import { Button } from './ui';

export function RecordingPlayback({ record }: { record: RecordDetail }) {
  if (!['sealed', 'completed'].includes(record.capture)) return null;
  const playback = recordingPlaybackState(record);
  if (!playback.available) return <div className="recording-playback-unavailable" title={playback.message}>
    <Button className="player-control" disabled aria-label={playback.label}><Play size={17} weight="fill" aria-hidden="true"/></Button>
    <span>{playback.label}</span>
  </div>;
  return <div className="recording-playback" role="group" aria-label="原音回放">
    <AudioPlayer sources={playback.sources.map(source => ({ id: source.id, src: recordingAudioUrl(record.id, source.id), label: source.label }))}/>
  </div>;
}
