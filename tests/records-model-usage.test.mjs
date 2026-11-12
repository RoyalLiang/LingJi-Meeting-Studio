import {completeModelJson} from '../services/records/src/llm.mjs';
import {completeModelTurn} from '../services/records/src/model-turn.mjs';
import {translateSeedText} from '../services/records/src/seed-translation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord,emit} from '../packages/records/src/record.mjs';
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

test('dated historical receipts survive the ledger upgrade without counting new requests twice',async()=>{
  const root=await mkdtemp(join(tmpdir(),'usage-history-')),repo=await createRepository({root});
  try{
    const before=new Date(Date.now()-86400000).toISOString(),record=createRecord('one');
    record.workspaceId='project';record.createdAt=before;record.updatedAt=before;
    record.jobs=[{id:'old',createdAt:before,usageCalls:{a:{reported:true,totalTokens:240},b:{reported:true,inputTokens:10,outputTokens:5}}}];
    emit(record,'minutes.usage',{jobId:'old'});record.events.at(-1).at=before;record.updatedAt=before;
    await repo.insert(record);
    const initial=await modelUsageOverview(repo,'one','project'),oldDay=new Date(Date.parse(before)+8*3600000).toISOString().slice(0,10);
    assert.equal(initial.activity.find(day=>day.day===oldDay).minutesTokens,255);
    await withModelUsage({repo,owner:'one',workspaceId:'project',recordId:record.id,kind:'minutes'},()=>meterModelCall({}, {},async callbacks=>{await callbacks.onRequest();await callbacks.onUsage({total_tokens:65});return {};}));
    await repo.change(record.id,row=>{row.jobs.push({id:'new',usageCalls:{a:{reported:true,totalTokens:65}}});emit(row,'minutes.usage',{jobId:'new'});});
    const expected=65+(oldDay.slice(0,4)===new Date(Date.now()+8*3600000).toISOString().slice(0,4)?255:0);
    assert.equal((await modelUsageOverview(repo,'one','project')).periods.year.minutesTokens,expected);
    assert.equal((await modelUsageOverview(repo,'one','project')).periods.year.minutesTokens,expected,'repeated reads do not duplicate historical receipts');
    assert.equal((await modelUsageOverview(repo,'one','inbox')).periods.year.minutesTokens,0);
    assert.equal((await modelUsageOverview(repo,'other')).periods.year.minutesTokens,0);
  }finally{await repo.close();await rm(root,{recursive:true,force:true});}
});

test('cross-day legacy jobs keep their known total without assigning all receipts to the final begin event',async()=>{
  const root=await mkdtemp(join(tmpdir(),'usage-cross-day-')),repo=await createRepository({root});
  try{
    const r=createRecord('one'),from=new Date(Date.now()-2*86400000).toISOString(),to=new Date(Date.now()-86400000).toISOString();
    r.createdAt=from;r.jobs=[{id:'old',createdAt:from,usageCalls:{a:{reported:true,totalTokens:100},b:{reported:false}}}];
    emit(r,'minutes.usage',{jobId:'old'});r.events.at(-1).at=from;emit(r,'minutes.usage',{jobId:'old'});r.events.at(-1).at=to;
    await repo.insert(r);const view=await modelUsageOverview(repo,'one');
    assert.equal(view.activity.reduce((sum,day)=>sum+day.minutesTokens,0),0,'the old job has no per-call dates');
    const expected=new Date(Date.parse(from)+8*3600000).getUTCFullYear()===new Date(Date.now()+8*3600000).getUTCFullYear()?100:0;
    assert.equal(view.periods.year.minutesTokens,expected);
  }finally{await repo.close();await rm(root,{recursive:true,force:true});}
});

test('reclaiming the same legacy job across cutover preserves totals regardless of first overview timing',async()=>{
  const root=await mkdtemp(join(tmpdir(),'usage-reclaim-')),repo=await createRepository({root});
  try{
    const at=new Date(Date.now()-86400000).toISOString();
    for(const owner of ['early','late']){
      const r=createRecord(owner);r.createdAt=at;r.jobs=[{id:'same-job',createdAt:at,usageCalls:{old:{reported:true,totalTokens:100}}}];emit(r,'minutes.usage',{jobId:'same-job'});r.events.at(-1).at=at;await repo.insert(r);
      if(owner==='early')await modelUsageOverview(repo,owner);
      await withModelUsage({repo,owner,recordId:r.id,kind:'minutes'},()=>meterModelCall({}, {},async callbacks=>{await callbacks.onRequest();await callbacks.onUsage({total_tokens:50});return {};}));
      await repo.change(r.id,row=>{row.jobs[0].usageCalls.new={reported:true,totalTokens:50};emit(row,'minutes.usage',{jobId:'same-job'});});
    }
    const early=await modelUsageOverview(repo,'early'),late=await modelUsageOverview(repo,'late');
    const expected=50+(new Date(Date.parse(at)+8*3600000).getUTCFullYear()===new Date(Date.now()+8*3600000).getUTCFullYear()?100:0);
    assert.equal(early.periods.year.minutesTokens,expected);assert.equal(late.periods.year.minutesTokens,expected);
  }finally{await repo.close();await rm(root,{recursive:true,force:true});}
});
