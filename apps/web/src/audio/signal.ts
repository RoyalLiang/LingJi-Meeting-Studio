import type { SourceKind } from '../model';
export interface CaptureSignal {
  sourceId: string; kind: SourceKind; label: string; rms: number; seconds: number;
  status: 'checking' | 'audible' | 'quiet' | 'silent' | 'muted' | 'suspended' | 'ended'; message: string;
}
export function pcmSignal(buffer: ArrayBuffer) {
  const samples = new DataView(buffer); let energy = 0;
  for (let offset = 0; offset + 1 < samples.byteLength; offset += 2) {
    const value = samples.getInt16(offset, true) / 32768; energy += value * value;
  }
  return { rms: Math.sqrt(energy / Math.max(1, samples.byteLength / 2)) };
}
export function signalMessage(signal: CaptureSignal, quietSeconds: number, muted: boolean, contextState: string) {
  if (contextState === 'closed') return { status: 'ended' as const, message: '采集已结束' };
  if (contextState !== 'running') return { status: 'suspended' as const, message: '音频处理已暂停，请结束录音后重新开始' };
  if (muted) return { status: 'muted' as const, message: '浏览器音轨已静音，请检查系统输入或共享来源' };
  if (quietSeconds >= 5) return { status: 'silent' as const, message: signal.kind === 'display'
    ? '连续 5 秒没有收到声音；请播放共享标签页，并确认勾选了共享音频'
    : '连续 5 秒没有收到声音；请说一句话，检查系统麦克风权限，或结束录音后切换输入设备' };
  if (signal.rms >= 0.0005) return { status: 'audible' as const, message: '已采到声音' };
  return { status: signal.seconds > 0 ? 'quiet' as const : 'checking' as const, message: signal.seconds > 0 ? '等待声音' : '正在检查音频信号' };
}
