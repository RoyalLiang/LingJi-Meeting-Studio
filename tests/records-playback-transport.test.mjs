import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transpileTypeScript } from './helpers/typescript.mjs';

const source = await readFile(new URL('../apps/web/src/audio/playback-transport.ts', import.meta.url), 'utf8');
const outputText = transpileTypeScript(source);
const { PlaybackTransport, PlaybackScrub, PlaybackClock } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('visible playback advances smoothly between coarse media samples without changing seek time',()=>{
 const clock=new PlaybackClock();let previous=clock.read(0,0,true);
 for(let now=16;now<=1600;now+=16){
  const actual=Math.floor(now/100)/10,shown=clock.read(actual,now,true);
  assert.ok(shown>=previous);assert.ok(shown-previous<.04);assert.ok(Math.abs(shown-actual)<=.25);
  previous=shown;
 }
 assert.equal(clock.read(1.6,1700,false),1.6);assert.equal(clock.read(1.6,1900,false),1.6);
 clock.reset(.3,2000);assert.equal(clock.read(.3,2000,true),.3);
 assert.ok(clock.read(.3,2016,true)>.3);
 assert.equal(clock.read(.3,3000,false),.3);
 assert.equal(clock.read(.3,4000,true,2),.3);assert.ok(Math.abs(clock.read(.3,4016,true,2)-.332)<1e-9);
 assert.ok(clock.read(.3,7000,true,2)<=2.8);
});

function track(duration) {
  let currentTime = 0;
  return {
    duration, paused: true, seeks: [], starts: 0, playbackRate: 1, preservesPitch: true,
    get ended() { return currentTime >= duration; },
    get currentTime() { return currentTime; },
    set currentTime(time) { currentTime = time; this.seeks.push(time); },
    async play() { this.paused = false; this.starts++; },
    pause() { this.paused = true; },
  };
}

test('visible cursor stays continuous with 500ms media quantization and tiny backward jitter',()=>{
  const clock=new PlaybackClock();let previous=clock.read(0,0,true),stalls=0;
  for(let now=16;now<3000;now+=16){
    const actual=Math.max(0,Math.floor((now-200)/500)*.5-(now%48===0?.001:0));
    const shown=clock.read(actual,now,true);
    assert.ok(shown>=previous,'sample jitter must not move the cursor backward');
    assert.ok(shown-previous<.04,'coarse media samples must not jump the visible cursor');
    if(shown===previous)stalls++;
    previous=shown;
  }
  assert.equal(stalls,0,'a playing cursor must not freeze between 500ms samples');
});

test('15 second jumps clamp to the timeline and keep paused recordings paused', async () => {
  const mic = track(90), meeting = track(60), transport = new PlaybackTransport(() => [mic, meeting]);
  await transport.skip(-15);
  assert.equal(transport.time, 0);
  transport.seek(50);
  await transport.skip(15);
  assert.equal(mic.currentTime, 65);
  assert.equal(meeting.currentTime, 60);
  assert.equal(mic.starts, 0);
  await transport.skip(100);
  assert.equal(transport.time, 90);
  await transport.skip(-100);
  assert.equal(transport.time, 0);
});

test('jumping backwards resumes an ended shorter track alongside a playing longer track', async () => {
  const mic = track(90), meeting = track(60), transport = new PlaybackTransport(() => [mic, meeting]);
  transport.seek(70);
  await transport.play();
  assert.equal(meeting.starts, 0);
  await transport.skip(-15);
  assert.equal(mic.currentTime, 55);
  assert.equal(meeting.currentTime, 55);
  assert.equal(mic.paused, false);
  assert.equal(meeting.paused, false);
  await transport.skip(100);
  assert.equal(transport.time, 90);
  assert.equal(transport.playing, false);
});

test('rate changes preserve pitch and apply to both tracks including a replacement', async () => {
  const mic = track(90), meeting = track(60);
  let tracks = [mic, meeting];
  const transport = new PlaybackTransport(() => tracks);
  transport.setRate(1.5);
  for (const media of tracks) {
    assert.equal(media.playbackRate, 1.5);
    assert.equal(media.preservesPitch, true);
  }
  const replacement = track(100); tracks = [replacement];
  await transport.play();
  assert.equal(replacement.playbackRate, 1.5);
  assert.throws(() => transport.setRate(NaN), /rate/);
  assert.throws(() => transport.setRate(0), /rate/);
  assert.equal(replacement.playbackRate, 1.5);
});

test('jumping before metadata is ready never writes an invalid seek position', async () => {
  const mic = track(90), meeting = track(NaN), transport = new PlaybackTransport(() => [mic, meeting]);
  await transport.skip(15);
  assert.deepEqual(mic.seeks, []);
  assert.deepEqual(meeting.seeks, []);
});

