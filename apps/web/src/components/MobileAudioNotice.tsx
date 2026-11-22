import { useState } from 'react';
import { ShieldCheck } from '@phosphor-icons/react';
import { MobileSheet } from './MobileSheet';

const title = '《音频收集告知书》';

export function MobileAudioNotice() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="mobile-about-row mobile-document-link" onClick={() => setOpen(true)}>
      <ShieldCheck size={17} aria-hidden="true"/><span>{title}</span>
    </button>
    {open && <MobileSheet title={title} close={() => setOpen(false)}>
      <div className="mobile-audio-notice">
        <p>录音前请告知参会者并取得所需同意。手动录音使用麦克风，可在应用内暂停、结束，或通过 Android 设置撤回权限。</p>
        <p>自动记录通过 Android 的系统投屏授权读取音频。聆记仅监听飞书、Teams、Zoom 和腾讯会议允许共享的播放音频。检测到声音后开始，持续静默 60 秒后保存。</p>
        <p>录音按片保存在本机。启用同步时，以端到端加密的形式同步到云端。</p>
      </div>
    </MobileSheet>}
  </>;
}
