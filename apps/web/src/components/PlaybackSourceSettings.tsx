import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowsClockwise} from '@phosphor-icons/react';
import {applicationAudioOptions,nativePlaybackSelection,preferredPlayback,setPreferredPlayback,type ApplicationAudioOptions} from '../audio/playback-devices';
import {messageOf} from '../api';
import {Select} from './Select';
import {Button} from './ui';
import {FeedbackNotice} from './FeedbackNotice';
export function PlaybackSourceSettings({disabled=false}:{disabled?:boolean}){
 const [options,setOptions]=useState<ApplicationAudioOptions|null>(null),[selected,setSelected]=useState(preferredPlayback),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const refresh=useCallback(async()=>{setBusy(true);try{const value=await applicationAudioOptions();if(mounted.current){setOptions(value);setError('');}}catch(cause){if(mounted.current)setError(typeof cause==='string'?cause:messageOf(cause));}finally{if(mounted.current)setBusy(false);}},[]);
 const native=nativePlaybackSelection();useEffect(()=>{if(native)void refresh();},[refresh,native]);
 if(!native)return null;
 const missing=selected!=='system'&&Boolean(options)&&!options?.applications.some(app=>app.id===selected),unresolved=selected!=='system'&&!options;
 return <div className="playback-source-settings" aria-busy={busy}>
  <p className="playback-source-label">会议声音来源</p>
  <div className="playback-source-control"><Select label="会议声音来源" disabled={disabled||busy} value={selected} onChange={value=>{setPreferredPlayback(value);setSelected(value);}} options={[{value:'system',label:'系统所有应用'},...(missing||unresolved?[{value:selected,label:missing?'所选应用已失效，请重新选择':error?'所选应用暂不可用，请刷新':'正在确认所选应用…'}]:[]),...(options?.applications||[]).map(app=>({value:app.id,label:app.label}))]}/><Button variant="ghost" aria-label="刷新可选应用" disabled={disabled||busy} onClick={()=>void refresh()}><ArrowsClockwise size={18}/></Button></div>
  <p className="fine-print">{unresolved?'正在确认所选应用，当前选择不会改用系统声音。':missing?'该选择不会改用系统声音；请重新选择正在运行的应用。':options?.reason||(selected==='system'?'记录本机正在播放的所有声音。':'仅记录所选应用及其子进程；应用退出后会停止此音源。')}</p>
  {error&&<FeedbackNotice key={error} message={error} error persistent inline/>}
 </div>;
}
