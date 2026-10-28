import type { Evidence } from '../model';

export function MinuteSpeakers({ evidence, speakers }: { evidence: Evidence[]; speakers: Map<string,string> }) {
  const labels=[...new Set(evidence.map(ref=>speakers.get(`${ref.segmentId}:${ref.revision}`) || '来源待核对'))];
  return <span className="minute-speakers" aria-label="说话人" title={labels.includes('未区分说话人')?'转录未提供可核实的说话人身份，可在逐字记录中标注或使用支持说话人区分的服务。':undefined}>{labels.join('、') || '未区分说话人'}</span>;
}
