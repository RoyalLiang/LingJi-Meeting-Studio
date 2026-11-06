import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider} from '@earendil-works/pi-ai/providers/faux';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord} from '../packages/records/src/record.mjs';
import {createMeetingAgentRuntime} from '../services/records/src/meeting-agent.mjs';

test('a long single meeting is accepted without discarding transcript evidence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lingji-sync-reliability-')),repo=await createRepository({root,databaseUrl:''}),models=createModels();
 const fake=fauxProvider({provider:'long-meeting',models:[{id:'test'}],tokensPerSecond:Infinity});models.setProvider(fake.provider);
 const agent=await createMeetingAgentRuntime({repo,models,model:{provider:'long-meeting',modelId:'test'}});
 try{const record=createRecord('owner',{title:'RTLS 1103周会'});record.transcriptRevision=3334;record.segments=Array.from({length:100},(_,i)=>({id:'seg-'+i,revision:1,text:'会议项目讨论与决策来源。'.repeat(100),startMs:i*1000,endMs:(i+1)*1000}));await repo.insert(record);
 await assert.doesNotReject(agent.request('owner',{recordIds:[record.id],prompt:'整理全部议题并保留引用',requestId:'long-meeting-repro',scopeConfirmed:true}));
 assert.equal((await repo.get(record.id)).segments.length,100);
 }finally{await agent.close();await repo.close();await rm(root,{recursive:true,force:true});}
});

test('long meetings read all pages, compact through Pi and retain a citation from the final page',async()=>{
 const {fauxAssistantMessage:message,fauxToolCall:call}=await import('@earendil-works/pi-ai/providers/faux');
 const {MEETING_COMPACTION}=await import('../services/records/src/meeting-agent-context.mjs');
 const root=await mkdtemp(join(tmpdir(),'lingji-paged-agent-')),repo=await createRepository({root,databaseUrl:''}),models=createModels();
 const fake=fauxProvider({provider:'paged-meeting',models:[{id:'test',contextWindow:24000}],tokensPerSecond:Infinity});models.setProvider(fake.provider);
 const record=createRecord('owner',{title:'长会议分页验证'});record.transcriptRevision=3334;record.segments=Array.from({length:100},(_,i)=>({id:'seg-'+i,revision:1,text:('第'+i+'段决策依据。').repeat(120),startMs:i*1000,endMs:(i+1)*1000}));record.segments.at(-1).text+='最终决定保留人工修订。';await repo.insert(record);
 const seen=new Set();let compactions=0;
 const respond=context=>{
  if(context.messages.some(m=>m.role==='system'&&typeof m.content==='string'&&m.content.startsWith(MEETING_COMPACTION))){compactions++;const full=JSON.stringify(context);assert.ok(full.length<120000);assert.match(full,/段决策依据/);return message('继续分页整理；已读页面均属于选中的同一会议。所有决定必须保留原始segmentId与revision。');}
  const result=context.messages.filter(m=>m.role==='toolResult'&&m.toolName==='read_selected_meeting').at(-1);
  if(!result)return message(call('read_selected_meeting',{recordId:record.id,page:0}),{stopReason:'toolUse'});
  const page=JSON.parse(result.content.filter(c=>c.type==='text').map(c=>c.text).join(''));assert.equal(page.format,'json-fragment');seen.add(page.page);
  if(page.nextPage!==undefined)return message(call('read_selected_meeting',{recordId:record.id,page:page.nextPage}),{stopReason:'toolUse'});
  return message(JSON.stringify({summary:'已读完全部会议内容。',decisions:[{text:'保留人工修订',evidence:[{recordId:record.id,segmentId:'seg-99',revision:1}]}],actions:[]}));
 };
 fake.setResponses(Array.from({length:80},()=>respond));const agent=await createMeetingAgentRuntime({repo,models,model:{provider:'paged-meeting',modelId:'test'}});
 try{const task=await agent.request('owner',{recordIds:[record.id],prompt:'整理全部议题并引用最后的决策',requestId:'paged-full-flow',scopeConfirmed:true,splitSources:false});let state;
 for(let i=0;i<500;i++){state=await agent.get('owner',task.id);if(['completed','failed','blocked'].includes(state.status))break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(state.status,'completed',JSON.stringify(state));assert.ok(seen.size>8);assert.ok(compactions>0,'Pi compaction must run on the long source');assert.equal(state.result.decisions[0].evidence[0].segmentId,'seg-99');assert.equal((await repo.get(record.id)).segments.length,100);
 }finally{await agent.close();await repo.close();await rm(root,{recursive:true,force:true});}
});

test('configured JSON transport compacts batched source pages below its request budget',async()=>{
 const {MEETING_COMPACTION,meetingSourcePages}=await import('../services/records/src/meeting-agent-context.mjs');
 const original=globalThis.fetch,root=await mkdtemp(join(tmpdir(),'lingji-paged-json-')),repo=await createRepository({root,databaseUrl:''});
 const record=createRecord('owner',{title:'长会议 JSON 桥接'});record.transcriptRevision=1;record.segments=Array.from({length:100},(_,i)=>({id:'seg-'+i,revision:1,text:('JSON \"value\" \\\\ synthetic.').repeat(160),startMs:i*1000,endMs:(i+1)*1000}));await repo.insert(record);
 let nextPage=0,compactions=0,largest=0;const total=meetingSourcePages({recordId:record.id,title:record.title,transcriptRevision:1,segments:record.segments},12000).length;
 globalThis.fetch=async(_url,options)=>{
  const body=JSON.parse(options.body);let output;
  if(body.messages[0].content.startsWith(MEETING_COMPACTION)){compactions++;output={summary:'已读取分页；保留全部引用标识和待确认条件。'};}
  else {const transcript=JSON.parse(body.messages[1].content);largest=Math.max(largest,JSON.stringify(transcript).length);
   output=nextPage<total?{toolCalls:Array.from({length:Math.min(8,total-nextPage)},()=>({name:'read_selected_meeting',arguments:{recordId:record.id,page:nextPage++}}))}:{result:{summary:'全部分页完成',decisions:[{text:'最后一段仍待确认',evidence:[{recordId:record.id,segmentId:'seg-99',revision:1}]}],actions:[]}};
  }
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}]}),{headers:{'content-type':'application/json'}});
 };
 const agent=await createMeetingAgentRuntime({repo,env:{LLM_API_KEY:'synthetic-key',LLM_MODEL:'synthetic',LLM_API_URL:'https://fixture.invalid/v1/chat/completions',LLM_PROTOCOL:'chat-completions'}});
 try{
  const task=await agent.request('owner',{recordIds:[record.id],prompt:'阅读全部分页并保留来源',requestId:'json-paged-batch',scopeConfirmed:true,splitSources:false});let state;
  for(let i=0;i<800;i++){state=await agent.get('owner',task.id);if(['completed','failed','blocked'].includes(state.status))break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(state.status,'completed',JSON.stringify(state));assert.ok(compactions>1);assert.ok(largest<=120000);assert.equal(state.progress.pagesRead,state.progress.totalPages);assert.equal(state.result.decisions[0].evidence[0].segmentId,'seg-99');
 }finally{await agent.close();globalThis.fetch=original;await repo.close();await rm(root,{recursive:true,force:true});}
});

