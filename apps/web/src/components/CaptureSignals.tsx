import { Headphones, Microphone, WarningCircle } from '@phosphor-icons/react';
import type { CaptureSignal } from '../audio/signal';

export function CaptureSignals({ signals }: { signals: CaptureSignal[] }) {
  if (!signals.length) return null;
  return <section className="capture-signals" aria-label="音源信号检测">{signals.map(signal => {
    const warning = ['silent', 'muted', 'suspended'].includes(signal.status);
    return <div className="source-signal" data-status={signal.status} key={signal.sourceId}>
      <div className="source-signal-heading">{signal.kind === 'display' ? <Headphones size={17}/> : <Microphone size={17}/>}<b>{signal.kind === 'display' ? '会议声音' : '我的声音'}</b><span className="source-signal-state">{signal.status === 'audible' ? '已接入' : warning ? '检查音源' : '等待声音'}</span></div>
      <div className="source-signal-meter" role="meter" aria-label={`${signal.kind === 'display' ? '会议声音' : '我的声音'}音量`} aria-valuenow={Math.round(Math.min(1, signal.rms * 8) * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ transform: `scaleX(${Math.min(1, signal.rms * 8)})` }}/></div>
      {warning && <p role="status"><WarningCircle size={14}/>{signal.status === 'suspended' ? '音频处理已暂停' : signal.status === 'muted' ? '音源被静音' : '暂未采到声音'}</p>}
    </div>;
  })}</section>;
}
