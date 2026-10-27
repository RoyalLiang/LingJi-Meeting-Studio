import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
export function useContentFollow(update: string, paused: boolean, selector = '[aria-label="会议内容滚动区"]', enabled = true, memoryKey = '') {
  const root = useRef<HTMLElement>(null), end = useRef<HTMLDivElement>(null);
  const memory=useRef<{top:number;following:boolean}|null>(null), loaded=useRef(false), position=useRef(0);
  if(!loaded.current){
    loaded.current=true;
    try{const saved=memoryKey && JSON.parse(localStorage.getItem(memoryKey)||'null');if(saved && Number.isFinite(saved.top) && saved.top>=0 && typeof saved.following==='boolean')memory.current=saved;}catch{/* Reading still works when browser storage is unavailable. */}
  }
  const jumped = useRef(false), wasEnabled = useRef(enabled);
  // Follow intent survives a temporarily inactive job; only user actions change it.
  const follow = useRef(memory.current?.following ?? true), moving = useRef(false), frame = useRef(0), [following,setFollowing] = useState(memory.current?.following ?? true);
  const change = useCallback((value: boolean) => { follow.current=value; setFollowing(value); }, []);
  const align = useCallback(() => {
    const container=root.current?.closest<HTMLElement>(selector), anchor=end.current;
    if (!container || !anchor) return;
    moving.current=true; const target=container.scrollTop+anchor.getBoundingClientRect().bottom-container.getBoundingClientRect().bottom+24;
    const top=Math.min(container.scrollHeight-container.clientHeight,Math.max(0,target));
    if(Math.abs(top-container.scrollTop)>1)container.scrollTo({top,behavior:'instant'});
    cancelAnimationFrame(frame.current); frame.current=requestAnimationFrame(()=>{frame.current=requestAnimationFrame(()=>{moving.current=false;});});
  }, [selector]);
  useLayoutEffect(()=>{
    const container=root.current?.closest<HTMLElement>(selector);
    if(!memoryKey || !container || !memory.current)return;
    container.scrollTo({top:memory.current.top,behavior:'instant'});position.current=container.scrollTop;
  },[memoryKey,selector]);
  useEffect(() => {
    const container=root.current?.closest<HTMLElement>(selector); if (!container) return;
    // A scroll event can pause following, but cannot undo an explicit reading intent.
    // Near the tail, the wheel and its scroll event may arrive in the same React batch.
    const scroll = () => { if(memoryKey && !document.hidden && container.clientHeight>0)position.current=container.scrollTop; if (!follow.current || jumped.current || moving.current || !end.current) return; const bottom=end.current.getBoundingClientRect().bottom, bounds=container.getBoundingClientRect(); if(bottom > bounds.bottom+96 || bottom < bounds.top)change(false); };
    const intent = () => { jumped.current=false; moving.current=false; };
    const readIntent = () => { intent(); change(false); };
    const pauseReading = () => { jumped.current=true; cancelAnimationFrame(frame.current); moving.current=false; change(false); };
    const wheel = (event: WheelEvent) => { intent(); if (event.deltaY<0) change(false); };
    container.addEventListener('scroll',scroll,{passive:true}); container.addEventListener('wheel',wheel,{passive:true}); container.addEventListener('touchmove',readIntent,{passive:true}); container.addEventListener('keydown',readIntent); container.addEventListener('meeting:jump-top',pauseReading); window.addEventListener('meeting:pause-follow',pauseReading);
    const save=()=>{
      if(!memoryKey)return;
      if(!document.hidden && container.clientHeight>0)position.current=container.scrollTop;
      try{localStorage.setItem(memoryKey,JSON.stringify({top:position.current,following:follow.current}));}catch{/* Private mode or a full store must not interrupt reading. */}
    };
    if(memoryKey){window.addEventListener('pagehide',save);document.addEventListener('visibilitychange',save);}
    const resize=new ResizeObserver(()=>{if(enabled && follow.current && !paused)align();}); if(root.current)resize.observe(root.current);
    return () => { save();if(memoryKey){window.removeEventListener('pagehide',save);document.removeEventListener('visibilitychange',save);}resize.disconnect(); cancelAnimationFrame(frame.current); container.removeEventListener('scroll',scroll);container.removeEventListener('wheel',wheel);container.removeEventListener('touchmove',readIntent);container.removeEventListener('keydown',readIntent); container.removeEventListener('meeting:jump-top',pauseReading); window.removeEventListener('meeting:pause-follow',pauseReading); };
  }, [align,change,paused,selector,enabled,memoryKey]);
  useLayoutEffect(() => {
    if(paused)change(false); else if((enabled || wasEnabled.current) && follow.current)align();
    wasEnabled.current=enabled;
  }, [update,paused,align,change,enabled,following]);
  const pause = useCallback(() => change(false),[change]);
  const enable = useCallback(() => { jumped.current=false; change(true); },[change]);
  return {root,end,following,pause,enable,resume:()=>{jumped.current=false;change(true);align();}};
}
