import {nativePlaybackSelection} from '../audio/playback-devices';
import {PlaybackSourceSettings} from './PlaybackSourceSettings';
import { CheckCircle, Headphones, Microphone, WarningCircle } from '@phosphor-icons/react';
import type { CaptureIssue, CaptureKind } from '../audio/capture';
import type { SourceKind } from '../model';
import type { CaptureSignal } from '../audio/signal';
import { DeviceSettings } from './DeviceSettings';
import { Button, Modal } from './ui';

export function CaptureSetup({ connected, signals, issues, busy, onConnect, onMicrophoneOff, onClose }: {
  connected: SourceKind[]; signals: CaptureSignal[]; issues: CaptureIssue[]; busy: boolean; onConnect: (kind: CaptureKind) => void; onMicrophoneOff: () => void; onClose: () => void;
}) {
  const native=nativePlaybackSelection();
  return <Modal title="音频来源" onClose={onClose}>
    <PlaybackSourceSettings disabled={busy||connected.includes('display')}/>
    <div className="capture-source-list">
      {(['display', 'microphone'] as const).map(kind => {
        const ready = connected.includes(kind), issue = issues.find(item => item.kind === kind), signal = signals.find(item => item.kind === kind);
        const Icon = kind === 'microphone' ? Microphone : Headphones;
        return <div className="capture-source" data-ready={ready} key={kind}>
          <span className="capture-source-icon"><Icon size={22}/></span>
          <div><h3>{kind === 'microphone' ? '麦克风（可选）' : '系统／会议音频'}<span>{ready ? '已接入' : kind === 'microphone' ? '未开启' : '待接入'}</span></h3>
            <p>{ready ? (kind === 'microphone' ? '正在独立记录麦克风输入。关闭后将停止此音源。' : '正在记录所选范围的声音。') : issue?.message || (kind === 'microphone' ? '需要记录本机发言时再开启；不会跟随会议软件的静音状态。' : native?'将按上方选择的范围记录会议声音。':'选择屏幕或会议标签页，并开启声音共享。')}</p>{signal && <small className="capture-device-detail">{signal.label} · {signal.message}</small>}
            {(!ready || kind === 'microphone') && <Button disabled={busy} onClick={() => ready ? onMicrophoneOff() : onConnect(kind)}>{ready ? '关闭麦克风' : kind === 'microphone' ? '开启麦克风' : native?'接入会议声音':'接入系统／会议音频'}</Button>}
          </div>{ready ? <CheckCircle size={21} weight="fill"/> : kind === 'display' || issue ? <WarningCircle size={21}/> : null}
        </div>;
      })}
    </div>
    {!connected.includes('microphone') && <div className="capture-microphone-device"><DeviceSettings compact disabled={busy}/></div>}
    <footer className="capture-setup-actions">
      <Button disabled={busy} onClick={onClose}>{connected.length ? '继续记录' : '暂不开始'}</Button></footer>
  </Modal>;
}
