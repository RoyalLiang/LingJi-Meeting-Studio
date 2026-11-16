import {MeetingControls} from './MeetingControls';
import {CaptureSetup} from './CaptureSetup';
import {useSyncExternalStore} from 'react';
import {capturedDurationMs, type CaptureSignal} from '../audio/signal';
import type {RecordDetail} from '../model';
import {timecode} from '../model';
import {useRecordingDuration} from '../useRecordingDuration';
import {useRecordingWidget} from '../useRecordingWidget';

export function createCaptureSignals() {
  let value:CaptureSignal[]=[];
  const listeners=new Set<()=>void>();
  return {
    read:()=>value,
    subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    update:(next:CaptureSignal[])=>{value=next;for(const listener of listeners)listener();},
  };
}

export function RecordingProgress({record,recording,signals,manifests}:{
  record:RecordDetail;recording:boolean;signals:ReturnType<typeof createCaptureSignals>;
  manifests:Parameters<typeof capturedDurationMs>[3];
}) {
  const current=useSyncExternalStore(signals.subscribe,signals.read);
  const saved=capturedDurationMs(record.durationMs||0,record.sources,current,manifests);
  const durationMs=useRecordingDuration(record.id,saved,recording);

  return <time className="record-duration" aria-label="录音进度，含本机待保存音频">{timecode(durationMs)}</time>;
}

export function RecordingRuntime({record,recording,busy,signals,manifests,onError}:{
  record:RecordDetail|null;recording:boolean;busy:boolean;signals:ReturnType<typeof createCaptureSignals>;
  manifests:Parameters<typeof capturedDurationMs>[3];onError:(message:string)=>void;
}) {
  const current=useSyncExternalStore(signals.subscribe,signals.read);
  const saved=capturedDurationMs(record?.durationMs||0,record?.sources||[],current,manifests);
  const durationMs=useRecordingDuration(record?.id||'',saved,recording);
  useRecordingWidget({recording,microphoneOn:current.some(signal=>signal.kind==='microphone'),paused:!recording&&record?.capture==='paused',canResume:record?.capture==='paused'&&record.sources.every(source=>source.watermark===source.lastSequence),busy,durationMs,rms:Math.max(0,...current.map(signal=>Math.min(1,signal.rms)))},onError,record?.id||'');
  return null;
}

export function LiveMeetingControls({signals,...props}:Omit<React.ComponentProps<typeof MeetingControls>,'signals'>&{signals:ReturnType<typeof createCaptureSignals>}) {
  return <MeetingControls {...props} signals={useSyncExternalStore(signals.subscribe,signals.read)}/>;
}
export function LiveCaptureSetup({signals,...props}:Omit<React.ComponentProps<typeof CaptureSetup>,'signals'>&{signals:ReturnType<typeof createCaptureSignals>}) {
  return <CaptureSetup {...props} signals={useSyncExternalStore(signals.subscribe,signals.read)}/>;
}
