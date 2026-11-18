import {useCallback,useEffect,useRef,useState} from 'react';
import {Check,MagnifyingGlass,PencilSimple,Plus,Trash,Waveform} from '@phosphor-icons/react';
import {api,messageOf} from '../api';
import type {RecordListItem} from '../model';
import {Button,Modal,Status} from './ui';
import {Select} from './Select';
import {FeedbackNotice} from './FeedbackNotice';
import './VoiceprintDialog.css';

type Entry={id:string;global?:boolean;recognitionDisabled?:boolean};
type Person={id:string;name:string;samples:number;entries:Entry[];recognitionEnabled?:boolean};
type Bank={available:boolean;revision:number;people:Person[];jobs:{id:string;personId:string;status:string}[]};
type Source={id:string;available:boolean;recordId?:string;title?:string;startMs?:number;endMs?:number;text?:string;audioAvailable?:boolean};
type Clip={id:string;revision:number;startMs:number;endMs:number;text:string};
type LearnInput={personId:string;requestId:string;recordId:string;segmentId:string;revision:number;consent:true};
const time=(ms=0)=>`${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}`;

function VoiceSources({person,revision,open}:{person:Person;revision:number;open?:(id:string)=>void}){
  const [sources,setSources]=useState<Source[]|null>(null),[error,setError]=useState(''),[failed,setFailed]=useState<Record<string,boolean>>({});
  const root=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const controller=new AbortController(),element=root.current;
    api<{sources:Source[]}>(`/voiceprints/people/${person.id}/sources`,'GET',undefined,controller.signal).then(value=>{if(!controller.signal.aborted)setSources(value.sources);}).catch(error=>{if(!controller.signal.aborted)setError(messageOf(error));});
    return()=>{controller.abort();element?.querySelectorAll('audio').forEach(audio=>{audio.pause();audio.removeAttribute('src');audio.load();});};
  },[person.id,revision]);
  return <div className="voice-sources" ref={root} aria-busy={!sources&&!error}>
    {error&&<FeedbackNotice message={error} error inline persistent/>}
    {!sources&&!error&&<p className="muted" role="status">正在读取声音来源…</p>}
    {sources?.map((source,index)=><article className="voice-source" key={source.id}>
      <header><strong>{source.available?source.title:'来源已不可用'}</strong><span>{source.available?`${time(source.startMs)}–${time(source.endMs)}`:`声音 ${index+1}`}</span></header>
      {source.available?<><blockquote>{source.text}</blockquote>{source.audioAvailable&&!failed[source.id]?<audio controls preload="none" src={`/api/workspaces/all/voiceprints/clip?id=${encodeURIComponent(source.id)}`} aria-label={`试听 ${person.name} 在 ${source.title} 的声音`} onError={()=>setFailed(current=>({...current,[source.id]:true}))}/>:<p className="muted">原音未保留或暂不可用</p>}{open&&source.recordId&&<Button variant="ghost" onClick={()=>open(source.recordId!)}>打开会议</Button>}</>:<p className="muted">原文已修订、过期或移除，无法用这份引用试听。</p>}
    </article>)}
    {sources?.length===0&&<p className="voice-empty">还没有声音来源。先在会议原文中确认此人的称谓，再添加已获同意的片段。</p>}
  </div>;
}

