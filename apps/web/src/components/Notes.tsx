import { lazy, Suspense, useEffect, useState } from 'react';
import { Check, FloppyDisk } from '@phosphor-icons/react';
import { Button } from './ui';
import type { RecordDetail } from '../model';
const MarkdownEditor=lazy(()=>import('./MarkdownEditor').then(module=>({default:module.MarkdownEditor})));

export function Notes({record,save,active=true}:{record:RecordDetail;save:(text:string,revision:number)=>Promise<boolean>;active?:boolean}){
  const [value,setValue]=useState(record.notes),[revision,setRevision]=useState(record.notesRevision),[busy,setBusy]=useState(false),[opened,setOpened]=useState(active);
  useEffect(()=>{setValue(record.notes);setRevision(record.notesRevision);},[record.id]);
  useEffect(()=>{if(active)setOpened(true);},[active]);
  const changed=value!==record.notes;
  const persist=async()=>{if(busy||!changed)return;setBusy(true);try{if(await save(value,revision))setRevision(revision+1);}finally{setBusy(false);}};
  return <section className="notes-block notes-workbench" onKeyDown={event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();void persist();}}}>
    <div className="notes-toolbar"><strong>手记</strong><Button className="notes-save" variant={changed?'primary':'ghost'} disabled={busy||!changed} onClick={()=>void persist()}>{changed?<FloppyDisk size={15}/>:<Check size={15}/>}<span>{busy?'保存中…':changed?'保存笔记':'已保存'}</span></Button></div>
    {opened&&<Suspense fallback={<p role="status">正在打开手记…</p>}><MarkdownEditor key={record.id} value={value} onChange={setValue}/></Suspense>}
  </section>;
}
