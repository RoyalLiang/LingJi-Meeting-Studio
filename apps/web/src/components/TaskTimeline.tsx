import {useState} from 'react';
import {api,messageOf} from '../api';
import {Button} from './ui';
import './TaskTimeline.css';

export type TaskMetric={kind:string;name?:string;startedAt:number;elapsedMs:number;count?:number;usage?:{totalTokens:number};usageReported?:boolean};
export type TaskLedger={rounds:number;compactions:number;totalTokens:number;cost:number|null;toolsMs?:number;userWaitMs?:number;reportedRounds?:number};
const names:Record<string,string>={model:'模型处理',compaction:'上下文压缩',tool:'工具执行',user_wait:'等待你的回复',children:'分段提炼完成',read_selected_meeting:'阅读会议材料',read_selected_skill:'阅读所选 Skill',call_selected_mcp:'查询已授权工具',manage_git_sync:'核对与归档仓库',request_user_input:'等待你的回复'};
export function TaskTimeline({timeline=[],ledger,kernelId}:{timeline?:TaskMetric[];ledger?:TaskLedger;kernelId?:string}){
 const [exporting,setExporting]=useState(false),[error,setError]=useState('');
 const download=async()=>{if(!kernelId)return;setExporting(true);setError('');try{
  const data=await api(`/meeting-tasks/${encodeURIComponent(kernelId)}/diagnostics`),url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='lingji-task-diagnostic.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(error){setError(messageOf(error));}finally{setExporting(false);}};
 if(!timeline.length&&!ledger&&!kernelId)return null;
 return <details className="task-timeline"><summary><span>任务过程与用量</span><span>{ledger?`${ledger.rounds} 轮 · ${ledger.totalTokens.toLocaleString()} tokens`:`${timeline.length} 项记录`}</span></summary><div className="task-timeline-body">
 {ledger&&<dl className="task-ledger"><div><dt>模型轮次</dt><dd>{ledger.rounds}</dd></div><div><dt>上下文压缩</dt><dd>{ledger.compactions}</dd></div><div><dt>已报告 token</dt><dd>{ledger.totalTokens.toLocaleString()}</dd></div><div><dt>费用 · USD</dt><dd>{ledger.cost===null?'暂无法核算':`$${ledger.cost.toFixed(4)}`}</dd></div></dl>}
 <ol>{timeline.map((item,index)=><li key={`${item.startedAt}:${index}`}><span>{names[item.name||item.kind]||'任务阶段'}{item.count?` · ${item.count} 个子任务`:''}</span><time>{(Math.max(0,item.elapsedMs)/1000).toFixed(1)} 秒</time>{item.usageReported===false&&<small>供应商未报告用量</small>}</li>)}</ol>
 {kernelId&&<Button variant="ghost" disabled={exporting} onClick={()=>void download()}>{exporting?'正在导出…':'导出脱敏诊断包'}</Button>}{error&&<p role="alert">{error}</p>}
 </div></details>;
}
