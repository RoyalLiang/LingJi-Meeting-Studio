import type { Evidence, MinutesVisual } from '../model';
import { CitationSources } from './CitationSources';
import './minutes-visuals.css';

type Props = { visuals: MinutesVisual[]; cite: (evidence: Evidence) => void };
export function MinutesVisuals({ visuals, cite }: Props) {
  if (!visuals.length) return null;
  return <div className="minutes-visuals">{visuals.map((visual, index) => <figure className={`minutes-visual is-${visual.kind}`} key={`${visual.title}:${index}`}>
    <figcaption>{visual.title}{visual.kind === 'bar' && <small>单位：{visual.unit}</small>}</figcaption>
    {visual.kind === 'timeline' ? <><ol className="minutes-timeline">{visual.entries.map((entry, at) => <li key={at}><span className="timeline-date">{entry.label}</span><p>{entry.text}</p><CitationSources compact evidence={entry.evidence} cite={cite}/></li>)}</ol><p className="visual-note">按会议提及顺序排列，时间保留原话</p></> : (() => {
      const values = visual.entries.map(entry => Number(entry.valueText.replaceAll(',', '')));
      const min = Math.min(0, ...values), max = Math.max(0, ...values), span = max - min || 1;
      return <div className="minutes-bars" role="list" aria-label={`${visual.title}，单位${visual.unit}`}>{visual.entries.map((entry, at) => {
        const value = values[at], zero = -min / span * 100;
        return <div className="minutes-bar-row" role="listitem" key={at}><div className="bar-label"><span>{entry.label}</span><strong>{entry.valueText}<small>{visual.unit}</small></strong></div><div className="minutes-bar-track" aria-hidden="true"><i className="bar-zero" style={{left:`${zero}%`}}/><span style={{left:`${(Math.min(0, value) - min) / span * 100}%`,width:`${Math.abs(value) / span * 100}%`}}/></div><CitationSources compact evidence={entry.evidence} cite={cite}/></div>;
      })}</div>;
    })()}
  </figure>)}</div>;
}
