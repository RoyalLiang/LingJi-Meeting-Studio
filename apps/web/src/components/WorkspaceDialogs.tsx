import { useState, type FormEvent } from 'react';
import { Folder, FolderPlus } from '@phosphor-icons/react';
import type { WorkspaceDirectory } from '../workspace-model';
import { Button, Modal } from './ui';
import { Select } from './Select';

export function WorkspaceEditor({ directory, save, close }: {directory?:WorkspaceDirectory;save:(name:string,description:string)=>Promise<void>;close:()=>void}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function submit(event:FormEvent<HTMLFormElement>) { event.preventDefault(); const data=new FormData(event.currentTarget); setBusy(true);setError('');try{await save(String(data.get('name')||'').trim(),String(data.get('description')||'').trim());}catch(e){setError(e instanceof Error?e.message:'保存失败，请重试。');}finally{setBusy(false);} }
  return <Modal title={directory?'编辑工作目录':'创建工作目录'} initialFocus="field" onClose={()=>{if(!busy)close();}}><form onSubmit={submit}><p className="muted">把同一项目的讨论放在一起，让进展有迹可循。</p><label>目录名称<input autoFocus name="name" defaultValue={directory?.name} placeholder="例如：产品研发" required maxLength={80}/></label><label>简短说明 <span className="muted">选填</span><textarea name="description" defaultValue={directory?.description} placeholder="这个目录关注什么？" maxLength={240} rows={3}/></label>{error&&<p role="alert" className="notice error">{error}</p>}<div className="actions"><Button type="submit" variant="primary" disabled={busy}><FolderPlus size={18}/>{busy?'正在保存…':directory?'保存目录':'创建目录'}</Button><Button disabled={busy} onClick={close}>取消</Button></div></form></Modal>;
}
export function ArchiveRecords({ directories, count, initial, save, close, create }: {directories:WorkspaceDirectory[];count:number;initial?:string|null;save:(id:string|null)=>Promise<void>;close:()=>void;create:()=>void}) {
  const [destination,setDestination]=useState(directories.some(w=>w.id===initial)?initial!:directories[0]?.id||''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  return <Modal title="归档到工作目录" onClose={()=>{if(!busy)close();}}><div className="archive-form"><p className="muted">将 {count} 条会议放入同一个目录，原文、纪要和分享权限保持原有设置。</p><label>目标目录<Select label="归档目标目录" value={destination} onChange={setDestination} disabled={busy} options={directories.map(w=>({value:w.id,label:w.name}))}/></label>{!directories.length&&<p className="fine-print">还没有工作目录。<Button variant="ghost" onClick={create}>创建第一个目录</Button></p>}{error&&<p role="alert" className="notice error">{error}</p>}<div className="actions"><Button variant="primary" disabled={busy||!destination} onClick={async()=>{setBusy(true);setError('');try{await save(destination);}catch(e){setError(e instanceof Error?e.message:'归档失败，请重试。');}finally{setBusy(false);}}}><Folder size={18}/>{busy?'正在归档…':'确认归档'}</Button><Button disabled={busy} onClick={close}>取消</Button></div></div></Modal>;
}
