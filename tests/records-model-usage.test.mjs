import {completeModelJson} from '../services/records/src/llm.mjs';
import {completeModelTurn} from '../services/records/src/model-turn.mjs';
import {translateSeedText} from '../services/records/src/seed-translation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord} from '../packages/records/src/record.mjs';
import {withModelUsage,meterModelCall,modelUsageOverview} from '../services/records/src/model-usage.mjs';

test('usage counts physical attempts once, preserves failed usage and isolates accounts/workspaces',async()=>{
  const root=await mkdtemp(join(tmpdir(),'usage-')),repo=await createRepository({root});
  try{
    const run=(workspaceId,kind,body)=>withModelUsage({repo,owner:'one',workspaceId,kind},()=>meterModelCall({LLM_MODEL:'actual'}, {}, body));
    await run('project','meeting-assistant',async callbacks=>{
      await callbacks.onRequest();await callbacks.onUsage({input_tokens:100,output_tokens:20});
      await callbacks.onUsage({input_tokens:100,output_tokens:30,total_tokens:130});
      return {tokenUsage:{totalTokens:130}};
    });
    await assert.rejects(run('project','automation',async callbacks=>{await callbacks.onRequest();await callbacks.onUsage({total_tokens:40});throw new Error('failed');}));
    await run('inbox','translation',async callbacks=>{await callbacks.onRequest();return {};});
    await repo.insert(createRecord('legacy'));
    const legacy=await modelUsageOverview(repo,'legacy');assert.equal(legacy.periods.day.usageIncomplete,true);assert.equal(legacy.activity[0].usageIncomplete,true);
    const all=await modelUsageOverview(repo,'one'),project=await modelUsageOverview(repo,'one','project');
    assert.equal(all.periods.day.minutesTokens,170);assert.equal(all.periods.day.usageIncomplete,true);
    assert.equal(project.periods.day.minutesTokens,170);assert.equal(project.periods.day.usageIncomplete,false);
    assert.equal((await modelUsageOverview(repo,'other')).periods.day.minutesTokens,0);
    const attempts=await repo.list('model-usage');assert.equal(attempts.length,3);
    assert.equal(attempts.filter(row=>row.requestKind==='automation').length,1);
    assert.ok(attempts.every(row=>row.finishedAt));
    await run('project','minutes',async()=>({tokenUsage:{totalTokens:999}}));
    assert.equal((await repo.list('model-usage')).length,3,'validation/no-network must not count');
  }finally{await repo.close();await rm(root,{recursive:true,force:true});}
});


test('provider error receipts are counted across JSON, agent native tools and dedicated translation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'usage-errors-')),repo=await createRepository({root}),previous=globalThis.fetch;
 const env={LLM_MODEL:'synthetic',LLM_API_KEY:'synthetic-key',LLM_API_URL:'https://fixture.invalid/v1/chat/completions',LLM_PROTOCOL:'chat-completions'};
 globalThis.fetch=async()=>new Response(JSON.stringify({usage:{total_tokens:21},error:{message:'rate limited'}}),{status:429,headers:{'Content-Type':'application/json'}});
 try{
  await withModelUsage({repo,owner:'one'},async()=>{
   await assert.rejects(completeModelJson([{role:'user',content:'fixture'}],env));
   await assert.rejects(completeModelTurn({messages:[{role:'user',content:'fixture'}]},env));
   await assert.rejects(translateSeedText('测试','en',env));
  });
  const value=await modelUsageOverview(repo,'one');assert.equal(value.periods.day.minutesTokens,63);assert.equal(value.periods.day.usageIncomplete,false);assert.equal((await repo.list('model-usage')).length,3);
 }finally{globalThis.fetch=previous;await repo.close();await rm(root,{recursive:true,force:true});}
});
