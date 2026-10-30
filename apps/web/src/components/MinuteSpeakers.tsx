import type { Evidence } from '../model';

export function MinuteSpeakers({ evidence, speakers }: { evidence: Evidence[]; speakers: Map<string,string> }) {
  const labels=[...new Set(evidence.map(ref=>speakers.get(`${ref.segmentId}:${ref.revision}`) || '来源待核对'))];
  if (!labels.length || labels.some(label=>label==='未区分说话人' || label==='来源待核对')) return null;
  return <span className="minute-speakers" aria-label="说话人">{labels.join('、')}</span>;
}
