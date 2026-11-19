import {useEffect, useState} from 'react';
import {loadMinutesScreenshots} from '../meeting-screenshot-client';
import type {MeetingScreenshot} from '../model';
import {timecode} from '../model';

export function MinutesScreenshots({recordId, through}:{recordId:string;through:number}) {
  const [frames, setFrames] = useState<MeetingScreenshot[]>([]);
  const [status, setStatus] = useState('正在读取会议截图…');
  useEffect(()=>{
    const controller = new AbortController();
    void loadMinutesScreenshots(recordId, through, controller.signal).then(value=>{
      if (!controller.signal.aborted) {
        setFrames(value);
        setStatus(value.length ? '' : '会议截图已不可用。');
      }
    }).catch(()=>{
      if (!controller.signal.aborted) setStatus('暂时无法读取会议截图。');
    });
    return ()=>controller.abort();
  },[recordId,through]);
  return <section className="minutes-section" aria-label="会议截图">
    <h4>会议截图</h4>
    {status && <p role="status">{status}</p>}
    <div className="minutes-screenshot-grid">{frames.map(frame=><figure key={frame.revision}>
      <img src={`data:image/jpeg;base64,${frame.jpeg}`} alt={`会议截图 ${timecode(frame.atMs)}`} loading="lazy"/>
      <figcaption>{timecode(frame.atMs)}</figcaption>
    </figure>)}</div>
  </section>;
}
