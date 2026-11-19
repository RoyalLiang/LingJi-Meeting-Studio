import {useCallback, useEffect, useRef, useState} from 'react';
import {api, messageOf} from '../api';

function meaningfullyChanged(previous: Uint8ClampedArray | undefined, next: Uint8ClampedArray) {
  if (!previous) return true;
  let difference = 0;
  for (let i = 0; i < next.length; i += 4) {
    difference += Math.max(Math.abs(previous[i] - next[i]), Math.abs(previous[i+1] - next[i+1]), Math.abs(previous[i+2] - next[i+2]));
  }
  return difference / (next.length / 4) >= 6;
}

export function useMeetingScreenshots(recordId: string | undefined, sessionId: string | undefined, enabled: boolean) {
  const [active, setActive] = useState(false), [picking, setPicking] = useState(false), [issue, setIssue] = useState('');
  const generation = useRef(0), stream = useRef<MediaStream | null>(null), interval = useRef<number | undefined>(undefined);
  const pending = useRef<Promise<void> | undefined>(undefined);
  const stopTrack = useCallback(() => {
    generation.current++;
    window.clearInterval(interval.current);
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
  }, []);
  useEffect(() => {
    stopTrack();
    setActive(false);
    setPicking(false);
    setIssue('');
    return stopTrack;
  }, [recordId, sessionId, enabled, stopTrack]);

  async function stop() {
    stopTrack();
    setActive(false);
    setPicking(false);
    await pending.current;
  }

  async function start() {
    if (!enabled || !recordId || !sessionId || active || picking || !navigator.mediaDevices?.getDisplayMedia) return;
    const current = ++generation.current;
    setPicking(true);
    setIssue('');
    try {
      const options = {video:{displaySurface:'window'}, audio:false, monitorTypeSurfaces:'exclude', surfaceSwitching:'exclude', selfBrowserSurface:'exclude'};
      const chosen = await navigator.mediaDevices.getDisplayMedia(options);
      if (generation.current !== current) {
        chosen.getTracks().forEach(track => track.stop());
        return;
      }
      stream.current = chosen;
      const track = chosen.getVideoTracks()[0];
      const surface = track?.getSettings().displaySurface;
      if (surface !== 'browser' && surface !== 'window') throw new Error('请选择飞书或 Chrome 会议窗口，或 Chrome 会议标签页。');
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = chosen;
      const thumbnail = document.createElement('canvas');
      thumbnail.width = 32;
      thumbnail.height = 18;
      const miniature = thumbnail.getContext('2d', {willReadFrequently:true});
      const picture = document.createElement('canvas');
      const context = picture.getContext('2d');
      if (!context || !miniature) throw new Error('当前环境无法生成会议截图。');
      miniature.imageSmoothingQuality = 'high';
      track.addEventListener('ended', () => {
        if (generation.current === current) {
          void stop();
          setIssue('会议画面共享已结束。');
        }
      }, {once:true});
      await video.play();
      if (generation.current !== current) return;
      setActive(true);
      let previous: Uint8ClampedArray | undefined;
      let savedAt = -Infinity;
      const capture = async () => {
        if (generation.current !== current || video.readyState < 2 || !video.videoWidth ||
            track.readyState !== 'live' || track.muted || pending.current || performance.now() - savedAt < 15000) return;
        try {
          const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
          picture.width = Math.max(1, Math.round(video.videoWidth * scale));
          picture.height = Math.max(1, Math.round(video.videoHeight * scale));
          context.drawImage(video, 0, 0, picture.width, picture.height);
          miniature.drawImage(picture, 0, 0, thumbnail.width, thumbnail.height);
          const next = miniature.getImageData(0, 0, thumbnail.width, thumbnail.height).data;
          if (!meaningfullyChanged(previous, next)) return;
          let jpeg = picture.toDataURL('image/jpeg', 0.72).split(',')[1];
          if (jpeg.length > 327680) jpeg = picture.toDataURL('image/jpeg', 0.45).split(',')[1];
          if (jpeg.length > 327680) throw new Error('当前画面过大，暂未保存。');
          const saved = await api<{full:boolean}>(`/records/${recordId}/screenshots`, 'POST', {sessionId, surface, jpeg, consent:true}, AbortSignal.timeout(6000));
          if (generation.current !== current) return;
          previous = next;
          savedAt = performance.now();
          setIssue(saved.full ? '已保存 24 张会议截图。' : '');
          if (saved.full) {
            stopTrack();
            setActive(false);
          }
        } catch (error) {
          if (generation.current === current) setIssue(messageOf(error));
        }
      };
      const sample = () => {
        if (pending.current) return;
        pending.current = capture().finally(() => { pending.current = undefined; });
      };
      interval.current = window.setInterval(sample, 4500);
      sample();
    } catch (error) {
      if (generation.current === current) {
        stopTrack();
        setActive(false);
        setIssue(error instanceof DOMException && ['NotAllowedError','AbortError'].includes(error.name) ? '未选择会议画面。' : messageOf(error));
      }
    } finally {
      if (generation.current === current || !stream.current) setPicking(false);
    }
  }

  return {active, picking, issue, start, stop, supported:typeof navigator.mediaDevices?.getDisplayMedia === 'function'};
}
