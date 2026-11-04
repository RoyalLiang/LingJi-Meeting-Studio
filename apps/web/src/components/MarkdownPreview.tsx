import {boardSvg} from '../../../../packages/records/src/minutes-presentation.mjs';
import './MarkdownPreview.css';
import {memo,useId,useMemo,useRef,useState,type ReactNode} from 'react';
import {Modal} from './ui';
import DOMPurify from 'dompurify';
import {isTauri,invoke} from '@tauri-apps/api/core';
import {renderMarkdown} from '../markdown.mjs';
import {FeedbackNotice} from './FeedbackNotice';
import {messageOf} from '../api';

export const MarkdownPreview=memo(function MarkdownPreview({text}:{text:string}){
  const prefix=useId().replace(/[^a-zA-Z0-9_-]/g,''),[error,setError]=useState('');
  const html=useMemo(()=>{const rendered=renderMarkdown(text,prefix);return typeof DOMPurify.sanitize==='function'?DOMPurify.sanitize(rendered,{USE_PROFILES:{html:true},FORBID_TAGS:['style','iframe','object','embed','form'],FORBID_ATTR:['style','autofocus'],ALLOW_DATA_ATTR:false}):rendered;},[text,prefix]);
  return <><article className="markdown-preview" aria-label="文档内容预览" dangerouslySetInnerHTML={{__html:html}} onClick={event=>{
    const target=event.target as Element,copy=target.closest<HTMLButtonElement>('.markdown-copy');
    if(copy){const code=copy.closest('.markdown-code')?.querySelector('code')?.textContent||'';void navigator.clipboard.writeText(code).then(()=>{copy.textContent='已复制';},()=>setError('复制失败，请选择代码后复制。'));return;}
    const link=target.closest<HTMLAnchorElement>('a');if(!link||link.getAttribute('href')?.startsWith('#'))return;
    if(!/^https?:$/.test(new URL(link.href).protocol)){event.preventDefault();return;}
    event.preventDefault();if(isTauri())void invoke('integration_open',{url:link.href}).catch(failure=>setError(typeof failure==='string'?failure:messageOf(failure)));else window.open(link.href,'_blank','noopener,noreferrer');
  }}/>{error&&<FeedbackNotice key={error} message={error} error/>}</>;
});
export type BoardNode={id:string;type?:string;text?:{text?:string};mind_map_node?:{parent_id:string};[key:string]:unknown};
export function BoardPreview({nodes,title="会议总览与主题图表"}:{nodes:BoardNode[];title?:string}){
  const graphic=useMemo(()=>boardSvg(nodes),[nodes]);
  const [zoom,setZoom]=useState(1),[fit,setFit]=useState(false),[expanded,setExpanded]=useState(false);
  const drag=useRef<{x:number;y:number;left:number;top:number}|null>(null);
  const children=useMemo(()=>{const map=new Map<string,BoardNode[]>();for(const node of nodes){const parent=node.mind_map_node?.parent_id||'';const group=map.get(parent)||[];group.push(node);map.set(parent,group);}return map;},[nodes]);
  const branch=(parent:string):ReactNode=><ul>{(children.get(parent)||[]).map(node=><li key={node.id}><span>{node.text?.text}</span>{children.has(node.id)&&branch(node.id)}</li>)}</ul>;
  const tools=<div className="feishu-board-tools"><button type="button" aria-label="缩小画板" onClick={()=>setZoom(value=>Math.max(.25,value/1.25))}>−</button><output>{Math.round(zoom*100)}%</output><button type="button" aria-label="放大画板" onClick={()=>setZoom(value=>Math.min(4,value*1.25))}>＋</button><button type="button" onClick={()=>{setZoom(1);setFit(true);}}>适应</button>{!expanded&&<button type="button" onClick={()=>setExpanded(true)}>放大查看</button>}</div>;
  const image=()=> <div className="feishu-board-canvas" tabIndex={0} role="region" aria-label="可缩放和拖动的纪要画板" onPointerDown={event=>{if(event.button!==0||event.pointerType==='touch')return;const element=event.currentTarget;drag.current={x:event.clientX,y:event.clientY,left:element.scrollLeft,top:element.scrollTop};element.setPointerCapture(event.pointerId);}} onPointerMove={event=>{if(!drag.current)return;event.currentTarget.scrollLeft=drag.current.left+drag.current.x-event.clientX;event.currentTarget.scrollTop=drag.current.top+drag.current.y-event.clientY;}} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}><div style={{width:`${zoom*100}%`,minWidth:fit?0:680*zoom}} dangerouslySetInnerHTML={{__html:graphic}}/></div>;
  return <section className="feishu-board-preview" aria-label="画板内容预览"><header><h3>{title}</h3>{graphic&&tools}</header>{graphic?image():branch('')}{expanded&&<Modal title={title} wide className="feishu-board-modal" onClose={()=>setExpanded(false)} headerActions={tools}>{image()}</Modal>}</section>;
}
