import {useEffect,useRef,useState} from 'react';
import {Check,Plus,Trash} from '@phosphor-icons/react';
import {api,messageOf} from '../api';
import {Button,Modal} from './ui';
import {FeedbackNotice} from './FeedbackNotice';
import './SpeakerPanel.css';

type Entry={id:string;global?:boolean};
type Person={id:string;name:string;samples:number;entries:Entry[]};
type Bank={available:boolean;revision:number;people:Person[]};
export function VoiceprintDialog({close}:{scope:string;close:()=>void}){
  const [bank,setBank]=useState<Bank|null>(null),[drafts,setDrafts]=useState<Record<string,string>>({}),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[deleting,setDeleting]=useState('');
  const alive=useRef(true),createId=useRef(crypto.randomUUID());
  useEffect(()=>{alive.current=true;const controller=new AbortController();api<Bank>('/voiceprints/people','GET',undefined,controller.signal).then(setBank).catch(error=>{if(!controller.signal.aborted)setError(messageOf(error));});return()=>{alive.current=false;controller.abort();};},[]);
  const mutate=async(run:()=>Promise<unknown>,done?:()=>void)=>{setBusy(true);setError('');try{await run();const value=await api<Bank>('/voiceprints/people');if(alive.current){setBank(value);done?.();}}catch(error){if(alive.current)setError(messageOf(error));}finally{if(alive.current)setBusy(false);}};
  return <Modal title="声纹库" onClose={close}><div className="voice-library">
    {error&&<FeedbackNotice key={error} message={error} error persistent inline/>}
    <fieldset disabled={busy} className="speaker-panel-form">
      <form className="voice-person-create" onSubmit={event=>{event.preventDefault();if(name.trim())void mutate(()=>api(`/voiceprints/people/${createId.current}`,'PATCH',{name}),()=>{setName('');createId.current=crypto.randomUUID();});}}><input aria-label="新说话人名称" value={name} onChange={event=>setName(event.target.value)} maxLength={80} placeholder="姓名或称谓"/><Button disabled={!name.trim()} type="submit"><Plus size={16}/>添加说话人</Button></form>
      {bank?.people.map(person=><section className="voice-person-card" key={person.id}>
        <header><span className="speaker-person-avatar">{person.name[0]}</span><input aria-label={`${person.name} 的库中名称`} value={drafts[person.id]??person.name} maxLength={80} onChange={event=>setDrafts({...drafts,[person.id]:event.target.value})}/><span className="voice-sample-count">{person.samples} 段声音</span>{drafts[person.id]!==undefined&&drafts[person.id]!==person.name&&<Button disabled={!drafts[person.id].trim()} onClick={()=>{void mutate(()=>api(`/voiceprints/people/${person.id}`,'PATCH',{name:drafts[person.id]}),()=>setDrafts(current=>{const next={...current};delete next[person.id];return next;}));}} aria-label={`保存 ${person.name} 的库中名称`}><Check size={16}/></Button>}<Button aria-label={`删除 ${person.name}`} onClick={()=>setDeleting(person.id)}><Trash size={16}/></Button></header>
        {person.entries.map((entry,index)=><div className="voice-sample" key={entry.id}><span>{index+1}</span><audio controls preload="none" src={`/api/workspaces/all/voiceprints/clip?id=${encodeURIComponent(entry.id)}`} aria-label={`${person.name} 的声音 ${index+1}`}/>{!entry.global&&<Button onClick={()=>{void mutate(()=>api(`/workspaces/all/voiceprints/${entry.id}`,'PATCH',{consent:true,libraryRevision:bank.revision}));}}>已获同意，启用识别</Button>}</div>)}
        {deleting===person.id&&<div className="speaker-delete"><span>删除此人及所有声音？</span><Button onClick={()=>{void mutate(()=>api(`/voiceprints/people/${person.id}`,'DELETE'),()=>{setDeleting('');setDrafts(current=>{const next={...current};delete next[person.id];return next;});});}}>删除</Button><Button onClick={()=>setDeleting('')}>取消</Button></div>}
      </section>)}
    </fieldset>
    {bank&&!bank.available&&<p className="speaker-learning-state">本地声音模型未就绪，称谓仍可保存。</p>}
  </div></Modal>;
}
