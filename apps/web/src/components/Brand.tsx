import appIcon from '../../../desktop/assets/lingji-app-icon.svg?url';

export function Brand({ markOnly = false }: { markOnly?: boolean }) {
  return <div className={markOnly ? 'brand brand-symbol' : 'brand'} aria-label={markOnly ? '聆记' : undefined}>
    <span className="brand-mark app-icon"><img src={appIcon} width={36} height={36} alt="" aria-hidden="true"/></span>
    {!markOnly && <><b>聆记</b><span>Meeting Studio</span></>}
  </div>;
}
