import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BookmarkSimple, Microphone, Pause, Play, Stop } from '@phosphor-icons/react';
import { MOBILE_PCM_BYTES, WAV_PCM_LIMIT } from '../sync/mobile-pcm';
import type { MobileRecording } from '../sync/mobile-library';
import { Button } from './ui';

const waveSize = 28;

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

  async function start() {
    setPhase('starting');
    onActive?.(true);
    setElapsed(0);
    setLastMark(-1);
    currentMarks.current = [];
    setError('');
    let context: AudioContext | undefined, stream: MediaStream | undefined;
    const close = () => {
      stream?.getTracks().forEach(track => track.stop());
      dispatchEvent(new Event('lingji:recording-closed'));
      if (context && context.state !== 'closed') void context.close().catch(() => {});
    };
    closeCapture.current = close;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioWorkletNode) throw new Error('此浏览器暂不支持录音');
      context = new AudioContext({ latencyHint: 'interactive' });
      const resumed = context.resume();
      void resumed.catch(() => {});
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 1 }, noiseSuppression: true, echoCancellation: true, autoGainControl: true },
      });
      dispatchEvent(new Event('lingji:recording-opened'));
      if (!mounted.current) { close(); return; }
      await resumed;
      await context.audioWorklet.addModule('/audio-worklet.js?v=2');
      if (!mounted.current) { close(); return; }
      const node = new AudioWorkletNode(context, 'meeting-pcm');
      const mute = context.createGain();
      mute.gain.value = 0;
      const rumble = context.createBiquadFilter();
      rumble.type = 'highpass';
      rumble.frequency.value = 75;
      rumble.Q.value = 0;
      context.createMediaStreamSource(stream).connect(rumble).connect(node).connect(mute).connect(context.destination);
      const pending: Uint8Array<ArrayBuffer>[] = [];
      const id = crypto.randomUUID(), at = Date.now();
      const name = '手机录音 · ' + new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
      let size = 0, ending = false, finished = false, deadline = 0;
      setCapturePaused.current = paused => {
        if (ending) return;
        node.port.postMessage({ type: paused ? 'pause' : 'resume' });
        for (const track of stream?.getAudioTracks() ?? []) track.enabled = !paused;
        setPhase(paused ? 'paused' : 'recording');
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        finishCapture.current = null;
        setCapturePaused.current = null;
        node.port.onmessage = null;
        close();
        if (!mounted.current) return;
        onLiveRecording?.('');
        if (!size) { setError('没有录到音频'); setPhase('idle'); onActive?.(false); return; }
        void persist(async () => {
          await drain().catch(() => drain());
          await commit({ id, title: name, at, seconds: Math.floor(size / MOBILE_PCM_BYTES), marks: currentMarks.current.slice() }, queued);
        });
      };
      finishCapture.current = () => {
        if (ending) return;
        ending = true;
        setPhase('saving');
        node.port.postMessage({ type: 'pause', reason: 'finish' });
        deadline = window.setTimeout(finish, 2000);
      };
      node.port.onmessage = ({ data }) => {
        if (data.type === 'flushed') { if (ending && data.reason === 'finish') finish(); return; }
        if (data.type === 'meter') {
          levels.shift();
          levels.push(Math.max(.15, Math.min(1, Math.sqrt(Math.max(0, data.value || 0)) * 2.5)));
          for (let index = 0; index < levels.length; index++) {
            const bar = wave.current?.children[index] as HTMLElement | undefined;
            if (bar) bar.style.setProperty('--wave-level', String(levels[index]));
          }
          return;
        }
        if (data.type !== 'pcm') return;
        const pcm = data.buffer as ArrayBuffer;
        const available = Math.min(pcm.byteLength, WAV_PCM_LIMIT - size);
        if (available > 0) {
          pending.push(new Uint8Array(available === pcm.byteLength ? pcm : pcm.slice(0, available)));
          size += available;
          if (!writing) void drain().catch(() => {
            if (mounted.current && !ending) finishCapture.current?.();
          });
          setElapsed(Math.floor(size / MOBILE_PCM_BYTES));
        }
        if (size >= WAV_PCM_LIMIT || pending.length >= 48) finishCapture.current?.();
      };
      stream.getAudioTracks()[0]?.addEventListener('ended', () => finishCapture.current?.(), { once: true });
      setPhase('recording');
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
