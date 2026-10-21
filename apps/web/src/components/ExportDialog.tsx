import { useState } from 'react';
import { FileMd, Waveform } from '@phosphor-icons/react';
import type { RecordDetail } from '../model';
import { recordingAudioUrl, recordingPlaybackState } from '../audio/recording-playback';
import { minutesForShare } from '../share-content';
import { Button, Download, Modal } from './ui';
import { Select } from './Select';

export function ExportDialog({ record, close }: { record: RecordDetail; close: () => void }) {
  const minutes = record.minutes?.edited ? record.minutes : minutesForShare(record), playback = recordingPlaybackState(record);
  const [format, setFormat] = useState('markdown');
  const [sourceId, setSourceId] = useState(playback.available ? playback.sources[0].id : '');
  const source = playback.available ? playback.sources.find(item=>item.id===sourceId) || playback.sources[0] : null;
  const audio = format === 'audio';
  return <Modal title="导出会议" onClose={close}>
    <div className="meeting-export">
      <p className="muted">{record.title}</p>
      <label>导出内容<Select label="导出内容" value={format} onChange={setFormat} options={[
        { value: 'markdown', label: '会议纪要 · Markdown' }, { value: 'audio', label: '原始录音 · WAV' }
      ]}/></label>
      {audio ? playback.available ? <>
        <label>录音来源<Select label="录音来源" value={source!.id} onChange={setSourceId} options={playback.sources.map((source, index) => ({ value: source.id,
          label: `${source.label || (source.kind === 'microphone' ? '我的声音' : '会议声音')} · 音轨 ${index + 1}` }))}/></label>
        <p className="fine-print">每个音源单独保存为 WAV 文件。暂停后继续录制的时段也会分别列出。</p>
        <Download href={`${recordingAudioUrl(record.id, source!.id)}?download=1`}><Waveform size={17}/>导出录音</Download>
      </> : <><p className="notice" role="status">{playback.message}</p><Button disabled>暂无可导出的录音</Button></>
        : minutes ? <>
          <p className="fine-print">导出当前已保存的纪要、主题、表格、行动候选、人工笔记及对应修订的引用原文。{(minutes !== record.minutes || record.capture !== 'completed') && '当前为会中草稿，文件内会标注。'}</p>
          <Download href={`/api/records/${record.id}/export?format=markdown`}><FileMd size={17}/>导出 Markdown</Download>
        </> : <><p className="notice" role="status">还没有已保存的纪要，生成纪要后即可导出。</p><Button disabled>暂无可导出的纪要</Button></>}
    </div>
  </Modal>;
}
