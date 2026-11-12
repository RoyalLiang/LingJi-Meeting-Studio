import { useEffect, useRef, useState } from 'react';
import { ArrowsClockwise, Check, Clock, WarningCircle } from '@phosphor-icons/react';
import { messageOf } from '../api';
import { Button } from './ui';

export function ModuleConnectionCheck({ label, revision, blockedReason, disabled=false, check }: {
  label:string; revision:string; blockedReason?:string; disabled?:boolean;
  check:(signal:AbortSignal)=>Promise<string>;
}) {
  const [result,setResult]=useState<{status:'idle'|'pending'|'success'|'error'|'stale';message:string}>({status:'idle',message:''});
  const request=useRef<AbortController|null>(null),sequence=useRef(0);
  useEffect(()=>{
    sequence.current++;request.current?.abort();request.current=null;
    setResult(current=>current.status==='idle'?current:{status:'stale',message:'配置已变更，请保存后重新检测。'});
    return()=>{sequence.current++;request.current?.abort();};
  },[revision]);
  async function run() {
    if(disabled||blockedReason||request.current)return;
    const controller=new AbortController(),token=++sequence.current;request.current=controller;
    setResult({status:'pending',message:`正在检测${label}…`});
    try {
      const message=await check(controller.signal);
      if(token===sequence.current&&!controller.signal.aborted)setResult({status:'success',message});
    } catch(error) {
      if(token===sequence.current&&!controller.signal.aborted)setResult({status:'error',message:messageOf(error)});
    } finally {if(request.current===controller)request.current=null;}
  }
  const texts={idle:'未检测',pending:'检测中',success:'检测通过',error:'检测未通过',stale:'待重新检测'};
  return <div className="module-connection-check" data-module={label}>

    <div className="module-check-result" data-state={result.status} role="status" aria-live="polite" aria-atomic="true"><span className="module-check-state">{result.status==='success'?<Check size={12}/>:result.status==='error'?<WarningCircle size={12}/>:<Clock size={12}/>} {texts[result.status]}</span>{(blockedReason||result.message)&&<small>{blockedReason||result.message}</small>}</div>
    <Button type="button" disabled={disabled||Boolean(blockedReason)||result.status==='pending'} aria-busy={result.status==='pending'} aria-label={`检测${label}`} onClick={()=>void run()}><ArrowsClockwise size={15}/>{result.status==='pending'?'检测中…':result.status==='idle'?'检测连接':'重新检测'}</Button>
  </div>;
}
