import { Headphones, Microphone, WarningCircle } from '@phosphor-icons/react';
import type { CaptureSignal } from '../audio/signal';

export function CaptureSignals({ signals }: { signals: CaptureSignal[] }) {
  if (!signals.length) return null;
  return <section className="capture-signals" aria-label="音源信号检测">{signals.map(signal => {
    const warning = ['silent', 'muted', 'suspended'].includes(signal.status);
    return <div className="source-signal" data-status={signal.status} key={signal.sourceId}>
      <div className="source-signal-heading">{signal.kind === 'display' ? <Headphones size={17}/> : <Microphone size={17}/>}<b>{signal.kind === 'display' ? '共享音频' : '麦克风'}</b><span title={signal.label}>{signal.label}</span><span className="source-signal-state">{signal.status === 'audible' ? '有声音' : warning ? '检查音源' : '等待声音'}</span></div>
      <div className="source-signal-meter" role="meter" aria-label={`${signal.kind === 'display' ? '共享音频' : '麦克风'}音量`} aria-valuenow={Math.round(Math.min(1, signal.rms * 8) * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ transform: `scaleX(${Math.min(1, signal.rms * 8)})` }}/></div>
      <p role={warning ? 'status' : undefined}>{warning && <WarningCircle size={15}/>} {signal.message}</p>
    </div>;
  })}</section>;
}
