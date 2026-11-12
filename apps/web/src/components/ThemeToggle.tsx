import {useEffect,useRef,useState} from 'react';
import {Moon,Sun} from '@phosphor-icons/react';
import {Button} from './ui';

export function ThemeToggle(){
  const [theme,setTheme]=useState(()=>document.documentElement.dataset.theme==='dark'?'dark':'light');
  const frame=useRef(0);
  useEffect(()=>()=>{cancelAnimationFrame(frame.current);delete document.documentElement.dataset.themeSwitching;},[]);
  return <Button variant="ghost" aria-label={theme==='light'?'切换深色':'切换浅色'} onClick={()=>{
    const next=theme==='light'?'dark':'light';
    cancelAnimationFrame(frame.current);
    document.documentElement.dataset.themeSwitching='true';
    document.documentElement.dataset.theme=next;
    frame.current=requestAnimationFrame(()=>{frame.current=requestAnimationFrame(()=>{delete document.documentElement.dataset.themeSwitching;});});
    try{localStorage.setItem('meeting-theme',next);}catch{/* The palette still changes when storage is unavailable. */}
    document.dispatchEvent(new Event('meeting:theme'));
    setTheme(next);
  }}>{theme==='light'?<Moon size={17}/>:<Sun size={17}/>}</Button>;
}
