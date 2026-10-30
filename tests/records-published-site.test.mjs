import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPair, SignJWT } from 'jose';
import { createSiteWorker, MAX_SHARE_BYTES } from '../apps/site/src/worker.mjs';
import { verifyPublisherToken, publisher } from '../apps/site/src/identity.mjs';
import { exampleContent } from '../apps/site/src/example.mjs';
import { normalizePublishedContent, createPublishedContent, ShareContentError } from '../packages/records/src/published-content.mjs';
import { deployPublicSite, projectName } from '../scripts/deploy-public-site.mjs';

const origin='https://lingji-meeting-studio-beta.pages.dev';
let fixtureNumber=0;
async function fixture(t){
  const clientIp=`192.0.2.${++fixtureNumber}`;
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(await readFile(new URL('../apps/site/migrations/0001_shares.sql',import.meta.url),'utf8'));t.after(()=>sqlite.close());
  let mode='',afterInsert=false,reads=0;const objects=new Map();
  const db={withSession(){return this;},prepare(sql){let args=[];return {bind(...values){args=values;return this;},async first(){if(mode==='unknown' && afterInsert)throw new Error('uncertain');reads++;return sqlite.prepare(sql).get(...args) || null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){if(sql.startsWith('INSERT') && ['failed','unknown'].includes(mode)){afterInsert=true;throw new Error('write unavailable');}const result=sqlite.prepare(sql).run(...args);if(sql.startsWith('INSERT') && mode==='committed'){afterInsert=true;throw new Error('response lost');}return {meta:{changes:Number(result.changes)}};}};}};
  const env={DB:db,BUCKET:{async put(key,value){objects.set(key,value);},async get(key){return objects.has(key)?{text:async()=>objects.get(key)}:null;},async delete(key){objects.delete(key);}},ASSETS:{fetch:async()=>new Response('static asset')},ACCESS_TEAM_DOMAIN:'fixture.cloudflareaccess.com',ACCESS_AUD:'fixture'};
  const worker=createSiteWorker({identify:async request=>{if(!request.headers.get('test-owner'))throw new ShareContentError('publisher_login_required',401);return {id:request.headers.get('test-owner')};}});
  const call=(path,method='GET',value,owner='owner-a',extra={})=>worker.fetch(new Request(origin+path,{method,headers:{origin,'test-owner':owner,'cf-connecting-ip':clientIp,...extra},...(value!==undefined?{body:JSON.stringify(value)}:{})}),env);
  const input=()=>({requestId:crypto.randomUUID(),token:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),content:structuredClone(exampleContent)});
  return {sqlite,objects,env,worker,call,input,setMode(value){mode=value;},get reads(){return reads;}};
}

