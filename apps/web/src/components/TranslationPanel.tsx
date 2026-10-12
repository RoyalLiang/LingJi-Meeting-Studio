import { useEffect, useRef, useState } from 'react';
import { Translate, X } from '@phosphor-icons/react';
import type { RecordDetail, Segment } from '../model';
import { ApiError, messageOf } from '../api';
import { Button, Modal, Status } from './ui';
import { Select } from './Select';
import { useContentFollow } from './useContentFollow';

export function TranslationPanel({ record, ready, close, configure, save, inspect }: { record: RecordDetail; ready: boolean; close: () => void; configure: () => void; save: (target: string) => Promise<void>; inspect: (segment: Segment) => void }) {
  const [target, setTarget] = useState(record.translationTarget || 'en'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [mobile, setMobile] = useState(() => matchMedia('(max-width:1100px)').matches);
  const active = useRef(true), pending = useRef(false), started = useRef(false);
  useEffect(() => { const media = matchMedia('(max-width:1100px)'); const change = () => setMobile(media.matches); media.addEventListener('change',change); active.current=true; return () => {active.current=false;media.removeEventListener('change',change);}; }, []);
  async function choose(value: string) {
    if (pending.current) return;
    pending.current=true;setBusy(true);setError('');
    const before=target;if(value)setTarget(value);
    try { await save(value); } catch(error) {if(active.current){setTarget(before);setError(messageOf(error));}} finally {pending.current=false;if(active.current)setBusy(false);}
  }
  // Mount follows the user's explicit toolbar click. Merely opening settings never enables translation.
  useEffect(() => { if(!started.current){started.current=true;if(ready && !record.translationTarget)void choose('en');} }, []);
  const segments=[...record.segments].sort((a,b)=>a.startMs-b.startMs);
  const translated=segments.filter(segment=>segment.translationLanguage===target && segment.translation);
  const failed=segments.filter(segment=>segment.translationError && segment.translationLanguage!==target);
  const follow=useContentFollow(`${target}:${record.transcriptRevision}:${translated.map(segment=>segment.translation).join('|')}`,false,'[data-follow-scroll="translation"]',Boolean(record.translationTarget));
  const content=<><div className="translation-toolbar"><label>目标语言<Select label="实时翻译目标语言" readOnly={busy} value={target} onChange={value=>void choose(value)} options={[{value:'en',label:'English'},{value:'zh',label:'中文'},{value:'ja',label:'日本語'},{value:'es',label:'Español'},{value:'fr',label:'Français'},{value:'de',label:'Deutsch'}]}/></label><Button aria-disabled={busy} disabled={!ready} onClick={()=>void choose(record.translationTarget?'':target)}>{record.translationTarget?'暂停翻译':'继续翻译'}</Button></div>
    <p className="translation-explainer">豆包翻译模型 · 确认原文后逐句翻译。开启时会发送本场已有及后续发言；关闭面板不停止翻译，可点击“暂停翻译”。</p>
    {!ready && <div className="notice"><p>豆包翻译连接尚未配置。</p><Button onClick={configure}>打开模型设置</Button></div>}{error && <p className="inline-error" role="alert">{error}</p>}
    {failed.length>0 && <div className="translation-error" role="alert"><p>{failed.length} 条翻译未完成：{messageOf(new ApiError(failed[0].translationError || 'invalid_translation',502))}</p><Button disabled={busy||!ready} onClick={()=>void choose(target)}>重试未完成翻译</Button></div>}
    <div className="translation-content" data-follow-scroll="translation" aria-label="实时译文滚动区" tabIndex={0}><section ref={follow.root} className="translation-segments" aria-label="实时译文">{translated.map(segment=><article key={segment.id} className="translation-segment"><header><span>{segment.speaker || '发言'}</span><Button variant="ghost" onClick={()=>inspect(segment)}>原文</Button></header><p lang={target}>{segment.translation}</p></article>)}{!translated.length && <p className="translation-empty">{record.translationTarget?'正在等待已确认发言的译文，完成后自动显示。':'开启后，已确认的发言会逐句显示译文。'}</p>}{record.translationTarget && segments.length>translated.length && <p className="fine-print">还有 {segments.length-translated.length} 条发言待翻译。</p>}<div ref={follow.end} className="content-follow-anchor" aria-hidden="true"/></section></div>
    <footer className="translation-footer"><Status>{record.translationTarget?'翻译已开启':'翻译已暂停'} · {translated.length}/{segments.length} 条</Status>{!follow.following && record.translationTarget && <Button variant="ghost" onClick={follow.resume}>最新译文</Button>}</footer></>;
  return mobile ? <Modal title="实时翻译" onClose={close} wide><div className="translation-mobile">{content}</div></Modal> : <aside className="translation-panel glass" aria-label="实时翻译"><header><div className="heading-icon"><Translate size={20}/><h2>实时翻译</h2></div><Button variant="ghost" aria-label="关闭翻译" onClick={close}><X size={20}/></Button></header>{content}</aside>;
}
