import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { SignJWT } from 'jose';
import { createSiteWorker } from '../apps/site/src/worker.mjs';
import { authentication, publisher, publishingConfigured } from '../apps/site/src/identity.mjs';
import { exampleContent } from '../apps/site/src/example.mjs';
import { normalizePublishedContent, createPublishedContent, ShareContentError, MAX_PUBLISHED_BYTES } from '../packages/records/src/published-content.mjs';
import { deployPublicSite, projectName, verifySiteSharing } from '../scripts/deploy-public-site.mjs';

const origin='https://lingji-meeting-studio-beta.pages.dev';
const oauthEnv={GITHUB_CLIENT_ID:'fixture-client-id',GITHUB_CLIENT_SECRET:'s'.repeat(40),PUBLISHER_GITHUB_ID:'123',PUBLIC_SITE_ORIGIN:'https://rookiecode.com'};
const oauthRequest=(path,cookie='',extra={})=>new Request(oauthEnv.PUBLIC_SITE_ORIGIN+path,{headers:{cookie,...extra}});
async function loginFlow(){
  const response=await authentication(oauthRequest('/auth/login'),oauthEnv),target=new URL(response.headers.get('location'));
  return {response,target,cookie:response.headers.get('set-cookie').split(';')[0]};
}
test('GitHub sign-in uses empty scopes, PKCE and a short HttpOnly host cookie',async()=>{
  const {response,target,cookie}=await loginFlow();
  assert.equal(response.status,303);assert.equal(target.origin,'https://github.com');assert.equal(target.searchParams.get('scope'),'');assert.equal(target.searchParams.get('code_challenge_method'),'S256');assert.equal(target.searchParams.get('code_challenge').length,43);assert.equal(target.searchParams.get('state').length,43);
  assert.equal(target.searchParams.get('redirect_uri'),'https://rookiecode.com/auth/callback');assert.match(cookie,/^__Host-lingji_oauth=/);assert.match(response.headers.get('set-cookie'),/Secure; HttpOnly; SameSite=Lax; Max-Age=600/);
  assert.equal(publishingConfigured(oauthEnv),true);assert.equal(publishingConfigured({...oauthEnv,GITHUB_CLIENT_SECRET:''}),false);
});
test('OAuth validates the live immutable identity and creates only an eight-hour publisher session',async()=>{
  const {target,cookie}=await loginFlow();let calls=0;
  const response=await authentication(oauthRequest('/auth/callback?code=test-code&state='+target.searchParams.get('state'),cookie),oauthEnv,async(url,options)=>{
    calls++;
    if(calls===1){assert.equal(url,'https://github.com/login/oauth/access_token');assert.equal(options.body.get('code'),'test-code');assert.equal(options.body.get('code_verifier').length,43);return Response.json({access_token:'test-token',scope:'',token_type:'bearer'});}
    assert.equal(url,'https://api.github.com/user');assert.equal(options.headers.Authorization,'Bearer test-token');return Response.json({id:123,login:'RoyalLiang'});
  });
  assert.equal(response.status,303);assert.equal(response.headers.get('location'),'https://rookiecode.com/publish');assert.equal(calls,2);
  const session=response.headers.getSetCookie().find(v=>v.startsWith('__Host-lingji_publisher='));assert.match(session,/Max-Age=28800/);assert.doesNotMatch(session,/test-token/);
  assert.deepEqual(await publisher(oauthRequest('/api/published',session.split(';')[0]),oauthEnv),{id:'github:123'});
  await assert.rejects(publisher(new Request(origin+'/api/published',{headers:{cookie:session.split(';')[0]}}),oauthEnv),{code:'publisher_login_required'});
});
test('missing, mismatched or forged OAuth state never reaches the token endpoint',async()=>{
  const {cookie}=await loginFlow();let calls=0;
  for(const value of ['',cookie,cookie+'x']){
    const response=await authentication(oauthRequest('/auth/callback?code=test&state=wrong',value),oauthEnv,async()=>{calls++;throw new Error();});assert.equal(response.status,401);assert.match(response.headers.get('set-cookie'),/Max-Age=0/);
  }assert.equal(calls,0);
});
test('OAuth rejects another account, changed immutable ID, expanded scopes and provider failures',async()=>{
  for(const mode of ['login','id','scope','unavailable']){
    const {target,cookie}=await loginFlow();let calls=0;
    const response=await authentication(oauthRequest('/auth/callback?code=test&state='+target.searchParams.get('state'),cookie),oauthEnv,async()=>{
      calls++;if(mode==='unavailable')throw new Error('network');
      if(calls===1)return Response.json({access_token:'test-token',scope:mode==='scope'?'repo':'',token_type:'bearer'});
      return Response.json({id:mode==='id'?456:123,login:mode==='login'?'other':'RoyalLiang'});
    });assert.equal(response.status,401);assert.doesNotMatch(response.headers.get('set-cookie'),/__Host-lingji_publisher=/);
  }
});
test('publisher sessions enforce signature, audience, expiry and allowlist; logout checks Origin',async()=>{
  for(const mode of ['signature','audience','expiry','owner']){
    const token=await new SignJWT({sub:mode==='owner'?'456':'123'}).setProtectedHeader({alg:'HS256'}).setIssuer(oauthEnv.PUBLIC_SITE_ORIGIN).setAudience(mode==='audience'?'oauth-flow':'publisher').setIssuedAt().setExpirationTime(mode==='expiry'?1:'2h').sign(new TextEncoder().encode(mode==='signature'?'x'.repeat(40):oauthEnv.GITHUB_CLIENT_SECRET));
    await assert.rejects(publisher(oauthRequest('/api/published','__Host-lingji_publisher='+token),oauthEnv),{code:'publisher_login_required'});
  }
  await assert.rejects(publisher(oauthRequest('/api/published'),{}),{code:'publishing_not_configured'});
  await assert.rejects(authentication(new Request('https://rookiecode.com/auth/logout',{method:'POST',headers:{origin:'https://evil.invalid'}}),oauthEnv),{code:'origin_rejected'});
  const logout=await authentication(new Request('https://rookiecode.com/auth/logout',{method:'POST',headers:{origin:'https://rookiecode.com'}}),oauthEnv);assert.equal(logout.status,303);assert.equal(logout.headers.getSetCookie().length,2);assert.ok(logout.headers.getSetCookie().every(v=>v.includes('Max-Age=0')));
});
test('a revoked reader clears its body and stops background status requests',async()=>{
  let reads=0,periodic,visibility,stopped=false,cleared=false;
  const status={dataset:{expires:String(Date.now()+60000)},textContent:''};
  runInNewContext(await readFile(new URL('../apps/site/public/share-status.js',import.meta.url),'utf8'),{
    document:{hidden:false,getElementById:()=>status,querySelector:()=>({replaceChildren:()=>{cleared=true;}}),addEventListener:(_event,callback)=>{visibility=callback;}},
    location:{pathname:'/share/'+'a'.repeat(43)},fetch:async()=>{reads++;return{status:404,ok:false};},AbortSignal,
    setTimeout:()=>1,clearTimeout(){},setInterval:callback=>{periodic=callback;return 2;},clearInterval:()=>{stopped=true;}
  });
  await new Promise(resolve=>setImmediate(resolve));await periodic();await visibility();assert.equal(reads,1);assert.equal(cleared,true);assert.equal(stopped,true);
});
let fixtureNumber=0;
async function fixture(t){
  const clientIp=`192.0.2.${++fixtureNumber}`;
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(await readFile(new URL('../apps/site/migrations/0001_shares.sql',import.meta.url),'utf8'));t.after(()=>sqlite.close());
  let mode='',afterInsert=false,reads=0;const queries=[];
  const db={withSession(){return this;},prepare(sql){queries.push(sql);let args=[];return {bind(...values){args=values;return this;},async first(){if(mode==='unknown' && afterInsert)throw new Error('uncertain');reads++;return sqlite.prepare(sql).get(...args) || null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){if(sql.startsWith('INSERT') && ['failed','unknown'].includes(mode)){afterInsert=true;throw new Error('write unavailable');}const result=sqlite.prepare(sql).run(...args);if(sql.startsWith('INSERT') && mode==='committed'){afterInsert=true;throw new Error('response lost');}return {meta:{changes:Number(result.changes)}};}};}};
  const env={DB:db,ASSETS:{fetch:async()=>new Response('static asset')},GITHUB_CLIENT_ID:'fixture-client-id',GITHUB_CLIENT_SECRET:'s'.repeat(40),PUBLISHER_GITHUB_ID:'123',PUBLIC_SITE_ORIGIN:origin};
  const worker=createSiteWorker({identify:async request=>{if(!request.headers.get('test-owner'))throw new ShareContentError('publisher_login_required',401);return {id:request.headers.get('test-owner')};}});
  const call=(path,method='GET',value,owner='owner-a',extra={})=>worker.fetch(new Request(origin+path,{method,headers:{origin,'test-owner':owner,'cf-connecting-ip':clientIp,...extra},...(value!==undefined?{body:JSON.stringify(value)}:{})}),env);
  const input=()=>({requestId:crypto.randomUUID(),token:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),content:structuredClone(exampleContent)});
  return {sqlite,queries,env,worker,call,input,setMode(value){mode=value;},get reads(){return reads;}};
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
test('publish is authenticated, origin protected, idempotent and owner isolated',async t=>{
  const f=await fixture(t),input=f.input();
  assert.equal((await f.call('/api/publish','POST',input,'')).status,401);
  assert.equal((await f.call('/api/publish','POST',input,'owner-a',{origin:'https://evil.invalid'})).status,403);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM shares').get().n,0);
  const response=await f.call('/api/publish','POST',input);assert.equal(response.status,201);const saved=await response.json();assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM shares').get().n,1);
  assert.equal((await f.call('/api/publish','POST',input)).status,200);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM shares').get().n,1);
  const changed=structuredClone(input);changed.content.title='changed';assert.equal((await f.call('/api/publish','POST',changed)).status,409);
  assert.equal((await f.call(`/api/published/${saved.id}`,'DELETE',undefined,'owner-b')).status,404);
  assert.equal((await (await f.call('/api/published','GET',undefined,'owner-b')).json()).shares.length,0);
  const read=await f.call(saved.path);assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');assert.match(await read.text(),/source-example-1-1/);
  assert.equal((await f.call('/api/shared/'+input.token+'/status')).status,200);assert.doesNotMatch(f.queries.at(-1),/\*|payload/);
  assert.equal((await f.call(`/api/published/${saved.id}`,'DELETE')).status,200);const revoked=f.sqlite.prepare('SELECT revoked_at,payload FROM shares WHERE id=?').get(saved.id);assert.ok(revoked.revoked_at);assert.equal(revoked.payload,null);
  assert.equal((await f.call(saved.path)).status,404);assert.equal((await f.call('/api/shared/'+input.token+'/status')).status,404);
});
test('expired snapshot rows cannot be read',async t=>{
  const f=await fixture(t),input=f.input();const saved=await (await f.call('/api/publish','POST',input)).json();f.sqlite.prepare('UPDATE shares SET expires_at=1').run();assert.equal((await f.call(saved.path)).status,404);
});
test('HTML uses escaped data, exact source anchors, and no scripts from uploaded text',async t=>{
  const f=await fixture(t),input=f.input();input.content.title='<script>alert(1)</script>';input.content.minutes.sections[0].items[0].text='<img src=x onerror=alert(1)>';
  const saved=await (await f.call('/api/publish','POST',input)).json(),response=await f.call(saved.path),html=await response.text();assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>alert|<img src=x/);assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(html,/share-status\.js/);
});
for(const mode of ['committed','failed','unknown'])test(`uncertain D1 outcome: ${mode} preserves one atomic snapshot`,async t=>{
  const f=await fixture(t),input=f.input();f.setMode(mode);const response=await f.call('/api/publish','POST',input);assert.equal(response.status,mode==='committed'?200:503);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM shares').get().n,mode==='committed'?1:0);
  if(mode==='committed'){const saved=await response.json();f.setMode('');assert.equal((await f.call(saved.path)).status,200);}
});
test('quota is enforced in SQL without partial snapshots',async t=>{
  const f=await fixture(t);for(let i=0;i<100;i++)assert.equal((await f.call('/api/publish','POST',f.input())).status,201);assert.equal((await f.call('/api/publish','POST',f.input())).status,429);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM shares').get().n,100);
});
test('chunked oversized uploads stop at the byte limit',async t=>{
  const f=await fixture(t);const response=await f.worker.fetch(new Request(origin+'/api/publish',{method:'POST',headers:{origin,'test-owner':'owner-a'},body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array(MAX_PUBLISHED_BYTES+1));controller.close();}}),duplex:'half'}),f.env);assert.equal(response.status,413);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM shares').get().n,0);
});
test('a large UTF-8 snapshot fits one atomic D1 row, and oversized content is rejected',async t=>{
  const f=await fixture(t),input=f.input();
  input.content.minutes.sections=[{heading:'长纪要',items:Array.from({length:11},()=>({text:'字'.repeat(30000),evidence:[]}))}];
  const result=await f.call('/api/publish','POST',input);assert.equal(result.status,201);
  const stored=f.sqlite.prepare('SELECT payload FROM shares').get().payload;assert.ok(Buffer.byteLength(stored)>900000);assert.ok(Buffer.byteLength(stored)<MAX_PUBLISHED_BYTES);
  const oversized=f.input();oversized.content.minutes.sections=[{heading:'长纪要',items:Array.from({length:11},()=>({text:'字'.repeat(32000),evidence:[]}))}];
  assert.equal((await f.call('/api/publish','POST',oversized)).status,413);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM shares').get().n,1);
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
test('deployment errors redact credentials before logging and never retry rejected permissions',async()=>{
  const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'private-deployment-secret',SITE_GITHUB_CLIENT_ID:'fixture-client-id',SITE_GITHUB_CLIENT_SECRET:'private-oauth-secret-'.repeat(3),PUBLISHER_GITHUB_ID:'123'};let writes=0;
  await assert.rejects(deployPublicSite({env,fetcher:async(url,options)=>{
    if(url.endsWith('/pages/projects/'+projectName))return new Response('{}',{status:404});
    if(options.method==='POST'){writes++;return Response.json({success:false,errors:[{code:10000,message:env.CLOUDFLARE_API_TOKEN+' '+env.SITE_GITHUB_CLIENT_SECRET}]},{status:403});}
    return Response.json({success:true,result:[]});
  }}),error=>{assert.match(error.message,/HTTP 403/);assert.match(error.message,/\[redacted\]/);assert.equal(error.message.includes(env.CLOUDFLARE_API_TOKEN),false);assert.equal(error.message.includes(env.SITE_GITHUB_CLIENT_SECRET),false);return true;});assert.equal(writes,1);
});
test('deployment smoke verifies real snapshot reads and denies expiry/revocation, then removes only its own rows',async t=>{
  const f=await fixture(t),saved=await f.call('/api/publish','POST',f.input());assert.equal(saved.status,201);
  const checks=await verifySiteSharing(async(_path,method,{sql,params})=>{assert.equal(method,'POST');return f.sqlite.prepare(sql).run(...params);},'fixture-db',origin,url=>f.call(new URL(url).pathname));
  assert.deepEqual(checks,{d1Read:true,expiry:true,revocation:true});assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM shares').get().n,1);
});
test('deployment recovers from a non-JSON 500 and confirms a committed final create before migrations',async t=>{
  const root=await mkdtemp(join(tmpdir(),'lingji-pages-deploy-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'apps/site'),{recursive:true});
  const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'test-secret',GITHUB_SHA:'b'.repeat(40),SITE_GITHUB_CLIENT_ID:'fixture-client-id',SITE_GITHUB_CLIENT_SECRET:'oauth-secret-'.repeat(4),PUBLISHER_GITHUB_ID:'123'},calls=[],commands=[];let creates=0,finalConfirmations=0;
  const fetcher=async(url,options={})=>{
    const path=new URL(url).pathname;assert.doesNotMatch(path,/\/r2\//,'R2 must stay disabled');calls.push([options.method || 'GET',path]);
    if(!path.startsWith('/client/v4/')){
      if(path.startsWith('/share/'))return new Response('source-example-1-1',{status:checksDenied?404:200,headers:{'Cache-Control':'no-store'}});
      return path==='/example'?new Response('source-example-1-1'):Response.json({publishing:true});
    }
    let result={};
    if(path.endsWith('/pages/projects') && options.method==='POST'){
      creates++;if(creates===1)return new Response('<html>Unavailable</html>',{status:500});
      return Response.json({success:false,errors:[{code:8000000,message:'Transient creation failure'}]},{status:500});
    }
    if(options.method==='GET' && path.endsWith('/pages/projects/'+projectName)){
      if(!commands.length){
        if(creates<3)return new Response('{}',{status:404});
        finalConfirmations++;return Response.json({success:true,result:{deployment_configs:{production:{env_vars:{LINGJI_SITE_ID:{value:'lingji-public-site-v1'}}}}}});
      }
      result={subdomain:projectName+'.pages.dev',production_deployment:{id:'deployment',deployment_trigger:{metadata:{commit_hash:env.GITHUB_SHA}}}};
    }else if(path.endsWith('/d1/database') && options.method==='GET')result=[];
    else if(path.endsWith('/d1/database'))result={uuid:'database-id'};
    else if(path.endsWith('/query'))checksDenied=!JSON.parse(options.body).sql.startsWith('INSERT');
    if(options.method==='PATCH'){const vars=JSON.parse(options.body).deployment_configs.production.env_vars;assert.deepEqual(vars.GITHUB_CLIENT_SECRET,{type:'secret_text',value:env.SITE_GITHUB_CLIENT_SECRET});}
    return Response.json({success:true,result});
  };
  let checksDenied=false;
  const receipt=await deployPublicSite({env,root,fetcher,run:async(...args)=>commands.push(args)});
  assert.equal(receipt.url,origin);assert.equal(receipt.sha,env.GITHUB_SHA);assert.equal(commands.length,2);assert.equal(creates,3);assert.equal(finalConfirmations,1,'even the last failed create must be read back');
  assert.equal(commands[1][1].includes('--config'),false,'Pages uses the standard project config path');
  const config=JSON.parse(await readFile(join(root,'apps/site/wrangler.jsonc'),'utf8'));assert.equal(config.d1_databases[0].database_id,'database-id');assert.equal(config.vars.LINGJI_SITE_ID,'lingji-public-site-v1');assert.equal(JSON.stringify(config).includes('test-secret'),false);assert.equal(JSON.stringify(config).includes(env.SITE_GITHUB_CLIENT_SECRET),false);assert.equal(config.vars.PUBLIC_SITE_ORIGIN,'https://rookiecode.com');assert.equal('r2_buckets' in config,false);
});