test('SIGKILL resumes the remaining queued Pi tool plan without skipping source pages',async t=>{
 const {spawn}=await import('node:child_process'),{once}=await import('node:events'),{pathToFileURL}=await import('node:url');
 const root=await mkdtemp(join(tmpdir(),'lingji-paged-crash-')),repo=await createRepository({root,databaseUrl:''}),record=createRecord('owner',{title:'分页恢复'});record.transcriptRevision=1;record.segments=Array.from({length:70},(_,i)=>({id:'s'+i,revision:1,text:'JSON "value" \\ synthetic. '.repeat(160),startMs:i*1000,endMs:(i+1)*1000}));await repo.insert(record);
 const env={LLM_API_KEY:'synthetic-key',LLM_MODEL:'synthetic',LLM_API_URL:'https://fixture.invalid/chat/completions',LLM_PROTOCOL:'chat-completions'},input={recordIds:[record.id],prompt:'读取全部分页',requestId:'queued-crash',scopeConfirmed:true,splitSources:false};
 const script=`setInterval(()=>{},1000);import {createRepository} from ${JSON.stringify(pathToFileURL(join(process.cwd(),'services/records/src/repository.mjs')).href)};import {createMeetingAgentRuntime} from ${JSON.stringify(pathToFileURL(join(process.cwd(),'services/records/src/meeting-agent.mjs')).href)};const repo=await createRepository({root:${JSON.stringify(root)},databaseUrl:''});let planned=false,checks=0;const access=repo.get.bind(repo);repo.get=async(...args)=>{if(planned&&++checks===2){console.log('CHECKPOINT_READY');await new Promise(()=>{});}return access(...args);};globalThis.fetch=async()=>{planned=true;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({toolCalls:Array.from({length:8},(_,page)=>({name:'read_selected_meeting',arguments:{recordId:${JSON.stringify(record.id)},page}}))})}}]}),{headers:{'content-type':'application/json'}});};const runtime=await createMeetingAgentRuntime({repo,env:${JSON.stringify(env)}});console.log('TASK:'+JSON.stringify(await runtime.request('owner',${JSON.stringify(input)})));`;
 const child=spawn(process.execPath,['--input-type=module','--eval',script],{cwd:process.cwd(),env:{PATH:process.env.PATH,TMPDIR:tmpdir()},stdio:['ignore','pipe','pipe']});let output='',errors='';child.stderr.on('data',bytes=>{errors+=bytes;});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 let agent;const original=globalThis.fetch;
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('no queued checkpoint: '+errors)),8000);child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);if(!output.includes('CHECKPOINT_READY'))reject(new Error('child exited '+errors+' '+output));});child.stdout.on('data',bytes=>{output+=bytes;if(output.includes('CHECKPOINT_READY')){clearTimeout(timer);resolve();}});});
  const task=JSON.parse(output.split('\n').find(line=>line.startsWith('TASK:')).slice(5)),exit=once(child,'exit');child.kill('SIGKILL');await exit;
  const {meetingSourcePages,MEETING_COMPACTION}=await import('../services/records/src/meeting-agent-context.mjs');const total=meetingSourcePages({recordId:record.id,title:record.title,segments:record.segments},12000).length;let next=8;
  globalThis.fetch=async(_url,options)=>{const body=JSON.parse(options.body);const result=body.messages[0].content.startsWith(MEETING_COMPACTION)?{summary:'保留已读取页和精确来源。'}:next<total?{toolCalls:Array.from({length:Math.min(8,total-next)},()=>({name:'read_selected_meeting',arguments:{recordId:record.id,page:next++}}))}:{result:{summary:'恢复完成',decisions:[{text:'保留来源',evidence:[{recordId:record.id,segmentId:'s69',revision:1}]}],actions:[]}};return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}),{headers:{'content-type':'application/json'}});};
  agent=await createMeetingAgentRuntime({repo,env});let state;for(let i=0;i<600;i++){state=await agent.get('owner',task.id);if(['completed','failed','blocked'].includes(state.status))break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(state.status,'completed',JSON.stringify(state));assert.equal(state.progress.pagesRead,state.progress.totalPages);assert.equal((await agent.request('owner',input)).id,task.id);
 }finally{await agent?.close();globalThis.fetch=original;await repo.close();await rm(root,{recursive:true,force:true});}
});

