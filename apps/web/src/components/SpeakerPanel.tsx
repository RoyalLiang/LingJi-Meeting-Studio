import { useEffect, useId, useRef, useState } from 'react';
import { Check, MagnifyingGlass, Plus, X } from '@phosphor-icons/react';
import { api, messageOf } from '../api';
import type { RecordDetail, Segment } from '../model';
import { Button } from './ui';
import { FeedbackNotice } from './FeedbackNotice';
import './SpeakerPanel.css';

type Person = { id: string; name: string; samples: number; automaticLearning?: boolean };
type Job = { id: string; status: string };
type Bank = { available: boolean; people: Person[]; jobs: Job[] };
const jobMessages: Record<string,string> = {
  queued: '声音已排队学习。', running: '声音正在后台学习。', waiting: '等待可用的独立发言。',
  ready: '声音已更新。', failed: '声音学习未完成，可重新核对片段后重试。', cancelled: '片段已变化，学习已取消。',
};

export function SpeakerPanel({recordId,segment,playable,unavailable,onSaved,close}: {
  recordId: string; segment: Segment; playable: boolean; unavailable: string; onSaved: (before: Segment, after: Segment) => void; close: () => void;
}) {
  const [bank,setBank] = useState<Bank|null>(null), [name,setName] = useState(segment.speaker||'');
  const [choice,setChoice] = useState(segment.personId||''), [query,setQuery] = useState('');
  const [searching,setSearching] = useState(false), [consent,setConsent] = useState(false), [busy,setBusy] = useState(false);
  const [error,setError] = useState(''), [libraryError,setLibraryError] = useState(''), [notice,setNotice] = useState(''), [job,setJob] = useState<Job|null>(null);
  const sample = useRef(segment), input = useRef<HTMLInputElement>(null), alive = useRef(false), pending = useRef(false);
  const nameId=useId();
  const personRequest = useRef(crypto.randomUUID()), learnRequest = useRef(crypto.randomUUID());
  useEffect(() => {
    const controller = new AbortController();
    alive.current = true;
    input.current?.focus({preventScroll:true});
    void api<Bank>('/voiceprints/people','GET',undefined,controller.signal).then(value=>{if(!controller.signal.aborted)setBank(value);}).catch(error=>{
      if(!controller.signal.aborted)setLibraryError(messageOf(error));
    });
    return () => {alive.current=false;controller.abort();};
  }, []);
  useEffect(() => {
    if(!job||!['queued','running','waiting'].includes(job.status))return;
    const controller=new AbortController();
    const timer=setTimeout(()=>void api<Bank>('/voiceprints/people','GET',undefined,controller.signal).then(value=>{
      if(controller.signal.aborted)return;
      setBank(value);
      setJob(value.jobs.find(row=>row.id===job.id)||job);
    }).catch(()=>{if(!controller.signal.aborted)setJob({...job});}),4000);
    return ()=>{clearTimeout(timer);controller.abort();};
  },[job]);

  const duration=segment.endMs-segment.startMs;
  const learningBlock= !playable ? unavailable :
    segment.overlappingSpeech ? '重叠发言暂不可学习' :
    duration<2000 ? '学习至少需要 2 秒原音' :
    duration>30000 ? '学习最多使用 30 秒原音' : '';
  const canLearn=Boolean(choice&&bank?.available&&!learningBlock);
  const selected=bank?.people.find(person=>person.id===choice);
  const people=(bank?.people||[]).filter(person=>person.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const choices=searching?people:[...(selected?[selected]:[]),...people.filter(person=>person.id!==choice)].slice(0,3);
  const resetLearning=()=>{setConsent(false);setJob(null);learnRequest.current=crypto.randomUUID();};
  const choose=(id:string,personName?:string)=>{
    setChoice(choice===id?'':id);
    if(choice!==id&&personName)setName(personName);
    resetLearning();
  };

  const save=async(learn:boolean)=>{
    if(pending.current||!name.trim()||learn&&(!canLearn||!consent))return;
    pending.current=true;setBusy(true);setError('');setNotice('');setJob(null);
    try{
      const current=sample.current;
      const personId=choice&&choice!=='new'?choice:undefined;
      const create=learn&&choice==='new';
      const updated=await api<RecordDetail>(`/records/${recordId}/speakers`,'PATCH',{
        segmentId:current.id,revision:current.revision,name,personId,
        ...(create?{requestId:personRequest.current}:!personId?{meetingOnly:true}:{}),
      });
      const saved=updated.segments.find(value=>value.id===current.id);
      if(!saved)throw Error('无法确认已保存的片段，请重新加载转录。');
      sample.current=saved;
      if(alive.current)setNotice('称谓已保存');
      onSaved(current,saved);
      if(create){
        personRequest.current=crypto.randomUUID();
        if(alive.current)setChoice(saved.personId||'');
      }
      if(learn&&saved.personId){
        const result=await api<Job>('/voiceprints/learn','POST',{
          personId:saved.personId,requestId:learnRequest.current,recordId,segmentId:saved.id,revision:saved.revision,consent:true,
        });
        if(alive.current){setJob(result);setConsent(false);}
      }
    }catch(error){if(alive.current)setError(messageOf(error));}
    finally{pending.current=false;if(alive.current)setBusy(false);}
  };

  return <form className="speaker-panel" aria-label="说话人标注" onSubmit={event=>{event.preventDefault();void save(false);}} onKeyDown={event=>{
    if(event.key==='Escape'){event.stopPropagation();close();}
  }}>
    <header><label htmlFor={nameId}>本场称谓</label><Button type="button" variant="ghost" aria-label="关闭说话人标注" onClick={close}><X size={16}/></Button></header>
    <fieldset className="speaker-panel-form" disabled={busy}>
      <input className="speaker-name" id={nameId} ref={input} value={name} maxLength={80} placeholder="输入姓名或称谓" onChange={event=>{setName(event.target.value);resetLearning();}}/>
      {searching&&<label className="speaker-search"><MagnifyingGlass size={15} aria-hidden="true"/><input autoFocus type="search" aria-label="搜索库中人物" value={query} maxLength={80} placeholder="搜索库中人物" onChange={event=>setQuery(event.target.value)}/></label>}
      <div className="speaker-people">
        {choices.map(person=><Button type="button" key={person.id} className="speaker-person-select" aria-pressed={person.id===choice} onClick={()=>choose(person.id,person.name)}><span className="speaker-person-avatar" aria-hidden="true">{Array.from(person.name)[0]}</span><span>{person.name}</span></Button>)}
        {bank&&<><Button type="button" aria-pressed={choice==='new'} onClick={()=>choose('new')}><Plus size={14}/>新建人物</Button>{bank.people.length>3&&<Button type="button" variant="ghost" aria-expanded={searching} onClick={()=>{setSearching(!searching);setQuery('');}}>{searching?'收起搜索':'选择其他人物'}</Button>}</>}
      </div>
      {searching&&!choices.length&&<p className="speaker-learning-state">没有匹配的人物。</p>}
      {libraryError&&<p className="speaker-learning-state" role="status">{libraryError}</p>}
      <footer>
        {canLearn&&<label className="speaker-consent"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>已获本人同意将这段声音用于跨会议识别</label>}
        {choice&&learningBlock&&<p className="speaker-learning-state">{learningBlock}</p>}
        {selected?.automaticLearning&&<p className="speaker-learning-state">此人物已授权会后自动深化</p>}

        {error&&<FeedbackNotice key={error} message={error} error persistent inline/>}
        {(notice||job)&&<p role="status" className="speaker-learning-state">{job ? jobMessages[job.status] : notice}</p>}
        <div className="actions"><Button type="submit" disabled={busy||!name.trim()} variant={consent?'secondary':'primary'}><Check size={15}/>仅保存称谓</Button>{canLearn&&<Button type="button" variant={consent?'primary':'secondary'} disabled={busy||!consent||!name.trim()} onClick={()=>void save(true)}>保存并学习</Button>}</div>
      </footer>
    </fieldset>
  </form>;
}
