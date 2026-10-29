import { useEffect, useMemo, useRef, useState } from 'react';
import { Translate, Pause, Play, ArrowRight, ArrowClockwise } from '@phosphor-icons/react';
import type { RecordDetail, Segment } from '../model';
import { timecode } from '../model';
import { api, ApiError, messageOf } from '../api';
import { Button, CloseButton, Modal, Status } from './ui';
import { Select } from './Select';
import { useContentFollow } from './useContentFollow';
import { LiveTranscriptText } from './LiveTranscriptText';
import './TranslationPanel.css';

export function TranslationPanel({ record, ready, close, configure, save, inspect }: { record: RecordDetail; ready: boolean; close: () => void; configure: () => void; save: (target: string) => Promise<void>; inspect: (segment: Segment) => void }) {
  const [target,setTarget]=useState(record.translationTarget || 'en'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[showOriginal,setShowOriginal]=useState(true);
  const [mobile,setMobile]=useState(()=>matchMedia('(max-width:1250px)').matches);
  const active=useRef(true),pending=useRef(false),started=useRef(false);
  useEffect(()=>{const media=matchMedia('(max-width:1250px)');const change=()=>setMobile(media.matches);media.addEventListener('change',change);active.current=true;return()=>{active.current=false;media.removeEventListener('change',change);};},[]);
  async function choose(value:string){
    if(pending.current || !ready)return;
    pending.current=true;setBusy(true);setError('');const before=target;if(value)setTarget(value);
    try{await save(value);}catch(error){if(active.current){setTarget(before);setError(messageOf(error));}}
    finally{pending.current=false;if(active.current)setBusy(false);}
  }
  useEffect(()=>{if(!started.current){started.current=true;if(ready && !record.translationTarget && !record.translationRevision)void choose('en');}},[]);
  useEffect(()=>{if(record.translationTarget && !pending.current)setTarget(record.translationTarget);},[record.translationTarget]);
  const segments=useMemo(()=>[...record.segments].sort((a,b)=>a.startMs-b.startMs),[record.segments]);
  const translated=segments.filter(segment=>segment.translationLanguage===target && segment.translation);
  const failed=segments.filter(segment=>segment.translationError && segment.translationLanguage!==target);
  const drafts=record.translationTarget?record.sources.filter(source=>source.asr?.state==='running' && source.asr.preview?.text).sort((a,b)=>(a.asr!.preview!.startMs)-(b.asr!.preview!.startMs)):[];
  const follow=useContentFollow(`${mobile}:${target}:${record.cursor}:${translated.length}`,false,'[data-follow-scroll="translation"]',Boolean(record.translationTarget));
  async function retry(segment:Segment){
    if(pending.current || !ready)return;
    pending.current=true;setBusy(true);setError('');
    try{await api(`/records/${record.id}/translation/retry`,'POST',{segmentId:segment.id,revision:segment.revision,target});}
    catch(error){if(active.current)setError(messageOf(error));}finally{pending.current=false;if(active.current)setBusy(false);}
  }
  const state=!ready?'未配置翻译服务':record.translationTarget?'实时翻译中':'翻译已暂停';
  const sourceLabel=record.language==='auto'?'自动识别':({zh:'中文',en:'English',ja:'日本語',es:'Español',fr:'Français',de:'Deutsch'}[record.language] || '原文');
  const content=<><div className="translation-toolbar"><div className="translation-language-row"><span className="translation-source-language">{sourceLabel}</span><ArrowRight size={17} aria-hidden="true"/><Select label="实时翻译目标语言" disabled={busy || !ready} value={target} onChange={value=>void choose(value)} options={[{value:'en',label:'English'},{value:'zh',label:'中文'},{value:'ja',label:'日本語'},{value:'es',label:'Español'},{value:'fr',label:'Français'},{value:'de',label:'Deutsch'}]}/><Button className="translation-toggle" disabled={busy || !ready} aria-label={record.translationTarget?'暂停翻译':'继续翻译'} title={record.translationTarget?'暂停翻译':'继续翻译'} onClick={()=>void choose(record.translationTarget?'':target)}>{record.translationTarget?<Pause size={18}/>:<Play size={18}/>}</Button></div><div className="translation-state-row"><Status>{state}</Status><label className="checkbox-label"><input type="checkbox" checked={showOriginal} onChange={event=>setShowOriginal(event.target.checked)}/>显示原文</label></div></div>
    {error && <p className="translation-action-error" role="alert">{error}</p>}
    {record.translationTarget && segments.length>translated.length && <div className="translation-backlog">{segments.length-translated.length} 条原文待翻译<span>新发言优先</span></div>}
    <div className="translation-content" data-follow-scroll="translation" aria-label="实时译文滚动区" tabIndex={0}><section ref={follow.root} className="translation-segments" aria-label="实时译文">
      {!ready?<div className="translation-empty"><Translate size={28}/><h3>连接翻译服务</h3><p>配置可用服务后，即可开始实时翻译。</p><Button variant="primary" onClick={configure}>打开模型设置</Button></div>:<>
        {!record.translationTarget && <div className="translation-paused"><span>翻译已暂停，已有译文保留。</span><Button disabled={busy} onClick={()=>void choose(target)}>继续翻译</Button></div>}
        {segments.map(segment=><article className="translation-segment" key={segment.id}><header><span>{segment.speaker || '发言'}</span><time>{timecode(segment.startMs)}</time><Button variant="ghost" onClick={()=>inspect(segment)} aria-label={`定位 ${timecode(segment.startMs)} 原文`}>定位原文</Button></header>{showOriginal && <p className="translation-original">{segment.text}</p>}{segment.translationLanguage===target && segment.translation?<p className="translation-target" lang={target}>{segment.translation}</p>:segment.translationError?<div className="translation-failure" role="status"><span>{messageOf(new ApiError(segment.translationError,502))}</span><Button disabled={busy || !record.translationTarget} onClick={()=>void retry(segment)}><ArrowClockwise size={15}/>重试本句</Button></div>:<p className="translation-pending">{record.translationTarget?'等待翻译…':'尚未翻译'}</p>}</article>)}
        {drafts.map(source=>{const preview=source.asr!.preview!,value=source.asr!.translation;const valid=value?.target===target && value.startMs===preview.startMs && value.sourceText && preview.text.startsWith(value.sourceText);return <article className="translation-live-draft" key={source.id}><header><span className="translation-live-label"><i className="live-dot"/>正在发言</span><span>临时译文</span></header>{showOriginal && <p className="translation-original"><LiveTranscriptText text={preview.text}/></p>}{valid && value.text?<p className="translation-target" lang={target}><LiveTranscriptText text={value.text}/></p>:<p className="translation-pending">正在根据实时原文翻译…</p>}{value?.error && preview.text.startsWith(value.errorText || value.sourceText || '')?<div className="translation-failure"><span>实时翻译暂未完成</span><Button disabled={busy} onClick={()=>void choose(target)}>重试</Button></div>:<small>{valid && value.sourceText!==preview.text?'原文继续更新，译文正在跟进':'确认原文后归入上方记录'}</small>}</article>;})}
        {!segments.length && !drafts.length && <div className="translation-empty"><Translate size={28}/><h3>{record.translationTarget?'等待发言':'开启实时翻译'}</h3><p>{record.translationTarget?'实时原文出现后，译文会在这里更新。':'开启后翻译本场已有与后续发言。'}</p></div>}
      </>}
      <div ref={follow.end} className="content-follow-anchor" aria-hidden="true"/>
    </section></div>
    <footer className="translation-footer"><span>{record.translationTarget?(follow.following?'跟随最新':'已暂停跟随'):'翻译已暂停'} · {translated.length}/{segments.length} 条{failed.length>0?` · ${failed.length} 条待重试`:''}</span>{!follow.following && record.translationTarget && <Button variant="primary" onClick={follow.resume}>回到最新译文</Button>}</footer></>;
  return mobile?<Modal title="实时翻译" className="translation-modal" onClose={close} wide><div className="translation-ui translation-mobile">{content}</div></Modal>:<aside className="translation-panel translation-ui glass" aria-label="实时翻译"><header><div className="heading-icon"><Translate size={20}/><h2>实时翻译</h2></div><CloseButton label="关闭翻译面板" title="关闭面板，翻译继续运行" onClick={close}/></header>{content}</aside>;
}
