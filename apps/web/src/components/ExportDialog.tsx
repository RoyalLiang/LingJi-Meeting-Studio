import { useState } from 'react';
import { FileMd, Waveform } from '@phosphor-icons/react';
import type { RecordDetail } from '../model';
import { recordingAudioUrl, recordingPlaybackState } from '../audio/recording-playback';
import { minutesForShare } from '../share-content';
import { Button, Download, Modal } from './ui';
import { Select } from './Select';
import { FeishuExport } from './FeishuExport';

export function ExportDialog({ record, close }: { record: RecordDetail; close: () => void }) {
 const minutes = record.minutes?.edited ? record.minutes : minutesForShare(record), playback = recordingPlaybackState(record);
 const [footerTarget,setFooterTarget]=useState<HTMLDivElement|null>(null);
 const [format,setFormat]=useState('markdown');
 const [sourceId,setSourceId]=useState(playback.available?playback.sources[0].id:'');
 const source=playback.available?playback.sources.find(item=>item.id===sourceId)||playback.sources[0]:null;
 return <Modal title="导出会议" onClose={close} className="export-modal" footer={format==='feishu'?<div className="export-footer" ref={setFooterTarget}/>:undefined} wide={format==='feishu'}>
  <div className="meeting-export"><p className="muted">{record.title}</p>
   <label>导出内容<Select label="导出内容" value={format} onChange={setFormat} options={[
    {value:'markdown',label:'会议纪要 · Markdown'},
    {value:'feishu',label:'飞书云文档'},
    {value:'json',label:'完整记录备份 · JSON'},
    ...(minutes?.actions?.length?[{value:'ics',label:'行动候选 · 日历 ICS'},{value:'issues',label:'工单候选 · JSON'}]:[]),
    {value:'audio',label:'原始录音 · WAV'}
   ]}/></label>
   {format==='feishu'?<FeishuExport record={record} footerTarget={footerTarget}/>:
    format==='audio'?playback.available?<>
     <label>录音来源<Select label="录音来源" value={source!.id} onChange={setSourceId} options={playback.sources.map((source,index)=>({value:source.id,label:`${source.label||(source.kind==='microphone'?'麦克风':'共享音频')} · ${index+1}`}))}/></label>
     <Download href={`${recordingAudioUrl(record.id,source!.id)}?download=1`}><Waveform size={17}/>导出录音</Download>
    </>:<><p className="muted">{playback.message}</p><Button disabled>暂无可导出的原音</Button></>:
    minutes||format==='json'?<Download href={`/api/records/${record.id}/export?format=${format}`}><FileMd size={17}/>{format==='json'?'备份记录':format==='ics'?'导出日历':format==='issues'?'导出工单候选':'导出 Markdown'}</Download>:
    <><p className="muted">生成会议纪要后即可导出。</p><Button disabled>暂无可导出的纪要</Button></>}
  </div>
 </Modal>;
}
