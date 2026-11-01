import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {deployFeishuRelay,relayProject,relayDatabase} from '../scripts/deploy-feishu-relay.mjs';
import {createFeishuRelay,RELAY_ID} from '../apps/feishu-relay/src/worker.mjs';
const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'private-cloudflare-token',GITHUB_SHA:'b'.repeat(40)};
test('relay deployment refuses foreign Pages resources and redacts provider errors',async()=>{
  const methods=[];await assert.rejects(deployFeishuRelay({env,fetcher:async(url,options)=>{methods.push(options.method);return Response.json({success:true,result:{deployment_configs:{production:{env_vars:{}}}}});}}),/ownership marker/);assert.deepEqual(methods,['GET']);
  await assert.rejects(deployFeishuRelay({env,fetcher:async()=>Response.json({success:false,errors:[{code:1000,message:env.CLOUDFLARE_API_TOKEN}]},{status:403})}),error=>!error.message.includes(env.CLOUDFLARE_API_TOKEN)&&error.message.includes('403'));
});
async function deployment(t,{dns='permission',foreignBinding=false}={}){
  const root=await mkdtemp(join(tmpdir(),'lingji-relay-deploy-'));await mkdir(join(root,'apps/feishu-relay'),{recursive:true});t.after(()=>rm(root,{recursive:true,force:true}));
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;');sqlite.exec(await readFile(new URL('../apps/feishu-relay/migrations/0001_transactions.sql',import.meta.url),'utf8'));t.after(()=>sqlite.close());
  const DB={withSession(){return this;},prepare(sql){return{bind(...params){return{async first(){return sqlite.prepare(sql).get(...params)||null;},async run(){return{meta:{changes:Number(sqlite.prepare(sql).run(...params).changes)}};}};}};}};
  const worker=createFeishuRelay(),workerEnv={DB,LINGJI_FEISHU_RELAY_ID:RELAY_ID,FEISHU_RELAY_KEY:randomBytes(32).toString('base64url')},requests=[],commands=[];
  const project={subdomain:relayProject+'.pages.dev',deployment_configs:{production:{env_vars:{LINGJI_FEISHU_RELAY_ID:{value:RELAY_ID},FEISHU_RELAY_KEY:{type:'secret_text'}},d1_databases:{DB:{id:foreignBinding?'foreign-database':'database-1'}}}},canonical_deployment:{id:'deployment-1',deployment_trigger:{metadata:{commit_hash:env.GITHUB_SHA}}}};
  const fetcher=async(url,options={})=>{
    const parsed=new URL(url);
    if(parsed.hostname!=='api.cloudflare.com'){
      const response=await worker.fetch(new Request(url,options),workerEnv);
      if(parsed.pathname.endsWith('/config'))return Response.json({...await response.json(),revision:env.GITHUB_SHA});return response;
    }
    const path=parsed.pathname.replace('/client/v4','');requests.push({path,method:options.method,body:options.body?JSON.parse(options.body):undefined});
    if(path==='/zones'&&dns==='permission')return Response.json({success:false,errors:[{code:10000}]},{status:403});
    let result;
    if(path.endsWith('/domains/auth.rookiecode.com'))result={name:'auth.rookiecode.com',status:'pending'};
    else if(path.endsWith('/domains'))result=[{name:'auth.rookiecode.com'}];
    else if(path.endsWith('/dns_records'))result=[{type:'TXT',content:'unrelated-record'}];
    else if(path==='/zones')result=[{id:'zone-1'}];
    else if(path.endsWith('/query')){const query=JSON.parse(options.body);result=/^SELECT/i.test(query.sql)?[{results:sqlite.prepare(query.sql).all(...query.params)}]:[{results:[],meta:{changes:Number(sqlite.prepare(query.sql).run(...query.params).changes)}}];}
    else if(path.endsWith('/d1/database'))result=[{name:relayDatabase,uuid:'database-1'}];
    else if(path.includes('/d1/database/')){const id=path.split('/').at(-1);result={uuid:id,name:id==='database-1'?relayDatabase:'unrelated-database'};}
    else result=project;
    return Response.json({success:true,result});
  };
  return {root,sqlite,requests,commands,run:(...args)=>{commands.push(args);return Promise.resolve();},fetcher};
}
test('relay deployment preserves secret configuration and reports DNS permission gaps explicitly',async t=>{
  const h=await deployment(t);const receipt=await deployFeishuRelay({...h,env});
  assert.equal(receipt.sourceSha,env.GITHUB_SHA);assert.equal(receipt.transport.claimIsolation,true);assert.equal(receipt.dnsNeedsPermission,true);assert.equal(receipt.canonicalTransport,null);assert.equal(receipt.realFeishuAuthorization,false);
  assert.ok(h.requests.filter(item=>item.method==='PATCH').every(item=>!item.body.deployment_configs.production.env_vars));
  assert.ok(h.commands.length===2);assert.doesNotMatch(await readFile(join(h.root,'apps/feishu-relay/wrangler.jsonc'),'utf8'),/private-cloudflare|FEISHU_RELAY_KEY/);
});
test('relay deployment never replaces an unrelated auth DNS record',async t=>{
  const h=await deployment(t,{dns:'conflict'});await assert.rejects(deployFeishuRelay({...h,env}),/unrelated auth DNS/);assert.ok(!h.requests.some(item=>item.path.includes('/dns_records')&&item.method!=='GET'));
});
test('relay workflow pins valid full action revisions',async()=>{
  const workflow=await readFile(new URL('../.github/workflows/feishu-relay.yml',import.meta.url),'utf8');
  const uses=[...workflow.matchAll(/uses: [\w/-]+@([a-f0-9]+)/g)];assert.equal(uses.length,3);for(const match of uses)assert.equal(match[1].length,40);
  assert.match(workflow,/cancel-in-progress: false/);assert.match(workflow,/contents: read/);
});
test('scheduled cleanup removes expired code ciphertext even without a later callback or claim',async t=>{
  const h=await deployment(t),now=Date.now();
  h.sqlite.prepare("INSERT INTO oauth_transactions(state_hash,client_id,challenge,claim_hash,created_at,expires_at,result_expires_at,result,status) VALUES(?,?,?,?,?,?,?,?,'ready')").run('c'.repeat(64),'cli_fixture_app','challenge','claim',now-180000,now+420000,now-60000,'expired-encrypted-code');
  h.sqlite.prepare('INSERT INTO oauth_rate_limits(bucket,count,expires_at) VALUES(?,?,?)').run('expired',1,now-1000);
  const result=await deployFeishuRelay({...h,env,cleanup:true});assert.equal(result.expiredTransactionsCleared,true);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM oauth_transactions').get().count,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM oauth_rate_limits').get().count,0);assert.equal(h.commands.length,0);
});
test('cleanup refuses a foreign DB binding before any deletion request',async t=>{
  const h=await deployment(t,{foreignBinding:true});await assert.rejects(deployFeishuRelay({...h,env,cleanup:true}),/different identity/);
  assert.ok(!h.requests.some(request=>request.method!=='GET'));
});
test('deployment refuses unrelated tables while allowing D1 reserved tables',async t=>{
  const h=await deployment(t);h.sqlite.exec('CREATE TABLE unrelated (value TEXT)');
  await assert.rejects(deployFeishuRelay({...h,env}),/unrelated tables/);
  assert.equal(h.commands.length,0);assert.ok(!h.requests.some(request=>request.method==='PATCH'));
});
