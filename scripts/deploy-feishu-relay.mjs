import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {RELAY_ID} from '../apps/feishu-relay/src/worker.mjs';
import {verifyFeishuRelay} from './verify-feishu-relay.mjs';
export const relayProject='lingji-feishu-auth',relayDatabase=relayProject+'-transactions',relayDomain='auth.rookiecode.com';
export async function deployFeishuRelay({env=process.env,fetcher=fetch,run=command,root=resolve(import.meta.dirname,'..'),cleanup=false}={}){
  if(!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID||'')||!env.CLOUDFLARE_API_TOKEN||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||''))throw new Error('Configured Cloudflare account/token and exact source SHA are required.');
  const account=`/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`,apiRoot='https://api.cloudflare.com/client/v4';
  async function api(path,method='GET',data,optional=false){
    const response=await fetcher(apiRoot+path,{method,headers:{Authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(30000)});
    if(optional&&response.status===404)return null;
    const value=await response.json().catch(()=>({success:false}));
    if(!response.ok||!value.success){const error=new Error(`Cloudflare ${path.split('?')[0]} HTTP ${response.status}; codes ${(value.errors||[]).map(item=>item.code).join(',')}`);error.status=response.status;throw error;}
    return value.result;
  }
  const projectPath=account+`/pages/projects/${relayProject}`;
  async function inspectDatabase(id){
    const metadata=await api(account+`/d1/database/${id}`);
    if(metadata.uuid!==id||metadata.name!==relayDatabase)throw new Error('Refusing to modify a database with a different identity.');
    const tables=await api(account+`/d1/database/${id}/query`,'POST',{sql:"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",params:[]});
    const allowed=new Set(['_cf_KV','_cf_METADATA','d1_migrations','oauth_transactions','oauth_rate_limits']);
    if(tables.flatMap(item=>item.results||[]).some(item=>!allowed.has(item.name)))throw new Error('Refusing to modify a database containing unrelated tables.');
  }
  let project=await api(projectPath,'GET',undefined,true);
  if(project&&project.deployment_configs?.production?.env_vars?.LINGJI_FEISHU_RELAY_ID?.value!==RELAY_ID)throw new Error('Refusing to modify a Pages project without the relay ownership marker.');
  if(cleanup){
    const id=project?.deployment_configs?.production?.d1_databases?.DB?.id;if(!id)throw new Error('Owned relay database binding is missing.');
    await inspectDatabase(id);
    await api(account+`/d1/database/${id}/query`,'POST',{sql:'DELETE FROM oauth_transactions WHERE expires_at<=? OR result_expires_at<=?',params:[Date.now(),Date.now()]});
    await api(account+`/d1/database/${id}/query`,'POST',{sql:'DELETE FROM oauth_rate_limits WHERE expires_at<=?',params:[Date.now()]});return {project:relayProject,expiredTransactionsCleared:true};
  }
  if(!project){
    const vars={LINGJI_FEISHU_RELAY_ID:{type:'plain_text',value:RELAY_ID},FEISHU_RELAY_KEY:{type:'secret_text',value:randomBytes(32).toString('base64url')}};
    try{await api(account+'/pages/projects','POST',{name:relayProject,production_branch:'main',deployment_configs:{production:{env_vars:vars},preview:{env_vars:{LINGJI_FEISHU_RELAY_ID:vars.LINGJI_FEISHU_RELAY_ID}}}});}
    catch(error){project=await api(projectPath,'GET',undefined,true);if(!project)throw error;}
    project=await api(projectPath);
    if(project.deployment_configs?.production?.env_vars?.LINGJI_FEISHU_RELAY_ID?.value!==RELAY_ID)throw new Error('Pages creation outcome belongs to another service.');
  }
  if(!project.deployment_configs?.production?.env_vars?.FEISHU_RELAY_KEY)throw new Error('Existing relay encryption key is missing; refuse silent key rotation.');
  let databases=await api(account+`/d1/database?name=${relayDatabase}`),db=databases.find(item=>item.name===relayDatabase);
  if(!db){try{db=await api(account+'/d1/database','POST',{name:relayDatabase});}catch(error){databases=await api(account+`/d1/database?name=${relayDatabase}`);db=databases.find(item=>item.name===relayDatabase);if(!db)throw error;}}
  await inspectDatabase(db.uuid);
  const oldBinding=project.deployment_configs?.production?.d1_databases?.DB?.id;if(oldBinding&&oldBinding!==db.uuid)throw new Error('Refusing to replace a different relay database binding.');
  await api(projectPath,'PATCH',{deployment_configs:{production:{compatibility_date:'2026-11-01',d1_databases:{DB:{id:db.uuid}}}}});
  const directory=resolve(root,'apps/feishu-relay'),configFile=resolve(directory,'wrangler.jsonc');
  await writeFile(configFile,JSON.stringify({name:relayProject,pages_build_output_dir:'./dist',compatibility_date:'2026-11-01',vars:{LINGJI_FEISHU_RELAY_ID:RELAY_ID},d1_databases:[{binding:'DB',database_name:relayDatabase,database_id:db.uuid,migrations_dir:'migrations'}]},null,2)+'\n');
  const wrangler=resolve(root,'node_modules/wrangler/bin/wrangler.js');
  await run(process.execPath,[wrangler,'d1','migrations','apply','DB','--remote','--config',configFile],{cwd:directory,env});
  await run(process.execPath,[wrangler,'pages','deploy','dist','--project-name',relayProject,'--branch','main','--commit-hash',env.GITHUB_SHA],{cwd:directory,env});
  project=await api(projectPath);if(project.canonical_deployment?.deployment_trigger?.metadata?.commit_hash!==env.GITHUB_SHA)throw new Error('Deployed relay source SHA does not match workflow.');
  const url=`https://${project.subdomain}`,transport=await verifyFeishuRelay(url,{fetcher,sourceSha:env.GITHUB_SHA});
  const domains=await api(projectPath+'/domains');if(!domains.some(item=>item.name===relayDomain))await api(projectPath+'/domains','POST',{name:relayDomain});
  let dnsConfigured=false,dnsNeedsPermission=false;
  try{
    const zones=await api('/zones?name=rookiecode.com');if(zones.length!==1)throw new Error('Expected exactly one rookiecode.com zone.');
    const path=`/zones/${zones[0].id}/dns_records`,records=await api(path+`?name=${relayDomain}`),target=project.subdomain.toLowerCase();
    if(records.length){if(records.length!==1||records[0].type!=='CNAME'||records[0].content.toLowerCase().replace(/\.$/,'')!==target)throw new Error('Refusing to replace an unrelated auth DNS record.');}
    else await api(path,'POST',{type:'CNAME',name:relayDomain,content:target,proxied:true,ttl:1,comment:'Lingji Feishu callback relay v1'});
    dnsConfigured=true;
  }catch(error){if(![401,403].includes(error.status))throw error;dnsNeedsPermission=true;}
  let canonicalTransport;
  if(dnsConfigured)for(let attempt=0;attempt<12;attempt++){try{canonicalTransport=await verifyFeishuRelay('https://'+relayDomain,{fetcher,sourceSha:env.GITHUB_SHA});break;}catch{await new Promise(resolve=>setTimeout(resolve,5000));}}
  const domain=await api(projectPath+`/domains/${relayDomain}`);
  const receipt={observedAtUtc:new Date().toISOString(),project:relayProject,sourceSha:env.GITHUB_SHA,deploymentId:project.canonical_deployment.id,url,transport,domain:relayDomain,domainStatus:domain.status,dnsConfigured,dnsNeedsPermission,dnsTarget:project.subdomain,canonicalTransport:canonicalTransport||null,realFeishuAuthorization:false};
  await writeFile(resolve(root,'feishu-relay-deployment-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  return receipt;
}
async function command(program,args,options){await new Promise((resolve,reject)=>{const child=spawn(program,args,{...options,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Cloudflare relay command failed.')));});}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{if(process.env.GITHUB_ACTIONS!=='true')throw new Error('Deployment must run in GitHub Actions.');const result=await deployFeishuRelay({cleanup:process.argv.includes('--cleanup')});console.log(JSON.stringify(result));}catch(error){console.error(error.message);process.exitCode=1;}}
