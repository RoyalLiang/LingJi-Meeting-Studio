import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';

const projectName='lingji-feishu-auth',ownerMarker='lingji-feishu-auth-v1';
export const retiredWorker='export default {fetch(){return new Response("Authorization relay retired",{status:410,headers:{"cache-control":"no-store","x-lingji-relay":"retired"}})}};';

export async function retireFeishuRelay({env=process.env,fetcher=fetch,run=command,root=resolve(import.meta.dirname,'..')}={}){
  if(env.GITHUB_ACTIONS!=='true'||!env.CLOUDFLARE_API_TOKEN||! /^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID||'')||! /^[a-f0-9]{40}$/.test(env.GITHUB_SHA||''))throw new Error('Retirement requires GitHub Actions account/token and source SHA.');
  const base=`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${projectName}`;
  async function api(path='',method='GET',optional=false){
    const response=await fetcher(base+path,{method,headers:{Authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`},signal:AbortSignal.timeout(30000)});
    if(optional&&response.status===404)return null;
    const body=await response.json();if(!response.ok||!body.success)throw new Error(`Relay retirement API HTTP ${response.status}`);return body.result;
  }
  let project=await api('','GET',true);
  if(!project)return {project:projectName,sourceSha:env.GITHUB_SHA,absent:true};
  if(project.name!==projectName||project.subdomain!==`${projectName}.pages.dev`||project.deployment_configs?.production?.env_vars?.LINGJI_FEISHU_RELAY_ID?.value!==ownerMarker)throw new Error('Refusing retirement of an unrecognized project.');
  const directory=await mkdtemp(join(tmpdir(),'lingji-retire-'));
  try{
    await writeFile(join(directory,'_worker.js'),retiredWorker);
    await run(process.execPath,[resolve(root,'node_modules/wrangler/bin/wrangler.js'),'pages','deploy',directory,'--project-name',projectName,'--branch','main','--commit-hash',env.GITHUB_SHA],{cwd:directory,env});
  }finally{await rm(directory,{recursive:true,force:true});}
  project=await api();const current=project.canonical_deployment;
  if(current?.deployment_trigger?.metadata?.commit_hash!==env.GITHUB_SHA)throw new Error('Retirement deployment source SHA mismatch.');
  const checks=[];
  for(const [path,method] of [['/api/integrations/feishu/callback','GET'],['/api/integrations/feishu/transactions','POST'],['/api/integrations/feishu/config','GET']]){
    const response=await fetcher(`https://${project.subdomain}${path}`,{method,redirect:'error',signal:AbortSignal.timeout(15000)});
    if(response.status!==410||response.headers.get('x-lingji-relay')!=='retired')throw new Error('Public relay still accepts requests.');checks.push({path,method,status:response.status});
  }
  let canonical;
  try{
    const response=await fetcher('https://auth.rookiecode.com/api/integrations/feishu/callback',{redirect:'error',signal:AbortSignal.timeout(15000)});
    if(response.status!==410||response.headers.get('x-lingji-relay')!=='retired')throw new Error('Canonical relay retirement is unverified.');
    canonical={state:'retired',status:410};
  }catch(error){if(error.cause?.code!=='ENOTFOUND')throw error;canonical={state:'unresolved'};}
  // Historical deployment URLs also serve workers; remove only this marked project's superseded deployments.
  let removed=0;
  for(let page=0;page<50;page++){
    const old=(await api('/deployments?per_page=100&page=1')).filter(item=>item.id!==current.id);
    if(!old.length)return {project:projectName,sourceSha:env.GITHUB_SHA,deploymentId:current.id,checks,canonical,removedDeployments:removed,databaseRetained:true};
    for(const item of old){if(!/^[a-f0-9-]{36}$/i.test(item.id))throw new Error('Invalid deployment identity.');await api(`/deployments/${item.id}?force=true`,'DELETE');removed++;}
  }
  throw new Error('Relay deployment cleanup limit reached.');
}
function command(program,args,options){return new Promise((resolve,reject)=>{const child=spawn(program,args,{...options,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Retirement deployment exited ${code}`)));});}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{const receipt=await retireFeishuRelay();await writeFile('feishu-relay-retirement-receipt.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));}catch(error){console.error(error.message);process.exitCode=1;}}
