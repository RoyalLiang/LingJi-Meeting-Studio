import { useEffect, useRef, useState } from 'react';
import { Editor, defaultValueCtx, editorViewOptionsCtx, rootCtx, serializerCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { history } from '@milkdown/plugin-history';
import { clipboard } from '@milkdown/plugin-clipboard';
import { Plugin } from '@milkdown/prose/state';
import { $prose } from '@milkdown/utils';
import { FeedbackNotice } from './FeedbackNotice';

export function MarkdownEditor({value,onChange}:{value:string;onChange:(value:string)=>void}){
  const host=useRef<HTMLDivElement>(null),latest=useRef(onChange),[loading,setLoading]=useState(true),[error,setError]=useState(false);
  latest.current=onChange;
  useEffect(()=>{
    let active=true,ready=false;
    const editor=Editor.make().config(ctx=>{
      ctx.set(rootCtx,host.current);ctx.set(defaultValueCtx,value);
      ctx.update(editorViewOptionsCtx,options=>({...options,attributes:{...options.attributes,role:'textbox','aria-label':'会议随手笔记','aria-multiline':'true'},nodeViews:{...options.nodeViews,image:node=>{const span=document.createElement('span');span.className='markdown-image-alt';span.textContent=node.attrs.alt||'图片';return{dom:span};}}}));
    }).use(commonmark).use(gfm).use(history).use(clipboard).use($prose(ctx=>new Plugin({
      filterTransaction:transaction=>!ready||!transaction.docChanged||ctx.get(serializerCtx)(transaction.doc).length<=19999,
      view:()=>({update:(view,previous)=>{if(ready&&!view.state.doc.eq(previous.doc))latest.current(ctx.get(serializerCtx)(view.state.doc));}}),
    })));
    const creating=editor.create();
    void creating.then(()=>{if(active){ready=true;setLoading(false);}},()=>{if(active){setError(true);setLoading(false);}});
    return()=>{active=false;ready=false;void creating.then(()=>editor.destroy()).catch(()=>{});};
  },[]);
  return <div className="notes-document-editor" aria-label="Markdown 即时预览编辑器"><div ref={host}/>{loading&&<p role="status">正在打开手记…</p>}{error&&<><FeedbackNotice error inline persistent message="编辑器暂不可用，已保留源码编辑。"/><textarea aria-label="会议随手笔记" value={value} maxLength={19999} onChange={event=>onChange(event.target.value)}/></>}</div>;
}
