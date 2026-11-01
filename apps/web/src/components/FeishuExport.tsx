import {createPortal} from 'react-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {CheckCircle,CircleNotch,WarningCircle} from '@phosphor-icons/react';
import {FeedbackNotice} from './FeedbackNotice';
import { api, ApiError, messageOf } from '../api';
import type { RecordDetail } from '../model';
import { Button } from './ui';
import { ExternalLink } from './ExternalLink';
import './FeishuExport.css';
import {Select} from './Select';
import {MarkdownPreview,BoardPreview,type BoardNode} from './MarkdownPreview';
import { FeishuConnection, type FeishuConnectionValue } from './FeishuConnection';

type Receipt={destinationEmail?:string;includeBoard?:boolean;boardNodes?:BoardNode[];authMode?:'app';id:string;title:string;folderToken:string;includeNotes:boolean;includeEvidence:boolean;source:{minutesRevision:number;transcriptRevision:number;edited:boolean;draft:boolean};status:string;stage:string;createdAt:number;url?:string;documentId?:string;error?:string;markdown?:string};
const endpoint='/integrations/feishu';
const states:Record<string,string>={draft:'等待确认',publishing:'正在导出',succeeded:'导出完成',partial:'部分完成',unknown:'结果待核对',failed:'导出失败'};
const stages:Record<string,string>={preview:'内容已固定',convert:'整理文档内容',create:'创建云文档',write:'写入正文与引用',board:'写入纪要画板',transfer:'转交成员云文档',verify:'核对文档',completed:'文档已就绪'};

