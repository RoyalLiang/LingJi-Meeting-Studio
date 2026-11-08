import {requireThat} from '../../../packages/records/src/record.mjs';
import {meetingTasks} from './meeting-tasks.mjs';
export const CONNECTOR_PROTOCOL='lingji.connector.v1';
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
function keys(value,allowed){requireThat(object(value)&&Object.keys(value).every(key=>allowed.includes(key)),'invalid_connector_request',400);}

// Extensions supply an adapter for the existing task kernel; they do not get a separate write executor.
export function createConnectorRegistry(kernel) {
 const definitions=new Map();
 function definition(id){const value=definitions.get(id);requireThat(value,'connector_not_found',404);requireThat(value.available!==false,'connector_unavailable',503);return value;}
 function confirmation(value,input){requireThat(input?.confirmed===true,value.confirmationError||'connector_confirmation_required',400);}
 async function selectedTask(owner,id,taskId){const value=definition(id),task=await kernel.inspect(owner,taskId);requireThat(task.taskKind===value.taskKind,'connector_task_mismatch',409);return {value,task};}
 return {
  register(value){
   requireThat(object(value)&&/^[a-z][a-z0-9-]{1,30}$/.test(value.id)&&!definitions.has(value.id)&&typeof value.taskKind==='string'&&typeof value.name==='string'&&typeof value.preview==='function'&&typeof value.selection==='function'&&typeof value.inspect==='function'&&typeof value.submitLegacy==='function','invalid_connector_definition',500);
   definitions.set(value.id,value);return ()=>definitions.delete(value.id);
  },
  list(){return [...definitions.values()].map(value=>({schema:CONNECTOR_PROTOCOL,protocolVersion:1,id:value.id,name:value.name,taskKind:value.taskKind,available:value.available!==false,operations:['preview','submit','inspect',...(value.cancellable?['cancel']:[]),...Object.keys(value.controls||{})],recovery:value.recovery}));},
  async preview(owner,id,input){return definition(id).preview(owner,input);},
  async submit(owner,id,envelope){
   keys(envelope,['protocolVersion','requestId','confirmed','input']);requireThat(envelope.protocolVersion===1&&typeof envelope.requestId==='string'&&envelope.requestId.length>0&&envelope.requestId.length<=128,'invalid_connector_request',400);
   const value=definition(id);confirmation(value,envelope);const {sourceIds,payload}=await value.selection(owner,envelope.input);
   return kernel.submit(owner,{kind:value.taskKind,requestId:envelope.requestId,sourceIds,payload:{...payload,confirmed:true}});
  },
  async inspect(owner,id,taskId){return (await selectedTask(owner,id,taskId)).task;},
  async control(owner,id,taskId,operation,input={}){
   const {value,task}=await selectedTask(owner,id,taskId);
   if(operation==='cancel'){requireThat(value.cancellable,'connector_operation_unsupported',400);return kernel.cancel(owner,taskId);}
   const control=value.controls?.[operation];requireThat(control,'connector_operation_unsupported',400);confirmation(value,input);const changed=await control(owner,task.id,input);return (await selectedTask(owner,id,changed?.id&&changed.id!==task.id?changed.kernelId:taskId)).task;
  },
  async legacySubmit(owner,id,input){const value=definition(id);confirmation(value,input);const selected=await value.selection(owner,input);return value.submitLegacy(owner,{...selected.payload,confirmed:true});},
  async legacyPreview(owner,id,...args){const value=definition(id);return (value.legacyPreview||value.preview)(owner,...args);},
  async legacyInspect(owner,id,externalId){return definition(id).inspect(owner,externalId);},
  async legacyControl(owner,id,externalId,operation,input){const value=definition(id),control=value.controls?.[operation];requireThat(control,'connector_operation_unsupported',400);confirmation(value,input);return control(owner,externalId,input);},
 };
}
export function createConnectors(repo,{feishu,gitSync}) {
 const registry=createConnectorRegistry(meetingTasks(repo));
 registry.register({id:'feishu',name:'飞书',cancellable:true,taskKind:'feishu-export',confirmationError:'feishu_confirmation_required',recovery:'reconcile-only',
  preview:async(owner,input)=>{keys(input,['recordId','options']);requireThat(uuid(input.recordId),'invalid_connector_request',400);return feishu.preview(owner,input.recordId,input.options||{});},legacyPreview:(owner,recordId,input)=>feishu.preview(owner,recordId,input),
  selection:async(owner,input)=>{keys(input,['exportId','id','confirmed','requestId']);const id=input.exportId||input.id;requireThat(uuid(id),'invalid_connector_request',400);const value=await feishu.get(owner,id);return {sourceIds:[value.recordId],payload:{id}};},
  inspect:(owner,id)=>feishu.get(owner,id),submitLegacy:(owner,input)=>feishu.publish(owner,input.id,{confirmed:input.confirmed}),
 });
 registry.register({id:'git',name:'Git 仓库',cancellable:true,taskKind:'git-sync',available:Boolean(gitSync),confirmationError:'git_confirmation_required',recovery:'guarded-resume',
  preview:async(owner,input={})=>{keys(input,['recordId']);requireThat(input.recordId===undefined||uuid(input.recordId),'invalid_connector_request',400);const value=await gitSync.preview(owner);return input.recordId?{...value,results:value.results.filter(result=>result.recordId===input.recordId)}:value;},legacyPreview:(owner,input)=>gitSync.preview(owner,input),
  selection:async(_owner,input)=>{keys(input,['recordId','confirmed','requestId']);requireThat(uuid(input.recordId),'invalid_connector_request',400);return {sourceIds:[input.recordId],payload:{recordId:input.recordId}};},
  inspect:(owner,id)=>gitSync.get(owner,id),submitLegacy:(owner,input)=>gitSync.start(owner,input.recordId),controls:Object.fromEntries(['pause','resume','retry','respond'].map(operation=>[operation,(owner,id,input)=>operation==='respond'?gitSync.respond(owner,id,input):gitSync.control(owner,id,operation,input)])),
 });
 return registry;
}
export async function connectorRoutes({req,res,path,user,connectors,readBody,send}){
 if(!path.startsWith('/api/connectors'))return false;
 if(path==='/api/connectors'&&req.method==='GET'){send(res,200,{schema:CONNECTOR_PROTOCOL,connectors:connectors.list()});return true;}
 const match=path.match(/^\/api\/connectors\/([a-z][a-z0-9-]{1,30})\/(preview|tasks)(?:\/(meeting-task(?::|%3A)[a-f0-9]{64})(?:\/(cancel|pause|resume|retry|respond))?)?$/);requireThat(match,'connector_not_found',404);
 const [,id,resource,encodedTask,operation]=match,taskId=encodedTask?decodeURIComponent(encodedTask):null;
 const wrap=task=>({schema:CONNECTOR_PROTOCOL,protocolVersion:1,connectorId:id,taskId:task.kernelId,task});
 if(resource==='preview'&&!taskId&&req.method==='POST'){const body=await readBody(req,8000);keys(body,['protocolVersion','input']);requireThat(body.protocolVersion===1,'invalid_connector_request',400);send(res,200,{schema:CONNECTOR_PROTOCOL,protocolVersion:1,connectorId:id,preview:await connectors.preview(user.id,id,body.input)});return true;}
 if(resource==='tasks'&&!taskId&&req.method==='POST'){send(res,202,wrap(await connectors.submit(user.id,id,await readBody(req,8000))));return true;}
 if(taskId&&!operation&&req.method==='GET'){send(res,200,wrap(await connectors.inspect(user.id,id,taskId)));return true;}
 if(taskId&&operation&&req.method==='POST'){const body=await readBody(req,18000);keys(body,['protocolVersion','confirmed','input']);requireThat(body.input===undefined||object(body.input),'invalid_connector_request',400);requireThat(body.protocolVersion===1,'invalid_connector_request',400);send(res,200,wrap(await connectors.control(user.id,id,taskId,operation,{...(body.input||{}),confirmed:body.confirmed===true})));return true;}
 requireThat(false,'connector_not_found',404);
}
