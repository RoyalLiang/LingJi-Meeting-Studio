import { api, uploadAudio } from '../api';
import { makeChunk } from '../audio/queue';
import type { RecordDetail, Source } from '../model';
import { acknowledgeLiveAudio, MOBILE_RECORDING_BYTES, pullLiveAudio } from './mobile';
import { decodeBytes, type Vault } from './vault';

export async function receiveLiveAudio(
  vault: Vault, root: Uint8Array<ArrayBuffer>, signal: AbortSignal, changed: () => void
) {
  const records = new Map<string, RecordDetail>();
  return pullLiveAudio(vault, root, 'desktop', signal, async frame => {
    if (frame.kind === 'received') return;
    let record = records.get(frame.id);
    if (!record) {
      record = await api<RecordDetail>('/private-sync/recording', 'POST', {
        vault: vault.id, id: frame.id, title: frame.title, live: true
      }, signal);
      records.set(frame.id, record);
    }
    if (record.deleted || record.capture === 'sealed' || record.capture === 'completed') return;
    const source = record.sources.find((entry: Source) => entry.kind === 'import');
    if (!source) throw new Error('手机录音音源不可用');
    if (frame.kind === 'finish') {
      await api('/records/' + record.id + '/seal', 'POST', {
        sources: [{ sourceId: source.id, sessionId: source.sessionId, epoch: source.epoch, lastSequence: frame.sequence - 1 }]
      }, signal);
      changed();
      return;
    }
    const pcm = decodeBytes(frame.data);
    if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0 || pcm.byteLength > 32000 ||
        frame.offset * 2 + pcm.byteLength > MOBILE_RECORDING_BYTES) throw new Error('手机录音 PCM 大小无效');
    try {
      const chunk = await makeChunk(source.id, source.epoch, frame.sequence, frame.offset, pcm.buffer, source.sessionId);
      const receipt = await uploadAudio<{ durable: boolean; watermark: number }>(`/records/${record.id}/audio`, chunk, signal);
      if (!receipt.durable || receipt.watermark < frame.sequence) throw new Error('电脑尚未保存实时录音片段');
    } finally { pcm.fill(0); }
    if (frame.sequence === 0) {
      changed();
      await acknowledgeLiveAudio(vault, root, frame.id, frame.title);
    }
  });
}
