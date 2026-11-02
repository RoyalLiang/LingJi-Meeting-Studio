import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig,saveConfig} from '../services/records/src/config.mjs';

test('desktop lanes share parsed settings but explicit reads environment and saves stay fresh',async()=>{
 const root=await mkdtemp(join(tmpdir(),'config-lanes-')),other=await mkdtemp(join(tmpdir(),'config-other-'));
 const parse=JSON.parse;let reads=0;
 try{
  await writeFile(join(root,'providers.json'),JSON.stringify({LLM_MODEL:'fixture-cache-one'}));
  await writeFile(join(other,'providers.json'),JSON.stringify({LLM_MODEL:'other-root'}));
  JSON.parse=function(text,...args){if(typeof text==='string'&&text.includes('fixture-cache-one'))reads++;return parse(text,...args);};
  const values=await Promise.all(Array.from({length:42},(_,i)=>readConfig(root,{LIVE_SETTING:String(i)},{cache:true})));
  assert.equal(reads,1);assert.equal(values[41].LIVE_SETTING,'41');
  values[0].LLM_MODEL='caller-change';assert.equal((await readConfig(root,{}, {cache:true})).LLM_MODEL,'fixture-cache-one');
  assert.equal((await readConfig(other,{}, {cache:true})).LLM_MODEL,'other-root');
  await writeFile(join(root,'providers.json'),JSON.stringify({LLM_MODEL:'external-update'}));
  assert.equal((await readConfig(root,{})).LLM_MODEL,'external-update','explicit UI and migration reads never use the worker cache');
  await saveConfig(root,{LLM_MODEL:'saved-update'},{});
  assert.equal((await readConfig(root,{}, {cache:true})).LLM_MODEL,'saved-update','a completed save invalidates every lane immediately');
  await writeFile(join(root,'providers.json'),'invalid json');
  await assert.rejects(readConfig(root,{}),SyntaxError);
  await new Promise(resolve=>setTimeout(resolve,270));
  await assert.rejects(readConfig(root,{}, {cache:true}),SyntaxError);
 }finally{JSON.parse=parse;await Promise.all([rm(root,{recursive:true,force:true}),rm(other,{recursive:true,force:true})]);}
});
