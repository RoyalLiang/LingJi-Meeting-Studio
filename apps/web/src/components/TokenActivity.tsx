import {useId,useRef,useState} from 'react';
import './TokenActivity.css';

type Day={day:string;minutesTokens:number|null;usageIncomplete:boolean};
const compact=new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1});
const value=(day:Day)=>day.minutesTokens===null||day.usageIncomplete&&!day.minutesTokens?'— Tokens':`${compact.format(day.minutesTokens)}${day.usageIncomplete?'+':''} Tokens`;

export function TokenActivity({days}:{days:Day[]}){
  const [selected,setSelected]=useState(''),id=useId(),keyboard=useRef(false);
  if(!days.length)return null;
  const current=days.find(day=>day.day===selected)||days[days.length-1];
  const offset=new Date(`${days[0].day}T00:00:00Z`).getUTCDay(),columns=Math.ceil((offset+days.length)/7),amounts=[...new Set(days.flatMap(day=>day.minutesTokens&&day.minutesTokens>0?[day.minutesTokens]:[]))].sort((a,b)=>a-b);
  const levels=new Map(amounts.map((amount,index)=>[amount,amounts.length===1?4:1+Math.floor(index*3/(amounts.length-1))]));
  const monthPositions=days.flatMap((day,index)=>index===0||day.day.endsWith('-01')?[{day,column:Math.floor((offset+index)/7)}]:[]);
  return <section className="token-activity" aria-label="近一年 Token 活动">
    <header><h2>Token 活动</h2><output id={id} className="token-activity-readout" aria-live="polite" aria-atomic="true"><time dateTime={current.day}>{current.day}</time><strong>{value(current)}</strong></output></header>
    <div className="token-activity-scroll"><div className="token-activity-calendar" style={{gridTemplateColumns:`repeat(${columns},minmax(0,1fr))`}}>
      {Array.from({length:offset},(_,i)=><span key={`offset-${i}`} aria-hidden="true"/>)}
      {days.map((day,index)=><button key={day.day} type="button" className="token-activity-day" data-level={day.minutesTokens===null||day.usageIncomplete&&!day.minutesTokens?'unknown':day.minutesTokens===0?0:levels.get(day.minutesTokens)} data-selected={current.day===day.day} aria-label={`${day.day}，${value(day)}`} aria-describedby={id} tabIndex={current.day===day.day?0:-1}
        onPointerEnter={()=>{if(!keyboard.current)setSelected(day.day);}} onPointerMove={event=>{if(event.movementX||event.movementY){keyboard.current=false;setSelected(day.day);}}} onClick={()=>{keyboard.current=false;setSelected(day.day);}} onFocus={()=>{keyboard.current=true;setSelected(day.day);}}
        onKeyDown={event=>{const delta=({ArrowLeft:-7,ArrowRight:7,ArrowUp:-1,ArrowDown:1,Home:-index,End:days.length-1-index} as Record<string,number>)[event.key];if(delta===undefined)return;event.preventDefault();keyboard.current=true;const next=Math.max(0,Math.min(days.length-1,index+delta));const cell=event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next],scroller=cell?.parentElement?.parentElement;cell?.focus({preventScroll:true});if(cell&&scroller){const r=cell.getBoundingClientRect(),bounds=scroller.getBoundingClientRect();scroller.scrollLeft+=Math.min(0,r.left-bounds.left)+Math.max(0,r.right-bounds.right);}}}/>)}
    </div><div className="token-activity-months" style={{gridTemplateColumns:`repeat(${columns},minmax(0,1fr))`}} aria-hidden="true">{monthPositions.map(({day,column})=><span key={day.day} style={{gridColumn:column+1}}>{Number(day.day.slice(5,7))}月</span>)}</div></div>
    <div className="token-activity-legend" aria-label="颜色越深表示消耗越多"><span>少</span>{[0,1,2,3,4].map(level=><i key={level} data-level={level}/>)}<span>多</span></div>
  </section>;
}
