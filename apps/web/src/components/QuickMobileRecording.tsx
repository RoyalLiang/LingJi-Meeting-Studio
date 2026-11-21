import { useEffect, useRef, useState } from 'react';
import { BookmarkSimple, CaretDown, Microphone, Pause, Play, Stop } from '@phosphor-icons/react';
import { MOBILE_PCM_BYTES, WAV_PCM_LIMIT } from '../sync/mobile-pcm';
import type { MobileRecording } from '../sync/mobile-library';
import { Button } from './ui';

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
  const [showChoices, setShowChoices] = useState(false);
  const control = useRef<HTMLButtonElement>(null);
  const wave = useRef<HTMLDivElement>(null);
  const currentMarks = useRef<number[]>([]);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'paused' | 'saving'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const draft = useRef<(() => Promise<void>) | null>(null);
  const closeCapture = useRef<(() => void) | null>(null);
  const finishCapture = useRef<(() => void) | null>(null);
  const setCapturePaused = useRef<((paused: boolean) => void) | null>(null);
  const mounted = useRef(false);

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
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      dispatchEvent(new Event('lingji:recording-opened'));
      if (!mounted.current) { close(); return; }
      await resumed;
      await context.audioWorklet.addModule('/audio-worklet.js?v=2');
      if (!mounted.current) { close(); return; }
      const node = new AudioWorkletNode(context, 'meeting-pcm');
      const mute = context.createGain();
      mute.gain.value = 0;
      context.createMediaStreamSource(stream).connect(node).connect(mute).connect(context.destination);
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
      const levels = Array.from({ length: 13 }, () => .13);
      let size = 0, ending = false, finished = false, deadline = 0;
      setCapturePaused.current = paused => {
        if (ending) return;
        node.port.postMessage({ type: paused ? 'pause' : 'resume' });
        for (const track of stream?.getAudioTracks() ?? []) track.enabled = !paused;
        setShowChoices(paused);
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
          levels.push(Math.max(.13, Math.min(1, Math.sqrt(Math.max(0, data.value || 0)) * 2.5)));
          for (let index = 0; index < levels.length; index++) {
            const bar = wave.current?.children[index] as HTMLElement | undefined;
            if (bar) bar.style.transform = `scaleY(${levels[index]})`;
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
  const label = phase === 'recording' ? '暂停录音' : phase === 'paused' ? '录音已暂停，继续或结束' : phase === 'saving' ? '正在保存' : phase === 'starting' ? '正在启动' : draft.current ? '重试保存' : '开始录音';
  const capturing = phase === 'recording' || phase === 'paused';
  if (!visible) return (capturing || phase === 'saving' || draft.current) && <aside className="quick-mobile-mini" aria-label="录音状态">
    <span><i aria-hidden="true"/>{capturing ? time : label}</span>
    <Button variant="ghost" onClick={showRecorder}>返回记录</Button>
  </aside>;
  const choicesOpen = phase === 'paused' && showChoices;
  return <section className="quick-mobile-recording" data-phase={phase} aria-label="快速记录">
    <div className="quick-mobile-controls" onKeyDown={event => {
      if (event.key === 'Escape' && choicesOpen) { setShowChoices(false); control.current?.focus(); }
    }}>
      <button type="button" ref={control} className="button quick-mobile-control" aria-label={label}
        aria-expanded={phase === 'paused' ? choicesOpen : undefined}
        disabled={phase === 'starting' || phase === 'saving'} onClick={() => {
          if (phase === 'recording') setCapturePaused.current?.(true);
          else if (phase === 'paused') setShowChoices(open => !open);
          else if (draft.current) void persist(draft.current);
          else void start();
        }}>
        <span key={phase} className="quick-mobile-symbol" aria-hidden="true">
          {phase === 'recording' ? <Pause size={29} weight="fill"/> : phase === 'paused'
            ? <><Play size={25} weight="fill"/><CaretDown size={12} weight="bold"/></> : phase === 'saving'
              ? <Stop size={25} weight="fill"/> : <Microphone size={31} weight="fill"/>}
        </span>
      </button>
      {choicesOpen && <div className="quick-mobile-choices" aria-label="已暂停的录音">
        <Button variant="ghost" onClick={() => {
          setShowChoices(false);
          setCapturePaused.current?.(false);
          control.current?.focus();
        }}><Play size={16} weight="fill"/>继续</Button>
        <Button variant="ghost" onClick={() => { setShowChoices(false); finishCapture.current?.(); }}>
          <Stop size={16} weight="fill"/>结束
        </Button>
      </div>}
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
      {phase === 'recording' && <div className="quick-mobile-wave" ref={wave} aria-hidden="true">
        {Array.from({ length: 13 }, (_, index) => <i key={index}/>)}
      </div>}
      <div className="quick-mobile-feedback">
        {error ? <p className="quick-mobile-issue" role="alert">{error}</p> : capturing && status && <p role="status">{status}</p>}
      </div>
    </div>
  </section>;
}
