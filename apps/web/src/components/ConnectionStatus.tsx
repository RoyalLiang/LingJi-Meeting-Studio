import { CloudSlash } from '@phosphor-icons/react';
import type { ConnectionState } from '../record-subscription';

export function ConnectionStatus({state,localBackend,online,pending}:{state:ConnectionState;localBackend:boolean;online:boolean;pending:number}) {
  const label=!online&&!localBackend ? '离线 · 本地保留' : state==='connected' ? localBackend&&!online?'云端离线':'' :
    {idle:'未连接',connecting:'连接中',reconnecting:'实时更新重连中',offline:'离线',unavailable:localBackend?'本机记录服务不可用':'记录服务不可用',inaccessible:'记录不可访问'}[state];
  if(!label&&!pending)return null;
  return <span className="sync-label">{label&&<span className="sync-connection-label"><CloudSlash size={18}/><span>{label}</span></span>}{pending>0&&<small className="sync-queue">{pending} 段待{localBackend?'保存':'上传'}</small>}</span>;
}
