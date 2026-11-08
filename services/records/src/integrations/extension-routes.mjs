import { DomainError } from '../../../../packages/records/src/record.mjs';
export async function extensionRoutes({req,res,path,user,extensions,readBody,send}){
  if(path==='/api/extensions'&&req.method==='GET'){send(res,200,{extensions:await extensions.list(user.id),builtinSkills:extensions.builtins()});return true;}
  if(path==='/api/extensions/skills/preview'&&req.method==='POST'){send(res,200,await extensions.skillPreview(await readBody(req,20000),user.id));return true;}
  if(path==='/api/extensions/skills'&&req.method==='POST'){send(res,201,await extensions.installSkill(user.id,await readBody(req,20000)));return true;}
  if(path==='/api/extensions/plugins'&&req.method==='POST'){send(res,201,await extensions.installPlugin(user.id,await readBody(req,20000)));return true;}
  const route=path.match(/^\/api\/extensions\/([^/]{1,150})(\/check)?$/);
  if(!route)return false;
  let id;try{id=decodeURIComponent(route[1]);}catch{throw new DomainError('not_found',404);}
  if(!/^extension:[a-z0-9-]{1,100}$/.test(id))throw new DomainError('not_found',404);
  if(req.method==='GET'&&!route[2])send(res,200,await extensions.detail(user.id,id));
  else if(req.method==='POST'&&route[2])send(res,200,await extensions.check(user.id,id));
  else if(req.method==='PATCH'&&!route[2])send(res,200,await extensions.change(user.id,id,await readBody(req,16000)));
  else if(req.method==='DELETE'&&!route[2])send(res,200,await extensions.remove(user.id,id));
  else throw new DomainError('not_found',404);
  return true;
}