test('retry reapplies the selected rate after load resets browser playbackRate', async () => {
  const media = track(90), other = track(60), transport = new PlaybackTransport(() => [media, other]);
  media.error = { code: 4 };
  media.load = () => { media.error = null; media.playbackRate = 1; };
  transport.setRate(1.5);
  await transport.play();
  assert.equal(media.playbackRate, 1.5);
  assert.equal(other.playbackRate, 1.5);
  assert.equal(media.preservesPitch, true);
});

test('pause cancels a pending jump resume and a seek rejects non-finite positions', async () => {
  const media = track(90), transport = new PlaybackTransport(() => [media]);
  await transport.play();
  transport.seek(20);
  let release;
  media.play = () => new Promise(resolve => { release = () => { media.paused = false; resolve(); }; });
  const jumping = transport.skip(15);
  transport.pause();
  release();
  await jumping;
  assert.equal(media.currentTime, 35);
  assert.equal(media.paused, true);
  assert.equal(transport.playing, false);
  const before = media.seeks.length;
  transport.seek(NaN); transport.seek(Infinity);
  assert.equal(media.seeks.length, before);
});

test('one transport plays, pauses and seeks both saved sources on the longest timeline', async () => {
  const mic = track(1861), meeting = track(1860), transport = new PlaybackTransport(() => [mic, meeting]);
  assert.equal(transport.duration, 1861);
  await transport.play();
  assert.equal(mic.paused, false);
  assert.equal(meeting.paused, false);
  transport.pause();
  assert.equal(mic.paused, true);
  assert.equal(meeting.paused, true);
  transport.seek(1860.5);
  assert.equal(mic.currentTime, 1860.5);
  assert.equal(meeting.currentTime, 1860);
  await transport.play();
  assert.equal(mic.starts, 2);
  assert.equal(meeting.starts, 1);
  assert.equal(transport.time, 1860.5);
});

test('long recording pointer previews do not seek until release, then resume both sources once', async () => {
  const mic = track(1861), meeting = track(1860), transport = new PlaybackTransport(() => [mic, meeting]);
  const previews = [], scrub = new PlaybackScrub(transport, time => previews.push(time));
  await transport.play();
  scrub.begin();
  for (let i = 1; i <= 100; i++) scrub.move(i * 10);
  assert.equal(previews.at(-1), 1000);
  assert.deepEqual(mic.seeks, []);
  assert.deepEqual(meeting.seeks, []);
  assert.equal(scrub.finish(), true);
  assert.deepEqual(mic.seeks, [1000]);
  assert.deepEqual(meeting.seeks, [1000]);
  assert.equal(scrub.finish(), false);
  await transport.play();
  assert.equal(mic.starts, 2);
  assert.equal(meeting.starts, 2);
});

test('cancelled pointer drag keeps the previous time, and reset does not resume pending playback', async () => {
  const media = track(120), transport = new PlaybackTransport(() => [media]);
  transport.seek(12);
  const previews = [], scrub = new PlaybackScrub(transport, time => previews.push(time));
  scrub.begin(); scrub.move(90);
  assert.equal(scrub.finish(false), false);
  assert.equal(media.currentTime, 12);
  assert.equal(previews.at(-1), 12);
  let release;
  media.play = () => new Promise(resolve => { release = () => { media.paused = false; resolve(); }; });
  const pending = transport.play();
  transport.pause(); transport.seek(0); release(); await pending;
  assert.equal(media.paused, true);
  assert.equal(media.currentTime, 0);
  assert.equal(transport.playing, false);
});

test('seek waits for all source metadata and a failed source stops a late loading source too', async () => {
  const mic = track(120), meeting = track(NaN), transport = new PlaybackTransport(() => [mic, meeting]);
  assert.equal(transport.duration, 0);
  const scrub = new PlaybackScrub(transport, () => {});
  scrub.begin(); assert.equal(scrub.active, false);
  meeting.duration = 119;
  assert.equal(transport.duration, 120);
  let release;
  mic.play = async () => { throw new Error('load failed'); };
  meeting.play = () => new Promise(resolve => { release = () => { meeting.paused = false; resolve(); }; });
  const playing = transport.play();
  await Promise.resolve(); release();
  await assert.rejects(playing, /load failed/);
  assert.equal(meeting.paused, true);
  assert.equal(transport.playing, false);
});

test('switching meetings stops a pending track even after its element ref has detached', async () => {
  const media = track(120);
  let tracks = [media], release;
  media.play = () => new Promise(resolve => { release = () => { media.paused = false; resolve(); }; });
  const transport = new PlaybackTransport(() => tracks), pending = transport.play();
  tracks = []; transport.pause(); release(); await pending;
  assert.equal(media.paused, true);
});

