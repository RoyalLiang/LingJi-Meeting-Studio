import { useEffect, useRef, useState } from 'react';
import { Microphone, Square } from '@phosphor-icons/react';
import { openMicrophone, preferredDevice } from '../audio/devices';
import { isTauri } from '@tauri-apps/api/core';
import { startNativeStream } from '../audio/native-runtime';
import { pcmSignal } from '../audio/signal';
import type { NativeStream } from '../audio/native-stream';
import { messageOf } from '../api';
import { Button } from './ui';

export function MicrophoneTest({ disabled, refresh }: { disabled: boolean; refresh: () => Promise<void> }) {
  const [testing, setTesting] = useState(false), [message, setMessage] = useState(''), [level, setLevel] = useState(0);
  const resources = useRef<{ context?: AudioContext; stream?: MediaStream; native?: NativeStream; frame?: number; timer?: number; token: number }>({ token: 0 });
  function stop() {
    const current = resources.current; current.token++;
    if (current.frame) cancelAnimationFrame(current.frame);
    if (current.timer) clearTimeout(current.timer);
    current.stream?.getTracks().forEach(track => track.stop()); void current.context?.close();
    void current.native?.stop(true).catch(() => {}); delete current.native;
    delete current.stream; delete current.context; setTesting(false); setLevel(0);
  }
  useEffect(() => () => {
    const current = resources.current; current.token++;
    if (current.frame) cancelAnimationFrame(current.frame); if (current.timer) clearTimeout(current.timer);
    current.stream?.getTracks().forEach(track => track.stop()); void current.context?.close();
    void current.native?.stop(true).catch(() => {});
  }, []);
  async function start() {
    stop(); const token = resources.current.token;
    setTesting(true); setMessage('请对着麦克风说一句话，测试只在本机进行。');
    if (isTauri()) {
      let heard = false;
      try {
        const native = await startNativeStream('microphone', preferredDevice(), async packet => {
          if (token !== resources.current.token) return;
          const { rms } = pcmSignal(packet.buffer); heard ||= rms >= 0.0005; setLevel(Math.min(1, rms * 8));
          if (heard) setMessage('已收到原生麦克风输入；测试音频未上传。');
        }, error => { if (token === resources.current.token) { setMessage(messageOf(error)); stop(); } });
        if (token !== resources.current.token) { await native.stop(true); return; }
        resources.current.native = native; await refresh();
        if (token !== resources.current.token) return;
        resources.current.timer = window.setTimeout(() => {
          setMessage(heard ? '测试完成：麦克风有声音。' : '未收到声音，请检查系统权限或切换输入设备。'); stop();
        }, 8000);
      } catch (error) { if (token === resources.current.token) { setMessage(messageOf(error)); stop(); } }
      return;
    }
    const context = new AudioContext(); resources.current.context = context;
    try {
      await context.resume();
      const stream = await openMicrophone();
      if (token !== resources.current.token) { stream.getTracks().forEach(track => track.stop()); return; }
      resources.current.stream = stream;
      const analyser = context.createAnalyser(); analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize); let heard = false;
      const sample = () => {
        if (token !== resources.current.token) return;
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        heard ||= rms >= 0.0005; setLevel(Math.min(1, rms * 8));
        if (heard) setMessage(`已收到声音 · ${stream.getAudioTracks()[0]?.label || '当前麦克风'}`);
        resources.current.frame = requestAnimationFrame(sample);
      };
      sample(); await refresh();
      if (token !== resources.current.token) return;
      resources.current.timer = window.setTimeout(() => { setMessage(heard ? '测试完成：麦克风有声音。' : '未收到声音。请切换输入设备，并检查系统隐私设置中的麦克风权限。'); stop(); }, 8000);
    } catch (error) { if (token === resources.current.token) { setMessage(messageOf(error)); stop(); } }
  }
  return <div className="microphone-test"><Button disabled={disabled} onClick={() => testing ? stop() : void start()}>{testing ? <Square size={16}/> : <Microphone size={16}/>} {testing ? '停止测试' : '测试麦克风'}</Button>{message && <p role="status">{message}</p>}{testing && <div className="source-signal-meter"><i style={{ transform: `scaleX(${level})` }}/></div>}</div>;
}
