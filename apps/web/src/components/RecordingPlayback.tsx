import { useState } from 'react';
import { Play } from '@phosphor-icons/react';
import type { RecordDetail } from '../model';
import { AudioPlayer } from './AudioPlayer';
import { recordingAudioUrl, recordingPlaybackState } from '../audio/recording-playback';
import { Button } from './ui';

export function RecordingPlayback({ record }: { record: RecordDetail }) {
  const [started, setStarted] = useState(false);
  const playback = recordingPlaybackState(record);
  if (!playback.available || !started) return <span className="recording-playback-trigger">
    <Button className="player-control" disabled={!playback.available}
      aria-label={playback.available ? '播放原音' : playback.label} title={playback.available ? '播放原音' : playback.message}
      onClick={() => setStarted(true)}><Play size={17} weight="fill" aria-hidden="true"/></Button>
  </span>;
  return <div className="recording-playback" role="group" aria-label="原音回放">
    <AudioPlayer sources={playback.sources.map(source => ({ id: source.id, src: recordingAudioUrl(record.id, source.id), label: source.label }))} autoPlay/>
  </div>;
}
