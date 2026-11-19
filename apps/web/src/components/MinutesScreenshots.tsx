import './MinutesScreenshots.css';
import {useEffect,useState} from 'react';
import {loadMinutesScreenshots} from '../meeting-screenshot-client';
import type {MeetingScreenshot} from '../model';
import {timecode} from '../model';

const noFrames: MeetingScreenshot[] = [];
export function useMinutesScreenshots(recordId: string, through?: number) {
  const key = through ? `${recordId}:${through}` : '';
  const [result,setResult] = useState<{key:string; frames:MeetingScreenshot[]; unavailable:boolean}>();
  useEffect(() => {
    if (!through) return;
    const controller = new AbortController();
    loadMinutesScreenshots(recordId,through,controller.signal).then(frames => {
      if (!controller.signal.aborted) setResult({key,frames,unavailable:frames.length!==through});
    }).catch(() => {
      if (!controller.signal.aborted) setResult({key,frames:noFrames,unavailable:true});
    });
    return () => controller.abort();
  },[key,recordId,through]);
  return result?.key===key ? result : {frames:noFrames,unavailable:false};
}

export function MinutesScreenshots({frames}: {frames:readonly MeetingScreenshot[]}) {
  if (!frames.length) return null;
  return <div className="minutes-screenshot-grid" aria-label="会议截图" role="group">
    {frames.map(frame => <figure key={frame.revision}>
      <img src={`data:image/jpeg;base64,${frame.jpeg}`} alt={`会议截图 ${timecode(frame.atMs)}`} loading="lazy"/>
      <figcaption>{timecode(frame.atMs)}</figcaption>
    </figure>)}
  </div>;
}
