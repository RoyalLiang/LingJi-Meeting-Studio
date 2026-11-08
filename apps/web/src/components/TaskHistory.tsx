import {useEffect,useState,useRef,type ReactNode} from 'react';
import {api,messageOf,ApiError} from '../api';
import {Button} from './ui';
import {FeedbackNotice} from './FeedbackNotice';

export function TaskHistory<T>({endpoint,empty,children,itemsKey='items',revision=''}:{endpoint:string;empty:string;children:(items:T[])=>ReactNode;itemsKey?:string;revision?:string}){
  const [cursors,setCursors]=useState(['']),[page,setPage]=useState(0),[next,setNext]=useState<string|null>(null),[items,setItems]=useState<T[]>([]),[busy,setBusy]=useState(true),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  const cursor=cursors[page];
  const list=useRef<HTMLDivElement>(null),identity=useRef('');
  const navigate=(nextPage:number)=>{setPage(nextPage);const node=list.current,root=node?.closest<HTMLElement>('.workspace-scroll,.modal-body,.ma-drawer-content');if(node&&root)root.scrollTop+=node.getBoundingClientRect().top-root.getBoundingClientRect().top;node?.focus({preventScroll:true});};
  useEffect(()=>{
    let stopped=false,timer:ReturnType<typeof setTimeout>,controller:AbortController|undefined;
    setBusy(true);setError('');const key=endpoint+':'+itemsKey+':'+cursor;if(identity.current!==key){identity.current=key;setItems([]);setNext(null);}
    async function load(first=false){
      if(stopped)return;
      if(!first&&document.visibilityState==='hidden'){timer=setTimeout(()=>void load(),15000);return;}
      controller=new AbortController();
      try{
        const result=await api<Record<string,unknown>>(`${endpoint}${endpoint.includes('?')?'&':'?'}limit=20${cursor?'&cursor='+encodeURIComponent(cursor):''}`,'GET',undefined,controller.signal);
        if(!Array.isArray(result[itemsKey])||result.nextCursor!==null&&typeof result.nextCursor!=='string')throw new ApiError('invalid_response',502);
        if(!stopped){setItems(result[itemsKey] as T[]);setNext(result.nextCursor as string|null);setError('');}
      }catch(failure){if(!stopped)setError(messageOf(failure));}
      finally{if(!stopped){setBusy(false);timer=setTimeout(()=>void load(),15000);}}
    }
    void load(true);
    return()=>{stopped=true;clearTimeout(timer);controller?.abort();};
  },[endpoint,cursor,itemsKey,refresh,revision]);
  return <div className="task-history" ref={list} tabIndex={-1}>
    {error&&<FeedbackNotice key={error} message={error} error action={{label:'重试',run:()=>setRefresh(v=>v+1)}}/>}
    {busy&&!items.length?<p role="status">正在加载记录…</p>:items.length?children(items):<p className="fine-print">{error?'暂时无法读取记录，请重试。':next?'本页没有可见记录，可继续查看更早记录。':empty}</p>}
    <nav className="history-pagination" aria-label="记录分页"><Button variant="ghost" disabled={busy||page===0} onClick={()=>navigate(page-1)}>上一页</Button><span aria-live="polite">第 {page+1} 页</span><Button variant="ghost" disabled={busy||!next} onClick={()=>{setCursors(value=>[...value.slice(0,page+1),next!]);navigate(page+1);}}>下一页</Button><Button variant="ghost" disabled={busy} onClick={()=>setRefresh(v=>v+1)}>刷新</Button></nav>
  </div>;
}