test('play retries a failed initial media load after the retained audio becomes available',async()=>{
  const media=track(10);media.error={code:4};let loads=0;
  media.load=()=>{loads++;media.error=null;};
  media.play=async()=>{if(media.error)throw new Error('initial audio fetch failed');media.paused=false;};
  const transport=new PlaybackTransport(()=>[media]);
  await transport.play();assert.equal(loads,1);assert.equal(transport.playing,true);
});

test('player speed uses the shared selector and changes both tracks without pausing', async () => {
  const { transform } = await import('esbuild'), vm = await import('node:vm');
  const source = await readFile(new URL('../apps/web/src/components/AudioPlayer.tsx', import.meta.url), 'utf8');
  const code = (await transform(source.replace(/^import .*$/gm, ''), { loader:'tsx',format:'cjs' })).code;
  const states=[], refs=[]; let cursor=0,refCursor=0,selection;
  const tracks=[track(30),track(45)]; tracks.forEach(media=>{media.paused=false;});
  const icon=()=>null, sandbox={module:{exports:{}},useEffect(){},memo:component=>component,useId:()=> 'wave-fixture',waveformTicks:()=>[],useRef(value){return refs[refCursor++]??={current:value};},
    useState(initial){const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return [states[index],next=>{states[index]=next;}];},
    PlaybackTransport,PlaybackScrub,PlaybackClock,Button:icon,Toast:icon,Play:icon,Pause:icon,ArrowCounterClockwise:icon,ArrowClockwise:icon,Waveform:icon,Timer:icon,ArrowRight:icon,Gauge:icon,
    Select:props=>{selection=props;return null;}};
  sandbox.React={createElement:(tag,props,...children)=>typeof tag==='function'?tag({...props,children}):({tag,props,children})};
  vm.runInNewContext(code,sandbox);
  const render=()=>{cursor=0;refCursor=0;sandbox.module.exports.AudioPlayer({sources:[{id:'mic',src:'/mic',label:'我的声音'},{id:'meeting',src:'/meeting',label:'会议声音'}]});};
  render(); refs[0].current=tracks;
  assert.match(selection.label,/^播放速度/);assert.ok(selection.triggerContent);assert.equal(selection.menuMinWidth,112);
  assert.deepEqual(Array.from(selection.options,option=>option.value),['0.75','1','1.25','1.5','2']);
  selection.onChange('1.5');render();
  assert.equal(selection.value,'1.5');
  for(const media of tracks){assert.equal(media.playbackRate,1.5);assert.equal(media.paused,false);assert.equal(media.preservesPitch,true);}
});

test('shared speed menu fits a narrow trigger, stays in view and supports keyboard choice', async () => {
  const { transform } = await import('esbuild'),vm=await import('node:vm');
  const source=await readFile(new URL('../apps/web/src/components/Select.tsx',import.meta.url),'utf8');
  const code=(await transform(source.replace(/^import .*$/gm,''),{loader:'tsx',format:'cjs'})).code;
  const states=[],refs=[],effects=[],choices=[];let cursor=0,refCursor=0,focused=0;
  const viewport={width:400,height:500,addEventListener(){},removeEventListener(){}},icon=()=>null;
  const sandbox={module:{exports:{}},useEffect(){},useLayoutEffect:fn=>effects.push(fn),useId:()=> 'speed-fixture',
    useState(initial){const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return[states[index],next=>{states[index]=typeof next==='function'?next(states[index]):next;}];},
    useRef(value){return refs[refCursor++]??={current:value};},createPortal:element=>element,CaretDown:icon,Check:icon,
    document:{body:{}},window:{visualViewport:viewport},visualViewport:viewport,addEventListener(){},removeEventListener(){}};
  sandbox.React={createElement:(tag,props,...children)=>typeof tag==='function'?tag({...props,children}):({tag,props,children})};vm.runInNewContext(code,sandbox);
  const options=['0.75','1','1.25','1.5','2'].map(value=>({value,label:`${value}×`}));
  const render=()=>{cursor=0;refCursor=0;effects.length=0;return sandbox.module.exports.Select({label:'播放速度',value:'1',menuMinWidth:112,options,onChange:value=>choices.push(value)});};
  let tree=render();refs[1].current={showPopover(){},hidePopover(){},querySelector:()=>({scrollIntoView(){}})};
  refs[2].current={focus(){focused++;},getBoundingClientRect:()=>({left:336,width:56,top:440,bottom:484}),closest:()=>null};
  tree.children[1].props.onClick();tree=render();effects.splice(0).forEach(fn=>fn());tree=render();
  const popup=tree.children[2];assert.equal(popup.props.style.width,112);assert.equal(popup.props.style.minWidth,112);
  assert.equal(popup.props.style.left,280);assert.equal(popup.props['data-placement'],'top');
  assert.equal(tree.children[1].props['aria-expanded'],true);
  const key=key=>({key,preventDefault(){},stopPropagation(){}});
  tree.props.onKeyDown(key('ArrowDown'));tree=render();tree.props.onKeyDown(key('Enter'));
  assert.deepEqual(choices,['1.25']);tree=render();assert.equal(tree.children[1].props['aria-expanded'],false);assert.ok(focused>=2);
});