function SamplePicker({person,available,busy,save,cancel}:{person:Person;available:boolean;busy:boolean;save:(input:LearnInput)=>void;cancel:()=>void}){
  const [query,setQuery]=useState(''),[records,setRecords]=useState<RecordListItem[]>([]),[recordId,setRecordId]=useState(''),[clips,setClips]=useState<Clip[]|null>(null),[clipId,setClipId]=useState(''),[consent,setConsent]=useState(false),[error,setError]=useState('');
  const requestId=useRef(crypto.randomUUID());
  useEffect(()=>{
    const controller=new AbortController(),timer=setTimeout(()=>{api<{records:RecordListItem[]}>(`/records?workspace=all&q=${encodeURIComponent(query)}`,'GET',undefined,controller.signal).then(value=>{if(!controller.signal.aborted)setRecords(value.records);}).catch(error=>{if(!controller.signal.aborted)setError(messageOf(error));});},200);
    return()=>{clearTimeout(timer);controller.abort();};
  },[query]);
  useEffect(()=>{
    if(!recordId)return;
    const controller=new AbortController();
    api<{clips:Clip[]}>(`/voiceprints/people/${person.id}/candidates?recordId=${encodeURIComponent(recordId)}`,'GET',undefined,controller.signal).then(value=>{if(!controller.signal.aborted)setClips(value.clips);}).catch(error=>{if(!controller.signal.aborted)setError(messageOf(error));});
    return()=>controller.abort();
  },[person.id,recordId]);
  const clip=clips?.find(clip=>clip.id===clipId);
  return <form className="voice-edit-form" onSubmit={event=>{event.preventDefault();if(available&&clip&&consent&&!busy)save({personId:person.id,requestId:requestId.current,recordId,segmentId:clip.id,revision:clip.revision,consent:true});}}>
    <h3>为 {person.name} 添加声音</h3>
    <label>查找会议<input type="search" value={query} maxLength={200} placeholder="搜索会议" onChange={event=>{setQuery(event.target.value);setRecordId('');setClips(null);setClipId('');setConsent(false);}}/></label>
    <label><span>来源会议</span><Select label="声音来源会议" value={recordId} onChange={value=>{setRecordId(value);setClips(null);setClipId('');setConsent(false);setError('');requestId.current=crypto.randomUUID();}} options={[{value:'',label:'选择会议'},...records.map(record=>({value:record.id,label:record.title}))]}/></label>
    {recordId&&<label><span>已确认归属的片段</span><Select label="已确认声音片段" value={clipId} onChange={value=>{setClipId(value);setConsent(false);requestId.current=crypto.randomUUID();}} readOnly={!clips} options={[{value:'',label:clips?'选择片段':'正在读取…'},...(clips||[]).map(clip=>({value:clip.id,label:`${time(clip.startMs)}–${time(clip.endMs)} · ${clip.text}`}))]}/></label>}
    {clip&&<blockquote>{clip.text}</blockquote>}
    {recordId&&clips?.length===0&&<p className="muted">没有可用片段。请先在会议原文中将独立发言标注为此人，并保留原音；可学习片段为 2–30 秒。</p>}
    <label className="voice-consent"><input type="checkbox" checked={consent} disabled={!clip||!available} onChange={event=>setConsent(event.target.checked)}/><span>已确认归属，并已获本人同意保存此声音，用于当前账户所有工作目录的跨会议识别</span></label>
    {person.recognitionEnabled===false&&<p className="muted">此人物已停止识别，添加声音不会自动启用。</p>}
    {error&&<FeedbackNotice message={error} error inline persistent/>}
    <div className="actions"><Button type="submit" variant="primary" disabled={busy||!available||!clip||!consent}>添加片段</Button><Button type="button" onClick={cancel}>取消</Button></div>
  </form>;
}

