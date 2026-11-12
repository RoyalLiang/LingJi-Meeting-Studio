import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import './TokenActivity.css';

type Day={day:string;minutesTokens:number|null;usageIncomplete:boolean};
const compact=new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1});
export function TokenActivity({days}:{days:Day[]}){
 const [focused,setFocused]=useState(days.length-1),[tip,setTip]=useState<{day:Day;anchor:HTMLElement}|null>(null),[position,setPosition]=useState({left:12,top:12});
 const root=useRef<HTMLElement>(null),popup=useRef<HTMLDivElement>(null),id=useId();
 useLayoutEffect(()=>{
  if(!tip)return;
  const place=()=>{const r=tip.anchor.getBoundingClientRect(),p=popup.current?.getBoundingClientRect();if(!p)return;const width=visualViewport?.width||innerWidth,height=visualViewport?.height||innerHeight;setPosition({left:Math.max(12,Math.min(width-p.width-12,r.left+(r.width-p.width)/2)),top:Math.max(12,r.bottom+p.height+8<height?r.bottom+8:r.top-p.height-8)});};
  place();addEventListener('resize',place);addEventListener('scroll',place,true);
  return()=>{removeEventListener('resize',place);removeEventListener('scroll',place,true);};
 },[tip]);
 useEffect(()=>{if(!tip)return;const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setTip(null);};const key=(e:KeyboardEvent)=>{if(e.key==='Escape')setTip(null);};document.addEventListener('pointerdown',outside);document.addEventListener('keydown',key);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key);};},[tip]);
 if(!days.length)return null;
 const offset=new Date(`${days[0].day}T00:00:00Z`).getUTCDay(),columns=Math.ceil((offset+days.length)/7),maximum=Math.max(1,...days.map(day=>day.minutesTokens||0));
 const value=(day:Day)=>day.minutesTokens===null||day.usageIncomplete&&!day.minutesTokens?'未上报':`${compact.format(day.minutesTokens)}${day.usageIncomplete?'+':''} Tokens`;
 const show=(day:Day,anchor:HTMLElement)=>setTip({day,anchor});
 const monthPositions=days.flatMap((day,index)=>index===0||day.day.endsWith('-01')?[{day,column:Math.floor((offset+index)/7)}]:[]);
 return <section ref={root} className="token-activity" aria-label="近一年 Token 活动">
  <header><h2>Token 活动</h2><div className="token-activity-legend" aria-label="颜色越深表示消耗越多"><span>少</span>{[0,1,2,3,4].map(level=><i key={level} data-level={level}/>)}<span>多</span></div></header>
  <div className="token-activity-scroll"><div className="token-activity-calendar" style={{gridTemplateColumns:`repeat(${columns},minmax(10px,1fr))`}} onPointerLeave={()=>{if(!root.current?.contains(document.activeElement))setTip(null);}}>
   {Array.from({length:offset},(_,i)=><span key={`pad-${i}`} aria-hidden="true"/>)}
   {days.map((day,index)=><button type="button" key={day.day} className="token-activity-day" data-level={day.minutesTokens===null||day.usageIncomplete?'unknown':day.minutesTokens===0?0:Math.min(4,Math.ceil(day.minutesTokens/maximum*4))} aria-label={`${day.day}，${value(day)}`} aria-describedby={tip?.day.day===day.day?id:undefined} tabIndex={focused===index?0:-1} onPointerEnter={e=>show(day,e.currentTarget)} onClick={e=>show(day,e.currentTarget)} onFocus={e=>{setFocused(index);show(day,e.currentTarget);}} onBlur={()=>setTip(null)} onKeyDown={e=>{const delta=({ArrowLeft:-7,ArrowRight:7,ArrowUp:-1,ArrowDown:1,Home:-index,End:days.length-1-index} as Record<string,number>)[e.key];if(delta===undefined)return;e.preventDefault();const next=Math.max(0,Math.min(days.length-1,index+delta));setFocused(next);const cell=e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next],scroller=cell?.parentElement?.parentElement;cell?.focus({preventScroll:true});if(cell&&scroller){const r=cell.getBoundingClientRect(),bounds=scroller.getBoundingClientRect();scroller.scrollLeft+=Math.min(0,r.left-bounds.left)+Math.max(0,r.right-bounds.right);}}}/>)}
  </div><div className="token-activity-months" style={{gridTemplateColumns:`repeat(${columns},minmax(10px,1fr))`}} aria-hidden="true">{monthPositions.map(({day,column})=><span key={day.day} style={{gridColumn:column+1}}>{Number(day.day.slice(5,7))}月</span>)}</div></div>
  {tip&&createPortal(<div ref={popup} id={id} className="token-activity-tooltip" role="tooltip" style={position}><time>{tip.day.day}</time><strong>{value(tip.day)}</strong></div>,document.body)}
 </section>;
}
