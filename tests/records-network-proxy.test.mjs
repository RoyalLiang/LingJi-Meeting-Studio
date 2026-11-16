import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createProxyDispatcher, createProxyResolver, installNetworkProxy, networkAgent, parseMacProxy, parseWindowsProxy, parseLinuxProxy, proxySettings, saveProxySettings } from '../services/records/src/network-proxy.mjs';

async function root(t) { const value = await mkdtemp(join(tmpdir(), 'lingji-proxy-')); t.after(() => rm(value, {recursive:true,force:true})); return value; }
async function listen(t, server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections?.(); server.close(); }); return server.address().port; }
const manual = (url, extra = {}) => ({mode:'manual',url,username:'',password:'',...extra});

test('proxy settings default to system, mask secrets and preserve passwords only for the same destination', async t => {
  const directory = await root(t);
  assert.equal((await proxySettings(directory)).mode, 'system');
  const saved = await saveProxySettings(directory, manual('socks5://127.0.0.1:1080', {username:'user',password:'secret'}));
  assert.equal(saved.password, undefined); assert.equal(saved.hasPassword, true);
  if(process.platform!=='win32') assert.equal((await stat(join(directory,'network-proxy.json'))).mode & 0o777, 0o600);
  await saveProxySettings(directory, {...saved,password:''});
  assert.equal(JSON.parse(await readFile(join(directory,'network-proxy.json'))).password,'secret');
  await saveProxySettings(directory, {...saved,password:'new-draft',clearPassword:true});
  assert.equal((await proxySettings(directory)).hasPassword,false);
  await saveProxySettings(directory, {...saved,password:'',url:'socks5://127.0.0.1:1081'});
  assert.equal((await proxySettings(directory)).hasPassword,false);
  await assert.rejects(saveProxySettings(directory, manual('file:///etc/passwd')), /invalid_proxy_url/);
  await assert.rejects(saveProxySettings(directory, manual('http://user:secret@example.com:80')), /invalid_proxy_url/);
  await assert.rejects(saveProxySettings(directory, manual('http://example.com/path')), /invalid_proxy_url/);
  await assert.rejects(saveProxySettings(directory, manual('socks5://example.com')), /invalid_proxy_url/);
});

test('system proxy parsers retain per-protocol routes, PAC and exclusions', () => {
  const mac = parseMacProxy('HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7890\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7891\nSOCKSEnable : 1\nSOCKSProxy : localhost\nSOCKSPort : 1080\nExceptionsList : <array> {\n0 : *.internal.example\n}\nExcludeSimpleHostnames : 1');
  assert.equal(mac.http, 'http://127.0.0.1:7890'); assert.equal(mac.https, 'http://127.0.0.1:7891'); assert.equal(mac.all,'socks5h://localhost:1080'); assert.deepEqual(mac.bypass,['*.internal.example']);
  const windows=parseWindowsProxy({ProxyEnable:1,ProxyServer:'http=localhost:7890;https=localhost:7891;socks=localhost:1080',ProxyOverride:'<local>;*.internal.example'});
  assert.equal(windows.https,'http://localhost:7891'); assert.equal(windows.all,'socks5h://localhost:1080'); assert.equal(windows.local,true);
  assert.equal(parseWindowsProxy({ProxyEnable:0,AutoConfigURL:'https://proxy.example/proxy.pac'}).pac,'https://proxy.example/proxy.pac');
  const linux=parseLinuxProxy("org.gnome.system.proxy mode 'manual'\norg.gnome.system.proxy.http host 'localhost'\norg.gnome.system.proxy.http port 7890\norg.gnome.system.proxy.https host 'localhost'\norg.gnome.system.proxy.https port 7891\norg.gnome.system.proxy ignore-hosts ['localhost', '*.internal.example']");
  assert.equal(linux.https,'http://localhost:7891'); assert.deepEqual(linux.bypass,['localhost','*.internal.example']);
});

