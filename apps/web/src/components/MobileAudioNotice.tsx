import { MobileSheet } from './MobileSheet';

export const audioNoticeTitle = '《音频收集告知书》';

export function MobileAudioNotice({ close }: { close: () => void }) {
  return <MobileSheet title={audioNoticeTitle} close={close} back>
    <div className="mobile-audio-notice">
      <p>录音前请告知参会者并取得所需同意。</p>
      <dl>
        <dt>检测与收音</dt>
        <dd>自动记录依据系统通话状态和受支持应用的通话通知，仅读取通知来源和类别。收音使用麦克风。你可以在 Android 设置中撤回授权。</dd>
        <dt>保存与同步</dt>
        <dd>录音分段保存在本机。启用同步后，录音会端到端加密上传，同一账号的电脑可接收并处理。</dd>
      </dl>
    </div>
  </MobileSheet>;
}
