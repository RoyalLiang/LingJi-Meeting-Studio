import brandMark from '../../../desktop/assets/lingji-brand-mark.svg?url';

import './Brand.css';

export function Brand({ markOnly = false }: { markOnly?: boolean }) {
  return <div className={markOnly ? 'brand brand-symbol' : 'brand'} aria-label={markOnly ? '聆记' : undefined}>
    <span className="brand-mark app-icon"><img src={brandMark} width={34} height={34} alt="" aria-hidden="true"/></span>
    {!markOnly && <><b>聆记</b><span>Meeting Studio</span></>}
  </div>;
}
