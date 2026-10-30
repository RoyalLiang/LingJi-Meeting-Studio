import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { normalizePublishedContent } from '../packages/records/src/published-content.mjs';
import { exampleContent } from '../apps/site/src/example.mjs';

export const projectName='lingji-meeting-studio-beta';
const resourceName=projectName+'-shares', marker='lingji-public-site-v1';
export async function verifySiteSharing(api,dbId,url,fetcher=fetch){
  const owner=`deployment-check:${randomUUID()}`,ids=[];
  const payload=JSON.stringify(normalizePublishedContent(exampleContent));
  const digest=value=>createHash('sha256').update(value).digest('hex');
  const query=(sql,params)=>api(`/d1/database/${dbId}/query`,'POST',{sql,params});
  try{
    for(const operation of ['expiry','revocation']){
      const id=randomUUID(),token=randomBytes(32).toString('base64url'),now=Date.now();ids.push(id);
      await query('INSERT INTO shares(id,owner_id,request_id,token_hash,payload,payload_hash,title,source_record_id,scope,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[id,owner,randomUUID(),digest(token),payload,digest(payload),exampleContent.title,exampleContent.sourceRecordId,'minutes',now,now+120000]);
      const target=url+'/share/'+token;
      const response=await fetcher(target,{signal:AbortSignal.timeout(30000)});
      if(!response.ok || response.headers.get('cache-control')!=='no-store' || !(await response.text()).includes('source-example-1-1'))throw new Error('D1 shared-page acceptance failed.');
      if(operation==='expiry')await query('UPDATE shares SET expires_at=? WHERE id=? AND owner_id=?',[Date.now()-60000,id,owner]);
      else await query('UPDATE shares SET revoked_at=?,payload=NULL WHERE id=? AND owner_id=?',[Date.now(),id,owner]);
      const denied=await fetcher(target,{signal:AbortSignal.timeout(30000)});
      if(denied.status!==404)throw new Error(`Shared-page ${operation} acceptance failed.`);
    }
    return {d1Read:true,expiry:true,revocation:true};
  }finally{for(const id of ids)await query('DELETE FROM shares WHERE id=? AND owner_id=?',[id,owner]);}
}
export async function deployPublicSite({env=process.env,fetcher=fetch,run=command,root=resolve(import.meta.dirname,'..'),cleanup=false}={}){
  if(!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '') || !env.CLOUDFLARE_API_TOKEN)throw new Error('Configure GitHub Secrets CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN before deployment.');
  const base=`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
  async function api(path,method='GET',data,optional=false){
    const response=await fetcher(base+path,{method,headers:{Authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(30000)});
    if(optional && response.status===404)return null;
    const value=await response.json().catch(()=>({success:false,errors:[{message:'Cloudflare returned a non-JSON response.'}]}));
    if(!response.ok || !value.success){
      let detail=(value.errors || []).map(e=>e.message || '').join('; ');
      for(const secret of [env.CLOUDFLARE_API_TOKEN,env.SITE_GITHUB_CLIENT_SECRET].filter(Boolean))detail=detail.replaceAll(secret,'[redacted]');
      detail=detail.replace(/[A-Za-z0-9_-]{40,}/g,'[redacted]').slice(0,1000);
      const error=new Error(`Cloudflare ${method} ${path.split('?')[0]} failed (HTTP ${response.status}; codes ${(value.errors || []).map(e=>e.code).join(',')}). ${detail}`);error.status=response.status;throw error;
    }
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
  if(!project && existing)throw new Error('Matching database already exists without a managed Pages project; inspect ownership before retrying.');
  const vars={LINGJI_SITE_ID:marker};
  const client=env.SITE_GITHUB_CLIENT_ID || '',secret=env.SITE_GITHUB_CLIENT_SECRET || '',owner=env.PUBLISHER_GITHUB_ID || '';
  const publishing=Boolean(client && secret && owner);
  if(client || secret || owner){
    if(!/^[A-Za-z0-9_.-]{12,128}$/.test(client) || secret.length<32 || !/^\d+$/.test(owner))throw new Error('Configure GitHub OAuth client ID, secret and immutable publisher ID.');
    Object.assign(vars,{GITHUB_CLIENT_ID:client,PUBLISHER_GITHUB_ID:owner,PUBLIC_SITE_ORIGIN:'https://rookiecode.com'});
  }else if(project?.deployment_configs?.production?.env_vars?.GITHUB_CLIENT_SECRET)throw new Error('OAuth configuration is missing; refusing to remove an existing publisher configuration.');
  const envVars=Object.fromEntries(Object.entries(vars).map(([key,value])=>[key,{type:'plain_text',value}]));
  if(publishing)envVars.GITHUB_CLIENT_SECRET={type:'secret_text',value:secret};
  if(!project){
    for(let attempt=0;attempt<3;attempt++){
      try{await api('/pages/projects','POST',{name:projectName,production_branch:'main',deployment_configs:{production:{env_vars:{LINGJI_SITE_ID:envVars.LINGJI_SITE_ID}},preview:{env_vars:{LINGJI_SITE_ID:envVars.LINGJI_SITE_ID}}}});break;}
      catch(error){
        if(error.status<500 || !error.status)throw error;
        const confirmed=await api(`/pages/projects/${projectName}`,'GET',undefined,true);
        if(confirmed){if(confirmed.deployment_configs?.production?.env_vars?.LINGJI_SITE_ID?.value!==marker)throw new Error('Created project ownership could not be confirmed.');break;}
        if(attempt===2)throw error;
        await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
      }
    }
  }
  const db=existing || await api('/d1/database','POST',{name:resourceName});
  await api(`/pages/projects/${projectName}`,'PATCH',{deployment_configs:{production:{compatibility_date:'2026-10-29',env_vars:envVars,d1_databases:{DB:{id:db.uuid}}}}});
  const config={name:projectName,pages_build_output_dir:'./dist',compatibility_date:'2026-10-29',vars,d1_databases:[{binding:'DB',database_name:resourceName,database_id:db.uuid,migrations_dir:'migrations'}]};
  const site=resolve(root,'apps/site'),configFile=resolve(site,'wrangler.jsonc');await writeFile(configFile,JSON.stringify(config,null,2)+'\n');
  const wrangler=resolve(root,'node_modules/wrangler/bin/wrangler.js');
  await run(process.execPath,[wrangler,'d1','migrations','apply','DB','--remote','--config',configFile],{cwd:site,env});
  await run(process.execPath,[wrangler,'pages','deploy','dist','--project-name',projectName,'--branch','main','--commit-hash',env.GITHUB_SHA],{cwd:site,env});
  const deployed=await api(`/pages/projects/${projectName}`),url=`https://${deployed.subdomain}`;
  if(deployed.production_deployment?.deployment_trigger?.metadata?.commit_hash!==env.GITHUB_SHA)throw new Error('Cloudflare production source SHA differs from this workflow.');
  const receipt={project:projectName,sha:env.GITHUB_SHA,deploymentId:deployed.production_deployment.id,url,publishingConfigured:publishing,verifiedAt:new Date().toISOString()};
  const response=await fetcher(url+'/example',{signal:AbortSignal.timeout(30000)});if(!response.ok || !(await response.text()).includes('source-example-1-1'))throw new Error('Public example acceptance failed.');
  const status=await fetcher(url+'/api/site-status',{signal:AbortSignal.timeout(30000)});if(!status.ok || (await status.json()).publishing!==receipt.publishingConfigured)throw new Error('Public publisher readiness differs from deployment configuration.');
  receipt.sharingChecks=await verifySiteSharing(api,db.uuid,url,fetcher);
  await writeFile(resolve(root,'cloudflare-publication-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  return receipt;
}
function command(program,args,options){return new Promise((resolve,reject)=>{const child=spawn(program,args,{...options,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Deployment command exited ${code}`)));});}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{if(process.env.GITHUB_ACTIONS!=='true')throw new Error('Cloudflare deployment runs through GitHub Actions.');const value=await deployPublicSite({cleanup:process.argv.includes('--cleanup')});console.log(JSON.stringify(value));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
