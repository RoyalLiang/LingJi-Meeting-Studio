import {useEffect,useId,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {DotsThree} from '@phosphor-icons/react';
import {Button} from './ui';

export function MeetingMoreMenu({children}:{children:ReactNode}){
  const [open,setOpen]=useState(false),trigger=useRef<HTMLSpanElement>(null),menu=useRef<HTMLDivElement>(null),id=useId(),last=useRef(false);
  const items=()=>[...menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')||[]];
  const opener=()=>trigger.current?.querySelector('button');
  const close=(restore=false)=>{setOpen(false);if(restore)opener()?.focus({preventScroll:true});};
  useLayoutEffect(()=>{
    const node=menu.current,button=opener();if(!open||!node||!button)return;
    // The reader clips its contents; the menu belongs in the viewport's top layer.
    const width=Math.min(252,innerWidth-24);node.style.width=`${width}px`;node.style.maxHeight=`${Math.min(440,innerHeight-24)}px`;
    node.showPopover?.();const rect=button.getBoundingClientRect(),height=node.getBoundingClientRect().height;
    node.style.left=`${Math.max(12,Math.min(rect.right-width,innerWidth-width-12))}px`;
    node.style.top=`${Math.max(12,rect.bottom+8+height>innerHeight&&rect.top>height+12?rect.top-height-8:Math.min(rect.bottom+8,innerHeight-height-12))}px`;
    (last.current?items().at(-1):items()[0])?.focus({preventScroll:true});
    return()=>{if(node.isConnected&&typeof node.hidePopover==='function'&&node.matches(':popover-open'))node.hidePopover();};
  },[open]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:Event)=>{const target=event.target as Node;if(!menu.current?.contains(target)&&!trigger.current?.contains(target))setOpen(false);};
    const scroll=(event:Event)=>{if(!menu.current?.contains(event.target as Node))setOpen(false);};
    const resize=()=>close(true);
    document.addEventListener('pointerdown',outside,true);document.addEventListener('focusin',outside);document.addEventListener('scroll',scroll,true);addEventListener('resize',resize);
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('focusin',outside);document.removeEventListener('scroll',scroll,true);removeEventListener('resize',resize);};
  },[open]);
  return <><span ref={trigger} className="meeting-more-anchor"><Button className="meeting-more-trigger" aria-label="更多会议操作" aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={()=>{last.current=false;setOpen(value=>!value);}} onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();last.current=event.key==='ArrowUp';setOpen(true);}}}><DotsThree size={21} weight="bold"/></Button></span>{createPortal(<div ref={menu} id={id} role="menu" aria-label="更多会议操作" popover="manual" data-state={open?'open':'closed'} className="meeting-more-menu" onClick={event=>{if((event.target as HTMLElement).closest('[role="menuitem"]:not(:disabled)'))close(true);}} onKeyDown={event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);return;}
    if(event.key==='Tab'){close(true);return;}
    const list=items(),index=list.indexOf(document.activeElement as HTMLButtonElement);let next:number|undefined;
    if(event.key==='ArrowDown')next=(index+1)%list.length;else if(event.key==='ArrowUp')next=(index+list.length-1)%list.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=list.length-1;
    if(next!==undefined){event.preventDefault();event.stopPropagation();list[next]?.focus();}
  }}>{children}</div>,document.body)}</>;
}
