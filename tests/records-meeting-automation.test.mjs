import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveConfig,readConfig,meetingAutomationConfig} from '../services/records/src/config.mjs';
const bundle=await build({entryPoints:['apps/web/src/meeting-automation.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {createMeetingAutomation}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const idle={id:'',recording:false,paused:false,busy:false};
const recording={id:'auto-record',recording:true,paused:false,busy:false};
const sample=(engine,at,active,report=idle,error)=>engine.sample({sampledAt:at,active,error},report);
const tick=(engine,from,to,active,report=idle)=>{let result;for(let at=from;at<=to;at+=2000)result=sample(engine,at,active,report);return result;};
function started(){const engine=createMeetingAutomation();assert.equal(tick(engine,0,4000,true)?.kind,'start');engine.started(recording.id);return engine;}

test('four seconds of activity starts once while short notifications do not start',()=>{
 const engine=createMeetingAutomation();tick(engine,0,2000,true);assert.equal(sample(engine,4000,false),null);
 assert.equal(tick(engine,6000,10000,true)?.kind,'start');assert.equal(sample(engine,12000,true),null);
 engine.started(recording.id);assert.equal(sample(engine,14000,true,recording),null);
});
test('ten seconds without IO stops only an automatically owned meeting',()=>{
 const engine=started();tick(engine,6000,12000,true,recording);assert.equal(engine.pending,null);
 assert.equal(tick(engine,14000,22000,false,recording),null);assert.equal(sample(engine,24000,false,recording)?.kind,'stop');
 engine.stopped();assert.equal(sample(engine,26000,true),null);
});
test('IO returning before the stop deadline cancels the candidate',()=>{
 const engine=started();tick(engine,6000,14000,false,recording);assert.equal(sample(engine,16000,true,recording),null);assert.equal(engine.pending,null);
});
test('manual recording pause and stop are never overridden',()=>{
 for(const report of [{...recording,id:'manual'},{...idle,id:'manual',paused:true}]){
  const engine=createMeetingAutomation();assert.equal(tick(engine,0,8000,true,report),null);assert.equal(tick(engine,10000,20000,true),null);
 }
 const engine=started();sample(engine,6000,true,idle);assert.equal(tick(engine,8000,18000,true),null);
});
test('unknown samples resume gaps and rollback reset the entire grace period',()=>{
 const engine=started();tick(engine,6000,14000,false,recording);sample(engine,16000,false,recording,'unavailable');assert.equal(engine.pending,null);
 assert.equal(tick(engine,18000,26000,false,recording),null);assert.equal(sample(engine,60000,false,recording),null);assert.equal(engine.pending,null);
 assert.equal(sample(engine,50000,false,recording),null);assert.equal(engine.pending,null);
});
test('cancel suppresses activity, ten quiet seconds rearm, and cancelling stop hands ownership to user',()=>{
 const engine=createMeetingAutomation();sample(engine,0,true);engine.cancel();assert.equal(tick(engine,2000,12000,true),null);
 tick(engine,14000,24000,false);assert.equal(tick(engine,26000,30000,true)?.kind,'start');
 const running=started();sample(running,6000,false,recording);running.cancel();assert.equal(tick(running,8000,22000,false,recording),null);
});
test('changing the viewed record never ends a different meeting',()=>{
 const engine=started();assert.equal(tick(engine,6000,22000,false,{...recording,id:'other'}),null);
});
test('changing targets retains ownership but restarts the stop grace period',()=>{
 const engine=started();tick(engine,6000,14000,false,recording);engine.reconfigure();assert.equal(tick(engine,16000,24000,false,recording),null);
 assert.equal(sample(engine,26000,false,recording)?.kind,'stop');
});
test('failed automatic starts do not retry against current activity',()=>{
 const engine=createMeetingAutomation();tick(engine,0,4000,true);engine.started();assert.equal(tick(engine,6000,24000,true),null);
});
test('queued stale native events cannot trigger immediate recording',()=>{
 const engine=createMeetingAutomation();for(let at=0;at<=20000;at+=2000)assert.equal(engine.sample({sampledAt:at,receivedAt:120000,active:true},idle),null);
 assert.equal(tick(engine,120000,124000,true),null);assert.equal(sample(engine,126000,true)?.kind,'start');
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


test('microphone-only or playback-only activity cannot auto-start; one direction can keep an owned meeting alive',()=>{
  const engine=createMeetingAutomation();
  for(let at=0;at<=20000;at+=2000)assert.equal(engine.sample({sampledAt:at,active:true,startActive:false},idle),null);
  for(let at=22000;at<=26000;at+=2000){const result=engine.sample({sampledAt:at,active:true,startActive:true},idle);if(at===26000)assert.equal(result?.kind,'start');}
  engine.started(recording.id);
  for(let at=28000;at<=48000;at+=2000)assert.equal(engine.sample({sampledAt:at,active:true,startActive:false},recording),null);
  assert.equal(engine.pending,null);
  assert.equal(tick(engine,50000,60000,false,recording)?.kind,'stop');
});

test('quick capture stays active when an auxiliary list or detail refresh fails',async()=>{
 const {transform}=await import('esbuild'),vm=await import('node:vm');
 const app=await readFile(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
 const start=app.indexOf('async function quickRecord()'),end=app.indexOf('async function startCapture(',start);
 const {code}=await transform(app.slice(start,end)+'\nexports.run=quickRecord;',{loader:'tsx',format:'cjs'});
 for(const failure of ['list','load','detail']){
  let stops=0,active=true;const errors=[];
  const controller={get active(){return active;},startMeeting:async()=>[],stop:async()=>{stops++;active=false;}};
  const noop=()=>{},context={exports:{},recording:false,busy:false,captureAllowed:()=>true,setError:value=>errors.push(value),setCaptureIssues:noop,setBusy:noop,setCapturePhase:noop,capture:{current:null},boot:null,scope:'all',minutesAvailable:()=>false,controllerFor:()=>controller,activeId:{current:null},selectRecord:noop,rememberRecord:noop,setModal:noop,setQueueRecords:noop,setRecording:noop,messageOf:e=>e.message,
   api:async(_path,method)=>{if(method==='POST')return{id:'new-record'};if(failure==='list')throw new Error('list unavailable');return{records:[]};},
   loadList:async()=>{if(failure==='load')throw new Error('list unavailable');},refresh:async()=>{if(failure==='detail')throw new Error('detail unavailable');}};
  vm.runInNewContext(code,context);
  assert.equal(await context.exports.run(),'new-record',failure);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(active,true);assert.equal(stops,0);assert.equal(context.activeId.current,'new-record');assert.ok(errors.some(value=>value.includes('unavailable')));
 }
});
