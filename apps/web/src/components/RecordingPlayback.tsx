import { useState } from 'react';
import { Play, Waveform } from '@phosphor-icons/react';
import type { RecordDetail } from '../model';
import { AudioPlayer } from './AudioPlayer';
import { recordingAudioUrl, recordingPlaybackState } from '../audio/recording-playback';
import { Button, Modal } from './ui';

export function RecordingPlayback({ record }: { record: RecordDetail }) {
  const [open, setOpen] = useState(false);
  const playback = recordingPlaybackState(record);
  return <>
    <Button aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><Play size={17}/>原音</Button>
    {open && <Modal title="原音回放" onClose={() => setOpen(false)}>
      {playback.available ? <div className="recording-playback-list">{playback.sources.map(source => <AudioPlayer key={source.id} src={recordingAudioUrl(record.id, source.id)} label={source.label}/>)}</div> : <div className="playback-empty" role="status"><Waveform size={28}/><p>{playback.message}</p></div>}
    </Modal>}
  </>;
}
