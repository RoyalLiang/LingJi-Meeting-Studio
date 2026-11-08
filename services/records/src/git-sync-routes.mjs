import {DomainError,requireThat} from '../../../packages/records/src/record.mjs';
import {historyQuery} from './task-history.mjs';
export async function gitSyncRoutes({req,res,path,user,gitSync,readBody,send}){
  const base='/api/integrations/git-sync';if(!path.startsWith(base))return false;
  requireThat(gitSync,'git_sync_unavailable',503);
  if(path===base){if(req.method==='GET')send(res,200,await gitSync.settings(user.id));else if(req.method==='PUT')send(res,200,await gitSync.save(user.id,await readBody(req,30000)));else throw new DomainError('not_found',404);return true;}
  if(path===`${base}/check`&&req.method==='POST'){send(res,200,await gitSync.check(user.id,await readBody(req,18000)));return true;}
  if(path===`${base}/preview`&&req.method==='POST'){send(res,200,await gitSync.preview(user.id,await readBody(req,30000)));return true;}
  if(path===`${base}/tasks`&&req.method==='GET'){send(res,200,await gitSync.status(user.id));return true;}
  if(path===`${base}/tasks/history`&&req.method==='GET'){send(res,200,await gitSync.historyPage(user.id,historyQuery(req.url)||{}));return true;}
  if(path===`${base}/tasks`&&req.method==='POST'){const body=await readBody(req,1000);requireThat(body.confirmed===true&&typeof body.recordId==='string','git_confirmation_required',400);send(res,202,await gitSync.start(user.id,body.recordId));return true;}
  const match=path.match(/^\/api\/integrations\/git-sync\/tasks\/(git-sync(?::|%3A)[a-f0-9]{64})(?:\/(pause|resume|retry|respond))?$/);
  if(match){if(req.method==='GET'&&!match[2])send(res,200,await gitSync.get(user.id,decodeURIComponent(match[1])));else if(req.method==='POST'&&match[2]){const body=await readBody(req,18000);requireThat(body.confirmed===true,'git_confirmation_required',400);send(res,200,match[2]==='respond'?await gitSync.respond(user.id,decodeURIComponent(match[1]),body):await gitSync.control(user.id,decodeURIComponent(match[1]),match[2],body));}else throw new DomainError('not_found',404);return true;}
  throw new DomainError('not_found',404);
}
