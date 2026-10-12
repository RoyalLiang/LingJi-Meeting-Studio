import { useEffect, useRef, useState } from 'react';

// Animate only a live append. ASR corrections replace immediately; history never replays.
export function LiveTranscriptText({text}:{text:string}) {
  const [displayed,setDisplayed]=useState('');
  const current=useRef('');
  useEffect(()=>{
    if(matchMedia('(prefers-reduced-motion: reduce)').matches || !text.startsWith(current.current)){
      current.current=text;setDisplayed(text);return;
    }
    const units=typeof Intl.Segmenter==='function' ? [...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].map(s=>s.segment) : Array.from(text);
    let count=Array.from(current.current).length;
    // Count graphemes rather than UTF-16 code units, including emoji sequences.
    if(typeof Intl.Segmenter==='function')count=[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(current.current)].length;
    const step=Math.max(1,Math.ceil((units.length-count)/5));
    const timer=setInterval(()=>{
      count=Math.min(units.length,count+step);current.current=units.slice(0,count).join('');setDisplayed(current.current);
      if(count===units.length)clearInterval(timer);
    },20);
    return()=>clearInterval(timer);
  },[text]);
  return <><span aria-hidden="true" data-live-text>{displayed}<span className="live-caret"/></span><span className="sr-only">{text}</span></>;
}
