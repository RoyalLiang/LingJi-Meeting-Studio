import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const projectName='lingji-meeting-studio-beta';
const resourceName=projectName+'-shares', marker='lingji-public-site-v1';
export async function deployPublicSite({env=process.env,fetcher=fetch,run=command,root=resolve(import.meta.dirname,'..'),cleanup=false}={}){
  if(!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '') || !env.CLOUDFLARE_API_TOKEN)throw new Error('Configure GitHub Secrets CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN before deployment.');
  const base=`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
  async function api(path,method='GET',data,optional=false){
    const response=await fetcher(base+path,{method,headers:{Authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(30000)});
    if(optional && response.status===404)return null;
    const value=await response.json();if(!response.ok || !value.success)throw new Error(`Cloudflare ${method} ${path.split('?')[0]} failed (HTTP ${response.status}; codes ${(value.errors || []).map(e=>e.code).join(',')}).`);
    return value.result;
  }
  const project=await api(`/pages/projects/${projectName}`,'GET',undefined,true);
  if(project && project.deployment_configs?.production?.env_vars?.LINGJI_SITE_ID?.value!==marker)throw new Error('Existing Pages project is not owned by this deployment; refusing to replace it.');
  if(cleanup){
    if(!project)throw new Error('Pages project is not provisioned.');
    const id=project.deployment_configs.production.d1_databases?.DB?.id;if(!id)throw new Error('D1 binding missing.');
    await api(`/d1/database/${id}/query`,'POST',{sql:'DELETE FROM shares WHERE expires_at < ?',params:[Date.now()-86400000]});
    return {cleanup:true};
  }
  const databases=await api(`/d1/database?name=${resourceName}`), existing=databases.find(d=>d.name===resourceName);
  const bucket=await api(`/r2/buckets/${resourceName}`,'GET',undefined,true);
  if(!project && (existing || bucket))throw new Error('Matching resources already exist without a managed Pages project; inspect ownership before retrying.');
  const vars={LINGJI_SITE_ID:marker};
  const team=env.CLOUDFLARE_ACCESS_TEAM_DOMAIN || '',aud=env.CLOUDFLARE_ACCESS_AUD || '';
  if(team || aud){if(!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(team) || !aud || aud.length>512)throw new Error('Configure both valid Access team domain and application AUD.');vars.ACCESS_TEAM_DOMAIN=team;vars.ACCESS_AUD=aud;}
  else if(project?.deployment_configs?.production?.env_vars?.ACCESS_AUD?.value)throw new Error('Access variables are missing; refusing to remove an existing publisher configuration.');
  const envVars=Object.fromEntries(Object.entries(vars).map(([key,value])=>[key,{type:'plain_text',value}]));
  if(!project)await api('/pages/projects','POST',{name:projectName,production_branch:'main',deployment_configs:{production:{env_vars:envVars}}});
  const db=existing || await api('/d1/database','POST',{name:resourceName});
  if(!bucket)await api('/r2/buckets','POST',{name:resourceName});
  await api(`/r2/buckets/${resourceName}/lifecycle`,'PUT',{rules:[{id:'expire-shared-snapshots',enabled:true,conditions:{prefix:'shares/'},deleteObjectsTransition:{condition:{type:'Age',maxAge:172800}}}]});
  await api(`/pages/projects/${projectName}`,'PATCH',{deployment_configs:{production:{compatibility_date:'2026-10-29',env_vars:envVars,d1_databases:{DB:{id:db.uuid}},r2_buckets:{BUCKET:{name:resourceName}}}}});
  const config={name:projectName,pages_build_output_dir:'./dist',compatibility_date:'2026-10-29',vars,d1_databases:[{binding:'DB',database_name:resourceName,database_id:db.uuid,migrations_dir:'migrations'}],r2_buckets:[{binding:'BUCKET',bucket_name:resourceName}]};
  const site=resolve(root,'apps/site'),configFile=resolve(site,'wrangler.jsonc');await writeFile(configFile,JSON.stringify(config,null,2)+'\n');
  const wrangler=resolve(root,'node_modules/wrangler/bin/wrangler.js');
  await run(process.execPath,[wrangler,'d1','migrations','apply','DB','--remote','--config',configFile],{cwd:site,env});
  await run(process.execPath,[wrangler,'pages','deploy','dist','--project-name',projectName,'--branch','main','--commit-hash',env.GITHUB_SHA],{cwd:site,env});
  const deployed=await api(`/pages/projects/${projectName}`),url=`https://${deployed.subdomain}`;
  if(deployed.production_deployment?.deployment_trigger?.metadata?.commit_hash!==env.GITHUB_SHA)throw new Error('Cloudflare production source SHA differs from this workflow.');
  const receipt={project:projectName,sha:env.GITHUB_SHA,deploymentId:deployed.production_deployment.id,url,publishingConfigured:Boolean(team && aud),verifiedAt:new Date().toISOString()};
  const response=await fetcher(url+'/example',{signal:AbortSignal.timeout(30000)});if(!response.ok || !(await response.text()).includes('source-example-1-1'))throw new Error('Public example acceptance failed.');
  const status=await fetcher(url+'/api/site-status',{signal:AbortSignal.timeout(30000)});if(!status.ok || (await status.json()).publishing!==receipt.publishingConfigured)throw new Error('Public publisher readiness differs from deployment configuration.');
  await writeFile(resolve(root,'cloudflare-publication-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  return receipt;
}
function command(program,args,options){return new Promise((resolve,reject)=>{const child=spawn(program,args,{...options,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Deployment command exited ${code}`)));});}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{if(process.env.GITHUB_ACTIONS!=='true')throw new Error('Cloudflare deployment runs through GitHub Actions.');const value=await deployPublicSite({cleanup:process.argv.includes('--cleanup')});console.log(JSON.stringify(value));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
