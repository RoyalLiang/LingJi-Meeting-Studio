import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from '@phosphor-icons/react';
import { MOBILE_AUDIO_LIMIT } from '../sync/mobile';
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

export function QuickMobileRecording({ save, status, onActive }: { save: (blob: Blob, title: string) => Promise<void>; status: string; onActive?: (active: boolean) => void }) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'paused' | 'saving'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const draft = useRef<{ blob: Blob; name: string } | null>(null);
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

  async function persist(blob: Blob, name: string) {
    draft.current = { blob, name };
    setPhase('saving');
    setError('');
    try {
      await save(blob, name);
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
      const limit = Math.min(MOBILE_AUDIO_LIMIT - 44, 5 * 60 * 32000);
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
        const name = '手机录音 · ' + new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        void persist(new Blob([wavHeader(size), ...chunks], { type: 'audio/wav' }), name);
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
        if (data.type !== 'pcm') return;
        const pcm = data.buffer as ArrayBuffer;
        const available = Math.min(pcm.byteLength, limit - size);
        if (available > 0) {
          chunks.push(available === pcm.byteLength ? pcm : pcm.slice(0, available));
          size += available;
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
  return <section className="quick-mobile-recording" aria-label="快速记录">
    <div className="quick-mobile-time" aria-label="录音用时">{time}</div>
    <Button className="quick-mobile-control" variant="primary" disabled={phase === 'starting' || phase === 'saving'} onClick={() => {
      if (active) setCapturePaused.current?.(phase === 'recording');
      else if (draft.current) void persist(draft.current.blob, draft.current.name);
      else void start();
    }}>
      {phase === 'recording' ? <Pause size={25} weight="fill"/> : <Play size={25} weight="fill"/>}
      {label}
    </Button>
    <div className="quick-mobile-feedback">
      {phase === 'paused' && <Button variant="ghost" onClick={() => finishCapture.current?.()}>结束并保存</Button>}
      {error ? <p className="quick-mobile-issue" role="alert">{error}</p> : !active && status && <p role="status">{status}</p>}
    </div>
  </section>;
}
