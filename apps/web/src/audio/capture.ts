import { preferredDevice, openMicrophone } from './devices';
import { api } from '../api';
import type { RecordDetail, Source, SourceKind } from '../model';
import { drainQueue, enqueue, makeChunk } from './queue';
import { pcmSignal, signalMessage } from './signal';
import type { CaptureSignal } from './signal';

export const capabilities = () => ({ secure: window.isSecureContext, microphone: Boolean(navigator.mediaDevices?.getUserMedia),
  display: Boolean(navigator.mediaDevices?.getDisplayMedia), worklet: Boolean(window.AudioWorkletNode), indexedDB: Boolean(window.indexedDB),
  browser: navigator.userAgent, online: navigator.onLine });
export type CaptureKind = Exclude<SourceKind, 'import'>;
export type CaptureIssue = { kind: CaptureKind; message: string };
function captureFailure(kind: CaptureKind, error: unknown) {
  const name = error instanceof Error ? error.name : '';
  const label = kind === 'display' ? '会议音频' : '麦克风';
  if (name === 'NotAllowedError') return kind === 'display'
    ? '会议音频尚未授权。重新接入后，选择会议所在标签页或系统音频，并允许共享声音。'
    : '麦克风尚未授权。请在浏览器的网站权限中允许使用麦克风，再重新接入。';
  if (name === 'NotFoundError') return `没有找到可用的${label}。请检查设备连接及浏览器支持。`;
  if (name === 'NotReadableError') return `${label}暂时无法使用，请检查系统权限或其他应用是否占用设备。`;
  return error instanceof Error ? error.message : `${label}未能接入，请重试。`;
}
export class CaptureController {
  private finishing = Promise.resolve();
  private retained = new Map<CaptureKind, MediaStream>();
  private microphoneEnabled = true;
  private connecting = new Map<CaptureKind, Promise<Source>>();
  private disconnected = new WeakSet<AudioWorkletNode>();
  private streams: MediaStream[] = []; private contexts: AudioContext[] = []; private nodes: AudioWorkletNode[] = [];
  private writes: Promise<void>[] = []; private flushes: (() => void)[] = [];
  private signals: CaptureSignal[] = [];
  sources: Source[] = []; active = false;
  constructor(private recordId: string | Promise<string>, private onMeter: (value: number) => void, private onFailure: (error: Error) => void,
    private onSaved: () => void, private onEnded: () => void, private onSignals: (signals: CaptureSignal[]) => void = () => {}) {
    // Permission denial can settle before record creation fails. Observe the deferred ID immediately.
    if (typeof recordId !== 'string') void recordId.catch(() => {});
  }
  async startMeeting(): Promise<CaptureIssue[]> {
    // Reuse only the sources active before pause; an explicitly disabled microphone stays off.
    const kinds: CaptureKind[] = this.retained.size ? [...this.retained.keys()] : ['display', ...(this.microphoneEnabled ? ['microphone' as const] : [])];
    const requests = kinds.map(kind => this.start(kind));
    const results = await Promise.allSettled(requests);
    return results.flatMap((result, index) => result.status === 'rejected'
      ? [{ kind: kinds[index], message: captureFailure(kinds[index], result.reason) }] : []);
  }
  async start(kind: CaptureKind, selectedDevice = preferredDevice()) {
    if (kind === 'microphone') this.microphoneEnabled = true;
    const existing = this.active && this.sources.find(source => source.kind === kind);
    if (existing) return existing;
    const pending = this.connecting.get(kind);
    if (pending) return pending;
    const request = this.connectSource(kind, selectedDevice);
    this.connecting.set(kind, request);
    try { return await request; } finally { this.connecting.delete(kind); }
  }
  private async connectSource(kind: CaptureKind, selectedDevice: string) {
    let retained = this.retained.get(kind);
    this.retained.delete(kind);
    if (retained && !retained.getAudioTracks().some(track => track.readyState === 'live')) { retained.getTracks().forEach(track => track.stop()); retained = undefined; }
    if (!retained && kind === 'display' && !navigator.mediaDevices?.getDisplayMedia) throw new Error('当前浏览器无法接入会议音频。可先使用麦克风；在线会议建议使用支持标签页音频共享的浏览器。');
    if (!retained && kind === 'microphone' && !navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器无法接入麦克风，请使用安全连接下的现代浏览器。');
    // The browser permission request must remain in the original user gesture.
    const displayOptions = { video: { displaySurface: 'monitor' }, audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false, suppressLocalAudioPlayback:false }, systemAudio: 'include', windowAudio:'system', selfBrowserSurface:'exclude', surfaceSwitching: 'include' };
    const permission = retained ? Promise.resolve(retained) : kind === 'display' ? navigator.mediaDevices.getDisplayMedia(displayOptions)
      : openMicrophone(selectedDevice);
    const stream = await permission;
    if (!stream.getAudioTracks().length) { stream.getTracks().forEach(t => t.stop()); throw new Error('共享来源没有音轨。请选择带音频的标签页并勾选共享音频，或改用麦克风/导入。'); }
    let context: AudioContext | undefined;
    try {
      const recordId = await this.recordId;
      context = new AudioContext({ latencyHint: 'interactive' }); await context.resume();
      if (context.state !== 'running') throw new Error('浏览器未启动音频处理，请检查站点权限后重新开始。');
      const source = await api<Source>(`/records/${recordId}/sources`, 'POST', { kind, label: stream.getAudioTracks()[0]?.label || (kind === 'display' ? '共享音轨' : '默认麦克风') });
      await context.audioWorklet.addModule('/audio-worklet.js');
      const input = context.createMediaStreamSource(stream), node = new AudioWorkletNode(context, 'meeting-pcm');
      const mute = context.createGain(); mute.gain.value = 0; input.connect(node).connect(mute).connect(context.destination);
      let sequence = 0, offset = 0;
      const track = stream.getAudioTracks()[0]; let quietSeconds = 0;
      const signal: CaptureSignal = { sourceId: source.id, kind, label: source.label, rms: 0, seconds: 0, status: 'checking', message: '' };
      this.signals.push(signal);
      const report = () => {
        if (!track.enabled || track.muted) signal.rms = 0;
        Object.assign(signal, signalMessage(signal, quietSeconds, !track.enabled || track.muted, context!.state));
        this.onSignals(this.signals.map(item => ({ ...item })));
      };
      track.addEventListener('mute', report); track.addEventListener('unmute', report);
      context.addEventListener('statechange', report); report();
      node.port.onmessage = event => {
        if (this.disconnected.has(node)) return;
        if (event.data.type === 'meter') { this.onMeter(event.data.value); return; }
        if (event.data.type === 'flushed') { this.flushes.shift()?.(); return; }
        if (event.data.type !== 'pcm') return;
        if (!track.enabled || track.muted || track.readyState === 'ended') { signal.rms = 0; report(); return; }
        const { rms } = pcmSignal(event.data.buffer), seconds = event.data.buffer.byteLength / 32000;
        signal.rms = rms; signal.seconds += seconds; quietSeconds = rms >= 0.0005 ? 0 : quietSeconds + seconds; report();
        const current = sequence++, start = offset; offset += event.data.buffer.byteLength / 2;
        const write = makeChunk(source.id, source.epoch, current, start, event.data.buffer, source.sessionId).then(chunk => this.disconnected.has(node) ? undefined : enqueue(recordId, chunk)).then(this.onSaved)
          .catch(error => { this.onFailure(error); void this.stop(); });
        this.writes.push(write);
        if (this.writes.length > 100) this.writes.splice(0, this.writes.length - 100);
      };
      stream.getTracks().forEach(track => track.addEventListener('ended', () => { if (this.active) this.onEnded(); }, { once: true }));
      this.streams.push(stream); this.contexts.push(context); this.nodes.push(node); this.sources.push(source); this.active = true;
      return source;
    } catch (error) { stream.getTracks().forEach(t => t.stop()); await context?.close(); throw error; }
  }
  async disconnect(kind: CaptureKind) {
    if (kind === 'microphone') this.microphoneEnabled = false;
    this.retained.get(kind)?.getTracks().forEach(track => track.stop()); this.retained.delete(kind);
    const index = this.sources.findIndex(source => source.kind === kind);
    if (index < 0) return;
    const [node] = this.nodes.splice(index, 1), [stream] = this.streams.splice(index, 1), [context] = this.contexts.splice(index, 1);
    const [source] = this.sources.splice(index, 1);
    // Discard this input's unfinished packet; reopening creates a new Source/epoch.
    this.disconnected.add(node); node.port.onmessage = null;
    stream.getTracks().forEach(track => track.stop());
    this.signals = this.signals.filter(signal => signal.sourceId !== source.id);
    this.active = this.streams.length > 0; this.onMeter(0); this.onSignals(this.signals.map(signal => ({ ...signal })));
    await context.close();
  }
  async pause() { this.finishing = this.finish(true); await this.finishing; }
  async stop() {
    await Promise.allSettled([...this.connecting.values()]);
    await this.finishing;
    await this.finish(false);
  }
  private async finish(retain: boolean) {
    if (!retain) { this.retained.forEach(stream => stream.getTracks().forEach(track => track.stop())); this.retained.clear(); }
    if (!this.active) return;
    this.active = false;
    // The worklet atomically stops input and flushes before its context is closed.
    await Promise.all(this.nodes.map(node => new Promise<void>(resolve => {
      const timer = window.setTimeout(resolve, 2000); this.flushes.push(() => { clearTimeout(timer); resolve(); }); node.port.postMessage({ type: 'pause' });
    })));
    this.streams.forEach((stream, index) => {
      if (retain) this.retained.set(this.sources[index].kind as CaptureKind, stream);
      else stream.getTracks().forEach(track => track.stop());
    });
    await Promise.all(this.contexts.map(context => context.close()));
    await Promise.all(this.writes);
    this.nodes.forEach(node => { this.disconnected.add(node); node.port.onmessage = null; });
    this.streams = []; this.nodes = []; this.contexts = []; this.sources = []; this.writes = []; this.onMeter(0); this.signals = []; this.onSignals([]);
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
