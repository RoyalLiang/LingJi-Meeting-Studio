import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from '@phosphor-icons/react';
import { MOBILE_RECORDING_BYTES, type MobileFrame } from '../sync/mobile';
import { encodeBytes } from '../sync/vault';
import { Button } from './ui';

function wavHeader(size: number) {
  const bytes = new Uint8Array(44), view = new DataView(bytes.buffer), text = new TextEncoder();
  bytes.set(text.encode('RIFF'), 0);
  view.setUint32(4, size + 36, true);
  bytes.set(text.encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(text.encode('data'), 36);
  view.setUint32(40, size, true);
  return bytes;
}

export function QuickMobileRecording({ save, status, live, onActive, onLiveRecording }: {
  save: (blob: Blob, title: string) => Promise<void>;
  status: string;
  live?: (id: string, title: string, frame: MobileFrame) => Promise<void>;
  onActive?: (active: boolean) => void;
  onLiveRecording?: (id: string) => void;
}) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'paused' | 'saving'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const draft = useRef<(() => Promise<void>) | null>(null);
  const waveform = useRef<SVGGElement>(null);
  const closeCapture = useRef<(() => void) | null>(null);
  const finishCapture = useRef<(() => void) | null>(null);
  const setCapturePaused = useRef<((paused: boolean) => void) | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; closeCapture.current?.(); onActive?.(false); };
  }, [onActive]);

  useEffect(() => {
    if (phase === 'idle' && waveform.current) {
      for (const bar of waveform.current.children) bar.setAttribute('y2', '38');
    }
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
    setError('');
    let context: AudioContext | undefined, stream: MediaStream | undefined;
    const close = () => {
      stream?.getTracks().forEach(track => track.stop());
      if (context && context.state !== 'closed') void context.close().catch(() => {});
    };
    closeCapture.current = close;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioWorkletNode) throw new Error('此浏览器暂不支持录音');
      context = new AudioContext({ latencyHint: 'interactive' });
      const resumed = context.resume();
      void resumed.catch(() => {});
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) { close(); return; }
      await resumed;
      await context.audioWorklet.addModule('/audio-worklet.js?v=2');
      if (!mounted.current) { close(); return; }
      const node = new AudioWorkletNode(context, 'meeting-pcm');
      const mute = context.createGain();
      mute.gain.value = 0;
      context.createMediaStreamSource(stream).connect(node).connect(mute).connect(context.destination);
      const chunks: ArrayBuffer[] = [];
      const limit = MOBILE_RECORDING_BYTES;
      const id = crypto.randomUUID();
      const name = '手机录音 · ' + new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
      let queued = 0, offset = 0, beats = 0;
      let writing: Promise<void> | null = null;
      function drain() {
        if (!live) return Promise.resolve();
        return writing ??= (async () => {
          while (queued < chunks.length) {
            const pcm = new Uint8Array(chunks[queued]);
            await live(id, name, { kind: 'pcm', sequence: queued, offset, data: encodeBytes(pcm) });
            chunks[queued++] = new ArrayBuffer(0);
            offset += pcm.byteLength / 2;
          }
        })().finally(() => { writing = null; });
      }
      onLiveRecording?.(live ? id : '');
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
        if (!size) { setError('没有录到音频'); setPhase('idle'); onActive?.(false); return; }
        void persist(async () => {
          if (!live) {
            await save(new Blob([wavHeader(size), ...chunks], { type: 'audio/wav' }), name);
            return;
          }
          await drain();
          await live(id, name, { kind: 'finish', sequence: queued });
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
        if (data.type === 'meter' && !ending && !reduceMotion && waveform.current) {
          const peak = Math.min(28, Math.sqrt(Math.max(0, Number(data.value) || 0)) * 36);
          Array.from(waveform.current.children).forEach((bar, i) => {
            bar.setAttribute('y2', String(38 - peak * (.5 + .5 * Math.sin(i * .65 + beats))));
          });
          beats += .5;
          return;
        }
        if (data.type !== 'pcm') return;
        const pcm = data.buffer as ArrayBuffer;
        const available = Math.min(pcm.byteLength, limit - size);
        if (available > 0) {
          chunks.push(available === pcm.byteLength ? pcm : pcm.slice(0, available));
          size += available;
          if (live) void drain().catch(() => {
            if (mounted.current && !ending) setError('手机暂无法保存音频片段');
          });
          setElapsed(Math.floor(size / 32000));
        }
        if (size >= limit) finishCapture.current?.();
      };
      stream.getAudioTracks()[0]?.addEventListener('ended', () => finishCapture.current?.(), { once: true });
      setPhase('recording');
    } catch (failure) {
      close();
      if (!mounted.current) return;
      setError(failure instanceof DOMException && failure.name === 'NotAllowedError' ? '请允许麦克风权限后重试' : failure instanceof Error ? failure.message : '无法启动录音');
      setPhase('idle');
      onActive?.(false);
    }
  }

  const time = String(Math.floor(elapsed / 60)).padStart(2, '0') + ':' + String(elapsed % 60).padStart(2, '0');
  const active = phase === 'recording' || phase === 'paused';
  const label = phase === 'recording' ? '暂停' : phase === 'paused' ? '继续'
    : phase === 'saving' ? '正在保存' : phase === 'starting' ? '正在启动' : draft.current ? '重试保存' : '开始';
  const capturing = phase === 'recording' || phase === 'paused';
  return <section className="quick-mobile-recording" data-phase={phase} aria-label="快速记录">
    <div className="quick-mobile-orb">
      <svg className="quick-mobile-wave" viewBox="0 0 196 196" aria-hidden="true">
        <circle cx="98" cy="98" r="81" />
        <g ref={waveform}>
          {Array.from({ length: 36 }, (_, i) => <line key={i} x1="98" x2="98" y1="47" y2="38" transform={`rotate(${i * 10} 98 98)`} />)}
        </g>
      </svg>
      <Button className="quick-mobile-control" aria-label={label} disabled={phase === 'starting' || phase === 'saving'} onClick={() => {
        if (capturing) setCapturePaused.current?.(phase === 'recording');
        else if (draft.current) void persist(draft.current);
        else void start();
      }}>
        {phase === 'recording' ? <Pause size={28} weight="fill"/> : <Play size={28} weight="fill"/>}
      </Button>
    </div>
    <div className="quick-mobile-time" aria-label="录音用时">{time}</div>
    <p className="quick-mobile-state">{label}</p>
    <div className="quick-mobile-feedback">
      {error ? <p className="quick-mobile-issue" role="alert">{error}</p> : status && <p role="status">{status}</p>}
    </div>
    <div className="quick-mobile-actions">
      {capturing && <Button variant="ghost" onClick={() => finishCapture.current?.()}>结束并保存</Button>}
    </div>
  </section>;
}
