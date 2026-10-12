import { preferredDevice, openMicrophone } from './devices';
import { api } from '../api';
import type { RecordDetail, Source, SourceKind } from '../model';
import { drainQueue, enqueue, makeChunk } from './queue';
import { pcmSignal, signalMessage } from './signal';
import type { CaptureSignal } from './signal';

export const capabilities = () => ({ secure: window.isSecureContext, microphone: Boolean(navigator.mediaDevices?.getUserMedia),
  display: Boolean(navigator.mediaDevices?.getDisplayMedia), worklet: Boolean(window.AudioWorkletNode), indexedDB: Boolean(window.indexedDB),
  browser: navigator.userAgent, online: navigator.onLine });
export class CaptureController {
  private streams: MediaStream[] = []; private contexts: AudioContext[] = []; private nodes: AudioWorkletNode[] = [];
  private writes: Promise<void>[] = []; private flushes: (() => void)[] = [];
  private signals: CaptureSignal[] = [];
  sources: Source[] = []; active = false;
  constructor(private recordId: string, private onMeter: (value: number) => void, private onFailure: (error: Error) => void,
    private onSaved: () => void, private onEnded: () => void, private onSignals: (signals: CaptureSignal[]) => void = () => {}) {}
  async startMeeting() {
    await this.start('display');
    try { await this.start('microphone'); }
    catch { throw new Error('共享音频已开始，但麦克风未启用。当前只记录共享声音；可点击“加麦克风”重试或结束录音。'); }
  }
  async start(kind: Exclude<SourceKind, 'import'>, selectedDevice = preferredDevice()) {
    // The browser permission request must remain in the original user gesture.
    const displayOptions = { video: true, audio: true, systemAudio: 'include', surfaceSwitching: 'include' };
    const permission = kind === 'display' ? navigator.mediaDevices.getDisplayMedia(displayOptions)
      : openMicrophone(selectedDevice);
    const stream = await permission;
    if (!stream.getAudioTracks().length) { stream.getTracks().forEach(t => t.stop()); throw new Error('共享来源没有音轨。请选择带音频的标签页并勾选共享音频，或改用麦克风/导入。'); }
    let context: AudioContext | undefined;
    try {
      context = new AudioContext({ latencyHint: 'interactive' }); await context.resume();
      if (context.state !== 'running') throw new Error('浏览器未启动音频处理，请检查站点权限后重新开始。');
      const source = await api<Source>(`/records/${this.recordId}/sources`, 'POST', { kind, label: stream.getAudioTracks()[0]?.label || (kind === 'display' ? '共享音轨' : '默认麦克风') });
      await context.audioWorklet.addModule('/audio-worklet.js');
      const input = context.createMediaStreamSource(stream), node = new AudioWorkletNode(context, 'meeting-pcm');
      const mute = context.createGain(); mute.gain.value = 0; input.connect(node).connect(mute).connect(context.destination);
      let sequence = 0, offset = 0;
      const track = stream.getAudioTracks()[0]; let quietSeconds = 0;
      const signal: CaptureSignal = { sourceId: source.id, kind, label: source.label, rms: 0, seconds: 0, status: 'checking', message: '' };
      this.signals.push(signal);
      const report = () => {
        Object.assign(signal, signalMessage(signal, quietSeconds, track.muted, context!.state));
        this.onSignals(this.signals.map(item => ({ ...item })));
      };
      track.addEventListener('mute', report); track.addEventListener('unmute', report);
      context.addEventListener('statechange', report); report();
      node.port.onmessage = event => {
        if (event.data.type === 'meter') { this.onMeter(event.data.value); return; }
        if (event.data.type === 'flushed') { this.flushes.shift()?.(); return; }
        if (event.data.type !== 'pcm') return;
        const { rms } = pcmSignal(event.data.buffer), seconds = event.data.buffer.byteLength / 32000;
        signal.rms = rms; signal.seconds += seconds; quietSeconds = rms >= 0.0005 ? 0 : quietSeconds + seconds; report();
        const current = sequence++, start = offset; offset += event.data.buffer.byteLength / 2;
        const write = makeChunk(source.id, source.epoch, current, start, event.data.buffer, source.sessionId).then(chunk => enqueue(this.recordId, chunk)).then(this.onSaved)
          .catch(error => { this.onFailure(error); void this.stop(); });
        this.writes.push(write);
        if (this.writes.length > 100) this.writes.splice(0, this.writes.length - 100);
      };
      stream.getTracks().forEach(track => track.addEventListener('ended', () => { if (this.active) this.onEnded(); }, { once: true }));
      this.streams.push(stream); this.contexts.push(context); this.nodes.push(node); this.sources.push(source); this.active = true;
      return source;
    } catch (error) { stream.getTracks().forEach(t => t.stop()); await context?.close(); throw error; }
  }
  async stop() {
    if (!this.active) return; this.active = false;
    await Promise.all(this.nodes.map(node => new Promise<void>(resolve => {
      const timer = window.setTimeout(resolve, 2000); this.flushes.push(() => { clearTimeout(timer); resolve(); }); node.port.postMessage({ type: 'flush' });
    })));
    this.streams.forEach(s => s.getTracks().forEach(t => t.stop())); await Promise.all(this.contexts.map(c => c.close()));
    await Promise.all(this.writes); this.streams = []; this.nodes = []; this.contexts = []; this.onMeter(0); this.signals = []; this.onSignals([]);
  }
}
export async function importAudio(file: File, record: RecordDetail, progress: (value: number) => void) {
  if (file.size > 64 * 1024 * 1024) throw new Error('音频文件超过 64 MB，请先拆分；浏览器解码需要足够内存。');
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    if (decoded.duration > 120 * 60) throw new Error('单次导入最多两小时。');
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000), node = offline.createBufferSource();
    node.buffer = decoded; node.connect(offline.destination); node.start(); const rendered = await offline.startRendering(), values = rendered.getChannelData(0);
    const source = await api<Source>(`/records/${record.id}/sources`, 'POST', { kind: 'import', label: file.name });
    for (let offset = 0, sequence = 0; offset < values.length; offset += 32000, sequence++) {
      const length = Math.min(32000, values.length - offset), pcm = new ArrayBuffer(length * 2), view = new DataView(pcm);
      for (let i = 0; i < length; i++) view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, values[offset + i])) * 32767), true);
      await enqueue(record.id, await makeChunk(source.id, source.epoch, sequence, offset, pcm, source.sessionId)); await drainQueue(); progress((offset + length) / values.length);
    }
  } finally { await context.close(); }
}
