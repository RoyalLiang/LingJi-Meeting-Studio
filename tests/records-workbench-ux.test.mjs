import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
const source=await Promise.all(['api.ts','downloads.ts','provider-settings.ts'].map(async file=>stripTypeScriptTypes(await readFile(new URL(`../apps/web/src/${file}`,import.meta.url),'utf8'),{mode:'transform'}).replace(/^import .*$/gm,'').replace(/export /g,'')));
function harness(fetch){const sandbox={exports:{},fetch,URL,location:{origin:'https://studio.example'}};vm.runInNewContext(source.join('\n')+'\nObject.assign(exports,{fetchDownload,protocolForAddress});',sandbox);return sandbox.exports;}
test('backup reads authenticated response before returning a named download and preserves HTTP errors',async()=>{
  const blob={size:200};let request;
  const h=harness(async(href,options)=>{request={href,options};return{ok:true,blob:async()=>blob,headers:new Map([['content-disposition','attachment; filename="meeting.json"']])};});
  const file=await h.fetchDownload('/api/records/example/export?format=json');
  assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.cache,'no-store');assert.equal(file.filename,'meeting.json');assert.equal(file.blob,blob);
  const failed=harness(async()=>({ok:false,status:401,json:async()=>({error:'session_expired'})}));
  await assert.rejects(failed.fetchDownload('/api/records/example/export?format=json'),error=>error.code==='session_expired'&&error.message.includes('登录已过期'));
  const proxy=harness(async()=>({ok:false,status:502,json:async()=>{throw Error('html');}}));
  await assert.rejects(proxy.fetchDownload('/api/records/example/export?format=json'),error=>error.code==='download_failed');
});
test('address editing prefers Responses while recognizing explicit legacy Chat paths',()=>{
  const {protocolForAddress}=harness(()=>{});
  assert.equal(protocolForAddress('https://models.example/v1'),'responses');
  assert.equal(protocolForAddress('https://models.example/v1/responses'),'responses');
  assert.equal(protocolForAddress('https://models.example/v1/chat/completions?region=cn'),'chat-completions');
});
