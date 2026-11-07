import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';

assert.equal(process.platform,'linux');
assert.equal(process.env.GITHUB_ACTIONS,'true');
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted','Virtual audio testing is confined to disposable CI');
const cargo=['test','--manifest-path','apps/desktop/src-tauri/Cargo.toml','--locked','--features','smoke-test','linux_monitor_captures_output_without_microphone'];
const run=(cmd,args,env={})=>new Promise((resolve,reject)=>{
  const child=spawn(cmd,args,{env:{...process.env,...env},stdio:'inherit'});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${cmd} exited ${code}`)));
});
await run('cargo',[...cargo,'--no-run']);
execFileSync('pulseaudio',['--start','--exit-idle-time=-1']);
let moduleId,player;
try{
  moduleId=execFileSync('pactl',['load-module','module-null-sink','sink_name=lingji_ci','format=s32le','rate=48000','channels=2','sink_properties=device.description=Lingji_CI_Output'],{encoding:'utf8'}).trim();
  assert.match(moduleId,/^\d+$/);
  execFileSync('pactl',['set-default-sink','lingji_ci']);
  // Only a virtual output is opened. No microphone or physical output is used.
  player=spawn('pacat',['--playback','--raw','--device=lingji_ci','--rate=48000','--channels=2','--format=float32le'],{stdio:['pipe','inherit','inherit']});
  const tone=Buffer.alloc(48000*20*2*4);
  for(let frame=0;frame<48000*20;frame++)for(let channel=0;channel<2;channel++)tone.writeFloatLE(Math.sin(frame*440*Math.PI*2/48000)*0.25,(frame*2+channel)*4);
  player.stdin.on('error',()=>{});player.stdin.end(tone);
  await run('cargo',[...cargo,'--','--ignored','--test-threads=1'],{TTS_LINUX_AUDIO_TEST:'1'});
  await mkdir('.agent-runtime',{recursive:true});
  await writeFile('.agent-runtime/linux-audio-compatibility.json',JSON.stringify({protocol:'PulseAudio',systemMonitorCaptured:true,virtualOutputTest:true,realAudioDevicesOpened:false},null,2)+'\n');
}finally{
  if(player)player.kill();
  if(moduleId)execFileSync('pactl',['unload-module',moduleId]);
  execFileSync('pulseaudio',['--kill']);
}
