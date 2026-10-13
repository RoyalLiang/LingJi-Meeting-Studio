export function AudioRetentionSetting({ checked, onChange, disabled = false, compact = false }: {
  checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; compact?: boolean;
}) {
  return <label className={`checkbox-label audio-retention-setting${compact ? ' is-compact' : ''}`}>
    <input type="checkbox" name="retainAudio" checked={checked} onChange={event => onChange(event.target.checked)} disabled={disabled}/>
    <span>保留原音供回放<small>{compact ? '仅新录音 · 保存至到期；关闭则转录后清理' : '开启后原音随记录保存至到期；关闭则转录后清理。此选择仅用于新录音，并记在本机。'}</small></span>
  </label>;
}
