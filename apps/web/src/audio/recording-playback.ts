import type { RecordDetail, Source } from '../model';

type PlaybackRecord = Pick<RecordDetail, 'capture' | 'retainAudio' | 'audioPurged' | 'sources'>;
export type RecordingPlaybackState = { available: true; sources: Source[] } | { available: false; message: string };

export function recordingPlaybackState(record: PlaybackRecord): RecordingPlaybackState {
  if (record.audioPurged) return { available: false, message: '原始录音已清理。' };
  if (!record.retainAudio) return { available: false, message: '本场未保留原始录音。' };
  if (record.capture !== 'completed') return {
    available: false,
    message: record.capture === 'sealed' ? '录音正在处理，完成后可播放。' : '结束会议并处理完成后可播放。',
  };
  const sources = record.sources.filter(source => source.watermark >= 0);
  return sources.length ? { available: true, sources } : { available: false, message: '本场暂无可播放的原始录音。' };
}

export function recordingAudioUrl(recordId: string, sourceId: string): string {
  return `/api/records/${encodeURIComponent(recordId)}/audio/${encodeURIComponent(sourceId)}`;
}
