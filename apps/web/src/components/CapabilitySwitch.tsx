import './CapabilitySwitch.css';
export function CapabilitySwitch({enabled,label,disabled=false,onChange}:{enabled:boolean;label:string;disabled?:boolean;onChange:(enabled:boolean)=>void}){
  return <button type="button" className="capability-switch" role="switch" aria-label={label} aria-checked={enabled} disabled={disabled} onClick={()=>onChange(!enabled)}><span aria-hidden="true"/></button>;
}
