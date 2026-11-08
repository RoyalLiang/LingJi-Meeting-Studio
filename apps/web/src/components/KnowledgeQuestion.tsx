import {useEffect,useRef,useState} from 'react';
import {ArrowUpRight,Sparkle,Stop} from '@phosphor-icons/react';
import {api,ApiError,messageOf} from '../api';
import type {KnowledgeReference} from '../model';
import {Button} from './ui';
import {FeedbackNotice} from './FeedbackNotice';
import {MarkdownPreview} from './MarkdownPreview';

type Coverage={indexedMeetings:number;usedMeetings:number;usedEntries:number;truncated:boolean};
type Evidence={recordId:string;segmentId:string;revision:number};
export type KnowledgeAnswerTask={id:string;status:string;preview:string;error?:string;stale:boolean;sources:{recordId:string;title:string;minutesRevision:number;transcriptRevision:number}[];result?:{summary:string;answers?:{text:string;evidence:Evidence[]}[];insufficientEvidence?:boolean;coverage?:Coverage}};
type Open=(id:string,reference?:KnowledgeReference)=>void;
export function KnowledgeAnswer({task,open}:{task:KnowledgeAnswerTask;open:Open}) {
 const result=task.result;
 if(!result?.answers||task.stale||task.status==='blocked')return null;
 return <div className="knowledge-answer">
  <MarkdownPreview text={result.summary}/>
  {result.answers.map((answer,index)=><article className="knowledge-answer-item" key={index}><MarkdownPreview text={answer.text}/><div className="knowledge-answer-sources">{answer.evidence.map((ref,i)=>{
   const source=task.sources.find(source=>source.recordId===ref.recordId);
   return source?<button type="button" key={`${ref.recordId}:${ref.segmentId}:${ref.revision}:${i}`} onClick={()=>open(ref.recordId,{minutesRevision:source.minutesRevision,transcriptRevision:source.transcriptRevision,evidence:[{segmentId:ref.segmentId,revision:ref.revision}]})} title={`原文片段 · v${ref.revision}`}><span>{source.title}</span><ArrowUpRight size={14}/></button>:null;
  })}</div></article>)}
  {result.insufficientEvidence&&<p className="fine-print">现有依据不足以完整回答这个问题。</p>}
  {result.coverage&&<p className="fine-print">目录收录 {result.coverage.indexedMeetings} 场会议，本次采用 {result.coverage.usedMeetings} 场相关会议的 {result.coverage.usedEntries} 条依据。{result.coverage.truncated?'还有匹配材料未纳入本次回答，可缩小问题范围继续查询。':'回答仅依据本次命中的材料。'}</p>}
 </div>;
}
const working=(task:KnowledgeAnswerTask|null)=>Boolean(task&&['queued','running','cancelling'].includes(task.status));
export function KnowledgeQuestion({scope,open,modelReady,refreshKey}:{scope:string;open:Open;modelReady:boolean;refreshKey:string}) {
 const [question,setQuestion]=useState(''),[task,setTask]=useState<KnowledgeAnswerTask|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const request=useRef<{scope:string;question:string;requestId:string}|null>(null),generation=useRef(0);
 useEffect(()=>{generation.current++;setTask(null);setError('');setNotice('');setBusy(false);request.current=null;return()=>{generation.current++;};},[scope]);
 useEffect(()=>{
  if(!task?.id)return;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  async function refresh(){try{const value=await api<KnowledgeAnswerTask>(`/agent/tasks/${task!.id}`,'GET',undefined,controller.signal);if(!controller.signal.aborted){setTask(value);timer=setTimeout(()=>void refresh(),working(value)?1000:4000);}}catch(cause){if(!controller.signal.aborted){setError(messageOf(cause));timer=setTimeout(()=>void refresh(),4000);}}}
  void refresh();return()=>{controller.abort();clearTimeout(timer);};
 },[task?.id,refreshKey]);
 async function submit(){
  if(busy||working(task)||!question.trim()||!modelReady)return;
  const current=generation.current,text=question.trim();
  if(request.current?.question!==text||request.current.scope!==scope)request.current={scope,question:text,requestId:crypto.randomUUID()};
  setBusy(true);setError('');setNotice('');
  try{const result=await api<{task:KnowledgeAnswerTask|null;summary?:string}>(`/workspaces/${scope}/knowledge/question`,'POST',request.current);if(current!==generation.current)return;setTask(result.task);setNotice(result.summary||'');request.current=null;}
  catch(cause){if(current===generation.current)setError(messageOf(cause));}finally{if(current===generation.current)setBusy(false);}
 }
 async function cancel(){if(!task||busy)return;const current=generation.current;setBusy(true);setError('');try{const value=await api<KnowledgeAnswerTask>(`/agent/tasks/${task.id}/cancel`,'POST',{});if(current===generation.current)setTask(value);}catch(cause){if(current===generation.current)setError(messageOf(cause));}finally{if(current===generation.current)setBusy(false);}}
 return <section className="knowledge-question" aria-label="向目录提问">
  <form onSubmit={event=>{event.preventDefault();void submit();}}><label htmlFor="knowledge-question">向目录提问</label><textarea id="knowledge-question" maxLength={1000} rows={2} placeholder="例如：上线负责人是谁？哪些决定仍待确认？" value={question} disabled={working(task)} onChange={event=>setQuestion(event.target.value)}/><div className="knowledge-question-actions"><span className="fine-print">{modelReady?'从相关会议中查找依据，每个回答保留原文引用。':'先在模型设置中配置分析模型。'}</span>{working(task)?<Button type="button" disabled={busy||task?.status==='cancelling'} onClick={()=>void cancel()}><Stop size={16}/>停止回答</Button>:<Button type="submit" disabled={busy||!modelReady||question.trim().length<2}><Sparkle size={16}/>{busy?'正在检索…':'查找并回答'}</Button>}</div></form>
  {error&&<FeedbackNotice message={error} error persistent inline/>}{notice&&<p role="status" className="directory-quiet">{notice}</p>}
  {task&&<div aria-live="polite">{task.error||task.stale?<FeedbackNotice error persistent inline message={task.stale?'依据已更新，请重新提问。':messageOf(new ApiError(task.error||'agent_failed',409))}/>:null}
   {working(task)&&<p className="fine-print" role="status">{task.status==='queued'?'已进入回答队列。':task.status==='cancelling'?'正在停止回答…':'正在阅读相关会议并核对依据…'}</p>}
   <KnowledgeAnswer task={task} open={open}/>
   {task.status==='cancelled'&&<p className="fine-print">回答已停止。</p>}
  </div>}
 </section>;
}
