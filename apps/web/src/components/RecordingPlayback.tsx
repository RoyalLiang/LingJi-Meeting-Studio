import { useState } from 'react';
import { Play } from '@phosphor-icons/react';
import type { RecordDetail } from '../model';
import { AudioPlayer } from './AudioPlayer';
import { recordingAudioUrl, recordingPlaybackState } from '../audio/recording-playback';
import { Button, Modal } from './ui';

export function RecordingPlayback({ record }: { record: RecordDetail }) {
  const [open, setOpen] = useState(false);
  const playback = recordingPlaybackState(record);
  return <>
    <span className="recording-playback-trigger" title={playback.available ? '播放本场留存的原音' : playback.message}><Button disabled={!playback.available} aria-label={playback.available ? '原音' : playback.message} aria-haspopup={playback.available ? 'dialog' : undefined} aria-expanded={playback.available ? open : undefined} onClick={() => setOpen(true)}><Play size={17}/>{playback.available ? '原音' : playback.label}</Button></span>
    {open && playback.available && <Modal title="原音回放" onClose={() => setOpen(false)}>
      <div className="recording-playback-list">{playback.sources.map(source => <AudioPlayer key={source.id} src={recordingAudioUrl(record.id, source.id)} label={source.label}/>)}</div>
    </Modal>}
  </>;
}
