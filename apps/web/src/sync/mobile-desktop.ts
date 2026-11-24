import { api, ApiError, uploadAudio } from '../api';
import { makeChunk } from '../audio/queue';
import type { RecordDetail, Source } from '../model';
import { acknowledgeLiveAudio, pullLiveAudio, type LiveFrame } from './mobile';
import { unpackMobilePcm, WAV_PCM_LIMIT } from './mobile-pcm';
import type { Vault } from './vault';

export function createMobileAudioReceiver(vault: Vault, signal: AbortSignal) {
  const records = new Map<string, RecordDetail>();
  const incomplete = new Set<string>();
  return async (frame: LiveFrame): Promise<{ next: number; done: boolean; stored?: true } | 'deleted' | null> => {
    signal.throwIfAborted();
    if (frame.kind === 'received' || (frame.sequence !== 0 && incomplete.has(frame.id))) return null;
    let record = records.get(frame.id);
    if (!record) {
      try {
        record = await api<RecordDetail>('/private-sync/recording', 'POST', {
          vault: vault.id, id: frame.id, title: frame.title, live: true, existingOnly: frame.sequence !== 0,
          recordedAt: frame.kind === 'pcm' && frame.sequence === 0 ? frame.recordedAt : undefined,
        }, signal);
      } catch (failure) {
        if (!(failure instanceof ApiError) || failure.code !== 'sync_recording_prefix_unavailable') throw failure;
        incomplete.add(frame.id);
        return null;
      }
      incomplete.delete(frame.id);
      records.set(frame.id, record);
    }
    if (record.deleted) return 'deleted';
    const source = record.sources.find((entry: Source) => entry.kind === 'import');
    if (!source) throw new Error('手机录音音源不可用');
    if (record.capture === 'sealed' || record.capture === 'completed') {
      const done = frame.kind === 'finish';
      const durable = done
        ? source.lastSequence === frame.sequence - 1 && source.watermark === source.lastSequence
        : source.watermark >= frame.sequence;
      return durable ? { next: source.watermark + 1, done } : null;
    }
    if (frame.sequence > source.watermark + 1) return null;
    if (frame.kind === 'finish') {
      await api('/records/' + record.id + '/seal', 'POST', {
        sources: [{ sourceId: source.id, sessionId: source.sessionId, epoch: source.epoch, lastSequence: frame.sequence - 1 }],
      }, signal);
      return { next: frame.sequence, done: true, stored: true };
    }
    const pcm = await unpackMobilePcm(frame.pcm);
    try {
      if (frame.offset * 2 + pcm.byteLength > WAV_PCM_LIMIT) throw new Error('录音超过支持的时长');
      const chunk = await makeChunk(source.id, source.epoch, frame.sequence, frame.offset, pcm.buffer, source.sessionId);
      const receipt = await uploadAudio<{ durable: boolean; watermark: number }>(`/records/${record.id}/audio`, chunk, signal);
      if (!receipt.durable || receipt.watermark < frame.sequence) throw new Error('桌面录音持久化回执无效');
      source.watermark = receipt.watermark;
      return { next: receipt.watermark + 1, done: false, stored: true };
    } finally {
      pcm.fill(0);
    }
  };
}

export async function receiveLiveAudio(
  vault: Vault, root: Uint8Array<ArrayBuffer>, signal: AbortSignal, changed: () => void, v2 = false
) {
  const receive = createMobileAudioReceiver(vault, signal);
  return pullLiveAudio(vault, root, 'desktop', signal, async frame => {
    const receipt = await receive(frame);
    if (receipt === 'deleted') return true;
    if (!receipt) return false;
    if (receipt.done) {
      changed();
      if (v2) await acknowledgeLiveAudio(vault, root, frame.id, frame.title, true);
    }
    if (receipt.stored && frame.kind === 'pcm' && frame.sequence === 0) {
      changed();
      await acknowledgeLiveAudio(vault, root, frame.id, frame.title);
    }
    return true;
  }, v2);
}
