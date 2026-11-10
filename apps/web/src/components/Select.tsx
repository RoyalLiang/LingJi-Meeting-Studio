import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CaretDown, Check } from '@phosphor-icons/react';
import './Select.css';
type Option = { value: string; label: string; searchText?: string };
export function Select({ value, defaultValue, onChange, options, name, label, disabled = false, readOnly = false, menuMinWidth = 0, triggerContent, searchable = false, singleLine = false, compact = false, onOpen }: { value?: string; defaultValue?: string; onChange?: (value: string) => void; options: Option[]; name?: string; label: string; disabled?: boolean; readOnly?: boolean; menuMinWidth?: number; triggerContent?: ReactNode; searchable?: boolean; singleLine?: boolean; compact?: boolean; onOpen?:()=>void }) {
 const [local, setLocal] = useState(defaultValue ?? options[0]?.value ?? ''), [open, setOpen] = useState(false), [index, setIndex] = useState(0),[query,setQuery]=useState('');
 const [position,setPosition] = useState<CSSProperties>({});
 const selected=value ?? local, root=useRef<HTMLDivElement>(null), popup=useRef<HTMLDivElement>(null), button=useRef<HTMLButtonElement|HTMLInputElement>(null), id=useId();
 const opening=useRef(onOpen);opening.current=onOpen;
 useEffect(()=>{if(open)opening.current?.();},[open]);
 const matches=searchable?options.filter(option=>(option.label+' '+(option.searchText||'')).normalize('NFKC').toLocaleLowerCase().includes(query.trim().normalize('NFKC').toLocaleLowerCase())):options;
 useEffect(()=>{setIndex(current=>Math.max(0,Math.min(current,matches.length-1)));},[matches.length]);
 const choose=(next:string)=>{setLocal(next);setQuery('');onChange?.(next);setOpen(false);button.current?.focus();};
 useEffect(()=>{
  const outside=(e:PointerEvent)=>{if (!root.current?.contains(e.target as Node) && !popup.current?.contains(e.target as Node)) setOpen(false);};
  document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);
 },[]);
 useLayoutEffect(()=>{
  if (!open) return;
  popup.current?.showPopover();
  const place=()=>{
   const rect=button.current?.getBoundingClientRect();if(!rect)return;
   const height=window.visualViewport?.height || innerHeight, width=window.visualViewport?.width || innerWidth;
   const below=height-rect.bottom-12, above=rect.top-12, flip=below<Math.min(240,matches.length*44+Math.max(0,matches.length-1)*8+10) && above>below;
   const maxHeight=Math.max(44,Math.min(300,flip?above:below));
   const menuWidth=Math.min(Math.max(rect.width,menuMinWidth),width-16);
   setPosition({position:'fixed',left:Math.max(8,Math.min(rect.left,width-menuWidth-8)),width:menuWidth,minWidth:menuMinWidth?menuWidth:undefined,maxHeight,top:flip?'auto':rect.bottom+4,bottom:flip?height-rect.top+4:'auto'});
  };
  place();addEventListener('resize',place);addEventListener('scroll',place,true);visualViewport?.addEventListener('resize',place);
  return()=>{popup.current?.hidePopover();removeEventListener('resize',place);removeEventListener('scroll',place,true);visualViewport?.removeEventListener('resize',place);};
 },[open,matches.length,menuMinWidth]);
 useEffect(()=>{if(open){const menu=popup.current,option=menu?.querySelector<HTMLElement>(`[data-option-index="${index}"]`);if(menu&&option){const top=option.offsetTop,bottom=top+option.offsetHeight;if(top<menu.scrollTop)menu.scrollTop=top;else if(bottom>menu.scrollTop+menu.clientHeight)menu.scrollTop=bottom-menu.clientHeight;}}},[index,open]);
 return <div ref={root} className={`select select-enhanced ${compact?'select-compact':''} ${open?'is-open':''}`} onKeyDown={e=>{
  if(disabled || readOnly || !options.length || e.nativeEvent?.isComposing)return;
  if(e.key==='Escape'&&open){e.preventDefault();e.stopPropagation();setOpen(false);button.current?.focus();}
  if(e.key==='Tab')setOpen(false);
  if(['ArrowDown','ArrowUp',...(!searchable?['Home','End']:[])].includes(e.key)){
   e.preventDefault();setOpen(true);setIndex(i=>e.key==='Home'?0:e.key==='End'?matches.length-1:Math.max(0,Math.min(matches.length-1,(open?i:Math.max(0,options.findIndex(o=>o.value===selected)))+(e.key==='ArrowDown'?1:-1))));
  }
  if(open && (e.key==='Enter'||!searchable&&e.key===' ')){e.preventDefault();if(matches.length)choose(matches[index]?.value ?? matches[0].value);}
 }}>
  {name && <input type="hidden" name={name} value={selected}/>}
  {searchable?<div className="select-editable"><input ref={node=>{button.current=node;}} className="select-trigger" type="text" role="combobox" aria-label={label} title={options.find(o=>o.value===selected)?.label} aria-autocomplete="list" aria-haspopup="listbox" aria-controls={id} aria-expanded={open} aria-activedescendant={open&&matches.length?`${id}-${index}`:undefined} autoComplete="off" disabled={disabled||!options.length} readOnly={readOnly} placeholder="输入名称或路径" value={open?query:options.find(o=>o.value===selected)?.label||''} onFocus={()=>{if(!readOnly){setQuery('');setOpen(true);setIndex(0);}}} onClick={()=>{if(!readOnly&&!open){setQuery('');setOpen(true);setIndex(0);}}} onChange={e=>{setQuery(e.target.value);setOpen(true);setIndex(0);}} onBlur={()=>{setOpen(false);setQuery('');}}/><CaretDown size={16}/></div>:<button type="button" ref={node=>{button.current=node;}} disabled={disabled||!options.length} aria-disabled={disabled||readOnly||!options.length} className="select-trigger" role="combobox" aria-label={label} aria-haspopup="listbox" aria-controls={id} aria-expanded={open} aria-activedescendant={open?`${id}-${index}`:undefined} onClick={()=>{if(readOnly)return;button.current?.focus({preventScroll:true});setOpen(!open);setIndex(Math.max(0,options.findIndex(o=>o.value===selected)));}}><span title={options.find(o=>o.value===selected)?.label}>{triggerContent ?? options.find(o=>o.value===selected)?.label ?? label}</span><CaretDown size={16}/></button>}
  {createPortal(<div ref={popup} popover="manual" className={`select-options select-portal select-menu ${singleLine?'select-single-line':''} ${compact?'select-compact':''}`} data-state={open?'open':'closed'} data-placement={position.bottom==='auto'?'bottom':'top'} style={position} role="listbox" id={id} aria-label={label}>{matches.map((option,i)=><div key={option.value} id={`${id}-${i}`} data-option-index={i} title={option.label} role="option" aria-selected={selected===option.value} className={index===i?'focused':''} onPointerMove={()=>setIndex(i)} onPointerDown={e=>{e.preventDefault();choose(option.value);}}><span>{option.label}</span><span className="select-option-indicator" aria-hidden="true">{selected===option.value && <Check size={15} weight="bold"/>}</span></div>)}{searchable&&!matches.length&&<div className="select-empty" role="status">没有匹配的项目</div>}</div>,button.current?.closest('dialog') || document.body)}
 </div>;
}
