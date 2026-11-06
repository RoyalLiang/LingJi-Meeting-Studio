import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import{gunzipSync}from'node:zlib';import{mkdtemp,writeFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{sendHttpPayload}from'../services/records/src/http-response.mjs';import{createProductionServer}from'../apps/web/src/production-server.mjs';
const raw=(server,encoding='gzip',method='GET')=>new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:server.address().port,path:'/',method,headers:{'Accept-Encoding':encoding}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({headers:res.headers,body:Buffer.concat(chunks)}));}).on('error',reject);});
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
test('JSON transport compresses losslessly, respects opt-out and coalesces concurrent reads',async t=>{
 const payload=Buffer.from(JSON.stringify({segments:Array.from({length:3000},(_,i)=>({id:i,text:'会议纪要保留人工修订和原文引用。',revision:1}))}));
 const server=http.createServer((req,res)=>void sendHttpPayload(res,200,payload,{'Content-Type':'application/json','Cache-Control':'no-store'}));await listen(server);t.after(()=>server.close());
 const replies=await Promise.all(Array.from({length:8},()=>raw(server)));for(const value of replies){assert.equal(value.headers['content-encoding'],'gzip');assert.equal(value.headers['content-length'],String(value.body.length));assert.deepEqual(gunzipSync(value.body),payload);assert.ok(value.body.length<payload.length*.2);}
 for(const encoding of ['gzip;q=0','br, *;q=0','*;q=1, gzip;q=0','identity']){const value=await raw(server,encoding);assert.equal(value.headers['content-encoding'],undefined);assert.deepEqual(value.body,payload);}
 assert.equal((await raw(server,'*;q=.5')).headers['content-encoding'],'gzip');const head=await raw(server,'gzip','HEAD');assert.equal(head.body.length,0);assert.equal(head.headers['content-length'],replies[0].headers['content-length']);
 console.log(JSON.stringify({httpCompression:{identityBytes:payload.length,gzipBytes:replies[0].body.length}}));
});
test('production static cache serves compressed HTML and notices edited files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lingji-http-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'index.html'),'<main>原始页面</main>'.repeat(1000));
 const server=createProductionServer({root});await listen(server);t.after(()=>server.close());const first=await raw(server);assert.equal(first.headers['content-encoding'],'gzip');assert.match(gunzipSync(first.body).toString(),/原始页面/);assert.match(first.headers.vary,/Accept-Encoding/);
 await writeFile(join(root,'index.html'),'<main>更新后的配置页面</main>'.repeat(1000));const changed=await raw(server);assert.match(gunzipSync(changed.body).toString(),/更新后的配置页面/);assert.notDeepEqual(changed.body,first.body);
});
