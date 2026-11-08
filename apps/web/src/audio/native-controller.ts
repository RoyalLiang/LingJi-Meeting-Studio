import {preferredPlayback} from './playback-devices';
import type { DirectStream, DirectSession, DirectProgress, NativeManifest } from './native-direct';
import type { Source } from '../model';
import type { CaptureKind, CaptureIssue, CaptureController as BrowserController } from './capture';
import { preferredDevice } from './devices';
import { api } from '../api';
import { persistNativeChunk, makeChunk, ensureAudioCapacity } from './queue';
import { pcmSignal, signalMessage, type CaptureSignal } from './signal';
import { startNativeStream, startNativeDirect, restoreNativeDirect, controlNativeRecord, stoppedNativeManifest, setNativeKind, nativeAudioDirect } from './native-runtime';
import type { NativeStream } from './native-stream';

export class NativeCaptureController {
  sources: Source[] = []; active = false;
  nativeManifests: NativeManifest[] = [];
  private connecting = new Map<CaptureKind, Promise<Source>>();
  private pausedKinds: CaptureKind[] | null = null;
  private microphoneEnabled = true;
  private streams = new Map<CaptureKind, { stream: NativeStream; source: Source; signal: CaptureSignal; dropped: boolean }>();
  private args: ConstructorParameters<typeof BrowserController>;
  constructor(...args: ConstructorParameters<typeof BrowserController>) { this.args = args; if (typeof args[0] !== 'string') void args[0].catch(() => {}); }
  private report() { this.args[5]?.([...this.streams.values()].map(item => ({ ...item.signal }))); }
  async startMeeting(): Promise<CaptureIssue[]> {
    const kinds: CaptureKind[] = this.pausedKinds ?? ['display', ...(this.microphoneEnabled ? ['microphone' as const] : [])];
    if (!kinds.length) return [{kind:'display',message:'请选择要接入的音源后再继续录制。'}];
    const results = await Promise.allSettled(kinds.map(kind => this.start(kind)));
    return results.flatMap((result, index) => result.status === 'rejected' && !(kinds[index] === 'microphone' && !this.microphoneEnabled)
      ? [{ kind: kinds[index], message: result.reason instanceof Error ? result.reason.message : String(result.reason) }] : []);
  }
  async start(kind: CaptureKind, selected = kind==='display'?preferredPlayback():preferredDevice()): Promise<Source> {
    if (kind === 'microphone') this.microphoneEnabled = true;
    const existing = this.streams.get(kind); if (existing) return existing.source;
    const pending = this.connecting.get(kind); if (pending) return pending;
    const promise = this.connect(kind, selected).finally(() => this.connecting.delete(kind));
    this.connecting.set(kind, promise); return promise;
  }
  private async connect(kind: CaptureKind, deviceId: string) {
    if (nativeAudioDirect()) return this.connectDirect(kind, deviceId);
    await ensureAudioCapacity();
    const recordId = await this.args[0];
    let resolveSource!: (source: Source) => void, rejectSource!: (error: unknown) => void;
    const ready = new Promise<Source>((resolve, reject) => { resolveSource = resolve; rejectSource = reject; });
    void ready.catch(() => {});
    let quiet = 0, dropped = false, persistenceFailed = false, failure: Error | undefined;
    const stream = await startNativeStream(kind, deviceId, async packet => {
      const source = await ready;
      if (dropped) return;
      const signal = this.streams.get(kind)?.signal;
      const { rms } = pcmSignal(packet.buffer), seconds = packet.buffer.byteLength / 32000;
      if (signal) {
        signal.rms = rms; signal.seconds = Math.max(signal.seconds, (packet.sampleOffset + packet.buffer.byteLength / 2) / 16000); quiet = rms >= 0.0005 ? 0 : quiet + seconds;
        Object.assign(signal, signalMessage(signal, quiet, false, 'running'));
        if (kind === 'display' && quiet >= 5) signal.message = '连续 5 秒没有收到系统播放声音，请播放会议声音并检查系统音频权限。';
        this.args[1](rms); this.report();
      }
      try {
        const chunk = await makeChunk(source.id, source.epoch, packet.sequence, packet.sampleOffset, packet.buffer, source.sessionId);
        if (!dropped) { await persistNativeChunk(recordId, chunk); this.args[3](); }
      } catch (error) { persistenceFailed = true; throw error; }
    }, (error, retaining) => {
      failure = error;
      if (persistenceFailed || retaining) { this.args[2](error); void this.stop().catch(() => {}); return; }
      const entry = this.streams.get(kind);
      if (!entry) return; // Connection failures are reported by start/startMeeting.
      entry.dropped = true; this.streams.delete(kind);
      this.sources = this.sources.filter(source => source.id !== entry.source.id);
      this.active = this.streams.size > 0; this.report();
      void entry.stream.stop(true).catch(() => {});
      void Promise.allSettled([...this.connecting.values()]).then(() => {
        if (!this.active) this.args[4]();
        this.args[2](new Error(`${kind === 'display' ? '会议声音' : '我的声音'}中断：${error.message}。${this.active ? '其他音源继续录制，可重新接入此音源。' : '会议已暂停，可恢复录制；尚未结束本场。'}`), true);
      });
    }, progress => {
      const signal = this.streams.get(kind)?.signal;
      if (!signal) return;
      signal.seconds = Math.max(signal.seconds, progress.sampleEnd / 16000);
      this.report();
    });
    try {
      const source = await api<Source>(`/records/${recordId}/sources`, 'POST', { kind, label: stream.label });
      if (failure) throw failure;
      const signal: CaptureSignal = { sourceId: source.id, kind, label: source.label, rms: 0, seconds: 0, status: 'checking', message: '原生音源已接入，正在检查声音' };
      // The closure flag also prevents a hash/persistNativeChunk finishing after microphone disconnect.
      const entry = { stream, source, signal, get dropped() { return dropped; }, set dropped(value: boolean) { dropped = value; } };
      this.streams.set(kind, entry); this.sources.push(source); this.active = true; resolveSource(source); this.report(); return source;
    } catch (error) { dropped = true; rejectSource(error); await stream.stop(true).catch(() => {}); throw error; }
  }
  async finishNative(action: 'pause' | 'seal') { if (nativeAudioDirect()) await controlNativeRecord(await this.args[0], action); }
  async restore(sessions: DirectSession[]) {
    const wanted = new Map(sessions.map(session=>[session.source.kind,session]));
    this.microphoneEnabled = Boolean(wanted.get('microphone') && !wanted.get('microphone')?.disconnected);
    if (sessions.every(session => session.stopped)) this.pausedKinds = [...wanted.values()].filter(session=>!session.disconnected).map(session=>session.source.kind).filter((kind):kind is CaptureKind=>kind==='display'||kind==='microphone');
    for (const session of sessions) if (session.stopped) this.nativeManifests.push(await stoppedNativeManifest(session.id));
    for (const session of sessions) if (!session.stopped) {
      const kind = session.source.kind;
      if (kind !== 'display' && kind !== 'microphone') throw new Error('本机音源类型无效');
      await this.connectDirect(kind, 'default', session);
    }
  }
  private retainManifest(stream: NativeStream) {
    const manifest = (stream as DirectStream).manifest;
    if (manifest) this.nativeManifests = [...this.nativeManifests.filter(item => item.sourceId !== manifest.sourceId), manifest];
  }
  private async connectDirect(kind: CaptureKind, selected: string, existing?: DirectSession): Promise<Source> {
    const recordId = await this.args[0];
    if (!existing) {
      if (kind === 'microphone' && !this.microphoneEnabled) throw new Error('已取消麦克风接入');
      await setNativeKind(recordId,kind,true);
      if (kind === 'microphone' && !this.microphoneEnabled) { await setNativeKind(recordId,kind,false); throw new Error('已取消麦克风接入'); }
    }
    const onError = (error: Error | null, retaining?: boolean) => {
      if (retaining) { if (error) this.args[2](error, true); return; }
      const entry = this.streams.get(kind); if (!entry) return;
      this.retainManifest(entry.stream); this.streams.delete(kind);
      this.sources = this.sources.filter(source => source.id !== entry.source.id); this.active = this.streams.size > 0; this.report();
      if (!this.active) this.args[4]();
      if (error) this.args[2](error, this.active);
    };
    const onProgress = (progress: DirectProgress) => {
      const signal = this.streams.get(kind)?.signal; if (!signal) return;
      signal.rms = progress.rms; signal.seconds = progress.sampleEnd / 16000;
      Object.assign(signal, signalMessage(signal, progress.quietSeconds, false, 'running'));
      this.args[1](progress.rms); this.report();
    };
    const stream = existing ? restoreNativeDirect(existing, onError, onProgress) : await startNativeDirect(recordId, kind, selected, onError, onProgress);
    if (kind === 'microphone' && !this.microphoneEnabled) { await stream.stop(); this.retainManifest(stream); throw new Error('已取消麦克风接入'); }
    const source = stream.source;
    const signal: CaptureSignal = { sourceId: source.id, kind, label: source.label, rms: 0, seconds: 0, status: 'checking', message: '正在确认音源' };
    this.streams.set(kind, { stream, source, signal, dropped: false }); this.sources.push(source); this.active = true; this.report(); return source;
  }
  async disconnect(kind: CaptureKind) {
    if (kind === 'microphone') this.microphoneEnabled = false;
    if (this.pausedKinds) this.pausedKinds = this.pausedKinds.filter(value => value !== kind);
    if (nativeAudioDirect()) await setNativeKind(await this.args[0],kind,false);
    const entry = this.streams.get(kind); if (!entry) return;
    if (nativeAudioDirect()) { await entry.stream.stop(); this.retainManifest(entry.stream); }
    entry.dropped = true;
    try { if (!nativeAudioDirect()) await entry.stream.stop(true); }
    finally { this.streams.delete(kind); this.sources = this.sources.filter(source => source.id !== entry.source.id); this.active = this.streams.size > 0; this.args[1](0); this.report(); }
  }
  async stop() {
    this.pausedKinds = null;
    await Promise.allSettled([...this.connecting.values()]);
    const result = await Promise.allSettled([...this.streams.values()].map(entry => entry.stream.stop()));
    for (const entry of this.streams.values()) this.retainManifest(entry.stream);
    const failure = result.find(item => item.status === 'rejected'); if (failure?.status === 'rejected') throw failure.reason;
    this.streams.clear(); this.sources = []; this.active = false; this.args[1](0); this.report();

  }
  async pause() {
    await Promise.allSettled([...this.connecting.values()]);
    const kinds = [...this.streams.keys()]; await this.stop(); this.pausedKinds = kinds;
  }
}
