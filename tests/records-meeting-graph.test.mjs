import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord} from '../packages/records/src/record.mjs';
import {createMeetingAgentRuntime} from '../services/records/src/meeting-agent.mjs';
import {meetingTasks} from '../services/records/src/meeting-tasks.mjs';

test('nine meetings use owned child tasks then aggregate validated original citations',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lingji-graph-')),repo=await createRepository({root,databaseUrl:''}),original=globalThis.fetch;
 const records=Array.from({length:9},(_,i)=>{const record=createRecord('owner',{title:'synthetic-'+i});record.transcriptRevision=1;record.segments=[{id:'s'+i,revision:1,text:'决定保留来源 '+i,startMs:0,endMs:1000}];return record;});for(const record of records)await repo.insert(record);
 const env={LLM_MODEL:'fixture',LLM_API_KEY:'synthetic',LLM_API_URL:'https://fixture.invalid/v1',LLM_PROTOCOL:'chat-completions',LLM_MODEL_PROFILES:JSON.stringify({fixture:{nativeTools:true,parallelTools:true,strictOutput:true,contextWindow:64000}})};
 globalThis.fetch=async(_url,options)=>{
  const body=JSON.parse(options.body);assert.ok(body.tools?.some(tool=>tool.function?.name==='read_selected_meeting'),'real native tool schema is sent');
  const input=JSON.parse(body.messages.find(item=>item.role==='user').content),seen=body.messages.filter(item=>item.role==='tool').map(item=>JSON.parse(item.content)),unread=input.selectedMeetings.filter(item=>!seen.some(value=>value.recordId===item.recordId));
  let message;
  if(unread.length)message={tool_calls:unread.slice(0,8).map((source,i)=>({id:'call-'+i,type:'function',function:{name:'read_selected_meeting',arguments:JSON.stringify({recordId:source.recordId})}}))};
  else {const decisions=seen.flatMap(source=>source.extractions?source.extractions.flatMap(result=>result.decisions):[{text:source.segments[0].text,evidence:[{recordId:source.recordId,segmentId:source.segments[0].id,revision:1}]}]);message={content:JSON.stringify({summary:'保留全部引用',decisions,actions:[]})};}
  return Response.json({choices:[{finish_reason:message.tool_calls?'tool_calls':'stop',message}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});
 };
 const agent=await createMeetingAgentRuntime({repo,env});t.after(async()=>{await agent.close();await meetingTasks(repo).close();globalThis.fetch=original;await repo.close();await rm(root,{recursive:true,force:true});});
 const task=await agent.request('owner',{requestId:'nine',recordIds:records.map(record=>record.id),prompt:'汇总决策',scopeConfirmed:true});let state;
 for(let i=0;i<500;i++){state=await agent.get('owner',task.id);if(['completed','failed','blocked'].includes(state.status))break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal(state.status,'completed',JSON.stringify(state));assert.equal(state.result.decisions.length,9);assert.ok(state.timeline.some(item=>item.kind==='children'&&item.count===9));assert.ok(state.ledger.totalTokens>=300);
 const files=(await readdir(join(root,'meeting-agent-jobs'))).filter(file=>file.endsWith('.sqlite'));assert.equal(files.length,10);
 await repo.change(records[0].id,record=>{record.deleted=true;});await agent.get('owner',task.id);
 assert.equal((await readdir(join(root,'meeting-agent-jobs'))).filter(file=>file.endsWith('.sqlite')).length,0);
 assert.equal(meetingTasks(repo).resources().handles,1,'purged histories release their Harness references');
});
