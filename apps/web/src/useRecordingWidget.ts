import { useEffect, useRef } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
export type RecordingWidgetState = {recording:boolean;paused:boolean;canResume:boolean;busy:boolean;durationMs:number;rms:number};
export function useRecordingWidget(report:RecordingWidgetState, onError:(message:string)=>void, recordId:string) {
  const latest=useRef(report), warned=useRef(false);
  const currentRecord=useRef(recordId);
  useEffect(()=>{
    latest.current={...report,durationMs:currentRecord.current===recordId?Math.max(latest.current.durationMs,report.durationMs):report.durationMs};
    currentRecord.current=recordId;
  },[report,recordId]);
  useEffect(()=>{
    if(!isTauri())return;
    let active=true;
    const update=()=>void invoke('recording_widget_update',{report:latest.current}).catch(()=>{
      if(active && latest.current.recording && !warned.current){warned.current=true;onError('悬浮录音窗未能打开，录音仍在继续。可在主窗口或系统托盘控制录音。');}
    });
    if(!report.recording)warned.current=false;
    update();const timer=setInterval(update,1000);
    return()=>{active=false;clearInterval(timer);};
  },[report.recording,report.paused,report.canResume,report.busy,onError]);
}
