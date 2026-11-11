import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, LinkSimple, X } from '@phosphor-icons/react';
import type { Evidence, MinutesItem, RecordDetail, RecordListItem, Segment } from '../model';
import type { WorkspaceOverview } from '../workspace-model';
import { Button } from './ui';
import { CitationSources } from './CitationSources';

export function WorkbenchContext({record,records,overview,mode,open,close,cite,selectRecord,children,tasksRef,translation=false}:{record:RecordDetail|null;records:RecordListItem[];overview:WorkspaceOverview|null;name:string;mode:'meeting'|'workspace'|'settings'|'extensions'|'automation';open:boolean;close:()=>void;cite:(ref:Evidence,snapshot?:Segment[],revision?:number)=>void;selectRecord:(id:string)=>void;children?:ReactNode;tasksRef?:(node:HTMLDivElement|null)=>void;translation?:boolean}) {
  const [tab,setTab]=useState('重点');
  const ref=useRef<HTMLElement>(null);
  useEffect(()=>setTab('重点'),[record?.id,mode]);
  useEffect(()=>{
    if(!open||!matchMedia('(max-width: 1179px)').matches)return;
    const opener=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const surfaces=[...document.querySelectorAll<HTMLElement>('.app-shell>.workspace,.app-shell>.v10-sidebar')];
    const previous=surfaces.map(node=>node.inert);surfaces.forEach(node=>{node.inert=true;});
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key=(event:KeyboardEvent)=>{
      if(document.querySelector('dialog[open],[role=listbox]:popover-open,[role=menu]:popover-open'))return;
      if(event.key==='Escape'){event.preventDefault();close();}
      if(event.key==='Tab'){
        const items=[...ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],[tabindex="0"]')||[]].filter(node=>node.getClientRects().length);
        const first=items[0],last=items.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };
    const resize=()=>{if(innerWidth>=1180)close();};
    addEventListener('resize',resize);document.addEventListener('keydown',key);
    return()=>{removeEventListener('resize',resize);document.removeEventListener('keydown',key);surfaces.forEach((node,index)=>{node.inert=previous[index];});if(opener?.isConnected)opener.focus();};
  },[open,close]);
  const minutes=record?.minutes?.edited?record.minutes:record?.capture==='completed'?record.minutes||record.liveMinutes:record?.liveMinutes||record?.minutes;
  const citeSelected=(ref:Evidence)=>cite(ref,minutes?.evidenceSnapshot,minutes?.transcriptRevision);
  const points=minutes?.highlights?.length?minutes.highlights:minutes?.decisions?.length?minutes.decisions:minutes?.sections.flatMap(section=>section.items).slice(0,3)||[];
  const actions=minutes?.actions||[];
  const sourceItems=[...points,...actions];
  const items=(list:MinutesItem[])=>list.length?list.map((item,index)=><article className="context-item" key={index}><p>{item.text}</p>{item.evidence.length>0&&<CitationSources evidence={item.evidence} cite={citeSelected} compact/>}</article>):<p className="context-empty">{record?.capture==='recording'?'正在记录…':'暂无内容'}</p>;
  return <><button className="context-backdrop" hidden={!open} aria-label="收起上下文" onClick={close}/><aside ref={ref} data-mode={mode} className={`workbench-context ${open?'is-open':''}`} aria-label={mode==='meeting'?'本场会议上下文':mode==='automation'?'自动化任务':'项目上下文'}>
    <header><div><h2>{mode==='meeting'?'本场会议':mode==='settings'?'配置与使用':mode==='automation'?'自动化任务':mode==='extensions'?'运行与授权':'项目动态'}</h2></div><Button className="context-close" aria-label="收起上下文" onClick={close}><X size={16}/></Button></header>
    <div className="context-scroll">
      {translation?children:mode==='meeting'?<><nav className="context-tabs" aria-label="会议上下文分类">{['重点','行动','来源'].map(label=><button key={label} aria-current={tab===label?'page':undefined} onClick={()=>setTab(label)}>{label}</button>)}</nav>{tab==='重点'?<>{children}{items(points)}</>:tab==='行动'?items(actions):sourceItems.some(item=>item.evidence.length)?sourceItems.filter(item=>item.evidence.length).map((item,index)=><article className="context-item" key={index}><p>{item.text}</p><CitationSources evidence={item.evidence} cite={citeSelected} compact/></article>):<p className="context-empty">暂无引用来源，可在转录中核对原文。</p>}</>:mode==='workspace'?<>
        <div className="context-section-title">最近的讨论</div>{overview?.summaries.length?overview.summaries.slice(0,3).map((summary,index)=><article className="context-item" key={index}><p title={summary.text}>{summary.text}</p><button className="context-link" onClick={()=>selectRecord(summary.source.recordId)}><LinkSimple size={14}/>核对原文<ArrowUpRight size={12}/></button></article>):<p className="context-empty">暂无纪要</p>}
        <div className="context-section-title">要跟进的</div>{overview?.actions.length?overview.actions.slice(0,4).map((action,index)=><article className="context-item context-action" key={index}><p>{action.text}</p><small>{action.owner||'负责人待确认'} · {action.due||'日期待确认'}</small><button className="context-link" onClick={()=>selectRecord(action.source.recordId)}>查看会议<ArrowUpRight size={12}/></button></article>):<p className="context-empty">暂无行动候选</p>}
        <div className="context-section-title">统计</div><dl className="context-stats"><div><dt>会议记录</dt><dd>{overview?.totals.meetings??records.length} 场</dd></div><div><dt>累计时长</dt><dd>{Math.ceil((overview?.totals.seconds??records.reduce((sum,item)=>sum+item.seconds,0))/60)} 分钟</dd></div><div><dt>已保存纪要</dt><dd>{overview?.totals.withMinutes??records.filter(item=>item.hasMinutes).length} 场</dd></div></dl>
      </>:mode==='automation'?null:<><div className="context-section-title">{mode==='settings'?'当前配置':'本次范围'}</div><article className="context-item"><p>{mode==='settings'?'账户与本机配置':'会议资料按 Workspace 选择'}</p>{mode!=='settings'&&<small>运行前核对会议范围</small>}</article><article className="context-item"><p>{mode==='settings'?'项目资料保持原有范围':'外部写入需要确认'}</p><small>{mode==='settings'?'保存设置不会改变会议归属与分享权限。':'飞书目标与 Git 仓库分别核对。'}</small></article></>}
    <div className="automation-context-tasks" ref={tasksRef} hidden={mode!=='automation'}/></div>
  </aside></>;
}
