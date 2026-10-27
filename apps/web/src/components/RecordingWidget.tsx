import { useEffect, useLayoutEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Pause, Play, Stop, ArrowsOutSimple, Microphone, MicrophoneSlash } from '@phosphor-icons/react';
import type { RecordingWidgetState } from '../useRecordingWidget';
import './RecordingWidget.css';
const initial:RecordingWidgetState={recording:false,microphoneOn:false,paused:false,canResume:false,busy:false,durationMs:0,rms:0};
export function RecordingWidget(){
  const [state,setState]=useState(initial),[error,setError]=useState('');
  const [loaded,setLoaded]=useState(false);
  useEffect(()=>{
    let active=true,eventRevision=0,stop:(()=>void)|undefined;
    void listen<RecordingWidgetState>('recording-widget-state',e=>{if(active){eventRevision++;setState(e.payload);}}).then(async unlisten=>{
      if(!active){unlisten();return;}stop=unlisten;
      const revision=eventRevision,report=await invoke<RecordingWidgetState>('recording_widget_state');if(active){if(revision===eventRevision)setState(report);setLoaded(true);}
    }).catch(()=>active&&setError('状态暂不可用，请返回主窗口'));
    return()=>{active=false;stop?.();};
  },[]);
  useLayoutEffect(()=>{if(loaded)void invoke('recording_widget_ready').catch(()=>setError('状态暂不可用，请返回主窗口'));},[loaded]);
  async function action(value:string){try{await invoke('recording_widget_action',{action:value});setError('');}catch{setError('操作未完成，请返回主窗口');}}
  const seconds=Math.floor(state.durationMs/1000),clock=[Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(x=>String(x).padStart(2,'0')).join(':');
  return <main className="recording-capsule" aria-label="悬浮录音控制">
    <div className="capsule-status" data-tauri-drag-region><span className={`capsule-dot ${state.recording?'is-live':''}`} aria-hidden="true"/><div data-tauri-drag-region><span data-tauri-drag-region>{error || (state.busy?'正在处理…':state.recording?'正在录音':!state.canResume?'音频补传中':'已暂停')}</span><time data-tauri-drag-region>{clock}</time></div></div>
    <div className="capsule-level" aria-hidden="true" data-tauri-drag-region>{Array.from({length:17},(_,i)=><i key={i} style={{height:`${3+(state.recording?Math.min(1,state.rms*8):0)*(5+(i*7%8))}px`}}/>)}</div>
    <div className="capsule-actions">
      <button type="button" disabled={state.busy || (!state.recording && (!state.paused || !state.canResume))} aria-pressed={state.microphoneOn} onClick={()=>void action('microphone')} aria-label={state.microphoneOn?'关闭麦克风':'开启麦克风'} title={state.microphoneOn?'关闭麦克风':'开启麦克风'}>{state.microphoneOn?<MicrophoneSlash size={18}/>:<Microphone size={18}/>}</button>
      <button type="button" disabled={state.busy || (state.paused && !state.canResume)} onClick={()=>void action('pause')} aria-label={state.recording?'暂停录音':'继续录音'} title={state.recording?'暂停录音':'继续录音'}>{state.recording?<Pause size={18} weight="fill"/>:<Play size={18} weight="fill"/>}</button>
      <button type="button" className="capsule-finish" disabled={state.busy} onClick={()=>void action('finish')} aria-label="结束并整理" title="结束并整理"><Stop size={17} weight="fill"/></button>
      <button type="button" onClick={()=>void action('restore')} aria-label="返回主窗口" title="返回主窗口"><ArrowsOutSimple size={18}/></button>
    </div>
  </main>;
}
