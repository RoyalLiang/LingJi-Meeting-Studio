import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFeishuRelay,RELAY_ID} from '../apps/feishu-relay/src/worker.mjs';
import {FEISHU_RELAY_ORIGIN,FEISHU_REDIRECT_URI} from '../packages/records/src/feishu-oauth.mjs';
import {createRepository} from '../services/records/src/repository.mjs';
import {createFeishu} from '../services/records/src/integrations/feishu.mjs';
const token=()=>randomBytes(32).toString('base64url'),hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(await readFile(new URL('../apps/feishu-relay/migrations/0001_transactions.sql',import.meta.url),'utf8'));t.after(()=>sqlite.close());
  const DB={withSession(){return this;},prepare(sql){return{bind(...params){return{async first(){return sqlite.prepare(sql).get(...params)||null;},async run(){const result=sqlite.prepare(sql).run(...params);return{meta:{changes:Number(result.changes)}};}};}};}};
  let time=Date.now();const app=createFeishuRelay({now:()=>time}),env={DB,LINGJI_FEISHU_RELAY_ID:RELAY_ID,FEISHU_RELAY_KEY:token(),RELAY_REVISION:'fixture'};
  const state=token(),claim=token(),challenge=token(),data={state,clientId:'cli_fixture_app',claimHash:hash(claim),challenge};
  const request=(path,method='GET',body,key)=>app.fetch(new Request(FEISHU_RELAY_ORIGIN+path,{method,headers:{...(key?{Authorization:`Bearer ${key}`}:{}) ,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
  return {sqlite,state,claim,data,env,app,request,advance:ms=>{time+=ms;},path:`/api/integrations/feishu/transactions/${hash(state)}`,start:()=>request('/api/integrations/feishu/transactions','POST',data)};
}
test('desktop default callback is the registered HTTPS relay, not a loopback URL',async t=>{
  const root=await mkdtemp(join(tmpdir(),'lingji-relay-default-')),repo=await createRepository({root,databaseUrl:''}),feishu=await createFeishu(repo);
  t.after(async()=>{await feishu.close();await repo.close();await rm(root,{recursive:true,force:true});});
  assert.equal((await feishu.settings('owner')).redirectUri,FEISHU_REDIRECT_URI);
});
test('relay stores encrypted short-lived codes and isolates device claim keys',async t=>{
  const h=await fixture(t);assert.equal((await h.start()).status,201);assert.equal((await h.start()).status,201);
  const pending=await h.request(h.path,'GET',undefined,h.claim);assert.equal((await pending.json()).status,'pending');
  assert.equal((await h.request(h.path,'GET',undefined,token())).status,401);assert.equal((await h.request(h.path)).status,401);
  const received=await h.request(`/api/integrations/feishu/callback?state=${h.state}&code=synthetic-code`);assert.equal(received.status,200);
  const html=await received.text();assert.doesNotMatch(html,new RegExp(h.state+'|synthetic-code|'+h.claim));assert.equal(received.headers.get('referrer-policy'),'no-referrer');
  const stored=h.sqlite.prepare('SELECT * FROM oauth_transactions').get();assert.doesNotMatch(JSON.stringify(stored),/synthetic-code/);assert.equal(stored.state_hash,hash(h.state));
  for(let i=0;i<2;i++){const result=await h.request(h.path,'GET',undefined,h.claim);assert.deepEqual(await result.json(),{status:'ready',expiresAt:stored.result_expires_at,code:'synthetic-code'});}
  assert.equal((await h.request(`/api/integrations/feishu/callback?state=${h.state}&code=replacement`)).status,410);
  assert.equal((await h.request(h.path,'DELETE',undefined,h.claim)).status,200);assert.equal((await h.request(h.path,'GET',undefined,h.claim)).status,410);
  assert.equal(h.sqlite.prepare('SELECT result FROM oauth_transactions').get().result,null);
});
test('relay rejects changed registrations, expires claims and handles denied authorization',async t=>{
  const h=await fixture(t);await h.start();assert.equal((await h.request('/api/integrations/feishu/transactions','POST',{...h.data,claimHash:hash(token())})).status,409);
  assert.equal((await h.request(`/api/integrations/feishu/callback?state=${h.state}&error=access_denied`)).status,200);
  assert.equal((await (await h.request(h.path,'GET',undefined,h.claim)).json()).error,'access_denied');h.advance(120001);
  assert.equal((await h.request(h.path,'GET',undefined,h.claim)).status,410);
});
test('relay callback accepts opaque encoded codes and never substitutes state for claim authentication',async t=>{
  const h=await fixture(t);await h.start();const code='opaque+code/with=padding';
  assert.equal((await h.request(`/api/integrations/feishu/callback?state=${h.state}&code=invalid&error=`)).status,400);
  assert.equal((await h.request(`/api/integrations/feishu/callback?state=${h.state}&code=${encodeURIComponent(code)}`)).status,200);
  assert.equal((await (await h.request(h.path,'GET',undefined,h.claim)).json()).code,code);
  assert.equal((await h.request(h.path,'GET',undefined,h.state)).status,401);
});
test('relay bounds registration bodies, active transactions and durable rate windows',async t=>{
  const h=await fixture(t);let response;
  for(let i=0;i<21;i++)response=await h.request('/api/integrations/feishu/transactions','POST',{...h.data,state:token()});
  assert.equal(response.status,429);h.advance(60001);assert.equal((await h.start()).status,201);
  assert.equal((await h.request('/api/integrations/feishu/transactions','POST',{...h.data,extra:'x'})).status,400);
  const config=await (await h.request('/api/integrations/feishu/config')).json();assert.equal(config.redirectUri,FEISHU_REDIRECT_URI);assert.equal(config.storesAppSecret,false);
});

async function desktop(t,h,extra={}){
  const root=await mkdtemp(join(tmpdir(),'lingji-relay-desktop-')),repo=await createRepository({root,databaseUrl:''}),calls=[],cloud=[];
  const secret='private-self-app-secret',accessToken='private-access-token';
  const fetcher=async(url,options)=>{calls.push({url,body:options.body,signal:options.signal});if(url.endsWith('/oauth/v3/token')){if(extra.tokenGate)await extra.tokenGate;return Response.json({access_token:accessToken,expires_in:7200,refresh_token:'private-refresh',refresh_token_expires_in:604800});}return Response.json({code:0,data:{open_id:'test-user',tenant_key:'test-tenant',name:'授权流程验证'}});};
  let lost=false;
  const relayFetch=async(url,options)=>{cloud.push({url,options});const response=await h.app.fetch(new Request(url,options),h.env);if(extra.loseRegistrationAck&&!lost&&options.method==='POST'){lost=true;throw new Error('lost acknowledgement');}return response;};
  const feishu=await createFeishu(repo,{fetch:fetcher,relayFetch,relayPollMs:100});
  t.after(async()=>{await feishu.close();await repo.close();await rm(root,{recursive:true,force:true});});
  await feishu.configure('owner',{appId:'cli_fixture_app',appSecret:secret,redirectUri:FEISHU_REDIRECT_URI});
  const wait=async(predicate)=>{for(let i=0;i<150;i++){const value=await feishu.settings('owner');if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('desktop authorization did not settle');};
  return {repo,feishu,calls,cloud,secret,accessToken,wait};
}
test('desktop receives HTTPS relay result in background and exchanges PKCE locally without forwarding secrets',async t=>{
  const h=await fixture(t),d=await desktop(t,h,{loseRegistrationAck:true});const started=await d.feishu.authorize('owner'),url=new URL(started.url),state=url.searchParams.get('state');
  assert.equal(url.searchParams.get('redirect_uri'),FEISHU_REDIRECT_URI);assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM oauth_transactions').get().count,1);
  await h.request(`/api/integrations/feishu/callback?state=${state}&code=provider-code`);
  await d.wait(value=>value.connected);const exchange=JSON.parse(d.calls[0].body);
  assert.equal(exchange.client_secret,d.secret);assert.equal(exchange.redirect_uri,FEISHU_REDIRECT_URI);
  assert.equal(createHash('sha256').update(exchange.code_verifier).digest('base64url'),url.searchParams.get('code_challenge'));
  assert.equal((await d.feishu.settings('another-owner')).connected,false);
  const sent=JSON.stringify(d.cloud);assert.ok(!sent.includes(d.secret)&&!sent.includes(d.accessToken)&&!sent.includes(exchange.code_verifier));
  await d.wait(()=>h.sqlite.prepare('SELECT result FROM oauth_transactions').get().result===null);
});
test('desktop cancellation and a new authorization retire old relay transactions',async t=>{
  const h=await fixture(t),d=await desktop(t,h);const first=new URL((await d.feishu.authorize('owner')).url),old=first.searchParams.get('state');
  await d.feishu.cancelAuthorization('owner');assert.equal((await d.feishu.settings('owner')).authorization.status,'idle');
  const next=new URL((await d.feishu.authorize('owner')).url);assert.notEqual(next.searchParams.get('state'),old);
  assert.equal((await h.request(`/api/integrations/feishu/callback?state=${old}&code=old-code`)).status,410);
  await h.request(`/api/integrations/feishu/callback?state=${next.searchParams.get('state')}&error=access_denied`);
  assert.equal((await d.wait(value=>value.authorization.status==='failed')).authorization.error,'feishu_authorization_denied');assert.equal(d.calls.length,0);
});
test('cancel during token exchange aborts the attempt and fences a late successful response',async t=>{
  let release;const tokenGate=new Promise(resolve=>{release=resolve;}),h=await fixture(t),d=await desktop(t,h,{tokenGate});
  const started=new URL((await d.feishu.authorize('owner')).url);await h.request(`/api/integrations/feishu/callback?state=${started.searchParams.get('state')}&code=delayed-code`);
  try{
    await d.wait(()=>d.calls.length===1);await d.feishu.cancelAuthorization('owner');
    assert.equal(d.calls[0].signal.aborted,true,'Cancellation must reach an in-flight token exchange');
  }finally{release();}
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await d.feishu.settings('owner')).connected,false);
});
test('cancel while authorization initialization awaits storage cannot resurrect the attempt',async t=>{
  const h=await fixture(t),d=await desktop(t,h),change=d.repo.change.bind(d.repo);let entered=false,release;
  const gate=new Promise(resolve=>{release=resolve;});
  d.repo.change=async(...args)=>{if(!entered){entered=true;await gate;}return change(...args);};
  const authorization=d.feishu.authorize('owner').catch(error=>error);
  try{await d.wait(()=>entered);await d.feishu.cancelAuthorization('owner');}finally{release();}
  const result=await authorization;assert.equal(result.code,'feishu_oauth_expired');assert.equal(d.cloud.length,0);assert.equal((await d.feishu.settings('owner')).connected,false);
});