test('selected large Skill instructions must finish every opened page before publishing',async()=>{
 const {fauxAssistantMessage:message,fauxToolCall:call}=await import('@earendil-works/pi-ai/providers/faux');
 for(const complete of [false,true]){
  const root=await mkdtemp(join(tmpdir(),'lingji-guide-pages-')),repo=await createRepository({root,databaseUrl:''}),models=createModels(),fake=fauxProvider({provider:'guide-pages',models:[{id:'test',contextWindow:24000}],tokensPerSecond:Infinity});models.setProvider(fake.provider);
  const record=createRecord('owner');record.segments=[{id:'s',revision:1,text:'合成会议来源',startMs:0,endMs:1000}];record.transcriptRevision=1;await repo.insert(record);
  const selected={id:'fixture-skill',name:'合成指引',version:'1',bundle:true},scope={skill:selected,skills:[selected],guides:[{key:'g',name:'指引',description:'',path:'SKILL.md',version:'1',content:'保留条件和待确认事项。'.repeat(2000)}],plugins:[]};
  const respond=context=>{const tool=context.messages.filter(m=>m.role==='toolResult').at(-1);if(!tool)return message(call('read_selected_skill',{key:'g',page:0}),{stopReason:'toolUse'});if(tool.toolName==='read_selected_skill'){const page=JSON.parse(tool.content.filter(c=>c.type==='text').map(c=>c.text).join(''));if(complete&&page.nextPage!==undefined)return message(call('read_selected_skill',{key:'g',page:page.nextPage}),{stopReason:'toolUse'});return message(call('read_selected_meeting',{recordId:record.id}),{stopReason:'toolUse'});}return message(JSON.stringify({summary:'整理完成',decisions:[{text:'合成结论',evidence:[{recordId:record.id,segmentId:'s',revision:1}]}],actions:[]}));};fake.setResponses(Array.from({length:20},()=>respond));
  const agent=await createMeetingAgentRuntime({repo,models,model:{provider:'guide-pages',modelId:'test'},extensions:{snapshot:async()=>scope,validate:async()=>{}}});
  try{const task=await agent.request('owner',{recordIds:[record.id],prompt:'按所选指引整理',requestId:'guide-pages',scopeConfirmed:true});let state;for(let i=0;i<300;i++){state=await agent.get('owner',task.id);if(['completed','failed','blocked'].includes(state.status))break;await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(state.status,complete?'completed':'failed',JSON.stringify(state));if(!complete)assert.equal(state.error,'invalid_agent_output');}
  finally{await agent.close();await repo.close();await rm(root,{recursive:true,force:true});}
 }
});

test('an over-escaped checkpoint is rejected before compaction can stop making progress',async()=>{
 const {fauxAssistantMessage:message,fauxToolCall:call}=await import('@earendil-works/pi-ai/providers/faux'),{MEETING_COMPACTION}=await import('../services/records/src/meeting-agent-context.mjs');
 const root=await mkdtemp(join(tmpdir(),'lingji-checkpoint-budget-')),repo=await createRepository({root,databaseUrl:''}),models=createModels(),fake=fauxProvider({provider:'checkpoint-budget',models:[{id:'test',contextWindow:24000}],tokensPerSecond:Infinity});models.setProvider(fake.provider);const record=createRecord('owner');record.transcriptRevision=1;record.segments=Array.from({length:100},(_,i)=>({id:'s'+i,revision:1,text:'引用与条件。'.repeat(300),startMs:i*1000,endMs:(i+1)*1000}));await repo.insert(record);let compactions=0;
 const respond=context=>{if(context.messages.some(m=>m.role==='system'&&typeof m.content==='string'&&m.content.startsWith(MEETING_COMPACTION))){compactions++;return message('\u0000'.repeat(12000));}const output=context.messages.filter(m=>m.role==='toolResult').at(-1),page=output?JSON.parse(output.content.filter(c=>c.type==='text').map(c=>c.text).join('')):null;return message(call('read_selected_meeting',{recordId:record.id,page:page?.nextPage??0}),{stopReason:'toolUse'});};fake.setResponses(Array.from({length:60},()=>respond));const agent=await createMeetingAgentRuntime({repo,models,model:{provider:'checkpoint-budget',modelId:'test'}});
 try{const task=await agent.request('owner',{recordIds:[record.id],prompt:'保留全部来源',requestId:'checkpoint-budget',scopeConfirmed:true,splitSources:false});let state;for(let i=0;i<300;i++){state=await agent.get('owner',task.id);if(['completed','failed','blocked'].includes(state.status))break;await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(state.status,'failed');assert.equal(compactions,1);}finally{await agent.close();await repo.close();await rm(root,{recursive:true,force:true});}
});


test('native Pi compaction context cannot inherit archive tools from the normal agent bridge',async()=>{
 const {configuredModels}=await import('../services/records/src/meeting-agent.mjs');
 const {MEETING_COMPACTION}=await import('../services/records/src/meeting-agent-context.mjs');
 const original=globalThis.fetch,root=await mkdtemp(join(tmpdir(),'lingji-native-compaction-'));
 let compactInstruction=false;
 globalThis.fetch=async(_url,options)=>{const body=JSON.parse(options.body);compactInstruction=body.messages[0].content.startsWith(MEETING_COMPACTION);const value=compactInstruction?{summary:'保留范围、引用和待确认问题。'}:{toolCalls:[{name:'request_user_input',arguments:{id:'q',question:'是否继续？'}}]};return Response.json({choices:[{message:{content:JSON.stringify(value)}}]});};
 try{const bridge=configuredModels(root,{LLM_API_KEY:'synthetic',LLM_MODEL:'synthetic',LLM_API_URL:'https://fixture.invalid/v1/chat/completions',LLM_PROTOCOL:'chat-completions'},1000);const model=bridge.models.getModel(bridge.model.provider,bridge.model.modelId);
 for(const context of [
 {systemPrompt:'You are a context summarization assistant. Your task is to summarize the conversation.',messages:[{role:'user',content:[{type:'text',text:'合成上下文。'}],timestamp:Date.now()}]},
 {messages:[{role:'system',content:'You are a context summarization assistant. Your task is to summarize the conversation.',timestamp:Date.now()},{role:'user',content:[{type:'text',text:'合成上下文。'}],timestamp:Date.now()}]}
 ]){const output=await bridge.models.completeSimple(model,context,{maxTokens:1000});
 assert.equal(compactInstruction,true,'native compaction must receive the text-only checkpoint instruction');assert.equal(output.stopReason,'stop');assert.ok(output.content.every(item=>item.type==='text'));}}

 finally{globalThis.fetch=original;await rm(root,{recursive:true,force:true});}
});
