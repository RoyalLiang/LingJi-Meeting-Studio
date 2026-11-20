import { useEffect, useRef, useState } from 'react';
import { Microphone, Stop } from '@phosphor-icons/react';
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
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'saving'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const draft = useRef<{ blob: Blob; name: string } | null>(null);
  const closeCapture = useRef<(() => void) | null>(null);
  const finishCapture = useRef<(() => void) | null>(null);
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
      setTitle('');
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
      await context.audioWorklet.addModule('/audio-worklet.js');
      if (!mounted.current) { close(); return; }
      const node = new AudioWorkletNode(context, 'meeting-pcm');
      const mute = context.createGain();
      mute.gain.value = 0;
      context.createMediaStreamSource(stream).connect(node).connect(mute).connect(context.destination);
      const chunks: ArrayBuffer[] = [];
      const limit = Math.min(MOBILE_AUDIO_LIMIT - 44, 5 * 60 * 32000);
      let size = 0, ending = false, finished = false, deadline = 0;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        finishCapture.current = null;
        node.port.onmessage = null;
        close();
        if (!mounted.current) return;
        if (!size) { setError('没有录到音频'); setPhase('idle'); onActive?.(false); return; }
        const name = title.trim() || '手机录音 · ' + new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        void persist(new Blob([wavHeader(size), ...chunks], { type: 'audio/wav' }), name);
      };
      finishCapture.current = () => {
        if (ending) return;
        ending = true;
        setPhase('saving');
        node.port.postMessage({ type: 'pause' });
        deadline = window.setTimeout(finish, 2000);
      };
      node.port.onmessage = ({ data }) => {
        if (data.type === 'flushed') { finish(); return; }
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
  return <section className="quick-mobile-recording" aria-label="快速记录">
    <label>录音标题<input value={title} maxLength={160} placeholder="选填" disabled={phase !== 'idle' || Boolean(draft.current)} onChange={event => setTitle(event.target.value)}/></label>
    <div className="quick-mobile-time" aria-label="录音用时">{time}</div>
    <p className="muted">最长 5 分钟</p>
    {phase === 'recording'
      ? <Button variant="primary" onClick={() => finishCapture.current?.()}><Stop size={19} weight="fill"/>结束并保存</Button>
      : <Button variant="primary" disabled={phase !== 'idle'} onClick={() => draft.current ? void persist(draft.current.blob, draft.current.name) : void start()}><Microphone size={19}/>{phase === 'saving' ? '正在加密保存…' : phase === 'starting' ? '正在打开麦克风…' : draft.current ? '重试保存' : '开始录音'}</Button>}
    {(error || status) && <p role={error ? 'alert' : 'status'}>{error || status}</p>}
  </section>;
}