test('visible cursor never stalls or jumps when media time arrives only once per second',()=>{
 for(const rate of [.75,1,1.25,1.5,2]){const clock=new PlaybackClock();let previous=clock.read(0,0,true,rate);
 for(let now=16;now<=8000;now+=16){
  const shown=clock.read(Math.max(0,Math.floor((now-200)*rate/1000)),now,true,rate);
  assert.ok(shown>previous,'a progressing media clock must advance each frame');
  assert.ok(shown-previous<.04,'one-second samples must not jump the visible cursor');previous=shown;
 }}
});

test('dual-track playback aligns before starting and leaves mixing headroom at any speed',async()=>{
 const mic=track(90),meeting=track(90);mic.currentTime=20;meeting.currentTime=19.88;
 const starts=[];for(const media of [mic,meeting]){const play=media.play.bind(media);media.play=async()=>{starts.push(media.currentTime);await play();};media.webkitPreservesPitch=false;}
 const transport=new PlaybackTransport(()=>[mic,meeting]);transport.setRate(2);await transport.play();
 assert.deepEqual(starts,[20,20],'align before audible playback instead of correcting after playback starts');
 for(const media of [mic,meeting]){assert.equal(media.volume,.5);assert.equal(media.preservesPitch,true);assert.equal(media.webkitPreservesPitch,true);assert.equal(media.playbackRate,2);}
 const single=track(90);await new PlaybackTransport(()=>[single]).play();assert.equal(single.volume,1);
});


test('persisted timeline enables seeking before lazy audio metadata has loaded',()=>{
 const mic=track(NaN),meeting=track(NaN),transport=new PlaybackTransport(()=>[mic,meeting],120);
 assert.equal(transport.duration,120);assert.equal(transport.seek(67),67);assert.equal(mic.currentTime,67);assert.equal(meeting.currentTime,67);
});

test('sequential resumed clips retain full level while overlapping sources share headroom',async()=>{
 const first=track(1),second=track(1.5),transport=new PlaybackTransport(()=>[first,second],1.5,media=>media===second?1:0);
 await transport.play();assert.equal(first.volume,1);assert.equal(second.volume,1);
});

function unloadedTrack(duration) {
 const media=track(NaN),events=new EventTarget();
 media.addEventListener=events.addEventListener.bind(events);media.removeEventListener=events.removeEventListener.bind(events);
 media.load=()=>{media.currentTime=0;};media.ready=()=>{media.duration=duration;events.dispatchEvent(new Event('loadedmetadata'));};return media;
}

test('lazy metadata resolves before filtering an ended short source at a shared seek target',async()=>{
 const short=unloadedTrack(2),long=unloadedTrack(6),transport=new PlaybackTransport(()=>[short,long],6);
 transport.seek(4);const playing=transport.play();assert.equal(transport.time,4);assert.equal(short.starts+long.starts,0);
 short.ready();assert.equal(transport.time,4,'metadata must not reset the visible seek target');long.ready();await playing;
 assert.equal(short.starts,0);assert.equal(long.starts,1);assert.equal(long.currentTime,4);assert.equal(transport.playing,true);
});

test('pause cancels metadata listeners and prevents a late cold load from starting playback',async()=>{
 const media=unloadedTrack(6),transport=new PlaybackTransport(()=>[media],6);transport.seek(4);
 const playing=transport.play();transport.pause();await playing;media.ready();await Promise.resolve();assert.equal(media.starts,0);assert.equal(transport.playing,false);assert.equal(transport.time,4);
});

test('retrying an errored retained audio load preserves the chosen seek target',async()=>{
 const media=track(60),transport=new PlaybackTransport(()=>[media],60);media.error={code:4};media.load=()=>{media.error=null;media.currentTime=0;};transport.seek(20);await transport.play();assert.equal(media.currentTime,20);assert.equal(media.paused,false);
});


test('ordinary 80ms media sample jitter never rewinds the visible cursor',()=>{
  const clock=new PlaybackClock();let previous=clock.read(0,0,true);
  for(let now=16;now<1600;now+=16){
    const actual=Math.max(0,now/1000-(now%96===0?.096:0));
    const shown=clock.read(actual,now,true);
    assert.ok(shown>=previous,`visible cursor rewound at ${now}ms: ${previous} to ${shown}`);
    previous=shown;
  }
});
