import {useEffect,useRef,useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {createMeetingAutomation,type MeetingReport} from './meeting-automation';
export type MeetingAutomationConfig={enabled:boolean;browser:boolean;feishu:boolean};
type Signal={token:string;sampledAt:number;input:boolean;output:boolean;error?:string};
export function useMeetingAutomation(config:MeetingAutomationConfig|undefined,report:MeetingReport,commands:{start:()=>Promise<string|undefined>;stop:(id:string)=>Promise<boolean>;error:(message:string)=>void}) {
  const latest=useRef({report,commands});latest.current={report,commands};
  const engineRef=useRef(createMeetingAutomation());
  const [notice,setNotice]=useState<{key:string;message:string;cancel:()=>void}>();
  useEffect(()=>{
    if(!isTauri())return;
    if(!config?.enabled)engineRef.current=createMeetingAutomation();
    const token=crypto.randomUUID(),engine=engineRef.current;engine.reconfigure();
    let active=true,unlisten:(()=>void)|undefined,warned=false;
    setNotice(undefined);
    const configure=async()=>{
      unlisten=await listen<Signal>('meeting-activity',async({payload})=>{
        if(!active || payload.token!==token)return;
        const current=latest.current;
        const decision=engine.sample({sampledAt:payload.sampledAt,receivedAt:Date.now(),active:payload.input || payload.output,error:payload.error},current.report);
        if(payload.error && !warned){warned=true;current.commands.error('音频调用监听暂不可用，自动联动已暂停。');}
        if(!payload.error)warned=false;
        const pending=engine.pending;
        setNotice(pending ? {key:`${token}:${pending.kind}:${pending.since}`,message:pending.kind==='start' ? `检测到音频调用，${Math.max(0,Math.ceil((pending.due-payload.sampledAt)/1000))} 秒后开始记录。` : `目标音频调用已结束，${Math.max(0,Math.ceil((pending.due-payload.sampledAt)/1000))} 秒后结束本场记录。`,cancel:()=>{engine.cancel();setNotice(undefined);}} : undefined);
        if(!decision)return;
        setNotice(undefined);
        try{
          if(decision.kind==='start')engine.started(await current.commands.start());
          else {if(latest.current.report.id===decision.recordId && latest.current.report.recording)await current.commands.stop(decision.recordId);engine.stopped();}
        }catch{engine.stopped();current.commands.error('自动联动未完成，请在主窗口检查录音状态。');}
      });
      if(!active){unlisten();return;}
      await invoke('meeting_watch_configure',{enabled:Boolean(config?.enabled),browser:config?.browser!==false,feishu:config?.feishu!==false,token});
    };
    void configure().catch(()=>{if(active)latest.current.commands.error('当前环境无法启用音频调用监听。');});
    return()=>{active=false;unlisten?.();void invoke('meeting_watch_configure',{enabled:false,browser:false,feishu:false,token}).catch(()=>{});};
  },[config?.enabled,config?.browser,config?.feishu]);
  return notice;
}
