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

test('browser duplex activity may arrive on alternating capture and playback samples',()=>{
 const engine=createMeetingAutomation();let decision;
 for(let at=0;at<=6000;at+=2000){const input=at%4000===0,output=!input;decision=engine.sample({sampledAt:at,active:true,startActive:false,input,output},idle);}
 assert.equal(decision?.kind,'start');
 const oneWay=createMeetingAutomation();for(let at=0;at<=16000;at+=2000)assert.equal(oneWay.sample({sampledAt:at,active:true,input:true,output:false},idle),null);
 const stale=createMeetingAutomation();stale.sample({sampledAt:0,active:true,input:true,output:false},idle);
 for(let at=8000;at<=20000;at+=2000)assert.equal(stale.sample({sampledAt:at,active:true,input:false,output:true},idle),null);
});


test('native listener passes alternating directions and rejects stale listener tokens',async()=>{
 const {transform}=await import('esbuild'),vm=await import('node:vm');
 const source=await readFile(new URL('../apps/web/src/useMeetingAutomation.ts',import.meta.url),'utf8');
 const code=(await transform(source.replace(/^import .*$/gm,'').replace('export function','function').replace(/^export type .*$/gm,'')+'\nexports.render=useMeetingAutomation;',{loader:'ts',format:'cjs'})).code;
 let handler,effect,time=0,starts=0;const errors=[];
 const box={exports:{},crypto:{randomUUID:()=> 'fixture-token'},Date:class extends Date{static now(){return time;}},isTauri:()=>true,createMeetingAutomation,useRef:value=>({current:value}),useState:()=>[undefined,()=>{}],useEffect:run=>{effect=run;},listen:async(_name,callback)=>{handler=callback;return()=>{};},invoke:async()=>true};
 vm.runInNewContext(code,box);box.exports.render({enabled:true,browser:true,feishu:false},idle,{start:async()=>{starts++;return 'auto-record';},stop:async()=>true,error:message=>errors.push(message)});
 const cleanup=effect();await Promise.resolve();await Promise.resolve();
 await handler({payload:{token:'old-token',sampledAt:time,input:true,output:true}});assert.equal(starts,0);
 for(time=0;time<=6000;time+=2000)await handler({payload:{token:'fixture-token',sampledAt:time,input:time%4000===0,output:time%4000!==0}});
 assert.equal(starts,1);assert.deepEqual(errors,[]);cleanup();
 box.invoke=async()=>false;box.exports.render({enabled:true,browser:true,feishu:false},idle,{start:async()=>undefined,stop:async()=>false,error:message=>errors.push(message)});const stop=effect();await new Promise(resolve=>setImmediate(resolve));assert.match(errors[0],/无法启用音频调用监听/);stop();
});

test('an open setup dialog blocks automatic start but not an owned meeting ending',()=>{
  const engine=createMeetingAutomation();
  for(let at=0;at<=8000;at+=2000)assert.equal(sample(engine,at,true,{...idle,startBlocked:true}),null);
  assert.equal(tick(engine,10000,14000,true,idle)?.kind,'start');engine.started(recording.id);
  assert.equal(tick(engine,16000,26000,false,{...recording,startBlocked:true})?.kind,'stop');
});

test('automation retries a failed stop without giving up ownership or stopping manual meetings',async()=>{
  const {transform}=await import('esbuild'),vm=await import('node:vm');
  const source=await readFile(new URL('../apps/web/src/useMeetingAutomation.ts',import.meta.url),'utf8');
  const code=(await transform(source.replace(/^import .*$/gm,'').replace(/export /g,'').replace(/^type .*$/gm,'')+'\nexports.render=useMeetingAutomation;',{loader:'ts',format:'cjs'})).code;
  let handler,cleanup,time=0,stops=0,slot=0;const refs=[],errors=[];
  const box={exports:{},crypto:{randomUUID:()=> 'fixture-token'},Date:class extends Date{static now(){return time;}},useRef:value=>{const index=slot++;return refs[index]||(refs[index]={current:value});},useState:()=>[undefined,()=>{}],useEffect:effect=>{if(!cleanup)cleanup=effect();},isTauri:()=>true,createMeetingAutomation,listen:async(_name,callback)=>{handler=callback;return()=>{};},invoke:async()=>true};
  vm.runInNewContext(code,box);
  const commands={start:async()=>recording.id,stop:async()=>{stops++;if(stops===1)return false;if(stops===2)throw new Error('seal unavailable');return true;},error:message=>errors.push(message)};
  const render=report=>{slot=0;box.exports.render({enabled:true,browser:true,feishu:false},report,commands);};
  render(idle);await Promise.resolve();await Promise.resolve();
  const feed=async(from,to,active)=>{for(time=from;time<=to;time+=2000)await handler({payload:{token:'fixture-token',sampledAt:time,input:active,output:active}});};
  await feed(0,4000,true);render(recording);
  await feed(6000,16000,false);assert.equal(stops,1);
  await feed(18000,28000,false);assert.equal(stops,2);
  await feed(30000,40000,false);assert.equal(stops,3);
  assert.equal(errors.length,2);render({...idle,id:recording.id});await feed(42000,60000,false);assert.equal(stops,3);cleanup();
});

test('automatic close seals the owned record even if its audio stream is already inactive',async()=>{
  const {transform}=await import('esbuild'),vm=await import('node:vm');const app=await readFile(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
  const line=app.split('\n').find(line=>line.includes('const meetingAutomation=useMeetingAutomation('));
  const code=(await transform(line+'\nexports.commands=meetingAutomation;',{loader:'tsx',format:'cjs'})).code;
  let seals=0;const context={exports:{},useMeetingAutomation:(_config,report,commands)=>({...commands,report}),pendingStop:{current:null},authReady:true,boot:{meetingAutomation:{enabled:true}},record:{id:'auto-record'},recording:true,busy:false,stopping:{current:false},modal:null,quickRecord:async()=>undefined,activeId:{current:'auto-record'},capture:{current:{active:false}},stopCapture:async mode=>{assert.equal(mode,'seal');seals++;return true;},setError:()=>{}};
  vm.runInNewContext(code,context);assert.equal(await context.exports.commands.stop('auto-record'),true);assert.equal(seals,1);
  assert.equal(await context.exports.commands.stop('different-record'),false);assert.equal(seals,1);
  const retryContext={...context,exports:{},recording:false,pendingStop:{current:{recordId:'auto-record',mode:'seal',title:''}}};vm.runInNewContext(code,retryContext);assert.equal(retryContext.exports.commands.report.recording,true);
});
