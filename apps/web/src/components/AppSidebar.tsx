import { useEffect, useRef, type ReactNode } from 'react';
import { BookOpen, FileText, Folder, FolderPlus, GearSix, House, MagnifyingGlass, Microphone, Moon, Plus, Sparkle, Sun, X } from '@phosphor-icons/react';
import type { RecordListItem } from '../model';
import type { WorkspaceDirectory } from '../workspace-model';
import { Brand } from './Brand';
import { Select } from './Select';
import { SearchHighlights } from './SearchHighlights';
import { Button } from './ui';

export type WorkspacePage = 'overview' | 'meetings' | 'knowledge' | 'workspaces';
type Props = {
  directories: WorkspaceDirectory[]; scope: string; records: RecordListItem[]; recordId: string;
  page: WorkspacePage; extensionOpen: boolean; settingsOpen: boolean; open: boolean; disabled: boolean; canRecord: boolean;
  name: string; account: string; theme: string; version: ReactNode; tools?: ReactNode;
  chooseScope: (id: string) => void; navigate: (page: WorkspacePage) => void; selectRecord: (id: string) => void;
  create: () => void; prepare: () => void; quick: () => void; extensions: () => void; settings: () => void;
  voices: () => void; search: () => void; toggleTheme: () => void; close: () => void;
};
export function AppSidebar(props: Props) {
  const ref=useRef<HTMLElement>(null);
  useEffect(()=>{
    if(!props.open)return;
    const sidebar=ref.current,opener=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const main=document.querySelector<HTMLElement>('main.workspace');if(main)main.inert=true;
    sidebar?.querySelector<HTMLElement>('.select-trigger')?.focus();
    const key=(event:KeyboardEvent)=>{
      if(document.querySelector('dialog[open], [role=listbox]:popover-open, [role=menu]:popover-open'))return;
      if(event.key==='Escape'){event.preventDefault();props.close();}
      if(event.key==='Tab'){
        const elements=[...sidebar?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not([type=hidden])')||[]].filter(e=>e.getClientRects().length);
        if(event.shiftKey&&document.activeElement===elements[0]){event.preventDefault();elements.at(-1)?.focus();}
        else if(!event.shiftKey&&document.activeElement===elements.at(-1)){event.preventDefault();elements[0]?.focus();}
      }
    };
    const resize=()=>{if(innerWidth>800)props.close();};
    addEventListener('resize',resize);document.addEventListener('keydown',key);
    return()=>{removeEventListener('resize',resize);document.removeEventListener('keydown',key);if(main)main.inert=false;if(opener?.isConnected)opener.focus({preventScroll:true});};
  },[props.open,props.close]);
  const active=!props.recordId&&!props.extensionOpen&&!props.settingsOpen;
  return <><aside ref={ref} id="project-sidebar" className={`sidebar v10-sidebar ${props.open?'is-open':''}`} aria-label="项目与会议导航">
    <div className="sidebar-head"><div className="rail-brand"><div className="rail-identity"><Brand/><div className="rail-version">{props.version}</div></div><div className="rail-top-actions"><Button variant="ghost" aria-label="搜索会议" disabled={props.disabled} onClick={props.search}><MagnifyingGlass size={17}/></Button><Button variant="ghost" aria-label="提前准备会议" disabled={props.disabled} onClick={props.prepare}><Plus size={19}/></Button><Button variant="ghost" className="sidebar-close" aria-label="关闭项目导航" onClick={props.close}><X size={18}/></Button></div></div>
      <div className="rail-section-label"><span>工作空间</span><Button variant="ghost" aria-label="新建工作目录" disabled={props.disabled} onClick={props.create}><FolderPlus size={15}/></Button></div>
      <div className="workspace-picker-card"><Brand markOnly/><div><Select label="选择工作目录" value={props.scope} onChange={props.chooseScope} disabled={props.disabled} options={[{value:'all',label:'所有会议'},...props.directories.map(w=>({value:w.id,label:w.name}))]}/><small>项目 Workspace</small></div></div>
      <Button className="new-record" onClick={props.quick} disabled={props.disabled||!props.canRecord}><Microphone size={16}/>快速记录</Button>
    </div>
    <nav className="project-navigation sidebar-projects" aria-label="当前项目"><div className="rail-section-label">项目</div>
      <Button variant="ghost" aria-current={active&&props.page==='overview'?'page':undefined} disabled={props.disabled} onClick={()=>props.navigate('overview')}><House size={17}/>项目概览</Button>
      <Button variant="ghost" aria-current={!props.extensionOpen&&!props.settingsOpen&&(props.recordId||active&&props.page==='meetings')?'page':undefined} disabled={props.disabled} onClick={()=>props.navigate('meetings')}><FileText size={17}/>会议记录<span className="rail-count" title="当前已载入的会议">{props.records.length}</span></Button>
      <Button variant="ghost" aria-current={active&&props.page==='knowledge'?'page':undefined} disabled={props.disabled} onClick={()=>props.navigate('knowledge')}><BookOpen size={17}/>知识与问答</Button>
      <Button variant="ghost" disabled={props.disabled||props.scope==='all'} onClick={props.voices}><Microphone size={17}/>声纹库</Button>
    </nav><div className="rail-section-label recent-heading"><span>最近讨论</span><Button variant="ghost" disabled={props.disabled} onClick={()=>props.navigate('meetings')}>全部</Button></div>
    <div className="sidebar-scroll"><nav className="record-list" aria-label="会议记录">{props.records.slice(0,8).map(r=><button key={r.id} className={`record-row ${r.id===props.recordId&&!props.extensionOpen&&!props.settingsOpen?'selected':''}`} aria-current={r.id===props.recordId&&!props.extensionOpen&&!props.settingsOpen?'page':undefined} title={r.title} disabled={props.disabled&&r.id!==props.recordId} onClick={()=>props.selectRecord(r.id)}><span className="record-icon">{r.hasMinutes?<FileText size={16}/>:<Microphone size={16}/>}</span><span><b><SearchHighlights text={r.title} ranges={r.search?.titleHighlights}/></b><small>{new Date(r.createdAt).toLocaleDateString('zh-CN',{month:'short',day:'numeric'})}<span className="record-duration-pill">{r.capture==='recording'?'录音中':`${Math.ceil(r.seconds/60)} 分钟`}</span></small></span></button>)}{!props.records.length&&<p className="rail-empty">这个范围还没有会议。</p>}</nav>
    </div><footer className="rail-footer"><nav className="project-navigation rail-utilities"><Button variant="ghost" aria-current={active&&props.page==='workspaces'?'page':undefined} disabled={props.disabled} onClick={()=>props.navigate('workspaces')}><Folder size={16}/>所有项目空间</Button><Button variant="ghost" aria-current={props.extensionOpen&&!props.settingsOpen?'page':undefined} disabled={props.disabled} onClick={props.extensions}><Sparkle size={16}/>扩展与助手</Button><Button variant="ghost" aria-label="设置与诊断" aria-current={props.settingsOpen?'page':undefined} onClick={props.settings}><GearSix size={16}/>设置与诊断</Button></nav><div className="account"><span className="avatar">{props.name.slice(0,1)}</span><span><b>{props.name}</b><small title={props.account}>{props.account}</small></span><Button variant="ghost" aria-label={props.theme==='light'?'切换深色':'切换浅色'} onClick={props.toggleTheme}>{props.theme==='light'?<Moon size={17}/>:<Sun size={17}/>}</Button></div><div className="rail-system-tools">{props.tools}</div></footer>
  </aside>{props.open&&<button className="sidebar-backdrop" aria-label="关闭项目导航" tabIndex={-1} onClick={props.close}/>}</>;
}
