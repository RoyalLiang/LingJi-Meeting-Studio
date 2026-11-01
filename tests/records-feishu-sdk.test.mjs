import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {WebSocketServer} from 'ws';
import * as Lark from '@larksuiteoapi/node-sdk';
import {createFeishuSdk} from '../services/records/src/integrations/feishu-sdk.mjs';

async function waitFor(check){for(let i=0;i<300;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('SDK fixture condition timed out');}
async function fixture(t){
  const calls=[],flags={},sockets=new Set();let connections=0,tokens=0;
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    calls.push({path:req.url,body:raw?JSON.parse(raw):null,authorization:req.headers.authorization});
    const send=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(req.url==='/callback/ws/endpoint'){
      if(flags.discoveryGate)await flags.discoveryGate;
      return send({code:0,data:{URL:`ws://127.0.0.1:${server.address().port}/ws?device_id=fixture-device&service_id=1`,ClientConfig:{PingInterval:60,ReconnectCount:3,ReconnectInterval:0.01,ReconnectNonce:0}}});
    }
    if(req.url==='/open-apis/auth/v3/tenant_access_token/internal')return send({code:0,tenant_access_token:`fixture-app-token-${++tokens}`,expire:7200});
    return send({code:0,data:{receivedToken:req.headers.authorization}});
  });
  const ws=new WebSocketServer({server,path:'/ws'});ws.on('connection',socket=>{connections++;sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const controller=new AbortController();let expireCache=false;
  class Cache extends Lark.DefaultCache{async get(...args){return expireCache?undefined:super.get(...args);}}
  const runtime=await createFeishuSdk({appId:'cli_a1b2c3d4e5f67890',appSecret:'fixture-sdk-secret',signal:controller.signal},{loadSdk:async()=>({...Lark,Domain:{Feishu:`http://127.0.0.1:${server.address().port}`},DefaultCache:Cache,defaultHttpInstance:{request:config=>Lark.defaultHttpInstance.request({...config,proxy:false})}})});
  t.after(async()=>{controller.abort();runtime.close();for(const socket of sockets)socket.terminate();await new Promise(resolve=>ws.close(resolve));await new Promise(resolve=>server.close(resolve));});
  return {runtime,controller,calls,flags,sockets,base:`http://127.0.0.1:${server.address().port}`,connections:()=>connections,tokens:()=>tokens,expire(){expireCache=true;}};
}

test('official SDK establishes a real socket, caches application tokens and renews an expired cache entry',async t=>{
  const h=await fixture(t);await h.runtime.start();await waitFor(()=>h.runtime.status().state==='connected');assert.equal(h.runtime.status().state,'connected');assert.equal(h.connections(),1);
  const first=await h.runtime.request(h.base+'/open-apis/probe',{body:{fixture:true}});
  assert.equal(first.data.receivedToken,'Bearer fixture-app-token-1');
  await h.runtime.request(h.base+'/open-apis/probe',{body:{fixture:true}});assert.equal(h.tokens(),1);
  h.expire();const renewed=await h.runtime.request(h.base+'/open-apis/probe',{body:{fixture:true}});assert.equal(h.tokens(),2);assert.equal(renewed.data.receivedToken,'Bearer fixture-app-token-2');
  assert.ok(h.calls.every(call=>!call.path.includes('oauth')));
  assert.deepEqual(h.calls.find(call=>call.path==='/callback/ws/endpoint').body,{AppID:'cli_a1b2c3d4e5f67890',AppSecret:'fixture-sdk-secret'});
  h.controller.abort();await waitFor(()=>h.sockets.size===0);assert.equal(h.runtime.status().state,'idle');
});

test('official SDK reconnects a dropped socket and close stops further reconnects',async t=>{
  const h=await fixture(t);await h.runtime.start();await waitFor(()=>h.runtime.status().state==='connected');[...h.sockets][0].terminate();
  await waitFor(()=>h.connections()>=2&&h.runtime.status().state==='connected');
  h.runtime.close();await waitFor(()=>h.sockets.size===0);assert.equal(h.runtime.status().state,'idle');
});

test('aborting official SDK discovery cannot resurrect a late socket',async t=>{
  const h=await fixture(t);let release;h.flags.discoveryGate=new Promise(resolve=>{release=resolve;});
  await h.runtime.start();
  try{await waitFor(()=>h.calls.some(call=>call.path==='/callback/ws/endpoint'));h.controller.abort();}finally{release();}
  await waitFor(()=>h.runtime.status().state==='idle');
  assert.equal(h.connections(),0);assert.equal(h.runtime.status().state,'idle');
});
