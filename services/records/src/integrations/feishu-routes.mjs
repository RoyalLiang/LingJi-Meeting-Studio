import { DomainError } from '../../../../packages/records/src/record.mjs';

export async function feishuRoutes({req,res,path,user,feishu,readBody,send}) {
  const base='/api/integrations/feishu';
  if(path===base){
    if(req.method==='GET')send(res,200,await feishu.settings(user.id));
    else if(req.method==='PUT')send(res,200,await feishu.configure(user.id,await readBody(req,8000)));
    else if(req.method==='DELETE')send(res,200,await feishu.disconnect(user.id));
    else throw new DomainError('not_found',404);
    return true;
  }
  if(path===`${base}/authorize`&&req.method==='POST'){send(res,200,await feishu.authorize(user.id));return true;}
  if(path===`${base}/automation`){if(req.method==='GET')send(res,200,await feishu.automation(user.id));else if(req.method==='PUT')send(res,200,await feishu.saveAutomation(user.id,await readBody(req,4000)));else throw new DomainError('not_found',404);return true;}
  const item=path.match(/^\/api\/integrations\/feishu\/exports\/([a-f0-9-]{36})(\/publish)?$/);
  if(item){
    if(req.method==='GET'&&!item[2])send(res,200,await feishu.get(user.id,item[1]));
    else if(req.method==='POST'&&item[2])send(res,202,await feishu.publish(user.id,item[1],await readBody(req,1000)));
    else throw new DomainError('not_found',404);
    return true;
  }
  const record=path.match(/^\/api\/records\/([a-f0-9-]{36})\/feishu(?:\/(preview))?$/);
  if(!record)return false;
  if(req.method==='GET'&&!record[2])send(res,200,{exports:await feishu.list(user.id,record[1])});
  else if(req.method==='POST'&&record[2])send(res,201,await feishu.preview(user.id,record[1],await readBody(req,4000)));
  else throw new DomainError('not_found',404);
  return true;
}
