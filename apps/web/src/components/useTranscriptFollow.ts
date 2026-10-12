import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
export function useTranscriptFollow(update: string, paused: boolean) {
  const root = useRef<HTMLElement>(null), end = useRef<HTMLDivElement>(null);
  const follow = useRef(true), moving = useRef(false), frame = useRef(0), [following,setFollowing] = useState(true);
  const change = useCallback((value: boolean) => { follow.current=value; setFollowing(value); }, []);
  const align = useCallback(() => {
    const container=root.current?.closest<HTMLElement>('[aria-label="会议内容滚动区"]'), anchor=end.current;
    if (!container || !anchor) return;
    moving.current=true; const target=container.scrollTop+anchor.getBoundingClientRect().bottom-container.getBoundingClientRect().bottom+24;
    container.scrollTo({top:Math.max(0,target),behavior:'instant'});
    cancelAnimationFrame(frame.current); frame.current=requestAnimationFrame(()=>{frame.current=requestAnimationFrame(()=>{moving.current=false;});});
  }, []);
  useEffect(() => {
    const container=root.current?.closest<HTMLElement>('[aria-label="会议内容滚动区"]'); if (!container) return;
    const scroll = () => { if (moving.current || !end.current) return; const bottom=end.current.getBoundingClientRect().bottom, bounds=container.getBoundingClientRect(); change(bottom <= bounds.bottom+96 && bottom >= bounds.top); };
    const intent = () => { moving.current=false; };
    const wheel = (event: WheelEvent) => { intent(); if (event.deltaY<0) change(false); };
    container.addEventListener('scroll',scroll,{passive:true}); container.addEventListener('wheel',wheel,{passive:true}); container.addEventListener('touchmove',intent,{passive:true}); container.addEventListener('keydown',intent);
    const resize=new ResizeObserver(()=>{if(follow.current && !paused)align();}); if(root.current)resize.observe(root.current);
    return () => { resize.disconnect(); cancelAnimationFrame(frame.current); container.removeEventListener('scroll',scroll);container.removeEventListener('wheel',wheel);container.removeEventListener('touchmove',intent);container.removeEventListener('keydown',intent); };
  }, [align,change,paused]);
  useLayoutEffect(() => { if(paused)change(false); else if(follow.current)align(); }, [update,paused,align,change]);
  const pause = useCallback(() => change(false),[change]);
  const enable = useCallback(() => change(true),[change]);
  return {root,end,following,pause,enable,resume:()=>{change(true);align();}};
}
