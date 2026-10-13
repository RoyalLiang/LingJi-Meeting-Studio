import type { RecordDetail, Source } from '../model';

type PlaybackRecord = Pick<RecordDetail, 'capture' | 'retainAudio' | 'audioPurged' | 'sources'>;
export type RecordingPlaybackState = { available: true; sources: Source[] } | { available: false; label: string; message: string };

export function recordingPlaybackState(record: PlaybackRecord): RecordingPlaybackState {
  if (record.audioPurged) return { available: false, label: '原音已清理 · 无法恢复', message: '原始录音已清理，无法恢复。下次录音前可开启“保留原音供回放”。' };
  if (!record.retainAudio) return { available: false, label: '原音未留存', message: '本场未开启“保留原音供回放”，原音会在转录后清理。' };
  if (record.capture !== 'completed') return {
    available: false,
    label: record.capture === 'sealed' ? '原音整理中' : '原音待结束',
    message: record.capture === 'sealed' ? '录音正在处理，完成后可播放。' : '结束会议并处理完成后可播放。',
  };
  const sources = record.sources.filter(source => source.watermark >= 0);
  return sources.length ? { available: true, sources } : { available: false, label: '暂无原音', message: '本场暂无可播放的原始录音。' };
}

export function recordingAudioUrl(recordId: string, sourceId: string): string {
  return `/api/records/${encodeURIComponent(recordId)}/audio/${encodeURIComponent(sourceId)}`;
}
