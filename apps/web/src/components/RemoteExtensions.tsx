import {FeedbackNotice} from './FeedbackNotice';
import { useRef, useState, type FormEvent } from 'react';
import { api, messageOf } from '../api';
import { Button } from './ui';
import { ExternalLink } from './ExternalLink';
import './RemoteExtensions.css';

export type InstalledExtension={id:string;type:'skill'|'mcp';name:string;description?:string;source?:string;path?:string;ref?:string;version:string;enabled:boolean;networkMode?:string;url?:string;hasToken?:boolean;tools?:{name:string;description:string;readOnly:boolean;inputSchema:unknown}[];approvedTools?:string[];warnings?:string[]};
type SkillPreview={source:string;path:string;ref:string;name:string;description:string;version:string;content:string;warnings:string[]};
export function RemoteExtensions({type,items,changed}:{type:'skill'|'mcp';items:InstalledExtension[];changed:()=>void}){
  const [token,setToken]=useState(''),[extensionId,setExtensionId]=useState(''),[adding,setAdding]=useState(false),[source,setSource]=useState(''),[path,setPath]=useState(''),[ref,setRef]=useState('main'),[preview,setPreview]=useState<SkillPreview|null>(null);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),pending=useRef(false);
  const [approved,setApproved]=useState<Record<string,string[]>>({});
  const perform=async(action:()=>Promise<void>)=>{if(pending.current)return;pending.current=true;setBusy(true);setError('');setNotice('');try{await action();}catch(failure){setError(messageOf(failure));}finally{pending.current=false;setBusy(false);}};
  const installPlugin=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const form=event.currentTarget,input=Object.fromEntries(new FormData(form));void perform(async()=>{await api('/extensions/plugins','POST',{...input,confirmed:true});form.reset();setAdding(false);changed();setNotice('已读取服务工具清单，请选择只读工具后启用。');});};
  return <section className="remote-extensions" aria-label={type==='skill'?'远程 Skills':'远程 MCP 插件'}>
    <div className="ma-toolbar"><h2>{type==='skill'?'已安装的远程 Skill':'HTTP MCP 插件'} <span>{items.length}</span></h2><Button disabled={busy} onClick={()=>{setAdding(!adding);setToken('');setExtensionId('');setPreview(null);}}>{adding?'收起':type==='skill'?'从 GitHub 安装':'添加 MCP 服务'}</Button></div>
    {adding&&type==='skill'&&<form className="remote-extension-form" onSubmit={event=>{event.preventDefault();void perform(async()=>setPreview(await api<SkillPreview>('/extensions/skills/preview','POST',{source,path,ref,token,extensionId:extensionId||undefined})));}}>
      <p className="fine-print">安装 GitHub 仓库中的 SKILL.md 文本指引。先核对来源与指引，再确认安装；不执行仓库脚本。</p>
      <label>GitHub 仓库<input required disabled={busy} type="url" value={source} onChange={event=>{setSource(event.target.value);setExtensionId('');setToken('');setPreview(null);}} placeholder="https://github.com/组织/仓库"/></label>
      <label>访问令牌（私有仓库）<input type="password" disabled={busy} autoComplete="new-password" value={token} onChange={event=>{setToken(event.target.value);setPreview(null);}} placeholder={items.some(item=>item.id===extensionId&&item.hasToken)?'留空使用已保存令牌':'GitHub token · Contents 只读权限'}/></label><div className="remote-extension-fields"><label>Skill 目录<input disabled={busy} value={path} onChange={event=>{setPath(event.target.value);setExtensionId('');setPreview(null);}} placeholder="留空表示仓库根目录"/></label><label>版本<input disabled={busy} value={ref} onChange={event=>{setRef(event.target.value);setPreview(null);}} placeholder="分支、标签或完整提交 SHA" required/></label></div>
      <Button disabled={busy} type="submit">检查来源与版本</Button>
      {preview&&<div className="remote-extension-preview"><h3>{preview.name}</h3><p>{preview.description}</p><p className="fine-print">固定提交 {preview.version}</p><pre tabIndex={0}>{preview.content}</pre><p className="fine-print">{preview.warnings.join(' ')}</p><Button variant="primary" disabled={busy} onClick={()=>void perform(async()=>{await api('/extensions/skills','POST',{source:preview.source,path:preview.path,ref:preview.ref,expectedVersion:preview.version,confirmed:true,token,extensionId:extensionId||undefined});setToken('');setExtensionId('');setPreview(null);setAdding(false);changed();setNotice('已安装并固定版本。启用后可在会议助手中选择。');})}>确认安装此版本</Button></div>}
    </form>}
    {adding&&type==='mcp'&&<form className="remote-extension-form" onSubmit={installPlugin}>
      <p className="fine-print">连接你信任的公开 HTTPS Streamable HTTP MCP 服务。先读取工具清单，再逐项批准服务声明为只读的工具；不会执行服务提供的代码包。</p>
      <label>插件名称<input name="name" required maxLength={80}/></label><label>MCP 服务地址<input name="url" required type="url" placeholder="https://服务域名/mcp"/></label><label>Bearer token · 可选<input name="token" type="password" autoComplete="new-password" placeholder="由后台加密保存"/></label>
      <Button variant="primary" disabled={busy} type="submit">连接并检查工具</Button>
    </form>}
    {!items.length&&!adding&&<p className="ma-muted remote-extension-empty">{type==='skill'?'尚未安装远程 Skill。':'尚未连接远程 MCP 服务。'}</p>}
    {items.map(item=><article key={item.id} className="remote-extension-row"><div className="remote-extension-title"><h3>{item.name}</h3><span className="ma-state">{item.enabled?'已启用':'已停用'}</span></div>
      <p>{item.description||item.url}</p>
      {item.type==='skill'?<><p className="fine-print">GitHub · 固定提交 {item.version.slice(0,12)} · {item.path||'根目录'}</p><ExternalLink href={`${item.source}/blob/${item.version}/${item.path?item.path+'/':''}SKILL.md`}>查看此版本指引</ExternalLink></>:<>
        <p className="fine-print">{item.networkMode==='desktop-proxy'?'本机代理兼容 · ':''}凭据{item.hasToken?'已保存':'未设置'} · 工具 {item.tools?.length||0} 项。只读标记由服务声明，请自行核对服务可信度。</p>
        <div className="remote-tool-list">{item.tools?.map(tool=><label className="checkbox-label" key={tool.name}><input type="checkbox" disabled={busy||item.enabled||!tool.readOnly} checked={(approved[item.id]||item.approvedTools||[]).includes(tool.name)} onChange={event=>setApproved(value=>({...value,[item.id]:event.target.checked?[...(value[item.id]||item.approvedTools||[]),tool.name]:(value[item.id]||item.approvedTools||[]).filter(name=>name!==tool.name)}))}/><span>{tool.name}<small>{tool.readOnly?tool.description||'服务声明只读':'未声明只读，当前不开放调用'}</small></span></label>)}</div>
      </>}
      <div className="remote-extension-actions"><Button disabled={busy} onClick={()=>void perform(async()=>{await api(`/extensions/${encodeURIComponent(item.id)}`,'PATCH',{enabled:!item.enabled,expectedVersion:item.version,...(item.type==='mcp'?{approvedTools:approved[item.id]||item.approvedTools||[]}:{})});changed();})}>{item.enabled?'停用':'启用'}</Button>
        {item.type==='skill'?<Button disabled={busy} onClick={()=>{setToken('');setExtensionId(item.id);setSource(item.source||'');setPath(item.path||'');setRef(item.ref||'main');setPreview(null);setAdding(true);}}>检查更新</Button>:<Button disabled={busy} onClick={()=>void perform(async()=>{await api(`/extensions/${encodeURIComponent(item.id)}/check`,'POST',{});changed();setApproved(value=>({...value,[item.id]:[]}));setNotice('已更新工具清单，需重新批准并启用。');})}>重新检查连接</Button>}
        <Button variant="ghost" disabled={busy} onClick={()=>void perform(async()=>{await api(`/extensions/${encodeURIComponent(item.id)}`,'DELETE');changed();})}>移除</Button></div>
    </article>)}
    <p className="fine-print">升级、停用或移除会阻止未完成任务继续使用该扩展；已完成结果保留当时版本。飞书导出单独授权，不作为助手工具。</p>
    {notice&&<FeedbackNotice key={notice} message={notice} warning={false}/>}{error&&<FeedbackNotice key={error} message={error} error/>}
  </section>;
}