test('published schema strips private metadata, freezes references and respects share scope',()=>{
  const input=structuredClone(exampleContent);input.secret='private';input.minutes.runtime={apiKey:'private'};input.notes='private';input.segments=[{...input.minutes.evidenceSnapshot[0],text:'not selected'}];
  const output=normalizePublishedContent(input);assert.equal('segments' in output,false);assert.doesNotMatch(JSON.stringify(output),/private|not selected/);
  assert.deepEqual(output.minutes.sections[0].items[0].evidence,[{segmentId:'example-1',revision:1}]);
  input.scope='full';assert.equal(normalizePublishedContent(input).segments[0].text,'not selected');
  const record={id:input.sourceRecordId,title:input.title,capture:'completed',minutes:input.minutes,segments:input.segments};assert.equal(createPublishedContent(record,'minutes').draft,false);
  record.capture='recording';assert.equal(createPublishedContent(record,'minutes').draft,true);
});
test('invalid schema and unresolved frozen references are rejected at the upload boundary',()=>{
  for(const mutate of [v=>v.schemaVersion=2,v=>v.minutes.sections[0].items[0].evidence[0].revision=999,v=>v.minutes.topics=[null],v=>v.minutes.visuals=[null],v=>v.minutes.speakerSummaries=[null],v=>v.minutes.evidenceSnapshot.push(v.minutes.evidenceSnapshot[0]),v=>v.scope='private']){const input=structuredClone(exampleContent);mutate(input);assert.throws(()=>normalizePublishedContent(input),ShareContentError);}
  for(const input of [null,{},[],false])assert.throws(()=>normalizePublishedContent(input),ShareContentError);
});
test('real signed publisher JWT verifies issuer, audience, expiry and signature',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256');const make=(aud='publish',iss='https://team.cloudflareaccess.com',exp='2h')=>new SignJWT({}).setProtectedHeader({alg:'RS256'}).setSubject('owner').setIssuer(iss).setAudience(aud).setExpirationTime(exp).sign(privateKey);
  assert.deepEqual(await verifyPublisherToken(await make(),publicKey,'https://team.cloudflareaccess.com','publish'),{id:'owner'});
  for(const token of [await make('other'),await make('publish','https://wrong.invalid'),await make('publish','https://team.cloudflareaccess.com',1)])await assert.rejects(verifyPublisherToken(token,publicKey,'https://team.cloudflareaccess.com','publish'));
  const other=await generateKeyPair('RS256');await assert.rejects(verifyPublisherToken(await make(),other.publicKey,'https://team.cloudflareaccess.com','publish'));
  await assert.rejects(publisher(new Request(origin),{}),{code:'publishing_not_configured'});
  await assert.rejects(publisher(new Request(origin),{ACCESS_TEAM_DOMAIN:'team.cloudflareaccess.com',ACCESS_AUD:'publish'}),{code:'publisher_login_required'});
});
test('publish is authenticated, origin protected, idempotent and owner isolated',async t=>{
  const f=await fixture(t),input=f.input();
  assert.equal((await f.call('/api/publish','POST',input,'')).status,401);
  assert.equal((await f.call('/api/publish','POST',input,'owner-a',{origin:'https://evil.invalid'})).status,403);
  assert.equal(f.objects.size,0);
  const response=await f.call('/api/publish','POST',input);assert.equal(response.status,201);const saved=await response.json();assert.equal(f.objects.size,1);
  assert.equal((await f.call('/api/publish','POST',input)).status,200);assert.equal(f.objects.size,1);
  const changed=structuredClone(input);changed.content.title='changed';assert.equal((await f.call('/api/publish','POST',changed)).status,409);
  assert.equal((await f.call(`/api/published/${saved.id}`,'DELETE',undefined,'owner-b')).status,404);
  assert.equal((await (await f.call('/api/published','GET',undefined,'owner-b')).json()).shares.length,0);
  const read=await f.call(saved.path);assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');assert.match(await read.text(),/source-example-1-1/);
  assert.equal((await f.call('/api/shared/'+input.token+'/status')).status,200);
  assert.equal((await f.call(`/api/published/${saved.id}`,'DELETE')).status,200);assert.equal(f.objects.size,0);
  assert.equal((await f.call(saved.path)).status,404);assert.equal((await f.call('/api/shared/'+input.token+'/status')).status,404);
});
test('expired metadata blocks access before loading the body',async t=>{
  const f=await fixture(t),input=f.input();const saved=await (await f.call('/api/publish','POST',input)).json();f.sqlite.prepare('UPDATE shares SET expires_at=1').run();f.env.BUCKET.get=()=>{throw new Error('must not fetch expired body');};assert.equal((await f.call(saved.path)).status,404);
});
test('HTML uses escaped data, exact source anchors, and no scripts from uploaded text',async t=>{
  const f=await fixture(t),input=f.input();input.content.title='<script>alert(1)</script>';input.content.minutes.sections[0].items[0].text='<img src=x onerror=alert(1)>';
  const saved=await (await f.call('/api/publish','POST',input)).json(),response=await f.call(saved.path),html=await response.text();assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>alert|<img src=x/);assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(html,/share-status\.js/);
});
for(const mode of ['committed','failed','unknown'])test(`uncertain D1 outcome: ${mode} preserves the correct R2 object`,async t=>{
  const f=await fixture(t),input=f.input();f.setMode(mode);const response=await f.call('/api/publish','POST',input);assert.equal(response.status,mode==='committed'?200:503);assert.equal(f.objects.size,mode==='failed'?0:1);
  if(mode==='committed'){const saved=await response.json();f.setMode('');assert.equal((await f.call(saved.path)).status,200);}
});
test('quota is enforced in SQL and failed uploads leave no readable object',async t=>{
  const f=await fixture(t);for(let i=0;i<100;i++)assert.equal((await f.call('/api/publish','POST',f.input())).status,201);assert.equal((await f.call('/api/publish','POST',f.input())).status,429);assert.equal(f.objects.size,100);
});
test('chunked oversized uploads stop at the byte limit',async t=>{
  const f=await fixture(t);const response=await f.worker.fetch(new Request(origin+'/api/publish',{method:'POST',headers:{origin,'test-owner':'owner-a'},body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array(MAX_SHARE_BYTES+1));controller.close();}}),duplex:'half'}),f.env);assert.equal(response.status,413);assert.equal(f.objects.size,0);
});
test('invalid tokens have a bounded lookup budget while valid shared readers do not consume it',async t=>{
  const f=await fixture(t),input=f.input(),saved=await (await f.call('/api/publish','POST',input)).json();
  for(let i=0;i<70;i++)assert.equal((await f.call(saved.path)).status,200);
  for(let i=0;i<60;i++)assert.equal((await f.call('/share/'+'a'.repeat(43))).status,404);
  const reads=f.reads;assert.equal((await f.call('/share/'+'b'.repeat(43))).status,429);assert.equal(f.reads,reads);
});
test('API and unknown share paths never fall through to a static SPA',async t=>{
  const f=await fixture(t);for(const path of ['/api/missing','/share/bad'])assert.equal((await f.call(path)).status,404);assert.equal((await f.call('/example')).status,200);assert.equal((await f.call('/')).status,200);
});

