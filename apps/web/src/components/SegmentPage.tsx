import {useRef,useState} from 'react';
import {Button} from './ui';
import type {Segment} from '../model';

const size=60;
export function useSegmentPage(segments:Segment[],live:boolean,highlighted=''){
  const [selected,setSelected]=useState<{page:number;following:boolean}|null>(null);
  const previous=useRef(0);
  const pages=Math.max(1,Math.ceil(segments.length/size));
  const index=highlighted?segments.findIndex(segment=>segment.id===highlighted):-1;
  const page=Math.min(pages-1,index>=0?Math.floor(index/size):selected&&!selected.following?selected.page:live?pages-1:previous.current);
  previous.current=page;
  return {items:segments.slice(page*size,(page+1)*size),page,pages,total:segments.length,select:(page:number)=>setSelected({page,following:false}),latest:()=>{previous.current=pages-1;setSelected({page:pages-1,following:true});}};
}
export function SegmentPagination({view,disabled=false,change}:{view:ReturnType<typeof useSegmentPage>;disabled?:boolean;change:()=>void}){
  if(view.pages<=1)return null;
  const select=(page:number)=>{change();view.select(page);};
  return <nav className="history-pagination segment-pagination" aria-label="文字记录分页">
    <Button disabled={disabled||view.page===0} onClick={()=>select(view.page-1)}>上一页</Button>
    <span aria-live="polite">{view.page*size+1}–{Math.min(view.total,(view.page+1)*size)} / {view.total} 段</span>
    <Button disabled={disabled||view.page===view.pages-1} onClick={()=>select(view.page+1)}>下一页</Button>
  </nav>;
}
