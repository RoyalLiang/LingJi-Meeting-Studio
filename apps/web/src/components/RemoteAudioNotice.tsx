import { Headphones, WarningCircle } from '@phosphor-icons/react';
import { Button } from './ui';
export function RemoteAudioNotice({ disabled, supported, share }: { disabled: boolean; supported: boolean; share: () => void }) {
  return <div className="remote-audio-notice" role="status"><WarningCircle size={21}/><div><b>尚未接入远端会议声音</b><p>当前仅记录麦克风。点击分享，在浏览器选择会议标签页或系统音频，并勾选“共享音频”。</p>{!supported && <p>当前浏览器未提供共享入口，请使用支持屏幕音频共享的浏览器。</p>}</div><Button variant="primary" disabled={disabled || !supported} onClick={share}><Headphones size={17}/>分享系统音频</Button></div>;
}
