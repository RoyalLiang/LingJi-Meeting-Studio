import { useEffect, useRef, useState } from 'react';
import { ArrowClockwise, ArrowRight, ArrowUpRight, CalendarBlank, CaretRight, Check, FileText, Plus, ShieldCheck, Sparkle, Stack, Stop, WarningCircle } from '@phosphor-icons/react';
import { api, ApiError } from '../api';
import type { RecordListItem } from '../model';
import { Button, Modal } from './ui';
import { Select } from './Select';
import './MeetingAgentCenter.css';

type View = 'skills' | 'plugins' | 'runs' | 'schedule' | 'assistant';
type TaskStatus = 'queued' | 'running' | 'blocked' | 'cancelling' | 'cancelled' | 'completed' | 'failed';
type Evidence = { recordId:string; segmentId:string; revision:number };
type Task = {
  id:string; requestId:string; status:TaskStatus; createdAt:string; updatedAt:string; prompt:string;
  skill:{id:'meeting-review';version:'1.0.0'};
  sources:{recordId:string;title:string;transcriptRevision:number;minutesRevision:number}[];
  preview:string; result?:{summary:string;decisions:{text:string;evidence:Evidence[]}[];actions:{text:string;owner?:string;evidence:Evidence[]}[]};
  error?:string; stale:boolean;
};
type RequestBody = { recordIds:string[]; prompt:string; requestId:string; scopeConfirmed:true };
type Submission = { body:RequestBody; attempted:boolean; conflict:boolean };
type Drawer = { kind:'skill'|'plugin'|'sources'|'confirm'|'task'; id?:string };
const navigation:{id:View;label:string}[] = [
  {id:'skills',label:'Skills'},{id:'plugins',label:'插件'},{id:'runs',label:'运行任务'},{id:'schedule',label:'自动化'},{id:'assistant',label:'会议助手'},
];
const labels:Record<TaskStatus,string> = {queued:'排队中',running:'整理中',blocked:'等待处理',cancelling:'正在取消',cancelled:'已取消',completed:'已完成',failed:'失败'};
const working = (task:Task) => ['queued','running','cancelling'].includes(task.status);
const safeMessages:Record<string,string> = {
  agent_scope_required:'请确认会议读取范围及模型发送授权。',
  invalid_agent_request:'请检查会议范围与整理目标，最多选择 8 场会议，目标不超过 2000 字。',
  agent_scope_denied:'无权读取所选会议，请重新选择可访问的会议。',
  agent_source_unavailable:'所选会议资料已不可用，请重新核对会议范围。',
  agent_input_too_large:'所选会议文字超出本次处理上限，请减少会议数量后重新确认。',
  agent_request_conflict:'此请求标识已对应其他内容。请核对任务列表；本次不会另建请求。',
  minutes_not_configured:'纪要模型尚未配置，请先在模型设置中完成配置。',
  agent_failed:'本次整理未完成，请检查任务状态后重试。',
  invalid_agent_output:'模型结果未通过校验，本次没有保存为有效结果。',
  agent_timeout:'整理超时，请核对任务状态后重试。',
  agent_runtime_busy:'运行底座正被另一进程使用，请关闭重复实例后重试。',
  agent_storage_upgrade_required:'此目录含旧实验任务数据，请在处理旧数据后重启。',
  agent_storage_unavailable:'任务存储暂不可用，请稍后重试。',
};
function safeError(error:unknown) {
  const code = typeof error === 'string' ? error : error instanceof ApiError ? error.code : '';
  if (safeMessages[code]) return safeMessages[code];
  if (error instanceof ApiError) {
    if (error.status === 401) return '登录已失效，请重新登录。';
    if (error.status === 403) return '没有执行此操作的权限。';
    if (error.status === 404) return '任务不存在或已不可访问，请刷新列表。';
    if (error.status === 429) return '请求较多，请稍后重试。';
  }
  return '服务暂时不可用，操作结果尚未确认。请刷新核对或使用原请求重试。';
}
function checkedTask(value:Task):Task {
  if (!value || typeof value.id !== 'string' || typeof value.requestId !== 'string' || !Object.hasOwn(labels,value.status) ||
      typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || typeof value.stale !== 'boolean' ||
      value.skill?.id !== 'meeting-review' || value.skill?.version !== '1.0.0' || typeof value.prompt !== 'string' || typeof value.preview !== 'string' || !Array.isArray(value.sources) ||
      !value.sources.every(source => source && typeof source.recordId === 'string' && typeof source.title === 'string' && Number.isInteger(source.transcriptRevision) && Number.isInteger(source.minutesRevision))) throw new ApiError('invalid_response',502);
  if (value.result && (typeof value.result.summary !== 'string' || !Array.isArray(value.result.decisions) || !Array.isArray(value.result.actions) ||
      ![...value.result.decisions,...value.result.actions].every(item => item && typeof item.text === 'string' && Array.isArray(item.evidence) && item.evidence.every(evidence =>
        evidence && typeof evidence.recordId === 'string' && value.sources.some(source=>source.recordId===evidence.recordId) && typeof evidence.segmentId === 'string' && Number.isInteger(evidence.revision))))) throw new ApiError('invalid_response',502);
  return value;
}
function sameRequest(task:Task,body:RequestBody) {
  const ids=task.sources.map(source=>source.recordId).sort(),selected=[...body.recordIds].sort();
  return task.prompt===body.prompt && ids.length===selected.length && ids.every((id,index)=>id===selected[index]);
}
function when(value:string) {
  const date=new Date(value);
  return Number.isNaN(date.valueOf())?'时间未知':date.toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
}
function EvidenceLinks({items,task,open}:{items:Evidence[];task:Task;open:(id:string)=>void}) {
  return <div className="ma-evidence">{items.map((item,index)=><button type="button" key={`${item.recordId}:${item.segmentId}:${item.revision}:${index}`} onClick={()=>open(item.recordId)} title={`片段 ${item.segmentId} · 转录 v${item.revision}`} aria-label={`${task.sources.find(source=>source.recordId===item.recordId)?.title||'来源会议'} · 原文引用 · 转录 v${item.revision} · 片段 ${item.segmentId}`}><FileText size={12}/><span>{task.sources.find(source=>source.recordId===item.recordId)?.title||'来源会议'} · 原文引用 · v{item.revision}</span><ArrowUpRight size={12}/></button>)}</div>;
}
function TaskContent({task,open}:{task:Task;open:(id:string)=>void}) {
  return <>
    <div className="ma-task-state"><span className={`ma-state ${task.status}`}>{labels[task.status]}</span><span>会议复盘 v1.0.0 · {task.sources.length} 场会议</span></div>
    {task.stale&&<p className="ma-notice warning"><WarningCircle size={16}/>会议内容已有更新，此处保留运行时引用的版本。</p>}
    {task.error&&<p className="ma-notice error" role="alert"><WarningCircle size={16}/>{safeError(task.error)}</p>}
    <section><h3>整理目标</h3><p className="ma-preserve">{task.prompt}</p></section>
    <section><h3>会议范围</h3><div className="ma-sources">{task.sources.map(source=><button type="button" key={source.recordId} onClick={()=>open(source.recordId)}><FileText size={15}/><span>{source.title}<small>转录 v{source.transcriptRevision} · 纪要 v{source.minutesRevision}</small></span><ArrowUpRight size={13}/></button>)}</div></section>
    {task.result?<section className="ma-result"><h3>独立整理结果</h3><p className="ma-preserve">{task.result.summary}</p><h4>决策</h4>{task.result.decisions.length?task.result.decisions.map((item,index)=><article key={index}><p>{item.text}</p><EvidenceLinks items={item.evidence} task={task} open={open}/></article>):<p className="ma-muted">本次没有形成决策条目。</p>}<h4>行动候选</h4>{task.result.actions.length?task.result.actions.map((item,index)=><article key={index}><p>{item.text}{item.owner&&<span className="ma-owner"> · {item.owner}</span>}</p><EvidenceLinks items={item.evidence} task={task} open={open}/></article>):<p className="ma-muted">本次没有形成行动候选。</p>}<p className="ma-result-note">结果独立保存，行动候选待人工确认。</p></section>:
      task.preview?<section><h3>{working(task)?'正在生成草稿':'未完成的草稿'}</h3><p className="ma-preview ma-preserve">{task.preview}</p></section>:
      <p className="ma-empty-inline" role="status">{task.status==='queued'?'任务已进入队列。':task.status==='running'?'正在读取会议文字，等待首段结果…':task.status==='cancelling'?'已请求取消，等待服务确认…':task.status==='cancelled'?'任务已取消，没有生成有效结果。':task.status==='completed'?'任务已完成，但服务未返回可展示结果，请刷新核对。':task.status==='blocked'?'任务等待处理，请查看提示后重新确认。':'本次没有生成有效结果。'}</p>}
  </>;
}
export default function MeetingAgentCenter({records,openRecord}:{records:RecordListItem[];openRecord:(id:string)=>void}) {
  const [view,setView]=useState<View>('skills'),[drawer,setDrawer]=useState<Drawer|null>(null);
  const [tasks,setTasks]=useState<Task[]>([]),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState(''),[detailError,setDetailError]=useState('');
  const [filter,setFilter]=useState('all'),[activeId,setActiveId]=useState(''),[refresh,setRefresh]=useState(0);
  const [selected,setSelected]=useState<string[]>([]),[draftSelected,setDraftSelected]=useState<string[]>([]),[prompt,setPrompt]=useState('');
  const [pending,setPendingState]=useState<Submission|null>(null),[confirmed,setConfirmed]=useState(false),[posting,setPosting]=useState(false),[submitError,setSubmitError]=useState(''),[cancelling,setCancelling]=useState('');
  const pendingRef=useRef<Submission|null>(null),tasksRef=useRef<Task[]>([]),mounted=useRef(true),mutation=useRef<AbortController|null>(null),detailRequest=useRef<AbortController|null>(null);
  const chosen=records.filter(record=>selected.includes(record.id)),active=tasks.find(task=>task.id===(drawer?.kind==='task'?drawer.id:activeId));
  const available=records.filter(record=>record.capture!=='recording'&&record.segments>0);
  function setPending(next:Submission|null) { pendingRef.current=next;setPendingState(next); }
  function storeTasks(next:Task[]) { tasksRef.current=next;setTasks(next); }
  function upsert(task:Task) { storeTasks([task,...tasksRef.current.filter(item=>item.id!==task.id)].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))); }
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;mutation.current?.abort();detailRequest.current?.abort();};},[]);
  useEffect(()=>{
    if (pendingRef.current) return;
    setSelected(ids=>ids.filter(id=>records.some(record=>record.id===id&&record.capture!=='recording'&&record.segments>0)));
  },[records]);
  useEffect(()=>{
    let stopped=false,timer:ReturnType<typeof setTimeout>,controller:AbortController|null=null,failures=0;
    async function poll() {
      if (document.visibilityState==='hidden') {timer=setTimeout(()=>void poll(),30000);return;}
      controller=new AbortController();
      try {
        const data=await api<{tasks:Task[]}>('/agent/tasks','GET',undefined,controller.signal);
        if (!Array.isArray(data.tasks)) throw new ApiError('invalid_response',502);
        const next=data.tasks.map(checkedTask).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
        if (stopped) return;
        storeTasks(next);setLoading(false);setLoadError('');failures=0;
        const submission=pendingRef.current,existing=submission?.attempted?next.find(task=>task.requestId===submission.body.requestId):undefined;
        if (submission&&existing) {
          if (sameRequest(existing,submission.body)) {setActiveId(existing.id);setPending(null);setSubmitError('');setDrawer(current=>current?.kind==='confirm'?null:current);}
          else {setSubmitError(safeMessages.agent_request_conflict);setPending({...submission,conflict:true});}
        }
      } catch(error) {
        if (!stopped) {setLoading(false);setLoadError(safeError(error));failures++;}
      }
      if (!stopped) timer=setTimeout(()=>void poll(),failures?Math.min(30000,2000*2**Math.min(failures,4)):tasksRef.current.some(working)?1000:15000);
    }
    void poll();
    return()=>{stopped=true;clearTimeout(timer);controller?.abort();};
  },[refresh]);
  function navigate(next:View) { setView(next);setDrawer(null);setDetailError('');setFilter('all'); }
  function showSources() {setDraftSelected(selected);setDrawer({kind:'sources'});}
  async function showTask(id:string) {
    detailRequest.current?.abort();const controller=new AbortController();detailRequest.current=controller;
    setActiveId(id);setDetailError('');setDrawer({kind:'task',id});
    try {const task=checkedTask(await api<Task>(`/agent/tasks/${encodeURIComponent(id)}`,'GET',undefined,controller.signal));if(mounted.current&&!controller.signal.aborted)upsert(task);}
    catch(error){if(mounted.current&&!controller.signal.aborted)setDetailError(safeError(error));}
  }
  function prepare() {
    setSubmitError('');
    if (!pending) {
      if (!chosen.length||chosen.length>8||prompt.trim().length<1||prompt.trim().length>2000) return;
      if (!globalThis.crypto?.randomUUID) {setSubmitError('当前环境无法生成安全请求标识，请在受支持的浏览器或客户端中重试。');return;}
      setPending({body:{recordIds:chosen.map(record=>record.id),prompt:prompt.trim(),requestId:crypto.randomUUID(),scopeConfirmed:true},attempted:false,conflict:false});
      setConfirmed(false);
    }
    setDrawer({kind:'confirm'});
  }
  async function submit() {
    const submission=pendingRef.current;
    if (!submission||!confirmed||posting||submission.conflict) return;
    const controller=new AbortController();mutation.current=controller;setPosting(true);setSubmitError('');setPending({...submission,attempted:true});
    try {
      const task=checkedTask(await api<Task>('/agent/tasks','POST',submission.body,controller.signal));
      if (!mounted.current) return;
      if(task.requestId!==submission.body.requestId||!sameRequest(task,submission.body))throw new ApiError('agent_request_conflict',409);
      upsert(task);setActiveId(task.id);setPending(null);setDrawer(null);setView('assistant');setRefresh(value=>value+1);
    } catch(error) {
      if(mounted.current&&!controller.signal.aborted&&pendingRef.current?.body.requestId===submission.body.requestId){setSubmitError(safeError(error));if(error instanceof ApiError&&error.code==='agent_request_conflict')setPending({...submission,attempted:true,conflict:true});}
    } finally {if(mounted.current)setPosting(false);if(mutation.current===controller)mutation.current=null;}
  }
  async function cancel(task:Task) {
    if(cancelling||!['queued','running','blocked'].includes(task.status))return;
    setCancelling(task.id);setDetailError('');
    try{const next=checkedTask(await api<Task>(`/agent/tasks/${encodeURIComponent(task.id)}/cancel`,'POST',{}));if(mounted.current){upsert(next);setRefresh(value=>value+1);}}
    catch(error){if(mounted.current)setDetailError(safeError(error));}
    finally{if(mounted.current)setCancelling('');}
  }
  const visible=tasks.filter(task=>filter==='all'||(filter==='active'?working(task):filter==='attention'?['blocked','failed'].includes(task.status):task.status==='completed'));
  const drawerTitle=drawer?.kind==='skill'?'会议复盘':drawer?.kind==='plugin'?'会议资料':drawer?.kind==='sources'?'选择会议':drawer?.kind==='confirm'?'确认运行':'任务详情';
  const pendingTitles=pending?.body.recordIds.map(id=>({id,title:records.find(record=>record.id===id)?.title||'所选会议'}))||[];
  return <section className="meeting-agent-center" aria-label="扩展中心">
    <header className="ma-heading"><h1>扩展中心</h1>{view==='runs'&&<Button onClick={()=>navigate('assistant')}><Plus size={16}/>新建任务</Button>}</header>
    <nav className="ma-navigation" aria-label="扩展中心导航">{navigation.map(item=><button type="button" key={item.id} aria-current={view===item.id?'page':undefined} onClick={()=>navigate(item.id)}>{item.label}</button>)}</nav>
    {view==='skills'&&<><div className="ma-toolbar"><h2>内置 Skill <span>1</span></h2></div><article className="ma-capability"><div className="ma-icon"><Stack size={22}/></div><button type="button" className="ma-item-name" onClick={()=>setDrawer({kind:'skill'})}><strong>会议复盘</strong><span>整理会议共识、决策与行动候选，保留来源引用。</span></button><span className="ma-muted">v1.0.0</span><span className="ma-state">内置</span><Button variant="ghost" aria-label="查看会议复盘" onClick={()=>setDrawer({kind:'skill'})}><CaretRight size={17}/></Button></article></>}
    {view==='plugins'&&<><div className="ma-toolbar"><h2>内置工具 <span>1</span></h2></div><article className="ma-capability"><div className="ma-icon"><FileText size={22}/></div><button type="button" className="ma-item-name" onClick={()=>setDrawer({kind:'plugin'})}><strong>会议资料</strong><span>只读本次选择的会议文字与来源引用。</span></button><span className="ma-muted">聆记</span><span className="ma-state">按任务授权</span><Button variant="ghost" aria-label="查看会议资料工具" onClick={()=>setDrawer({kind:'plugin'})}><CaretRight size={17}/></Button></article><div className="ma-permission"><ShieldCheck size={20}/><div><strong>运行前确认会议范围</strong><p>不读取其他会议，不修改纪要，不对外写入。</p></div></div></>}
    {view==='schedule'&&<div className="ma-empty"><CalendarBlank size={30}/><h2>自动化尚未接入</h2><p>当前可在会议助手中手动发起任务。</p><Button onClick={()=>navigate('assistant')}>打开会议助手<ArrowRight size={15}/></Button></div>}
    {view==='runs'&&<>
      <div className="ma-run-summary">{[{name:'进行中',count:tasks.filter(working).length},{name:'等待处理',count:tasks.filter(task=>['blocked','failed'].includes(task.status)).length},{name:'已完成',count:tasks.filter(task=>task.status==='completed').length}].map(item=><div key={item.name}><span>{item.name}</span><strong>{loading?'—':item.count}</strong></div>)}</div>
      <div className="ma-toolbar"><h2>全部任务 <span>{loading?'':tasks.length}</span></h2><div className="ma-tools"><Select label="筛选任务状态" value={filter} onChange={setFilter} options={[{value:'all',label:'全部状态'},{value:'active',label:'进行中'},{value:'attention',label:'等待处理'},{value:'completed',label:'已完成'}]}/><Button variant="ghost" aria-label="刷新任务" onClick={()=>setRefresh(value=>value+1)}><ArrowClockwise size={16}/></Button></div></div>
      {loadError&&<p className="ma-notice error" role="alert"><WarningCircle size={16}/>{loadError}<Button onClick={()=>setRefresh(value=>value+1)}>重试</Button></p>}
      {loading?<div className="ma-empty" role="status">正在加载任务…</div>:!visible.length?<div className="ma-empty"><Stack size={30}/><h2>{tasks.length?'没有匹配的任务':loadError?'暂时无法读取任务':'还没有运行任务'}</h2><p>{loadError?'恢复连接后刷新列表。':'选择会议和整理目标，开始第一次复盘。'}</p>{!loadError&&<Button onClick={()=>navigate('assistant')}>新建任务<ArrowRight size={15}/></Button>}</div>:<div className="ma-run-table"><div className="ma-table-head"><span>任务</span><span>状态</span><span>会议范围</span><span>更新时间</span><span/></div>{visible.map(task=><button type="button" className="ma-run-row" key={task.id} onClick={()=>void showTask(task.id)}><div><strong>{task.prompt}</strong><span>会议复盘 · v1.0.0{task.stale?' · 来源已更新':''}</span></div><span className={`ma-state ${task.status}`}>{labels[task.status]}</span><span>{task.sources.length} 场会议</span><time dateTime={task.updatedAt}>{when(task.updatedAt)}</time><CaretRight size={16}/></button>)}</div>}
    </>}
    {view==='assistant'&&<div className="ma-assistant">
      <div className="ma-assistant-start"><div className="ma-assistant-mark"><Sparkle size={28}/></div><h2>从讨论到下一步</h2><p>选择会议，整理你关心的内容。</p></div>
      <form className="ma-composer" onSubmit={event=>{event.preventDefault();prepare();}}><div className="ma-composer-tools"><Button type="button" disabled={Boolean(pending)} onClick={showSources}><FileText size={16}/>{chosen.length?`${chosen.length} 场会议`:'选择会议'}<CaretRight size={14}/></Button><Select label="使用 Skill" value="meeting-review" readOnly options={[{value:'meeting-review',label:'会议复盘'}]}/></div><textarea aria-label="整理目标" maxLength={2000} placeholder="希望从这些会议中整理什么？" value={prompt} disabled={Boolean(pending)} onChange={event=>setPrompt(event.target.value)}/><div className="ma-composer-bottom"><span>{pending?'保留上次确认的会议与目标':`只读会议文字 · ${prompt.length}/2000`}</span><Button variant="primary" type="submit" disabled={posting||(!pending&&(!chosen.length||chosen.length>8||!prompt.trim()))}>{pending?'继续确认':'确认运行'}<ArrowRight size={16}/></Button></div></form>
      {!available.length&&<p className="ma-empty-inline">当前目录暂无可读取的会议文字。请先完成一场会议的转录。</p>}
      {!!chosen.length&&<div className="ma-selected-sources">{chosen.map(record=><button type="button" key={record.id} onClick={()=>openRecord(record.id)}><FileText size={13}/>{record.title}<ArrowUpRight size={12}/></button>)}</div>}
      {submitError&&<p className="ma-notice error" role="alert"><WarningCircle size={16}/>{submitError}</p>}
      {active&&<div className="ma-active-task"><div className="ma-result-heading"><h2>当前任务</h2><Button variant="ghost" onClick={()=>void showTask(active.id)}>查看详情<CaretRight size={15}/></Button></div>{detailError&&<p className="ma-notice error" role="alert">{detailError}</p>}<TaskContent task={active} open={openRecord}/>{['queued','running','blocked'].includes(active.status)&&<div className="ma-task-actions"><Button disabled={Boolean(cancelling)} onClick={()=>void cancel(active)}><Stop size={14}/>{cancelling===active.id?'正在请求取消…':'取消任务'}</Button></div>}</div>}
    </div>}
    {drawer&&<div className="ma-layer"><Modal title={drawerTitle} explicitCloseOnly={posting} onClose={()=>{if(!posting)setDrawer(null);}}>
      <div className="ma-drawer-content">
        {drawer.kind==='skill'&&<><div className="ma-identity"><div className="ma-icon"><Stack size={24}/></div><div><strong>会议复盘</strong><span>v1.0.0 · 聆记内置</span></div></div><section><h3>能力</h3><p>基于所选会议文字整理共识、决策与行动候选；结论保留来源引用。</p></section><section><h3>权限</h3><ul className="ma-check-list"><li><Check size={15}/>只读本次选择的会议文字</li><li><Check size={15}/>发送到已配置的纪要模型</li><li><Check size={15}/>保存独立结果，不回写纪要</li></ul></section></>}
        {drawer.kind==='plugin'&&<><div className="ma-identity"><div className="ma-icon"><FileText size={24}/></div><div><strong>会议资料</strong><span>聆记内置 · 只读工具</span></div></div><section><h3>读取范围</h3><p>仅限当前账户在任务中选择的会议转录、纪要文字及来源引用。</p></section><section><h3>能力边界</h3><p>不读取原始音频，不访问其他会议，不修改纪要，不对外写入。</p></section></>}
        {drawer.kind==='sources'&&<><p className="ma-muted">选择 1–8 场已有转录的会议。</p><div className="ma-source-list">{records.map(record=>{const disabled=record.capture==='recording'||record.segments===0||(!draftSelected.includes(record.id)&&draftSelected.length>=8);return <label key={record.id} className={disabled?'is-disabled':''}><input type="checkbox" disabled={disabled} checked={draftSelected.includes(record.id)} onChange={()=>setDraftSelected(ids=>ids.includes(record.id)?ids.filter(id=>id!==record.id):[...ids,record.id])}/><FileText size={18}/><span><strong>{record.title}</strong><small>{record.capture==='recording'?'正在记录，完成后可选':record.segments?`${record.segments} 段转录 · ${record.hasMinutes?'已有纪要':'尚无纪要'}`:'尚无转录文字'}</small></span></label>;})}</div>{!records.length&&<div className="ma-empty">当前目录没有会议</div>}</>}
        {drawer.kind==='confirm'&&pending&&<><section><h3>整理目标</h3><p className="ma-preserve">{pending.body.prompt}</p></section><section><h3>会议范围 <span>{pendingTitles.length}</span></h3><div className="ma-confirm-sources">{pendingTitles.map(record=><div key={record.id}><FileText size={16}/>{record.title}</div>)}</div></section><section><h3>使用能力</h3><dl className="ma-properties"><div><dt>Skill</dt><dd>会议复盘 v1.0.0</dd></div><div><dt>读取</dt><dd>所选会议文字与引用</dd></div><div><dt>模型</dt><dd>已配置的纪要模型</dd></div><div><dt>输出</dt><dd>独立结果，不改纪要、不外发</dd></div></dl></section><label className="ma-consent"><input type="checkbox" checked={confirmed} disabled={posting||pending.attempted} onChange={event=>setConfirmed(event.target.checked)}/><span>确认只读以上会议文字，并发送到已配置的纪要模型进行整理。</span></label>{submitError&&<p className="ma-notice error" role="alert"><WarningCircle size={16}/>{submitError}</p>}{pending.attempted&&<p className="ma-muted ma-retry-note">重试会复用同一请求。放弃重试不会取消服务端可能已收到的任务；请先核对运行任务，避免重复运行。</p>}</>}
        {drawer.kind==='task'&&<>{detailError&&<p className="ma-notice error" role="alert"><WarningCircle size={16}/>{detailError}</p>}{active?<TaskContent task={active} open={openRecord}/>:!detailError&&<p className="ma-empty-inline" role="status">正在读取任务…</p>}</>}
      </div>
      <div className="ma-drawer-footer">
        {['skill','plugin'].includes(drawer.kind)&&<Button variant="primary" onClick={()=>navigate('assistant')}>在会议助手中使用<ArrowRight size={15}/></Button>}
        {drawer.kind==='sources'&&<><span className="ma-muted">已选 {draftSelected.length}/8 场</span><Button variant="primary" disabled={!draftSelected.length} onClick={()=>{setSelected(draftSelected);setDrawer(null);}}>确认选择</Button></>}
        {drawer.kind==='confirm'&&pending&&<>{pending.attempted?<Button disabled={posting} onClick={()=>{setPending(null);setConfirmed(false);setSubmitError('');setDrawer(null);}}>放弃重试并编辑</Button>:<Button disabled={posting} onClick={()=>{setPending(null);setConfirmed(false);setDrawer(null);}}>返回编辑</Button>}<Button variant="primary" disabled={!confirmed||posting||pending.conflict} onClick={()=>void submit()}>{posting?'正在提交…':pending.attempted?'使用原请求重试':'确认并开始'}</Button></>}
        {drawer.kind==='task'&&active&&<><Button onClick={()=>{setRefresh(value=>value+1);void showTask(active.id);}}>刷新任务</Button>{['queued','running','blocked'].includes(active.status)&&<Button disabled={Boolean(cancelling)} onClick={()=>void cancel(active)}><Stop size={14}/>{cancelling===active.id?'正在请求取消…':'取消任务'}</Button>}</>}
      </div>
    </Modal></div>}
  </section>;
}
