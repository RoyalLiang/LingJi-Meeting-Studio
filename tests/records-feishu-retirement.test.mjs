import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {retireFeishuRelay,retiredWorker} from '../scripts/retire-feishu-relay.mjs';
const env={GITHUB_ACTIONS:'true',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'test-token',GITHUB_SHA:'b'.repeat(40)};
const response=(result,status=200)=>Response.json({success:true,result},{status});
const marked={name:'lingji-feishu-auth',subdomain:'lingji-feishu-auth.pages.dev',deployment_configs:{production:{env_vars:{LINGJI_FEISHU_RELAY_ID:{value:'lingji-feishu-auth-v1'}}}},canonical_deployment:{id:'c'.repeat(36),deployment_trigger:{metadata:{commit_hash:env.GITHUB_SHA}}}};
test('retirement refuses unknown projects and never recreates absent ones',async()=>{
  let mutations=0;const run=async()=>{mutations++;};
  const absent=await retireFeishuRelay({env,run,fetcher:async()=>response(null,404)});assert.equal(absent.absent,true);assert.equal(mutations,0);
  await assert.rejects(retireFeishuRelay({env,run,fetcher:async()=>response({...marked,deployment_configs:{}})}),/unrecognized/);assert.equal(mutations,0);
});
test('retirement requires CI and validates public shutdown before deleting old deployments',async()=>{
  await assert.rejects(retireFeishuRelay({env:{...env,GITHUB_ACTIONS:'false'}}),/GitHub Actions/);
  const calls=[];let deleted=false;
  const fetcher=async(url,options)=>{calls.push([url,options.method]);if(url.startsWith('https://lingji-feishu-auth.pages.dev')||url.startsWith('https://auth.rookiecode.com'))return new Response('',{status:410,headers:{'x-lingji-relay':'retired'}});if(options.method==='DELETE'){deleted=true;return response(null);}if(url.includes('/deployments?'))return response(deleted?[marked.canonical_deployment]:[marked.canonical_deployment,{id:'a'.repeat(36)}]);return response(marked);};
  const result=await retireFeishuRelay({env,fetcher,run:async()=>{}});assert.equal(result.removedDeployments,1);assert.equal(result.checks.length,3);assert.equal(result.databaseRetained,true);assert.ok(calls.find(([url,method])=>method==='DELETE'&&url.endsWith('?force=true')));assert.ok(calls.every(([url])=>!url.includes('/d1/')&&!url.includes('/dns')));
  await assert.rejects(retireFeishuRelay({env,run:async()=>{},fetcher:async(url)=>url.includes('api.cloudflare.com')?response(marked):new Response('',{status:200})}),/still accepts/);
});
test('retired worker answers every method with 410 and contains no OAuth runtime',async()=>{
  const worker=vm.runInNewContext('('+retiredWorker.replace('export default','').replace(/;$/,'')+')',{Response});
  for(const method of ['GET','POST','DELETE']){const result=await worker.fetch(new Request('https://example.test/callback',{method}));assert.equal(result.status,410);assert.equal(result.headers.get('x-lingji-relay'),'retired');}
});
