import {requireThat} from '../../../packages/records/src/record.mjs';
import {voiceLearning} from './voiceprint-learning.mjs';

export async function voiceprintRoutes({req,res,path,user,repo,readBody,send}){
  const service=voiceLearning(repo);
  if(path==='/api/voiceprints/people'&&req.method==='GET'){send(res,200,await service.people(user.id));return true;}
  if(path==='/api/voiceprints/learn'&&req.method==='POST'){send(res,202,await service.learn(user.id,await readBody(req,3000)));return true;}
  const profile=path.match(/^\/api\/voiceprints\/people\/([a-f0-9-]{36})$/i);
  if(profile){
    if(req.method==='PATCH'){send(res,200,await service.savePerson(user.id,{...await readBody(req,1000),id:profile[1]}));return true;}
    if(req.method==='DELETE'){send(res,200,await service.remove(user.id,profile[1]));return true;}
  }
  const annotation=path.match(/^\/api\/records\/([a-f0-9-]{36})\/speakers$/i);
  if(annotation){requireThat(req.method==='PATCH','method_not_allowed',405);send(res,200,await service.annotate(user.id,annotation[1],await readBody(req,2000)));return true;}
  return false;
}
