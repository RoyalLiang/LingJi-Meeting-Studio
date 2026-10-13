import { useMemo, useState } from 'react';
import { ChatCircleText, Clock, CaretDown } from '@phosphor-icons/react';
import { citationContext, type CitationSelection } from '../citation-context';
import { timecode } from '../model';
import { Button, Modal } from './ui';
import './CitationContext.css';

export function CitationContext({ selection, close }: { selection: CitationSelection; close: () => void }) {
  const [radius, setRadius] = useState(2);
  const context = useMemo(() => citationContext(selection, radius), [selection, radius]);
  return <Modal title="引用原文" onClose={close} wide>
    <div className="source-context">
      <div className="source-context-meta"><span><ChatCircleText size={16}/>引用原文</span>{selection.transcriptRevision !== undefined && <span>转录 v{selection.transcriptRevision}</span>}</div>
      {context ? <><ol className="source-context-list" aria-label="引用及前后文">{context.segments.map(segment => {
        const selected = segment.id === context.target.id && segment.revision === context.target.revision;
        return <li key={`${segment.id}:${segment.revision}`} className={selected ? 'source-context-hit' : ''} aria-current={selected ? 'true' : undefined}>
          <div className="source-context-speaker"><b>{segment.speaker || '未标注说话人'}</b><span><Clock size={13}/>{timecode(segment.startMs)}–{timecode(segment.endMs)}</span>{selected && <small>引用片段 · v{segment.revision}</small>}</div>
          <p>{segment.text}</p>
        </li>;
      })}</ol>{context.hasMore && <Button variant="ghost" className="source-context-more" onClick={() => setRadius(current => current + 3)}><CaretDown size={16}/>更多上下文</Button>}</> : <p className="source-context-missing" role="status">此版本的引用快照暂不可用。</p>}
    </div>
  </Modal>;
}
