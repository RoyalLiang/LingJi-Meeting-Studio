import { Headphones, Microphone } from '@phosphor-icons/react';
import type { CaptureSignal } from '../audio/signal';

export function CaptureSignals({ signals }: { signals: CaptureSignal[] }) {
  if (!signals.length) return null;
  return <section className="capture-signals" aria-label="音源信号检测">{signals.map(signal => {
    const label = signal.kind === 'display' ? '会议声音' : '我的声音';
    const state = signal.status === 'audible' ? '已接入' : signal.status === 'suspended' ? '音频处理已暂停'
      : signal.status === 'muted' ? '音源被静音' : signal.status === 'ended' ? '采集已结束' : '等待声音';
    return <div className="source-signal" data-status={signal.status} key={signal.sourceId} role="group" aria-label={`${label}：${state}`} title={signal.message || state}>
      <div className="source-signal-heading">{signal.kind === 'display' ? <Headphones size={17} aria-hidden="true"/> : <Microphone size={17} aria-hidden="true"/>}<b>{label}</b></div>
      <div className="source-signal-meter" role="meter" aria-label={`${label}音量`} aria-valuenow={Math.round(Math.min(1, signal.rms * 8) * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ transform: `scaleX(${Math.min(1, signal.rms * 8)})` }}/></div>
    </div>;
  })}</section>;
}
