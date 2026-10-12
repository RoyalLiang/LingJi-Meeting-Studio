import { CheckCircle, Headphones, Microphone, WarningCircle } from '@phosphor-icons/react';
import type { CaptureIssue } from '../audio/capture';
import type { SourceKind } from '../model';
import { Button, Modal } from './ui';

export function CaptureSetup({ connected, issues, busy, onRetry, onClose }: {
  connected: SourceKind[]; issues: CaptureIssue[]; busy: boolean; onRetry: () => void; onClose: () => void;
}) {
  const complete = connected.includes('microphone') && connected.includes('display');
  return <Modal title={complete ? '声音已就绪' : '让每一方的声音都被记住'} onClose={onClose}>
    <p className="capture-setup-intro">{complete ? '你的声音与会议声音都已接入，安心继续对话。' : connected.length ? '已接入的声音会继续记录。缺少的来源可以重新连接，也可以先开始当前的对话。' : '暂时没有接入声音。请查看下面的提示，允许权限或检查设备后重新连接。'}</p>
    <div className="capture-source-list">
      {(['microphone', 'display'] as const).map(kind => {
        const ready = connected.includes(kind), issue = issues.find(item => item.kind === kind);
        const Icon = kind === 'microphone' ? Microphone : Headphones;
        return <div className="capture-source" data-ready={ready} key={kind}>
          <span className="capture-source-icon"><Icon size={22}/></span>
          <div><h3>{kind === 'microphone' ? '我的声音' : '会议里的声音'}<span>{ready ? '已接入' : '待接入'}</span></h3>
            <p>{ready ? (kind === 'microphone' ? '正在记录麦克风输入。' : '正在记录共享来源的声音。') : issue?.message || (kind === 'microphone' ? '允许麦克风权限后，即可记录你的发言。' : '连接会议标签页或系统音频，记录远端发言。')}</p>
          </div>{ready ? <CheckCircle size={21} weight="fill"/> : <WarningCircle size={21}/>}
        </div>;
      })}
    </div>
    {!complete && <p className="capture-permission-note">共享声音需要你在浏览器中确认来源，网站无法代选。若使用桌面会议软件，系统音频是否可用取决于浏览器与操作系统。</p>}
    <footer className="capture-setup-actions">{!complete && <Button variant="primary" disabled={busy} onClick={onRetry}>{busy ? '正在连接…' : '重新接入声音'}</Button>}
      <Button disabled={busy} onClick={onClose}>{connected.length ? '继续记录' : '暂不开始'}</Button></footer>
  </Modal>;
}
