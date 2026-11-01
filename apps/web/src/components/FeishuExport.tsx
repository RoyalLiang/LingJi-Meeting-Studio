import { useEffect, useRef, useState } from 'react';
import { api, ApiError, messageOf } from '../api';
import type { RecordDetail } from '../model';
import { Button } from './ui';
import { ExternalLink } from './ExternalLink';
import './FeishuExport.css';
import { FeishuConnection, type FeishuConnectionValue } from './FeishuConnection';

type Receipt={id:string;title:string;folderToken:string;includeNotes:boolean;includeEvidence:boolean;source:{minutesRevision:number;transcriptRevision:number;edited:boolean;draft:boolean};status:string;stage:string;createdAt:number;url?:string;documentId?:string;error?:string;markdown?:string};
const endpoint='/integrations/feishu';
const states:Record<string,string>={draft:'等待确认',publishing:'正在导出',succeeded:'已导出',partial:'部分完成',unknown:'结果待核对',failed:'导出失败'};
const stages:Record<string,string>={preview:'内容已固定',convert:'整理文档内容',create:'创建云文档',write:'写入正文与引用',verify:'核对文档',completed:'文档已就绪'};

export function FeishuExport({record}:{record:RecordDetail}) {
  const [connection,setConnection]=useState<FeishuConnectionValue|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [title,setTitle]=useState(record.title),[folder,setFolder]=useState(''),[notes,setNotes]=useState(false),[evidence,setEvidence]=useState(true);
  const [receipt,setReceipt]=useState<Receipt|null>(null),[history,setHistory]=useState<Receipt[]>([]),[confirmed,setConfirmed]=useState(false),pending=useRef(false);
  useEffect(()=>{let active=true;api<{exports:Receipt[]}>(`/records/${record.id}/feishu`).then(value=>{if(active)setHistory(value.exports);}).catch(failure=>{if(active)setError(messageOf(failure));});return()=>{active=false;};},[record.id]);
  useEffect(()=>{
    if(receipt?.status!=='publishing')return;let active=true,loading=false;
    const timer=setInterval(()=>{if(loading)return;loading=true;api<Receipt>(`${endpoint}/exports/${receipt.id}`).then(value=>{if(active){setReceipt(value);setError('');}}).catch(failure=>{if(active)setError(messageOf(failure));}).finally(()=>{loading=false;});},1500);
    return()=>{active=false;clearInterval(timer);};
  },[receipt?.id,receipt?.status]);
  const perform=async(action:()=>Promise<void>)=>{if(pending.current)return;pending.current=true;setBusy(true);setError('');setNotice('');try{await action();}catch(failure){setError(messageOf(failure));}finally{pending.current=false;setBusy(false);}};
  const reset=()=>{setReceipt(null);setConfirmed(false);};
  return <section className="feishu-export" aria-label="导出到飞书云文档">
    <FeishuConnection onChange={setConnection} disabled={receipt?.status==='publishing'}/>
    {connection?.connected&&!receipt&&<>
      <label>文档标题<input value={title} maxLength={200} onChange={event=>setTitle(event.target.value)}/></label>
      <label>目标文件夹<input value={folder} onChange={event=>setFolder(event.target.value)} placeholder="留空放入个人空间，或粘贴飞书文件夹链接"/></label>
      <div className="feishu-scope"><label className="checkbox-label"><input type="checkbox" checked={evidence} onChange={event=>setEvidence(event.target.checked)}/><span>附带引用原文<small>保留片段与转录修订，便于追溯</small></span></label><label className="checkbox-label"><input type="checkbox" checked={notes} onChange={event=>setNotes(event.target.checked)}/><span>附带随手笔记<small>只包含已保存的人工笔记</small></span></label></div>
      <p className="fine-print">仅新建文档；可见范围继承飞书目标位置的权限，聆记不修改分享设置。不会导出录音或会议助手的独立分析。会后自动导出可在扩展中心的“自动化”中开启。</p>
      <div className="feishu-actions"><Button variant="primary" disabled={busy||!title.trim()} onClick={()=>void perform(async()=>{setReceipt(await api<Receipt>(`/records/${record.id}/feishu/preview`,'POST',{title,folderToken:folder,includeNotes:notes,includeEvidence:evidence}));setConfirmed(false);})}>预览并确认范围</Button></div>
    </>}
    {receipt&&<div className="feishu-receipt" aria-live="polite"><div className="feishu-receipt-title"><strong>{receipt.title}</strong><span>{states[receipt.status]||receipt.status}</span></div>
      <p className="fine-print">{receipt.source.draft?'会中草稿':`纪要 v${receipt.source.minutesRevision}`} · 转录 v{receipt.source.transcriptRevision}{receipt.source.edited?' · 人工修订':''} · {receipt.folderToken?`文件夹 ${receipt.folderToken}`:'个人空间'}</p>
      <p className="fine-print">{receipt.includeEvidence?'包含引用原文':'不含引用原文'} · {receipt.includeNotes?'包含随手笔记':'不含随手笔记'}</p>
      {receipt.markdown&&<pre className="feishu-preview" tabIndex={0}>{receipt.markdown}</pre>}
      {receipt.status==='draft'?<><label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/><span>确认将上述内容发送至此飞书位置</span></label><div className="feishu-actions"><Button onClick={reset} disabled={busy}>返回修改</Button><Button variant="primary" disabled={busy||!confirmed} onClick={()=>void perform(async()=>{setReceipt(await api<Receipt>(`${endpoint}/exports/${receipt.id}/publish`,'POST',{confirmed:true}));})}>确认导出到飞书</Button></div></>:<>
        <p>{receipt.status==='publishing'?stages[receipt.stage]||'正在导出…':receipt.status==='succeeded'?'纪要已写入飞书云文档。':receipt.status==='unknown'?'创建请求结果不确定，请先到飞书核对。聆记不会自动再创建。':receipt.status==='partial'?'已创建文档，但后续步骤未完成，请到飞书核对。':'未完成导出，请检查连接和应用权限后重试。'}</p>
        {receipt.error&&<p className="notice">{messageOf(new ApiError(receipt.error,502))}</p>}
        {receipt.url&&<ExternalLink href={receipt.url}>打开飞书云文档</ExternalLink>}
        <p className="fine-print">回执 {receipt.id}{receipt.documentId?` · 文档 ${receipt.documentId}`:''}</p>
        {receipt.status!=='publishing'&&<Button onClick={()=>{reset();void api<{exports:Receipt[]}>(`/records/${record.id}/feishu`).then(value=>setHistory(value.exports)).catch(()=>{});}}>返回导出设置</Button>}
      </>}
    </div>}
    {!receipt&&history.length>0&&<details className="feishu-history"><summary>最近导出 · {history.length}</summary>{history.map(item=><button type="button" className="feishu-history-item" key={item.id} onClick={()=>void perform(async()=>{setConfirmed(false);setReceipt(await api<Receipt>(`${endpoint}/exports/${item.id}`));})}><span>{item.title}</span><span>{states[item.status]||item.status}</span></button>)}</details>}
    {notice&&<p role="status" className="notice">{notice}</p>}{error&&<p role="alert" className="error">{error}</p>}
  </section>;
}