test('deployment fails before mutations when credentials or project ownership are missing',async()=>{
  let calls=0;await assert.rejects(deployPublicSite({env:{},fetcher:async()=>{calls++;}}),/GitHub Secrets/);assert.equal(calls,0);
  const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'test-secret'};
  await assert.rejects(deployPublicSite({env,fetcher:async(_url,options)=>{calls++;assert.equal(options.method,'GET');return Response.json({success:true,result:{deployment_configs:{production:{env_vars:{}}}}});}}),/not owned/);assert.equal(calls,1);
});

test('concurrent invalid reads reserve capacity before awaiting D1',async t=>{
  const f=await fixture(t);let release,lookups=0;
  const gate=new Promise(resolve=>{release=resolve;});
  f.env.DB={withSession(){return this;},prepare(){return{bind(){return this;},async first(){lookups++;await gate;return null;}};}};
  const requests=Array.from({length:80},()=>f.call('/share/'+'z'.repeat(43)));
  await new Promise(resolve=>setTimeout(resolve,50));release();
  const responses=await Promise.all(requests);assert.equal(lookups,60);assert.equal(responses.filter(r=>r.status===429).length,20);
});
test('deployment provisions bindings, applies migrations and verifies the production source and example',async t=>{
  const root=await mkdtemp(join(tmpdir(),'lingji-pages-deploy-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'apps/site'),{recursive:true});
  const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'test-secret',GITHUB_SHA:'b'.repeat(40)},calls=[],commands=[];
  const fetcher=async(url,options={})=>{
    const path=new URL(url).pathname;calls.push([options.method || 'GET',path]);
    if(!path.startsWith('/client/v4/'))return path==='/example'?new Response('source-example-1-1'):Response.json({publishing:false});
    let result={};
    if(options.method==='GET' && path.endsWith('/pages/projects/'+projectName)){
      if(!commands.length)return new Response('{}',{status:404});
      result={subdomain:projectName+'.pages.dev',production_deployment:{id:'deployment',deployment_trigger:{metadata:{commit_hash:env.GITHUB_SHA}}}};
    }else if(path.endsWith('/d1/database') && options.method==='GET')result=[];
    else if(path.includes('/r2/buckets/') && options.method==='GET')return new Response('{}',{status:404});
    else if(path.endsWith('/d1/database'))result={uuid:'database-id'};
    return Response.json({success:true,result});
  };
  const receipt=await deployPublicSite({env,root,fetcher,run:async(...args)=>commands.push(args)});
  assert.equal(receipt.url,origin);assert.equal(receipt.sha,env.GITHUB_SHA);assert.equal(commands.length,2);
  assert.equal(commands[1][1].includes('--config'),false,'Pages uses the standard project config path');
  const config=JSON.parse(await readFile(join(root,'apps/site/wrangler.jsonc'),'utf8'));assert.equal(config.d1_databases[0].database_id,'database-id');assert.equal(config.vars.LINGJI_SITE_ID,'lingji-public-site-v1');assert.equal(JSON.stringify(config).includes('test-secret'),false);assert.ok(calls.some(([method,path])=>method==='PUT' && path.endsWith('/lifecycle')));
});