export function FeishuExport({record,footerTarget}:{record:RecordDetail;footerTarget?:HTMLElement|null}) {
  const [connection,setConnection]=useState<FeishuConnectionValue|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [title,setTitle]=useState(record.title),[folder,setFolder]=useState(''),[email,setEmail]=useState(''),[destination,setDestination]=useState('folder'),[board,setBoard]=useState(true),[notes,setNotes]=useState(false),[evidence,setEvidence]=useState(true);
  const [receipt,setReceipt]=useState<Receipt|null>(null),[history,setHistory]=useState<Receipt[]>([]),[confirmed,setConfirmed]=useState(false),pending=useRef(false);
  useEffect(()=>{let active=true;api<{exports:Receipt[]}>(`/records/${record.id}/feishu`).then(value=>{if(active)setHistory(value.exports);}).catch(failure=>{if(active)setError(messageOf(failure));});return()=>{active=false;};},[record.id]);
  useEffect(()=>{
    if(receipt?.status!=='publishing')return;let active=true,loading=false;
    const timer=setInterval(()=>{if(loading)return;loading=true;api<Receipt>(`${endpoint}/exports/${receipt.id}`).then(value=>{if(active){setReceipt(value);setError('');}}).catch(failure=>{if(active)setError(messageOf(failure));}).finally(()=>{loading=false;});},1500);
    return()=>{active=false;clearInterval(timer);};
  },[receipt?.id,receipt?.status]);
  const perform=async(action:()=>Promise<void>)=>{if(pending.current)return;pending.current=true;setBusy(true);setError('');try{await action();}catch(failure){setError(messageOf(failure));}finally{pending.current=false;setBusy(false);}};
  const actions=(content:ReactNode)=>footerTarget?createPortal(content,footerTarget):content;
  const reset=()=>{setReceipt(null);setConfirmed(false);};
  return <section className="feishu-export" aria-label="导出到飞书云文档">
    {!receipt&&<FeishuConnection onChange={setConnection}/>}
    {connection?.connected&&!receipt&&<>
      <label>文档标题<input value={title} maxLength={200} onChange={event=>setTitle(event.target.value)}/></label>
      <div className="feishu-fields"><label>导出位置<Select label="导出位置" value={destination} onChange={setDestination} options={[{value:'member',label:'成员云文档'},{value:'folder',label:'飞书文件夹'}]}/></label>{destination==='member'?<label>成员飞书邮箱<input type="email" value={email} onChange={event=>setEmail(event.target.value)} placeholder="name@company.com"/></label>:<label>文件夹链接<input value={folder} onChange={event=>setFolder(event.target.value)} placeholder="粘贴应用可写的文件夹链接"/></label>}</div>
      <fieldset className="feishu-options"><legend>附带内容</legend><label className="checkbox-label"><input type="checkbox" checked={board} onChange={event=>setBoard(event.target.checked)}/><span>纪要画板</span></label><label className="checkbox-label"><input type="checkbox" checked={evidence} onChange={event=>setEvidence(event.target.checked)}/><span>引用原文</span></label><label className="checkbox-label"><input type="checkbox" checked={notes} onChange={event=>setNotes(event.target.checked)}/><span>随手笔记</span></label></fieldset>
      {destination==='member'&&<p className="feishu-target-hint">文档将归该成员所有。</p>}
      {destination==='folder'&&!folder.trim()&&<p className="feishu-target-hint">未指定文件夹时仅应用可见；可选择成员云文档。</p>}
      {actions(<div className="feishu-actions"><Button variant="primary" disabled={busy||!title.trim()||destination==='member'&&!email.trim()} onClick={()=>void perform(async()=>{setReceipt(await api<Receipt>(`/records/${record.id}/feishu/preview`,'POST',{title,folderToken:destination==='folder'?folder:'',destinationEmail:destination==='member'?email:'',includeBoard:board,includeNotes:notes,includeEvidence:evidence}));setConfirmed(false);})}>预览文档</Button></div>)}
    </>}
    {receipt?.status==='draft'&&<div className="feishu-receipt"><p className="fine-print">{receipt.title} · {receipt.destinationEmail||receipt.folderToken||'应用文档'} · {receipt.includeNotes?'附带笔记':'不含笔记'} · {receipt.includeEvidence?'附带引用':'不含引用'}</p><div className="feishu-preview" tabIndex={0}><MarkdownPreview text={receipt.markdown||''}/>{receipt.includeBoard&&receipt.boardNodes&&<BoardPreview nodes={receipt.boardNodes}/>}</div><label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/><span>确认将文档发送至上述位置</span></label>{actions(<div className="feishu-actions"><Button onClick={reset} disabled={busy}>返回修改</Button><Button variant="primary" disabled={busy||!confirmed} onClick={()=>void perform(async()=>{setReceipt(await api<Receipt>(`${endpoint}/exports/${receipt.id}/publish`,'POST',{confirmed:true}));})}>确认导出到飞书</Button></div>)}</div>}
    {receipt&&receipt.status!=='draft'&&<div className={`feishu-progress ${receipt.status}`} role="status" aria-live="polite">{receipt.status==='publishing'?<CircleNotch className="feishu-progress-spinner" size={22} aria-hidden="true"/>:receipt.status==='succeeded'?<CheckCircle size={22} aria-hidden="true"/>:<WarningCircle size={22} aria-hidden="true"/>}<strong>{receipt.status==='publishing'?stages[receipt.stage]||'正在导出':states[receipt.status]||receipt.status}</strong>{receipt.url&&<ExternalLink href={receipt.url}>打开文档</ExternalLink>}{receipt.status==='failed'&&<Button onClick={reset}>返回设置</Button>}</div>}
    {receipt?.error&&<FeedbackNotice key={`${receipt.id}:${receipt.error}`} message={messageOf(new ApiError(receipt.error,502))} error/>}
    {!receipt&&history.length>0&&<details className="feishu-history"><summary>最近导出 · {history.length}</summary>{history.map(item=><button type="button" className="feishu-history-item" key={item.id} onClick={()=>void perform(async()=>{setConfirmed(false);setReceipt(await api<Receipt>(`${endpoint}/exports/${item.id}`));})}><span>{item.title}</span><span>{states[item.status]||item.status}</span></button>)}</details>}
    {error&&<FeedbackNotice key={error} message={error} error/>}
  </section>;
}
