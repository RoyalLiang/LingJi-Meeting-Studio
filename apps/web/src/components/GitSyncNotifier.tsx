import {lazy,Suspense,useEffect,useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import type {GitJob} from './GitAutomation';
import {gitSyncStatus} from '../git-sync-feed';
import {FeedbackNotice} from './FeedbackNotice';
const Detail=lazy(()=>import('./GitAutomation').then(m=>({default:m.GitTask})));
export function GitSyncNotifier(){
  const [attention,setAttention]=useState<GitJob|null>(null),[detail,setDetail]=useState<GitJob|null>(null);
  useEffect(()=>{let stopped=false,loading=false,timer:ReturnType<typeof setTimeout>;const notified=new Set<string>();
    const poll=async()=>{if(stopped||loading)return;loading=true;let next=15000;try{
      const value=await gitSyncStatus();if(stopped)return;const latest=new Map<string,GitJob>();for(const job of value.recent)if(!latest.has(job.recordId))latest.set(job.recordId,job);
      const jobs=[...latest.values()],waiting=jobs.find(j=>j.interaction);
      setAttention(waiting||jobs.find(j=>['failed','blocked','unknown'].includes(j.status))||null);setDetail(current=>current?value.recent.find(j=>j.id===current.id)||current:null);
      if(waiting?.interaction){const key=`${waiting.id}:${waiting.interaction.id}`;if(!notified.has(key)){notified.add(key);if(isTauri())void invoke('client_attention').catch(()=>{});if(typeof Notification!=='undefined'&&Notification.permission==='granted'){try{const notice=new Notification('Git 同步等待你的回复',{body:waiting.title,tag:key});notice.onclick=()=>{setDetail(waiting);window.focus();notice.close();};}catch{/* In-app notice remains available. */}}}}
      if(value.recent.some(j=>['queued','running','waiting'].includes(j.status)))next=1500;
    }catch{/* A transient connection failure is retried on the next poll. */}finally{loading=false;if(!stopped)timer=setTimeout(()=>void poll(),next);}};
    const refresh=()=>{clearTimeout(timer);void poll();};window.addEventListener('lingji:git-sync-changed',refresh);window.addEventListener('focus',refresh);void poll();return()=>{stopped=true;clearTimeout(timer);window.removeEventListener('lingji:git-sync-changed',refresh);window.removeEventListener('focus',refresh);};
  },[]);
  return <>{attention&&<FeedbackNotice key={`${attention.id}:${attention.interaction?.id||attention.status}`} message={attention.interaction?`Git 同步等待你的回复：${attention.title}`:`Git 同步${attention.status==='failed'?'失败':'待处理'}：${attention.title}`} persistent={Boolean(attention.interaction)} error={attention.status==='failed'} dismissalKey={`git-sync:${attention.id}:${attention.interaction?.id||attention.status}`} action={{label:attention.interaction?'回复 Agent':'查看同步任务',run:()=>setDetail(attention)}}/>}{detail&&<Suspense fallback={null}><Detail job={detail} close={()=>setDetail(null)} changed={job=>{setDetail(job);window.dispatchEvent(new Event('lingji:git-sync-changed'));}}/></Suspense>}</>;
}
