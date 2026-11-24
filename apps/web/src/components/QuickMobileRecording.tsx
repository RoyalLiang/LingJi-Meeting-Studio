import audioWorkletSource from '../../public/audio-worklet.js?raw';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BookmarkSimple, Microphone, Pause, Play, Stop } from '@phosphor-icons/react';
import { MOBILE_PCM_BYTES, WAV_PCM_LIMIT } from '../sync/mobile-pcm';
import type { MobileRecording } from '../sync/mobile-library';
import { pcmBytes } from '../audio/pcm';
import { Button } from './ui';

const waveSize = 28;
const meterInterval = 80;

export function QuickMobileRecording({ append, commit, status, visible, showRecorder, onActive, onLiveRecording }: {
  append: (entry: MobileRecording, sequence: number, offset: number, bytes: Uint8Array<ArrayBuffer>) => Promise<void>;
  commit: (entry: MobileRecording, sequence: number) => Promise<void>;
  visible: boolean;
  showRecorder: () => void;
  status: string;
  onActive?: (active: boolean) => void;
  onLiveRecording?: (id: string) => void;
}) {
  const [lastMark, setLastMark] = useState(-1);
  const wave = useRef<HTMLDivElement>(null);
  const currentMarks = useRef<number[]>([]);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'paused' | 'saving'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const mainControl = useRef<HTMLButtonElement>(null);
  const resumeControl = useRef<HTMLButtonElement>(null);
  const moveControlFocus = useRef(false);
  const draft = useRef<(() => Promise<void>) | null>(null);
  const closeCapture = useRef<(() => void) | null>(null);
  const finishCapture = useRef<(() => void) | null>(null);
  const setCapturePaused = useRef<((paused: boolean) => void) | null>(null);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    if (!moveControlFocus.current) return;
    moveControlFocus.current = false;
    const control = phase === 'paused' ? resumeControl : mainControl;
    if (visible) control.current?.focus({ preventScroll: true });
  }, [phase, visible]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; closeCapture.current?.(); onActive?.(false); };
  }, [onActive]);

  useEffect(() => {
    if (phase === 'idle' && !draft.current) return;
    const keepOpen = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    addEventListener('beforeunload', keepOpen);
    return () => removeEventListener('beforeunload', keepOpen);
  }, [phase]);

  async function persist(commit: () => Promise<void>) {
    draft.current = commit;
    setPhase('saving');
    setError('');
    try {
      await commit();
      draft.current = null;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败，请重试');
    } finally {
      if (mounted.current) { setPhase('idle'); onActive?.(Boolean(draft.current)); }
    }
  }

  const detectSystemAudio = useRef<() => void>(() => {});
  useEffect(() => {
    const detect = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== 'system-audio-detected') return;
      detectSystemAudio.current();
    };
    addEventListener('lingji:system-audio', detect);
    return () => removeEventListener('lingji:system-audio', detect);
  }, []);
  useLayoutEffect(() => {
    detectSystemAudio.current = () => {
      if (phase === 'idle' && !draft.current && !closeCapture.current) void start(true);
      else dispatchEvent(new Event('lingji:system-audio-disarm'));
    };
  });

  async function start(system = false) {
    setPhase('starting');
    onActive?.(true);
    setElapsed(0);
    setLastMark(-1);
    currentMarks.current = [];
    setError('');
    const native = !system && /\bLingJi-Android\/(?:0\.4-preview\.(?:2[7-9]|[3-9]\d|\d{3,}))\b/.test(navigator.userAgent);
    const nativeMeter = native && !/\bLingJi-Android\/0\.4-preview\.27\b/.test(navigator.userAgent);
    let context: AudioContext | undefined, stream: MediaStream | undefined;
    let systemListener: ((event: Event) => void) | undefined;
    let nativeListener: ((event: Event) => void) | undefined;
    let pollMeter: (() => void) | undefined;
    let readNative: (() => void) | undefined;
    let nativePoll = 0, nativeDeadline = 0, meterTimer = 0, meterFrame = 0;
    const sendNative = (detail: string) => dispatchEvent(new CustomEvent('lingji:native-microphone', { detail }));
    const close = () => {
      stream?.getTracks().forEach(track => track.stop());
      closeCapture.current = null;
      if (systemListener) removeEventListener('lingji:system-audio', systemListener);
      if (nativeListener) removeEventListener('lingji:native-microphone-result', nativeListener);
      if (pollMeter) document.removeEventListener('visibilitychange', pollMeter);
      if (readNative) document.removeEventListener('visibilitychange', readNative);
      clearTimeout(nativePoll);
      clearTimeout(nativeDeadline);
      clearTimeout(meterTimer);
      cancelAnimationFrame(meterFrame);
      dispatchEvent(new Event(system ? 'lingji:system-audio-disarm' : 'lingji:recording-closed'));
      if (context && context.state !== 'closed') void context.close().catch(() => {});
    };
    closeCapture.current = close;
    try {
      let node: AudioWorkletNode | undefined;
      if (!system && !native) {
        if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioWorkletNode) throw new Error('此浏览器暂不支持录音');
        context = new AudioContext({ latencyHint: 'interactive' });
        const resumed = context.resume();
        void resumed.catch(() => {});
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 }, noiseSuppression: true, echoCancellation: true, autoGainControl: false },
        });
        dispatchEvent(new Event('lingji:recording-opened'));
        if (!mounted.current) { close(); return; }
        await resumed;
        if (/\bLingJi-iOS\//.test(navigator.userAgent)) {
          const module = URL.createObjectURL(new Blob([audioWorkletSource], { type: 'text/javascript' }));
          try { await context.audioWorklet.addModule(module); } finally { URL.revokeObjectURL(module); }
        } else await context.audioWorklet.addModule('/audio-worklet.js?v=2');
        if (!mounted.current) { close(); return; }
        node = new AudioWorkletNode(context, 'meeting-pcm');
        const mute = context.createGain();
        mute.gain.value = 0;
        const rumble = context.createBiquadFilter();
        rumble.type = 'highpass';
        rumble.frequency.value = 70;
        rumble.Q.value = 0;
        const hiss = context.createBiquadFilter();
        hiss.type = 'lowpass';
        hiss.frequency.value = 7000;
        hiss.Q.value = 0;
        context.createMediaStreamSource(stream).connect(rumble).connect(hiss).connect(node).connect(mute).connect(context.destination);
      }
      const pending: Uint8Array<ArrayBuffer>[] = [];
      const id = crypto.randomUUID(), at = Date.now();
      const name = (system ? '会议录音' : '手机录音') + ' · ' + new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      let queued = 0, offset = 0;
      let writing: Promise<void> | null = null;
      function drain() {
        return writing ??= (async () => {
          while (pending.length) {
            const pcm = pending[0];
            await append({ id, title: name, at, seconds: Math.floor((offset * 2 + pcm.length) / MOBILE_PCM_BYTES),
              marks: currentMarks.current.slice() }, queued, offset, pcm);
            queued++;
            offset += pcm.byteLength / 2;
            pending.shift();
            pcm.fill(0);
          }
        })().finally(() => { writing = null; });
      }
      onLiveRecording?.(id);
      const levels = Array.from({ length: waveSize }, () => .15);
      const systemPacket = system ? new Uint8Array(MOBILE_PCM_BYTES) : null;
      let systemBuffered = 0;
      let size = 0, ending = false, finished = false, deadline = 0, capturePaused = false;
      let displayedSeconds = 0, latestLevel = 0;
      const updateElapsed = (bytes: number) => {
        const seconds = Math.floor(bytes / MOBILE_PCM_BYTES);
        if (seconds > displayedSeconds) {
          displayedSeconds = seconds;
          setElapsed(seconds);
        }
      };
      setCapturePaused.current = paused => {
        if (ending) return;
        flushSystemPacket();
        if (finished) return;
        capturePaused = paused;
        node?.port.postMessage({ type: paused ? 'pause' : 'resume' });
        for (const track of stream?.getAudioTracks() ?? []) track.enabled = !paused;
        dispatchEvent(new CustomEvent('lingji:recording-state', { detail: `${system ? 'system-' : ''}${paused ? 'pause' : 'resume'}:${displayedSeconds}` }));
        setPhase(paused ? 'paused' : 'recording');
      };
      const finish = (interrupted = false) => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        finishCapture.current = null;
        setCapturePaused.current = null;
        flushSystemPacket();
        if (node) node.port.onmessage = null;
        close();
        if (!mounted.current) return;
        if (!size) {
          onLiveRecording?.('');
          setError('没有录到音频');
          setPhase('idle');
          onActive?.(false);
          return;
        }
        void persist(async () => {
          await drain().catch(() => drain());
          await commit({ id, title: name, at, seconds: Math.floor(size / MOBILE_PCM_BYTES), marks: currentMarks.current.slice() }, queued);
          if (interrupted && mounted.current) setError('麦克风录音已中断，可用片段已保存');
        });
      };
      finishCapture.current = () => {
        if (ending) return;
        ending = true;
        setPhase('saving');
        if (native) {
          sendNative('native-finish:' + id);
          readNative?.();
          return;
        }
        if (!node) { finish(); return; }
        node.port.postMessage({ type: 'pause', reason: 'finish' });
        deadline = window.setTimeout(() => finish(), 2000);
      };
      const onAudio = (data: { type: string; reason?: string; value?: number; buffer?: ArrayBuffer }) => {
        if (data.type === 'flushed') { if (ending && data.reason === 'finish') finish(); return; }
        if (data.type === 'meter') {
          if (capturePaused || ending || document.hidden) return;
          latestLevel = Math.max(.15, Math.min(1, Math.sqrt(Math.max(0, data.value || 0)) * 2.5));
          if (!meterFrame) meterFrame = requestAnimationFrame(() => {
            meterFrame = 0;
            if (!wave.current || document.hidden || capturePaused || ending) return;
            levels.shift();
            levels.push(latestLevel);
            for (let index = 0; index < levels.length; index++) {
              const bar = wave.current.children[index] as HTMLElement;
              bar.style.setProperty('--wave-level', String(levels[index]));
            }
          });
          return;
        }
        if (data.type !== 'pcm' || !data.buffer) return;
        const pcm = data.buffer;
        const available = Math.min(pcm.byteLength, WAV_PCM_LIMIT - size);
        if (available > 0) {
          pending.push(new Uint8Array(available === pcm.byteLength ? pcm : pcm.slice(0, available)));
          size += available;
          if (!writing) void drain().catch(() => {
            if (!nativeMeter && mounted.current && !ending) finishCapture.current?.();
          });
          if (!nativeMeter) updateElapsed(size);
        }
        if (size >= WAV_PCM_LIMIT || pending.length >= 48) finishCapture.current?.();
      };

      function flushSystemPacket() {
        if (!systemPacket || !systemBuffered) return;
        const buffer = systemPacket.slice(0, systemBuffered).buffer;
        systemBuffered = 0;
        onAudio({ type: 'pcm', buffer });
      }
      if (node) node.port.onmessage = ({ data }) => onAudio(data);
      else if (native) {
        let captured = 0, ready = false, reading = false;
        const read = () => {
          clearTimeout(nativePoll);
          if (finished || reading || (nativeMeter && document.hidden && !ending)) return;
          if (pending.length > 8) {
            if (!writing) void drain().catch(() => {});
            nativePoll = window.setTimeout(read, 250);
            return;
          }
          reading = true;
          sendNative('native-read:' + id + ':' + captured);
        };
        const nativeError = (message: string) => {
          if (size) { finish(true); return; }
          finish();
          setError(message);
        };
        nativeListener = event => {
          const result = (event as CustomEvent<string>).detail;
          if (!result.startsWith(id + ':') || finished) return;
          const data = result.slice(id.length + 1);
          if (data === 'error') { nativeError('麦克风录音中断，请重试'); return; }
          if (data === 'permission') { nativeError('请允许麦克风权限后重试'); return; }
          if (data === 'end') { finish(); return; }
          if (data === 'status:starting') return;
          if (data !== 'starting' && !ready) {
            ready = true;
            clearTimeout(nativeDeadline);
            if (!ending) setPhase('recording');
          }
          if (data.startsWith('status:')) {
            if (document.hidden || ending) return;
            const [, bytes, rms] = data.split(':');
            updateElapsed(Number(bytes));
            onAudio({ type: 'meter', value: Number(rms) });
            return;
          }
          reading = false;
          if (data === 'wait' || data === 'starting') {
            nativePoll = window.setTimeout(read, 250);
          } else {
                const bytes = pcmBytes(data);
            captured += bytes.length;
            if (!nativeMeter) {
              const pcm = new Int16Array(bytes.buffer);
              const meanSquare = pcm.reduce((sum, sample) => sum + sample * sample, 0) / pcm.length / 32768 ** 2;
              onAudio({ type: 'meter', value: Math.sqrt(meanSquare) });
            }
            onAudio({ type: 'pcm', buffer: bytes.buffer });
            nativePoll = window.setTimeout(read, 0);
          }
        };
        addEventListener('lingji:native-microphone-result', nativeListener);
        sendNative('native-start:' + id);
        nativeDeadline = window.setTimeout(() => nativeError('无法启动麦克风录音，请重试'), 45_000);
        if (nativeMeter) {
          pollMeter = function refreshMeter() {
            clearTimeout(meterTimer);
            if (document.hidden || finished || ending) return;
            sendNative('native-status:' + id);
            meterTimer = window.setTimeout(refreshMeter, meterInterval);
          };
          document.addEventListener('visibilitychange', pollMeter);
          readNative = read;
          document.addEventListener('visibilitychange', read);
          pollMeter();
        }
        read();
      }
      else if (systemPacket) {
        systemListener = event => {
          const data = (event as CustomEvent<string>).detail;
          if (data === 'system-audio-ended') finish();
          if (!data.startsWith('system-audio-frame:') || ending || capturePaused) return;
          const bytes = pcmBytes(data.slice('system-audio-frame:'.length));
          const pcm = new Int16Array(bytes.buffer);
          const meanSquare = pcm.reduce((sum, sample) => sum + sample * sample, 0) / pcm.length / 32768 ** 2;
          onAudio({ type: 'meter', value: Math.sqrt(meanSquare) });
          systemPacket.set(bytes, systemBuffered);
          systemBuffered += bytes.byteLength;
          if (systemBuffered === systemPacket.length) flushSystemPacket();
        };
        addEventListener('lingji:system-audio', systemListener);
      }
      stream?.getAudioTracks()[0]?.addEventListener('ended', () => finishCapture.current?.(), { once: true });
      if (!native) setPhase('recording');
    } catch (failure) {
      close();
      if (!mounted.current) return;
      if (failure instanceof DOMException && failure.name === 'NotAllowedError') setError('请允许麦克风权限后重试');
      else if (failure instanceof DOMException && failure.name === 'NotReadableError') setError('麦克风暂时无法使用，请重试');
      else setError(failure instanceof Error ? failure.message : '无法启动录音');
      setPhase('idle');
      onActive?.(false);
    }
  }

  const time = String(Math.floor(elapsed / 60)).padStart(2, '0') + ':' + String(elapsed % 60).padStart(2, '0');
  const label = phase === 'recording' ? '暂停录音' : phase === 'paused' ? '继续录音' : phase === 'saving' ? '正在保存' : phase === 'starting' ? '正在启动' : draft.current ? '重试保存' : '开始录音';
  const paused = phase === 'paused';
  const capturing = phase === 'recording' || paused;
  const feedback = paused ? '已暂停' : status;
  if (!visible) return (capturing || phase === 'saving' || draft.current) && <aside className="quick-mobile-mini" aria-label="录音状态">
    <span><i aria-hidden="true"/>{capturing ? time : label}</span>
    <Button variant="ghost" onClick={showRecorder}>返回记录</Button>
  </aside>;
  return <section className="quick-mobile-recording" data-phase={phase} aria-label="快速记录">
    <div className="quick-mobile-controls">
      <div className="quick-mobile-primary" inert={paused}>
        {capturing && <div className="quick-mobile-wave" ref={wave} aria-hidden="true">
          {Array.from({ length: waveSize }, (_, index) => <i key={index} style={{ transform: `rotate(${index * 360 / waveSize}deg)` }}/>)}
        </div>}
        <button ref={mainControl} type="button" className="button quick-mobile-control" aria-label={paused ? '暂停录音' : label}
          disabled={paused || phase === 'starting' || phase === 'saving'} onClick={event => {
            if (phase === 'recording') {
              moveControlFocus.current = event.detail === 0;
              setCapturePaused.current?.(true);
            } else if (draft.current) void persist(draft.current);
            else void start();
          }}>
          <span key={capturing ? 'capture' : phase} className="quick-mobile-symbol" aria-hidden="true">
            {capturing ? <Pause size={29} weight="fill"/>
              : phase === 'saving' ? <Stop size={25} weight="fill"/>
              : <Microphone size={31} weight="fill"/>}
          </span>
        </button>
      </div>
      <div className="quick-mobile-paused-actions" inert={!paused}>
        <button ref={resumeControl} type="button" className="quick-mobile-action" aria-label="继续录音" disabled={!paused}
          onClick={event => {
            moveControlFocus.current = event.detail === 0;
            setCapturePaused.current?.(false);
          }}>
          <span className="quick-mobile-action-icon"><Play size={24} weight="fill" aria-hidden="true"/></span>
          <span>继续</span>
        </button>
        <button type="button" className="quick-mobile-action quick-mobile-action-end" aria-label="结束录音" disabled={!paused}
          onClick={() => finishCapture.current?.()}>
          <span className="quick-mobile-action-icon"><Stop size={23} weight="fill" aria-hidden="true"/></span>
          <span>结束</span>
        </button>
      </div>
    </div>
    <div className="quick-mobile-details">
      {(capturing || phase === 'saving') && <div className="quick-mobile-clock">
        <time className="quick-mobile-time" aria-label={`录音用时 ${time}`}>{time}</time>
        {phase === 'recording' && <button type="button" className="button quick-mobile-mark" aria-label="标重点"
          aria-pressed={lastMark === elapsed} onClick={() => {
            if (currentMarks.current.includes(elapsed)) return;
            currentMarks.current = [...currentMarks.current, elapsed];
            setLastMark(elapsed);
          }}><BookmarkSimple size={17} weight={lastMark === elapsed ? 'fill' : 'regular'}/></button>}
      </div>}
      <div className="quick-mobile-feedback">
        {error ? <p className="quick-mobile-issue" role="alert">{error}</p> : capturing && feedback && <p role="status">{feedback}</p>}
      </div>
    </div>
  </section>;
}
