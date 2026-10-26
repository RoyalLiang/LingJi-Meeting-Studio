import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { transform } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const code=(await transform(await readFile(new URL('../apps/web/src/components/ConnectionStatus.tsx',import.meta.url),'utf8'),{loader:'tsx',jsx:'automatic',format:'cjs'})).code;
const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,require:name=>name==='@phosphor-icons/react'?{CloudCheck:()=>null,CloudSlash:()=>null}:createRequire(import.meta.url)(name)});
const render=props=>renderToStaticMarkup(createElement(module.exports.ConnectionStatus,props));
const label=html=>html.match(/class="sync-connection-label">([^<]+)/)[1];

test('queue churn preserves the connection label and keeps pending audio visible separately',()=>{
 const props={state:'connected',localBackend:true,online:true};
 for(const pending of [0,1,12,0]){
  const html=render({...props,pending});assert.equal(label(html),'本机已连接');
  assert.match(html,new RegExp(`aria-hidden="${pending?'false':'true'}"`));
  if(pending)assert.ok(html.includes(`${pending} 段待保存`));
 }
});

test('real service failures and offline cloud status remain distinct from saved-queue state',()=>{
 assert.equal(label(render({state:'unavailable',localBackend:true,online:true,pending:0})),'本机记录服务不可用');
 assert.equal(label(render({state:'connected',localBackend:true,online:false,pending:0})),'本机已连接 · 云端离线');
 assert.equal(label(render({state:'connected',localBackend:false,online:false,pending:1})),'离线 · 本地保留');
});
