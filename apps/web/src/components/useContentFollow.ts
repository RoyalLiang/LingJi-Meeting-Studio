import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
export function useContentFollow(update: string, paused: boolean, selector = '[aria-label="会议内容滚动区"]', enabled = true) {
  const root = useRef<HTMLElement>(null), end = useRef<HTMLDivElement>(null);
  const jumped = useRef(false), wasEnabled = useRef(enabled);
  // Follow intent survives a temporarily inactive job; only user actions change it.
  const follow = useRef(true), moving = useRef(false), frame = useRef(0), [following,setFollowing] = useState(true);
  const change = useCallback((value: boolean) => { follow.current=value; setFollowing(value); }, []);
  const align = useCallback(() => {
    const container=root.current?.closest<HTMLElement>(selector), anchor=end.current;
    if (!container || !anchor) return;
    moving.current=true; const target=container.scrollTop+anchor.getBoundingClientRect().bottom-container.getBoundingClientRect().bottom+24;
    container.scrollTo({top:Math.max(0,target),behavior:'instant'});
    cancelAnimationFrame(frame.current); frame.current=requestAnimationFrame(()=>{frame.current=requestAnimationFrame(()=>{moving.current=false;});});
  }, [selector]);
  useEffect(() => {
    const container=root.current?.closest<HTMLElement>(selector); if (!container) return;
    const scroll = () => { if (jumped.current || moving.current || !end.current) return; const bottom=end.current.getBoundingClientRect().bottom, bounds=container.getBoundingClientRect(); change(bottom <= bounds.bottom+96 && bottom >= bounds.top); };
    const intent = () => { jumped.current=false; moving.current=false; };
    const jumpTop = () => { jumped.current=true; cancelAnimationFrame(frame.current); moving.current=false; change(false); };
    const wheel = (event: WheelEvent) => { intent(); if (event.deltaY<0) change(false); };
    container.addEventListener('scroll',scroll,{passive:true}); container.addEventListener('wheel',wheel,{passive:true}); container.addEventListener('touchmove',intent,{passive:true}); container.addEventListener('keydown',intent); container.addEventListener('meeting:jump-top',jumpTop);
    const resize=new ResizeObserver(()=>{if(enabled && follow.current && !paused)align();}); if(root.current)resize.observe(root.current);
    return () => { resize.disconnect(); cancelAnimationFrame(frame.current); container.removeEventListener('scroll',scroll);container.removeEventListener('wheel',wheel);container.removeEventListener('touchmove',intent);container.removeEventListener('keydown',intent); container.removeEventListener('meeting:jump-top',jumpTop); };
  }, [align,change,paused,selector,enabled]);
  useLayoutEffect(() => {
    if(paused)change(false); else if((enabled || wasEnabled.current) && follow.current)align();
    wasEnabled.current=enabled;
  }, [update,paused,align,change,enabled]);
  const pause = useCallback(() => change(false),[change]);
  const enable = useCallback(() => { jumped.current=false; change(true); },[change]);
  return {root,end,following,pause,enable,resume:()=>{jumped.current=false;change(true);align();}};
}
