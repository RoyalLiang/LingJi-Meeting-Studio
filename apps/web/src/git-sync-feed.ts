import {api,getAuthGeneration} from './api';
import type {GitJob} from './components/GitAutomation';
export type GitStatus={enabled:boolean;recent:GitJob[]};
let pending:Promise<GitStatus>|undefined,cached:GitStatus|undefined,at=0,generation=-1,epoch=0;
export function invalidateGitSyncStatus(){epoch++;pending=undefined;cached=undefined;}
export function gitSyncStatus(fresh=false):Promise<GitStatus>{
  const current=getAuthGeneration(),version=epoch;
  if(generation!==current){generation=current;pending=undefined;cached=undefined;}
  if(pending)return pending;
  if(!fresh&&cached&&Date.now()-at<900)return Promise.resolve(cached);
  const request=api<GitStatus>('/integrations/git-sync/tasks').then(value=>{
    if(current!==getAuthGeneration()||version!==epoch)throw new DOMException('Authentication changed','AbortError');
    cached=value;at=Date.now();return value;
  }).finally(()=>{if(pending===request)pending=undefined;});
  pending=request;return request;
}
