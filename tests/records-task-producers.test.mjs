import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord} from '../packages/records/src/record.mjs';
import {meetingTasks} from '../services/records/src/meeting-tasks.mjs';
import {createMeetingTaskProducers} from '../services/records/src/meeting-task-producers.mjs';

test('event and timed producers submit deduplicated read-only requests and require explicit enablement',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lingji-producer-')),repo=await createRepository({root,databaseUrl:''}),kernel=meetingTasks(repo);let now=Date.now();
 const records=[createRecord('owner'),createRecord('other')];for(const record of records){record.capture='completed';record.transcription='ready';record.transcriptRevision=1;record.segments=[{id:'s',revision:1,text:'synthetic',startMs:0,endMs:1000}];record.deleteAt=new Date(now+30*86400000).toISOString();await repo.insert(record);}
 const submissions=new Map();kernel.register('assistant',{submit:async(owner,input)=>{submissions.set(input.requestId,{owner,input});return{id:input.requestId};},inspect:async()=>({status:'completed'})});
 let producers=createMeetingTaskProducers(repo,{now:()=>now,pollMs:100000});t.after(async()=>{producers.close();await kernel.close();await repo.close();await rm(root,{recursive:true,force:true});});
 const input={enabled:true,confirmed:true,trigger:'meeting-completed',recordIds:[records[0].id],prompt:'只生成本地决策汇总'};
 await assert.rejects(producers.save('owner',{...input,confirmed:false}),{code:'agent_scope_required'});
 await assert.rejects(producers.save('owner',{...input,recordIds:[records[1].id]}),{code:'agent_scope_denied'});
 const rule=await producers.save('owner',input);await producers.sourceChanged([records[1].id]);assert.equal(submissions.size,0);
 await producers.sourceChanged([records[0].id]);await producers.tick();assert.equal(submissions.size,1);
 producers.close();producers=createMeetingTaskProducers(repo,{now:()=>now,pollMs:100000});await producers.tick();assert.equal(submissions.size,1,'restart keeps producer deduplication');
 const weekly=await producers.save('owner',{...input,trigger:'weekly-decisions'});now=weekly.nextAt;await producers.tick();assert.equal(submissions.size,2);await producers.tick();assert.equal(submissions.size,2);
 const reminder=await producers.save('owner',{...input,trigger:'open-actions'});now=reminder.nextAt;await producers.tick();assert.equal(submissions.size,3);
 assert.ok([...submissions.values()].every(({input})=>input.skillId==='meeting-review'&&input.scopeConfirmed&&!input.pluginIds&&!input.kernelGitSync));
 await producers.save('owner',{...input,id:rule.id,enabled:false});await repo.change(records[0].id,row=>{row.transcriptRevision++;});await producers.tick();assert.equal(submissions.size,3,'disabled post-meeting rule cannot produce new work');
});
