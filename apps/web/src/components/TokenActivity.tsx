import {useState} from 'react';
import './TokenActivity.css';

type Day={day:string;minutesTokens:number|null;usageIncomplete:boolean};
export function TokenActivity({days}:{days:Day[]}){
 const [focused,setFocused]=useState(days.length-1),[tip,setTip]=useState<{day:Day;x:number;y:number}|null>(null);
 if(!days.length)return null;
 const offset=new Date(`${days[0].day}T00:00:00Z`).getUTCDay(),columns=Math.ceil((offset+days.length)/7);
 const maximum=Math.max(1,...days.map(day=>day.minutesTokens||0));
 const description=(day:Day)=>`${day.day} · ${day.minutesTokens===null?'用量未报告':`${day.usageIncomplete?'≥ ':''}${day.minutesTokens.toLocaleString()} Token`}${day.usageIncomplete&&day.minutesTokens!==null?'（部分用量未报告）':''}`;
 const show=(day:Day,node:HTMLElement)=>{const r=node.getBoundingClientRect();setTip({day,x:Math.max(130,Math.min(innerWidth-130,r.left+r.width/2)),y:Math.min(innerHeight-64,r.bottom+8)});};
 const monthPositions=days.flatMap((day,index)=>index===0||day.day.endsWith('-01')?[{day,column:Math.floor((offset+index)/7)}]:[]);
 return <section className="token-activity" aria-label="近一年纪要 Token 活动" title="北京时间，按会议创建日期汇总已报告的纪要 Token">
  <header><h2>Token 活动</h2><div className="token-activity-legend" aria-label="颜色越深表示消耗越多"><span>少</span>{[0,1,2,3,4].map(level=><i key={level} data-level={level}/>)}<span>多</span></div></header>
  <div className="token-activity-scroll"><div className="token-activity-calendar" style={{gridTemplateColumns:`repeat(${columns},minmax(10px,1fr))`}} onPointerLeave={()=>setTip(null)}>
   {Array.from({length:offset},(_,i)=><span key={`pad-${i}`} aria-hidden="true"/>)}
   {days.map((day,index)=><button type="button" key={day.day} className="token-activity-day" data-level={day.minutesTokens===null?'unknown':day.minutesTokens===0?0:Math.min(4,Math.ceil(day.minutesTokens/maximum*4))} aria-label={description(day)} tabIndex={focused===index?0:-1} onPointerEnter={event=>show(day,event.currentTarget)} onFocus={event=>{setFocused(index);show(day,event.currentTarget);}} onBlur={()=>setTip(null)} onKeyDown={event=>{const delta=({ArrowLeft:-7,ArrowRight:7,ArrowUp:-1,ArrowDown:1,Home:-index,End:days.length-1-index} as Record<string,number>)[event.key];if(delta===undefined){if(event.key==='Escape')setTip(null);return;}event.preventDefault();const next=Math.max(0,Math.min(days.length-1,index+delta));setFocused(next);const cell=event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next],scroller=cell?.parentElement?.parentElement;cell?.focus({preventScroll:true});if(cell&&scroller){const r=cell.getBoundingClientRect(),bounds=scroller.getBoundingClientRect();scroller.scrollLeft+=Math.min(0,r.left-bounds.left)+Math.max(0,r.right-bounds.right);}}}/>)}
  </div><div className="token-activity-months" style={{gridTemplateColumns:`repeat(${columns},minmax(10px,1fr))`}} aria-hidden="true">{monthPositions.map(({day,column})=><span key={day.day} style={{gridColumn:column+1}}>{Number(day.day.slice(5,7))}月</span>)}</div></div>
  {tip&&<div className="token-activity-tooltip" role="tooltip" style={{left:tip.x,top:tip.y}}>{description(tip.day)}</div>}
 </section>;
}