export function VoiceprintDialog({close,open}:{scope:string;close:()=>void;open?:(id:string)=>void}){
  const [bank,setBank]=useState<Bank|null>(null),[selected,setSelected]=useState(''),[query,setQuery]=useState(''),[mode,setMode]=useState<'detail'|'new'|'rename'|'add'|'consent'|'stop'|'delete'>('detail');
  const [name,setName]=useState(''),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const alive=useRef(true),pending=useRef(false),generation=useRef(0),createId=useRef(crypto.randomUUID()),libraryRoot=useRef<HTMLDivElement>(null);
  const load=useCallback(async(signal?:AbortSignal)=>{const token=++generation.current,value=await api<Bank>('/voiceprints/people','GET',undefined,signal);if(alive.current&&token===generation.current&&!signal?.aborted)setBank(value);},[]);
  useEffect(()=>{alive.current=true;const controller=new AbortController();void load(controller.signal).catch(error=>{if(!controller.signal.aborted)setError(messageOf(error));});return()=>{alive.current=false;generation.current++;controller.abort();};},[load]);
  useEffect(()=>{if(!bank?.jobs?.some(job=>['queued','running','waiting'].includes(job.status)))return;const controller=new AbortController(),timer=setTimeout(()=>{void load(controller.signal).catch(error=>{if(!controller.signal.aborted)setError(messageOf(error));});},bank.jobs.some(job=>['queued','running'].includes(job.status))?4000:15000);return()=>{clearTimeout(timer);controller.abort();};},[bank,load]);
  const people=(bank?.people||[]).filter(person=>person.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())),person=people.find(person=>person.id===selected)||people[0];
  useEffect(()=>{setMode('detail');setConsent(false);},[person?.id]);
  const mutate=async(run:()=>Promise<unknown>,done?:()=>void)=>{
    if(pending.current)return;pending.current=true;generation.current++;setBusy(true);setError('');
    try{await run();await load();if(alive.current)done?.();}catch(error){if(alive.current){setError(messageOf(error));try{await load();}catch{/* Keep the mutation error and allow an explicit reload. */}}}finally{pending.current=false;if(alive.current)setBusy(false);}
  };
  const personJobs=bank?.jobs?.filter(job=>job.personId===person?.id)||[],activeJobs=personJobs.filter(job=>['queued','running','waiting'].includes(job.status));
  const enabled=person?.recognitionEnabled!==false&&person?.entries.some(entry=>entry.global),stoppable=person?.recognitionEnabled!==false&&(enabled||activeJobs.length>0);
  return <Modal title="人物与声音" wide className="voice-people-modal" onClose={close} headerActions={<div className="voice-header-actions"><Button disabled={busy||!bank} onClick={()=>{setName('');setMode('new');}}><Plus size={16}/>新建人物</Button></div>}>
    <div className="voice-library" ref={libraryRoot} aria-busy={busy}>
      <div className="voice-library-toolbar"><label><MagnifyingGlass size={16} aria-hidden="true"/><input type="search" aria-label="搜索人物" placeholder="搜索人物" value={query} maxLength={80} disabled={busy} onChange={event=>setQuery(event.target.value)}/></label><span>当前账户私有 · 所有工作目录</span></div>
      {error&&<FeedbackNotice key={error} message={error} error persistent inline/>}
      {!bank&&!error&&<p role="status">正在读取人物库…</p>}
      {error&&<Button disabled={busy} onClick={()=>void load().catch(error=>setError(messageOf(error)))}>重新读取</Button>}
      <fieldset disabled={busy} className="voice-library-layout">
        <nav className="voice-person-list" aria-label="人物"><span className="voice-list-count">人物 {people.length}</span>{people.map(value=><button type="button" key={value.id} aria-pressed={person?.id===value.id} onClick={()=>{setSelected(value.id);setMode('detail');}}><span className="voice-person-avatar">{value.name[0]}</span><span><strong>{value.name}</strong><small><span>{value.samples} 段声音</span><span>{value.recognitionEnabled!==false&&value.entries.some(entry=>entry.global)?'可跨会议识别':'未启用识别'}</span></small></span></button>)}{bank&&!people.length&&<p className="voice-empty">{query?'没有匹配人物':'还没有人物'}</p>}</nav>
        <section className="voice-person-detail">
          {mode==='new'?<form className="voice-edit-form" onSubmit={event=>{event.preventDefault();const id=createId.current;if(name.trim())void mutate(()=>api(`/voiceprints/people/${id}`,'PATCH',{name}),()=>{setQuery('');setSelected(id);setMode('detail');createId.current=crypto.randomUUID();});}}><h3>新建人物</h3><label>姓名或称谓<input autoFocus aria-label="新人物姓名" value={name} maxLength={80} onChange={event=>setName(event.target.value)} required/></label><div className="actions"><Button variant="primary" type="submit" disabled={!name.trim()}>创建人物</Button><Button type="button" onClick={()=>setMode('detail')}>取消</Button></div></form>:!person?<p className="voice-empty">{query?'换个名字再试试。':'先新建人物，再从已确认的会议片段添加声音。'}</p>:<>
            <header className="voice-person-heading"><div><span className="voice-person-avatar">{person.name[0]}</span><div><h3>{person.name}</h3><p>{person.samples} 段声音</p></div></div><div className="actions"><Button onClick={()=>{setName(person.name);setMode('rename');}}><PencilSimple size={15}/>改名</Button><Button onClick={()=>setMode('add')} disabled={!bank?.available}><Plus size={15}/>添加已确认片段</Button></div></header>
            {mode==='rename'&&<form className="voice-edit-form" onSubmit={event=>{event.preventDefault();if(name.trim())void mutate(()=>api(`/voiceprints/people/${person.id}`,'PATCH',{name}),()=>{setQuery('');setSelected(person.id);setMode('detail');});}}><label>库中姓名<input autoFocus aria-label="库中姓名" value={name} maxLength={80} required onChange={event=>setName(event.target.value)}/></label><div className="actions"><Button variant="primary" type="submit" disabled={!name.trim()}><Check size={15}/>保存姓名</Button><Button type="button" onClick={()=>setMode('detail')}>取消</Button></div></form>}
            {mode==='add'?<SamplePicker key={person.id} person={person} available={Boolean(bank?.available)} busy={busy} save={input=>void mutate(()=>api('/voiceprints/learn','POST',input),()=>setMode('detail'))} cancel={()=>setMode('detail')}/>:<div className="voice-person-columns"><section><div className="voice-section-heading"><h4><Waveform size={17}/>声音来源</h4><span>保留原文与时间</span></div><VoiceSources key={`${person.id}:${bank?.revision}`} person={person} revision={bank?.revision||0} open={open}/></section>
              <aside className="voice-recognition"><h4>跨会议识别</h4><Status tone={enabled?'success':''}>{enabled?'已启用':person.recognitionEnabled===false?'已停止':stoppable?'等待声音':'尚未启用'}</Status><p>{stoppable?'已授权声音会在就绪后参与当前账户的跨会议匹配。':'人物与历史称谓保留，声音匹配需另行授权。'}</p><Button disabled={!person.samples&&!stoppable} onClick={()=>{setConsent(false);setMode(stoppable?'stop':'consent');}}>{stoppable?'停止使用':'授权启用'}</Button>
                {(mode==='consent'||mode==='stop')&&<div className="voice-confirm"><p>{mode==='stop'?'停止后保留人物、声音来源与人工称谓；新的学习任务也不会自动重新启用识别。':'将这些声音用于当前账户所有工作目录的匹配。'}</p>{mode==='consent'&&<label className="voice-consent"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/><span>已获本人对此范围的同意</span></label>}<div className="actions"><Button disabled={mode==='consent'&&!consent} onClick={()=>void mutate(()=>api(`/voiceprints/people/${person.id}/recognition`,'PATCH',{enabled:mode==='consent',consent:mode==='consent'&&consent,libraryRevision:bank?.revision}),()=>setMode('detail'))}>{mode==='stop'?'确认停止':'确认授权'}</Button><Button variant="ghost" onClick={()=>setMode('detail')}>取消</Button></div></div>}
                <p className="voice-priority">人工标注优先，自动结果不覆盖已确认称谓。</p><Button variant="ghost" onClick={()=>setMode('delete')}><Trash size={15}/>删除人物</Button>
                {mode==='delete'&&<div className="voice-confirm"><p>删除此人及全部声音样本？会议中已确认的称谓保留。</p><div className="actions"><Button variant="danger" onClick={()=>{libraryRoot.current?.querySelectorAll('audio').forEach(audio=>audio.pause());void mutate(()=>api(`/voiceprints/people/${person.id}`,'DELETE'),()=>setMode('detail'));}}>确认删除</Button><Button type="button" onClick={()=>setMode('detail')}>取消</Button></div></div>}
              </aside></div>}
            {activeJobs.length>0&&<p className="voice-job" role="status">{activeJobs.every(job=>job.status==='waiting')?'声音学习等待合适的独立片段。':'声音正在后台学习…'}</p>}{personJobs.at(-1)?.status==='failed'&&<p className="voice-job" role="status">声音学习未完成，请重新核对原音后添加。</p>}
          </>}
          {bank&&!bank.available&&<p className="voice-model-state">本地声音模型未就绪；人物和称谓仍可管理。</p>}
        </section>
      </fieldset>
    </div>
  </Modal>;
}
