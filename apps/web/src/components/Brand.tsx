export function Brand({ markOnly = false }: { markOnly?: boolean }) {
  return <div className={markOnly ? 'brand brand-symbol' : 'brand'} aria-label={markOnly ? '聆记' : undefined}>
    <span className="brand-mark voice-page"><img src="/brand/lingji-voice-page.png" width={64} height={64} alt="" aria-hidden="true"/></span>
    {!markOnly && <><b>聆记</b><span>Meeting Studio</span></>}
  </div>;
}
