import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveConfig,readConfig,meetingAutomationConfig} from '../services/records/src/config.mjs';
const bundle=await build({entryPoints:['apps/web/src/meeting-automation.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {createMeetingAutomation}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const idle={id:'',recording:false,paused:false,busy:false};
const recording={id:'auto-record',recording:true,paused:false,busy:false};
const sample=(engine,at,active,report=idle,error)=>engine.sample({sampledAt:at,active,error},report);
const tick=(engine,from,to,active,report=idle)=>{let result;for(let at=from;at<=to;at+=2000)result=sample(engine,at,active,report);return result;};
function started(){const engine=createMeetingAutomation();assert.equal(tick(engine,0,10000,true)?.kind,'start');engine.started(recording.id);return engine;}

test('short notifications do not start a meeting and sustained IO starts only once',()=>{
 const engine=createMeetingAutomation();tick(engine,0,4000,true);assert.equal(sample(engine,6000,false),null);
 assert.equal(tick(engine,8000,18000,true)?.kind,'start');assert.equal(sample(engine,20000,true),null);
 engine.started('auto-record');assert.equal(sample(engine,22000,true,recording),null);
});
test('only all selected IO ending for thirty seconds stops an automatically owned meeting',()=>{
 const engine=started();tick(engine,12000,30000,true,recording);assert.equal(engine.pending,null,'silent but running IO stays active');
 assert.equal(tick(engine,32000,60000,false,recording),null);const decision=sample(engine,62000,false,recording);
 assert.equal(decision.kind,'stop');assert.equal(decision.recordId,'auto-record');
 engine.stopped();assert.equal(sample(engine,64000,true,idle),null);
});
test('IO returning during the end grace period cancels the end candidate',()=>{
 const engine=started();tick(engine,12000,30000,false,recording);assert.equal(sample(engine,32000,true,recording),null);assert.equal(engine.pending,null);
});
test('manual meetings, manual pause and manual stop cannot be overridden',()=>{
 for(const report of [{...recording,id:'manual'},{...idle,id:'manual',paused:true}]){
  const engine=createMeetingAutomation();assert.equal(tick(engine,0,20000,true,report),null);assert.equal(tick(engine,22000,50000,true,idle),null);
 }
 const engine=started();sample(engine,12000,true,idle);assert.equal(tick(engine,14000,40000,true,idle),null);
});
test('unknown samples, resume gaps and clock rollback restart the safety grace period',()=>{
 const engine=started();tick(engine,12000,30000,false,recording);
 sample(engine,32000,false,recording,'unavailable');assert.equal(engine.pending,null);
 assert.equal(tick(engine,34000,62000,false,recording),null);
 assert.equal(sample(engine,120000,false,recording),null);assert.equal(engine.pending,null);
 assert.equal(sample(engine,100000,false,recording),null);assert.equal(engine.pending,null);
});
test('cancelling start suppresses the current activity and cancelling stop hands the recording to the user',()=>{
 const engine=createMeetingAutomation();sample(engine,0,true);engine.cancel();assert.equal(tick(engine,2000,30000,true),null);
 tick(engine,32000,64000,false);assert.equal(tick(engine,66000,76000,true)?.kind,'start');
 const running=started();sample(running,12000,false,recording);running.cancel();assert.equal(tick(running,14000,60000,false,recording),null);
});
test('changing the viewed record never ends a different meeting',()=>{
 const engine=started();assert.equal(tick(engine,12000,50000,false,{...recording,id:'other'}),null);
});
test('changing listening targets retains ownership while restarting the end grace period',()=>{
 const engine=started();tick(engine,12000,30000,false,recording);engine.reconfigure();
 assert.equal(tick(engine,32000,60000,false,recording),null);
 const decision=sample(engine,62000,false,recording);assert.equal(decision.kind,'stop');assert.equal(decision.recordId,'auto-record');
});
test('failed automatic starts do not retry against a still-active application',()=>{
 const engine=createMeetingAutomation();tick(engine,0,10000,true);engine.started();assert.equal(tick(engine,12000,60000,true),null);
});
test('queued native events delivered after a frozen renderer cannot trigger immediate recording',()=>{
 const engine=createMeetingAutomation();
 for(let at=0;at<=20000;at+=2000)assert.equal(engine.sample({sampledAt:at,receivedAt:120000,active:true},idle),null);
 assert.equal(tick(engine,120000,130000,true),null);assert.equal(sample(engine,132000,true)?.kind,'start');
});
test('background automation defaults off, requires a target, and persists independent target choices',async()=>{
 const root=await mkdtemp(join(tmpdir(),'meeting-auto-config-'));
 try{
  assert.deepEqual(meetingAutomationConfig(await readConfig(root,{})),{enabled:false,browser:true,feishu:true});
  await saveConfig(root,{AUTO_MEETING_ENABLED:'true',AUTO_MEETING_BROWSER:'false',AUTO_MEETING_FEISHU:'true'},{});
  assert.deepEqual(meetingAutomationConfig(await readConfig(root,{})),{enabled:true,browser:false,feishu:true});
  await assert.rejects(saveConfig(root,{AUTO_MEETING_FEISHU:'false'},{}),{code:'invalid_meeting_automation'});
  await saveConfig(root,{AUTO_MEETING_ENABLED:'false'},{});assert.equal(meetingAutomationConfig(await readConfig(root,{})).enabled,false);
 }finally{await rm(root,{recursive:true,force:true});}
});
