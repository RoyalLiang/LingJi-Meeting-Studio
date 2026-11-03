import {lazy,Suspense,useEffect,useState} from 'react';
import {api,ApiError,messageOf} from '../api';
import type {GitJob} from './GitAutomation';
import {FeedbackNotice} from './FeedbackNotice';
const Detail=lazy(()=>import('./GitAutomation').then(m=>({default:m.GitTask})));
export function GitSyncNotifier(){
  const [attention,setAttention]=useState<GitJob|null>(null),[detail,setDetail]=useState<GitJob|null>(null);
  useEffect(()=>{let stopped=false,loading=false,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{if(loading||stopped)return;loading=true;let next=false;try{const value=await api<{enabled:boolean;recent:GitJob[]}>('/integrations/git-sync');if(stopped)return;const latest=new Map<string,GitJob>();for(const job of value.recent)if(!latest.has(job.recordId))latest.set(job.recordId,job);setAttention([...latest.values()].find(j=>['failed','blocked','unknown'].includes(j.status))||null);setDetail(current=>current?value.recent.find(j=>j.id===current.id)||current:null);next=value.enabled||value.recent.some(j=>['queued','running'].includes(j.status));}catch{/* Persistent task history survives a temporary disconnected view. */next=true;}finally{loading=false;if(!stopped&&next)timer=setTimeout(()=>void poll(),30000);}};
    const refresh=()=>{clearTimeout(timer);void poll();};window.addEventListener('lingji:git-sync-changed',refresh);void poll();return()=>{stopped=true;clearTimeout(timer);window.removeEventListener('lingji:git-sync-changed',refresh);};
  },[]);
  return <>{attention&&<FeedbackNotice key={`${attention.id}:${attention.updatedAt}:${attention.status}`} message={`Git 同步未完成 · ${attention.title}：${messageOf(new ApiError(attention.error||'git_sync_failed',502))}`} error={attention.status==='failed'} dismissalKey={`git-sync:${attention.id}:${attention.updatedAt}:${attention.status}`} action={{label:'查看同步任务',run:()=>setDetail(attention)}}/>}{detail&&<Suspense fallback={<p role="status">正在打开同步任务…</p>}><Detail job={detail} close={()=>setDetail(null)} changed={job=>{setDetail(job);window.dispatchEvent(new Event('lingji:git-sync-changed'));}}/></Suspense>}</>;
}
