import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Segment } from '../model';
import { segmentRange } from '../virtual-segments';

export function VirtualSegments({ segments, children, className = '', selector = '[aria-label="会议内容滚动区"]', pinned = '', highlighted = '', resetKey = '' }: {
  segments: Segment[]; children: (segment: Segment, index: number) => ReactNode; className?: string;
  selector?: string; pinned?: string; highlighted?: string; resetKey?: string;
}) {
  const root = useRef<HTMLDivElement>(null), [margin, setMargin] = useState(0);
  const pinnedIndex = pinned ? segments.findIndex(segment => segment.id === pinned) : -1;
  const virtualizer = useVirtualizer({
    count: segments.length, initialRect: {width:0,height:800}, getScrollElement: () => root.current?.closest<HTMLElement>(selector) || null,
    estimateSize: () => 160, getItemKey: index => segments[index].id, scrollMargin: margin,
    rangeExtractor: range => segmentRange(range.startIndex, range.endIndex, range.count, pinnedIndex),
    anchorTo: 'end', followOnAppend: false,
  });
  useLayoutEffect(() => {
    const element=root.current,container=element?.closest<HTMLElement>(selector);
    if(!element||!container)return;
    let frame=0;
    const measure=()=>{const next=container.scrollTop+element.getBoundingClientRect().top-container.getBoundingClientRect().top-container.clientTop;setMargin(previous=>Math.abs(next-previous)>0.5?next:previous);};
    const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);};
    const resize=new ResizeObserver(schedule);
    for(let node:HTMLElement|null=element;node;node=node===container?null:node.parentElement)resize.observe(node);
    const mutation=new MutationObserver(schedule);
    mutation.observe(container,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','class']});
    measure();
    return()=>{cancelAnimationFrame(frame);resize.disconnect();mutation.disconnect();};
  },[selector,resetKey]);
  const lastHighlight = useRef('');
  useLayoutEffect(() => {
    if (!highlighted) { lastHighlight.current = ''; return; }
    if (lastHighlight.current === highlighted) return;
    const index = segments.findIndex(segment => segment.id === highlighted);
    if (index >= 0) { lastHighlight.current = highlighted; virtualizer.scrollToIndex(index, { align: 'center', behavior: 'auto' }); }
  },[highlighted,segments,virtualizer]);
  const previousReset = useRef(resetKey);
  useLayoutEffect(() => {
    if (previousReset.current !== resetKey) { previousReset.current = resetKey; if (segments.length) virtualizer.scrollToIndex(0, { align: 'start' }); }
  }, [resetKey, virtualizer, segments.length]);
  return <div ref={root} className={`virtual-segments ${className}`} role="list" style={{ height: virtualizer.getTotalSize() }}>
    {virtualizer.getVirtualItems().map(item => <div key={item.key} data-index={item.index} data-segment-key={segments[item.index].id} ref={virtualizer.measureElement} role="listitem" aria-posinset={item.index+1} aria-setsize={segments.length} className="virtual-segment-row" style={{ transform: `translateY(${item.start - margin}px)` }}>{children(segments[item.index], item.index)}</div>)}
  </div>;
}