test('loopback stays direct and saved settings apply to new requests without restart', async t => {
  const directory=await root(t), resolve=createProxyResolver(directory,{readSystem:async()=>({https:'http://system.example:7890',bypass:['*.internal.example']})});
  assert.equal(await resolve('https://api.example/'),'http://system.example:7890');
  assert.equal(await resolve('https://service.internal.example/'),'');
  await saveProxySettings(directory,manual('socks5://127.0.0.1:1080'));
  assert.match(await resolve('https://api.example/'),/^socks5h:/);
  assert.match(await resolve('https://127.api.example.com/'),/^socks5h:/);
  for(const address of ['http://localhost:3000','http://127.10.0.2:3000','http://[::1]:3000','http://[::ffff:127.0.0.1]:3000']) assert.equal(await resolve(address),'');
  await saveProxySettings(directory,{...manual(''),mode:'direct'}); assert.equal(await resolve('https://api.example/'),'');
});

test('fetch tunnels HTTP with proxy authentication and streams the original response', async t => {
  const destination=http.createServer((request,response)=>{assert.equal(request.url,'/transcript?q=1');assert.equal(request.headers.authorization,'Bearer model-key');assert.equal(request.headers['proxy-authorization'],undefined);response.write('first');response.end(' second');});
  const port=await listen(t,destination), connects=[];
  const proxy=http.createServer();
  proxy.on('connect',(request,socket,head)=>{connects.push([request.url,request.headers['proxy-authorization']]);const upstream=net.connect(port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);});socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());});
  const proxyPort=await listen(t,proxy), dispatcher=createProxyDispatcher(async()=>`http://user:secret@127.0.0.1:${proxyPort}`);t.after(()=>dispatcher.destroy());
  const response=await fetch('http://api.example/transcript?q=1',{dispatcher,headers:{Authorization:'Bearer model-key'}});
  assert.equal(await response.text(),'first second');assert.deepEqual(connects,[['api.example:80','Basic '+Buffer.from('user:secret').toString('base64')]]);
});

test('SOCKS5 resolves the target at the proxy, rather than leaking local DNS', async t => {
  const destination=http.createServer((_request,response)=>response.end('socks-ok')),port=await listen(t,destination),hosts=[];
  const proxy=net.createServer(socket=>{let buffer=Buffer.alloc(0),stage=0;const data=chunk=>{buffer=Buffer.concat([buffer,chunk]);
    if(stage===0&&buffer.length>=2+buffer[1]){buffer=buffer.subarray(2+buffer[1]);socket.write(Buffer.from([5,0]));stage=1;}
    if(stage===1&&buffer.length>=5){const size=buffer[3]===3?7+buffer[4]:10;if(buffer.length<size)return;assert.equal(buffer[3],3);hosts.push(buffer.subarray(5,5+buffer[4]).toString());buffer=buffer.subarray(size);stage=2;socket.off('data',data);const upstream=net.connect(port,'127.0.0.1',()=>{socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));if(buffer.length)upstream.write(buffer);socket.pipe(upstream).pipe(socket);});socket.on('close',()=>upstream.destroy());socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());}
  };socket.on('data',data);});
  const proxyPort=await listen(t,proxy),dispatcher=createProxyDispatcher(async()=>`socks5h://127.0.0.1:${proxyPort}`);t.after(()=>dispatcher.destroy());
  const response=await fetch('http://unresolvable.invalid/asr',{dispatcher});assert.equal(await response.text(),'socks-ok');assert.deepEqual(hosts,['unresolvable.invalid']);
});

test('rejected proxy credentials fail promptly and never send the origin request', async t => {
  const proxy=http.createServer();let connected=0;
  proxy.on('connect',(_request,socket)=>{connected++;socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');});
  const port=await listen(t,proxy),dispatcher=createProxyDispatcher(async()=>`http://user:wrong@127.0.0.1:${port}`);t.after(()=>dispatcher.destroy());
  await assert.rejects(fetch('https://provider.invalid/private',{dispatcher,signal:AbortSignal.timeout(2000)}),error=>error.name==='TypeError'&&!String(error.cause).includes('wrong'));
  assert.equal(connected,1);
});

test('WebSocket follows the same manual proxy, while local HTTP bypasses it', async t => {
  const directory=await root(t),destination=http.createServer((_request,response)=>response.end('local-ok')),port=await listen(t,destination);
  const websocket=new WebSocketServer({server:destination});websocket.on('connection',socket=>socket.on('message',message=>socket.send(message)));
  const proxy=http.createServer();let connected=0;
  proxy.on('connect',(_request,socket,head)=>{connected++;const upstream=net.connect(port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);});socket.on('close',()=>upstream.destroy());socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());});
  const proxyPort=await listen(t,proxy);await saveProxySettings(directory,manual(`http://127.0.0.1:${proxyPort}`));const network=installNetworkProxy(directory);t.after(()=>network.close());
  const socket=new WebSocket('ws://cloud.example/asr',{agent:networkAgent()});t.after(()=>socket.terminate());await once(socket,'open');socket.send('audio');assert.equal((await once(socket,'message'))[0].toString(),'audio');
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(),'local-ok');assert.equal(connected,1);
});

