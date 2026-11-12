import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Check,PencilSimple,Plus,Trash,Waveform,X} from '@phosphor-icons/react';
import {api,messageOf} from '../api';
import type {RecordDetail,Segment} from '../model';
import {Button} from './ui';
import {FeedbackNotice} from './FeedbackNotice';
import './SpeakerPanel.css';

type Person={id:string;name:string;samples:number;entries:{id:string}[]};
type Bank={available:boolean;people:Person[];jobs:{id:string;personId:string;status:string}[]};
export function SpeakerPanel({record,segment,changed,close}:{record:RecordDetail;segment:Segment;changed?:()=>void;close:()=>void}){
  const [bank,setBank]=useState<Bank|null>(null),[name,setName]=useState(segment.speaker||''),[personId,setPersonId]=useState(segment.personId||''),[query,setQuery]=useState(''),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[deleting,setDeleting]=useState(''),[renaming,setRenaming]=useState(''),[profileName,setProfileName]=useState('');
  const panel=useRef<HTMLElement>(null),input=useRef<HTMLInputElement>(null),alive=useRef(true),newPerson=useRef(crypto.randomUUID()),sample=useRef(segment),learnId=useRef(crypto.randomUUID());
  useLayoutEffect(()=>{const measure=()=>{if(panel.current)panel.current.style.setProperty('--speaker-panel-top',`${Math.max(12,panel.current.getBoundingClientRect().top)}px`);};measure();window.addEventListener('resize',measure);document.addEventListener('scroll',measure,true);return()=>{window.removeEventListener('resize',measure);document.removeEventListener('scroll',measure,true);};},[]);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;alive.current=true;input.current?.focus();const controller=new AbortController();
    const load=()=>api<Bank>('/voiceprints/people','GET',undefined,controller.signal).then(value=>{if(alive.current){setBank(value);if(value.jobs.find(job=>job.id===learnId.current)?.status==='ready')setNotice('声音已更新，将用于后续会议识别。');}}).catch(error=>{if(!controller.signal.aborted)setError(messageOf(error));});
    void load();const timer=setInterval(()=>{void load();},4000);
    return()=>{alive.current=false;controller.abort();clearInterval(timer);if(panel.current?.contains(document.activeElement))previous?.focus();};
  },[]);
  const learn=async(id:string)=>{
    const current=sample.current;
    const result=await api<{status:string}>('/voiceprints/learn','POST',{personId:id,requestId:learnId.current,recordId:record.id,segmentId:current.id,revision:current.revision,consent:true});
    if(alive.current)setNotice(result.status==='waiting'?'称谓已保存，等待可用的独立发言片段。':'称谓已保存，声音正在后台学习。');
  };
  const save=async()=>{
    setBusy(true);setError('');setNotice('');
    try{
      const id=personId||newPerson.current;
      const updated=await api<RecordDetail>(`/records/${record.id}/speakers`,'PATCH',{segmentId:sample.current.id,revision:sample.current.revision,personId:personId||undefined,requestId:newPerson.current,name});
      sample.current=updated.segments.find(value=>value.id===segment.id)!;
      learnId.current=crypto.randomUUID();
      if(alive.current){setPersonId(id);setNotice('称谓已保存。');}changed?.();
      if(consent)await learn(id);
      const value=await api<Bank>('/voiceprints/people');if(alive.current)setBank(value);
    }catch(error){if(alive.current)setError(messageOf(error));}finally{if(alive.current)setBusy(false);}
  };
  const validClip=segment.sourceId!=='text-import'&&!segment.overlappingSpeech&&segment.endMs-segment.startMs>=2000&&segment.endMs-segment.startMs<=30000;
  const clip=`/api/workspaces/all/voiceprints/clip?${new URLSearchParams({recordId:record.id,segmentId:sample.current.id,revision:String(sample.current.revision)})}`;
  const people=(bank?.people||[]).filter(person=>person.name.toLowerCase().includes(query.toLowerCase()));
  return <aside ref={panel} className="speaker-panel" aria-label="说话人标注" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();close();}}}>
    <header><h3><Waveform size={20}/>说话人</h3><Button variant="ghost" aria-label="关闭说话人标注" onClick={close}><X size={18}/></Button></header>
    <div className="speaker-panel-body"><fieldset className="speaker-panel-form" disabled={busy}>
      <blockquote>{segment.text}</blockquote>
      {validClip&&<audio controls preload="none" src={clip} aria-label="试听当前发言"/>}
      <label className="speaker-name">称谓<input ref={input} value={name} maxLength={80} onChange={event=>setName(event.target.value)} placeholder="输入姓名或称谓" onKeyDown={event=>{if(event.key==='Enter'&&name.trim()&&!busy)void save();}}/></label>
      <div className="speaker-library-heading"><h4>声纹库</h4><Button variant="ghost" aria-label="新建说话人" onClick={()=>{setPersonId('');newPerson.current=crypto.randomUUID();learnId.current=crypto.randomUUID();setName('');input.current?.focus();}}><Plus size={17}/></Button></div>
      <input className="speaker-search" aria-label="查找说话人" placeholder="查找说话人" value={query} onChange={event=>setQuery(event.target.value)}/>
      <div className="speaker-people">{people.map(person=><div className="speaker-person" data-selected={person.id===personId} key={person.id}>
        <button type="button" className="speaker-person-select" aria-pressed={person.id===personId} onClick={()=>{setPersonId(person.id);setName(person.name);learnId.current=crypto.randomUUID();}}><span className="speaker-person-avatar">{person.name[0]}</span><span><b>{person.name}</b><small>{person.samples?`${person.samples} 段声音`:'尚未学习声音'}</small></span>{person.id===personId&&<Check size={17}/>}</button>
        <Button variant="ghost" aria-label={`修改 ${person.name} 的库中名称`} onClick={()=>{setRenaming(person.id);setProfileName(person.name);}}><PencilSimple size={15}/></Button>
        <Button variant="ghost" aria-label={`删除 ${person.name}`} onClick={()=>setDeleting(person.id)}><Trash size={15}/></Button>
        {renaming===person.id&&<div className="speaker-profile-name"><label>库中名称<input value={profileName} maxLength={80} onChange={event=>setProfileName(event.target.value)}/></label><Button disabled={!profileName.trim()} onClick={async()=>{setBusy(true);try{await api(`/voiceprints/people/${person.id}`,'PATCH',{name:profileName});const value=await api<Bank>('/voiceprints/people');if(alive.current){setBank(value);setRenaming('');}}catch(error){if(alive.current)setError(messageOf(error));}finally{if(alive.current)setBusy(false);}}}>保存</Button><Button onClick={()=>setRenaming('')}>取消</Button></div>}
        {deleting===person.id&&<div className="speaker-delete"><span>删除此人及声音？</span><Button disabled={busy} onClick={async()=>{setBusy(true);try{const value=await api<Bank>(`/voiceprints/people/${person.id}`,'DELETE');if(alive.current){setBank(value);setDeleting('');if(personId===person.id)setPersonId('');}}catch(error){setError(messageOf(error));}finally{setBusy(false);}}}>删除</Button><Button onClick={()=>setDeleting('')}>取消</Button></div>}
      </div>)}</div>
      {bank?.jobs.filter(job=>job.personId===personId).slice(-1).map(job=><p className="speaker-learning-state" role="status" key={job.id}>{({queued:'等待学习',running:'正在学习声音',ready:'声音已更新',cancelled:'标注已更新，旧学习已取消',waiting:'等待独立发言片段',failed:'声音学习未完成，可重新保存重试'} as Record<string,string>)[job.status]}</p>)}
      {!bank?.available&&bank&&<p className="speaker-learning-state">本地声音模型未就绪，称谓仍可保存。</p>}
    </fieldset></div>
    <footer><label className="speaker-consent"><input type="checkbox" checked={consent} disabled={busy||!bank?.available||segment.sourceId==='text-import'} onChange={event=>{setConsent(event.target.checked);learnId.current=crypto.randomUUID();}}/>已获同意，保存声音用于后续会议识别</label>{error&&<FeedbackNotice key={error} message={error} error persistent inline/>}{notice&&<p role="status" className="speaker-learning-state">{notice}</p>}<Button variant="primary" disabled={busy||!name.trim()} onClick={()=>{void save();}}><Check size={16}/>{busy?'保存中…':'保存称谓'}</Button></footer>
  </aside>;
}
