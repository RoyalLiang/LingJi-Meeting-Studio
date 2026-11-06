import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord} from '../packages/records/src/record.mjs';
import {meetingTasks} from '../services/records/src/meeting-tasks.mjs';
import {createMeetingAgentRuntime} from '../services/records/src/meeting-agent.mjs';

test('kernel identity, source authority, budget and recording admission share one seam',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lingji-kernel-')),repo=await createRepository({root,databaseUrl:''}),kernel=meetingTasks(repo,{maxConcurrent:1});
 t.after(async()=>{await kernel.close();await repo.close();await rm(root,{recursive:true,force:true});});
 const record=createRecord('owner',{title:'synthetic'});await repo.insert(record);let starts=0;
 kernel.register('fixture',{submit:async()=>{starts++;return {id:'job'};},inspect:async()=>({id:'job',status:'completed',prompt:'private',preview:'private',timeline:[{kind:'tool',name:'read_selected_meeting',elapsedMs:2,input:'private'}]}),cancel:async()=>{}});
 const request={kind:'fixture',requestId:'one',sourceIds:[record.id],payload:{}};
 const task=await kernel.submit('owner',request),again=await kernel.submit('owner',request);assert.equal(task.kernelId,again.kernelId);assert.equal(starts,1,'idempotent request cannot dispatch twice');
 await assert.rejects(kernel.submit('owner',{...request,payload:{changed:true}}),{code:'agent_request_conflict'});assert.equal(starts,1,'rejected retries have no dispatch side effects');
 await repo.change(record.id,row=>{row.transcriptRevision++;});await kernel.submit('owner',request);assert.equal(starts,1,'source changes cannot turn a replay into a different task');
 await assert.rejects(kernel.inspect('intruder',task.kernelId),{code:'meeting_task_not_found'});
 const diagnostic=await kernel.diagnostics('owner',task.kernelId);assert.equal(JSON.stringify(diagnostic).includes('private'),false);
 await assert.rejects(kernel.preflight({LLM_MODEL:'unknown',MEETING_TASK_BUDGET_USD:'1'},{characters:100,pages:2}),{code:'agent_pricing_unavailable'});
 await assert.rejects(kernel.preflight({LLM_MODEL:'known',MEETING_TASK_BUDGET_USD:'.01',LLM_MODEL_PROFILES:JSON.stringify({known:{prices:{input:10,output:20,cacheRead:1,cacheWrite:10}}})},{characters:100,pages:2}),{code:'agent_budget_exceeded'});
 await repo.change(record.id,row=>{row.capture='recording';});let admitted=false;
 const controller=new AbortController(),waiting=kernel.capacity('owner',controller.signal).then(release=>{admitted=true;return release;});
 await new Promise(resolve=>setTimeout(resolve,25));assert.equal(admitted,false);await repo.change(record.id,row=>{row.capture='completed';});(await waiting)();
 const release=await kernel.capacity('owner');const abort=new AbortController(),second=kernel.capacity('owner',abort.signal);abort.abort();await assert.rejects(second);release();
 await repo.change(record.id,row=>{row.deleted=true;});await assert.rejects(kernel.diagnostics('owner',task.kernelId),{code:'agent_source_unavailable'});
});
test('a waiting task cannot continue with changed model prices or output limits',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lingji-model-snapshot-')),repo=await createRepository({root,databaseUrl:''}),original=globalThis.fetch;
 const record=createRecord('owner');record.transcriptRevision=1;record.segments=[{id:'s',revision:1,text:'synthetic scope',startMs:0,endMs:1000}];await repo.insert(record);
 const profile={contextWindow:24000,maxOutputTokens:1024,nativeTools:false,prices:{input:1,output:2,cacheRead:.1,cacheWrite:1}},env={LLM_MODEL:'fixture',LLM_API_KEY:'synthetic',LLM_API_URL:'https://fixture.invalid/v1',LLM_PROTOCOL:'chat-completions',LLM_MODEL_PROFILES:JSON.stringify({fixture:profile})};let calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:JSON.stringify({toolCalls:[calls===1?{name:'read_selected_meeting',arguments:{recordId:record.id}}:{name:'request_user_input',arguments:{id:'scope',question:'确认合成范围？',options:['继续']}}]})}}],usage:{prompt_tokens:50,completion_tokens:10,total_tokens:60}});};
 const agent=await createMeetingAgentRuntime({repo,env});t.after(async()=>{await agent.close();await meetingTasks(repo).close();globalThis.fetch=original;await repo.close();await rm(root,{recursive:true,force:true});});
 const task=await agent.request('owner',{recordIds:[record.id],prompt:'合成核对',requestId:'frozen-model',scopeConfirmed:true},{managed:false});let state;
 for(let i=0;i<200;i++){state=await agent.get('owner',task.id);if(state.interaction)break;await new Promise(resolve=>setTimeout(resolve,5));}assert.ok(state.interaction);
 await writeFile(join(root,'providers.json'),JSON.stringify({LLM_MODEL_PROFILES:JSON.stringify({fixture:{...profile,maxOutputTokens:2048,prices:{...profile.prices,output:99}}})}));
 await agent.respond('owner',task.id,{id:state.interaction.id,answer:'继续'});
 for(let i=0;i<200;i++){state=await agent.get('owner',task.id);if(state.status==='failed')break;await new Promise(resolve=>setTimeout(resolve,5));}
 assert.equal(state.error,'agent_model_changed');assert.equal(calls,2,'new expensive model configuration is blocked before provider invocation');
});
