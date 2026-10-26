import { CloudCheck, CloudSlash } from '@phosphor-icons/react';
import type { ConnectionState } from '../record-subscription';

export function ConnectionStatus({state,localBackend,online,pending}:{state:ConnectionState;localBackend:boolean;online:boolean;pending:number}) {
  const label=localBackend&&state==='connected' ? online?'本机已连接':'本机已连接 · 云端离线' : !online&&!localBackend ? '离线 · 本地保留' : state==='connected' ? '已连接' :
    {idle:'未连接',connecting:'连接中',reconnecting:'实时更新重连中',offline:'离线',unavailable:localBackend?'本机记录服务不可用':'记录服务不可用',inaccessible:'记录不可访问'}[state];
  return <>{state==='connected'?<CloudCheck size={18}/>:<CloudSlash size={18}/>}<span className="sync-label"><span className="sync-connection-label">{label}</span><small className="sync-queue" aria-hidden={!pending}>{pending?`${pending} 段待${localBackend?'保存':'上传'}`:'已保存'}</small></span></>;
}
