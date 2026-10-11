import { useEffect, useId, useRef, useState } from 'react';
import { CaretDown, Check } from '@phosphor-icons/react';
type Option = { value: string; label: string };
export function Select({ value, defaultValue, onChange, options, name, label, disabled = false }: { value?: string; defaultValue?: string; onChange?: (value: string) => void; options: Option[]; name?: string; label: string; disabled?: boolean }) {
  const [local, setLocal] = useState(defaultValue ?? options[0]?.value ?? ''), [open, setOpen] = useState(false), [index, setIndex] = useState(0);
  const selected = value ?? local, root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), id = useId();
  const choose = (next: string) => { setLocal(next); onChange?.(next); setOpen(false); button.current?.focus(); };
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, []);
  useEffect(() => { if (open) root.current?.querySelector<HTMLElement>(`[data-option-index="${index}"]`)?.scrollIntoView({block:'nearest'}); }, [index, open]);
  return <div ref={root} className={`select ${open ? 'is-open' : ''}`} onKeyDown={e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); button.current?.focus(); }
    if (e.key === 'Tab') setOpen(false);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); setOpen(true);
      setIndex(i => e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : Math.max(0, Math.min(options.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))));
    }
    if (open && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choose(options[index].value); }
  }}>
    {name && <input type="hidden" name={name} value={selected}/>}
    <button type="button" ref={button} disabled={disabled} className="select-trigger" role="combobox" aria-label={label} aria-haspopup="listbox" aria-controls={id} aria-expanded={open} aria-activedescendant={open ? `${id}-${index}` : undefined} onClick={() => { setOpen(!open); setIndex(Math.max(0, options.findIndex(o => o.value === selected))); }}>
      <span>{options.find(o => o.value === selected)?.label || label}</span><CaretDown size={15}/>
    </button>
    {open && <div className="select-options" role="listbox" id={id} aria-label={label}>{options.map((option, i) => <div key={option.value} id={`${id}-${i}`} data-option-index={i} role="option" aria-selected={selected === option.value} className={index === i ? 'focused' : ''} onPointerMove={() => setIndex(i)} onPointerDown={e => { e.preventDefault(); choose(option.value); }}><span>{option.label}</span>{selected === option.value && <Check size={16}/>}</div>)}</div>}
  </div>;
}