test('native update tunnel rejects unauthenticated callers',async t=>{
  const directory=await root(t),network=installNetworkProxy(directory),server=http.createServer();
  const detach=network.attachNativeTunnel(server,'private-instance');t.after(async()=>{detach();await network.close();});const port=await listen(t,server);
  const socket=net.connect(port,'127.0.0.1');socket.write('CONNECT github.com:8443 HTTP/1.1\r\nHost: github.com:8443\r\n\r\n');assert.match((await once(socket,'data'))[0].toString(),/407/);socket.destroy();
});

test('PAC uses the complete request path and tries its configured fallback proxies', async t => {
  const directory=await root(t), destination=http.createServer((request,response)=>response.end(request.url)),port=await listen(t,destination);
  const proxy=http.createServer();let connected=0;
  proxy.on('connect',(_request,socket)=>{connected++;const upstream=net.connect(port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.pipe(upstream).pipe(socket);});socket.on('close',()=>upstream.destroy());socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());});
  const proxyPort=await listen(t,proxy),pac=join(directory,'proxy.pac');
  await writeFile(pac,`function FindProxyForURL(url,host){return url.indexOf('/proxied')>=0?'PROXY 127.0.0.1:1; PROXY 127.0.0.1:${proxyPort}':'DIRECT';}`);
  const dispatcher=createProxyDispatcher(async()=>`pac+${pathToFileURL(pac).href}`);t.after(()=>dispatcher.destroy());
  for(const path of ['/direct','/proxied']) assert.equal(await (await fetch(`http://127.0.0.1:${port}${path}`,{dispatcher})).text(),path);
  assert.equal(connected,1);
});

test('native update tunnel follows proxy settings and keeps its credential away from the upstream', async t => {
  const directory=await root(t),destination=net.createServer(socket=>socket.pipe(socket)),port=await listen(t,destination);
  const proxy=http.createServer();let target,credential;
  proxy.on('connect',(request,socket)=>{target=request.url;credential=request.headers['proxy-authorization'];const upstream=net.connect(port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.pipe(upstream).pipe(socket);});socket.on('close',()=>upstream.destroy());socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());});
  const proxyPort=await listen(t,proxy);await saveProxySettings(directory,manual(`http://127.0.0.1:${proxyPort}`));
  const network=installNetworkProxy(directory),server=http.createServer(),detach=network.attachNativeTunnel(server,'native-only-secret');t.after(async()=>{detach();await network.close();});const relayPort=await listen(t,server);
  const socket=net.connect(relayPort,'127.0.0.1');socket.write('CONNECT github.com:8443 HTTP/1.1\r\nHost: github.com:8443\r\nProxy-Authorization: Basic '+Buffer.from('lingji:native-only-secret').toString('base64')+'\r\n\r\n');assert.match((await once(socket,'data'))[0].toString(),/200 Connection Established/);
  socket.write('encrypted-update');assert.equal((await once(socket,'data'))[0].toString(),'encrypted-update');assert.equal(target,'github.com:8443');assert.equal(credential,undefined);socket.destroy();
});


test('parallel requests share the same bounded system-proxy lookup', async t => {
  const directory=await root(t);let reads=0;
  const resolve=createProxyResolver(directory,{readSystem:async()=>{reads++;await new Promise(done=>setTimeout(done,20));return {https:'http://proxy.example:7890'};}});
  const results=await Promise.all(Array.from({length:30},()=>resolve('https://provider.example/')));
  assert.ok(results.every(value=>value==='http://proxy.example:7890'));assert.equal(reads,1);
});
