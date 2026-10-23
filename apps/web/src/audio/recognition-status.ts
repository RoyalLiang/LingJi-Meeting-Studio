import type { RecordDetail } from '../model';

type RecognitionRecord = Pick<RecordDetail, 'capture' | 'sources' | 'transcription' | 'usage' | 'transcriptRevision'>;

export function recognitionStatus(record: RecognitionRecord, audioOnly = false): string | null {
  const failed = record.sources.filter(source => source.asr?.state === 'failed');
  if (audioOnly && (failed.length || ['blocked', 'failed'].includes(record.transcription))) return '豆包音频模型转录未完成，请检查模型配置后重试';
  if (failed.some(source => source.asr?.error === 'doubao_asr_45000292')) return '豆包语音识别配额超限，请检查语音服务额度后重试（45000292）';
  if (failed.length) {
    const reconnecting = failed.every(source => source.asr?.retryable ?? /^(doubao_connection_failed|doubao_incomplete_session|doubao_completion_timeout|doubao_stream_failed|doubao_http_(408|429|5\d\d))$/.test(source.asr?.error || ''));
    return reconnecting ? '语音识别连接中断，正在自动重连' : '语音识别暂不可用，请重试或检查服务设置';
  }
  if (['blocked', 'failed'].includes(record.transcription)) return '语音识别处理受阻，可重新尝试';
  if (record.capture === 'recording' && !record.transcriptRevision && record.usage.samples > 0) return '已收到音频，正在等待识别结果';
  return null;
}
