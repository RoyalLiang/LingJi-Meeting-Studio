import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transpileTypeScript } from './helpers/typescript.mjs';
import { recordingWaveform } from '../services/records/src/waveform.mjs';

const load = async path => import(`data:text/javascript;base64,${Buffer.from(transpileTypeScript(await readFile(new URL(path, import.meta.url), 'utf8'))).toString('base64')}`);
const { mergeWaveforms, parsePlaybackTime, waveformTicks, waveformSeekTime } = await load('../apps/web/src/audio/playback-waveform.ts');
const { PlaybackTransport, PlaybackScrub, PlaybackClock } = await load('../apps/web/src/audio/playback-transport.ts');

function pcm(values) { const bytes = Buffer.alloc(values.length * 2); values.forEach((value,index) => bytes.writeInt16LE(value,index * 2)); return bytes; }

test('waveform reads real PCM across object boundaries with fixed memory and peak bins', async () => {
  const objects = [pcm(Array(120).fill(0)), pcm(Array(264).fill(-32768))];
  const chunks = [{object:0,sampleOffset:0,sampleCount:120},{object:1,sampleOffset:120,sampleCount:264}];
  const reads=[];
  const result = await recordingWaveform(chunks, async object => { reads.push(object); return objects[object]; });
  assert.deepEqual(reads,[0,1]); assert.equal(result.samples,384);assert.equal(result.sampleRate,16000);
  assert.equal(result.peaks.length,192);assert.ok(result.peaks.slice(0,60).every(peak=>peak===0));
  assert.ok(result.peaks.slice(60).every(peak=>peak===1));
});

test('cancelled waveform reads stop without returning partial/fake peaks; corrupt PCM fails', async () => {
  let reads=0;
  const chunks = [{object:'a',sampleOffset:0,sampleCount:2},{object:'b',sampleOffset:2,sampleCount:2}];
  assert.equal(await recordingWaveform(chunks,async()=>{reads++;return pcm([1,2]);},()=>reads>0),null);
  assert.equal(reads,1);
  await assert.rejects(recordingWaveform(chunks,async()=>Buffer.alloc(2)),/audio_unavailable/);
});

test('shorter waveform ends on the shared clock instead of stretching to full length', () => {
  const long={samples:64000,sampleRate:16000,peaks:Array(192).fill(0)};
  const short={samples:16000,sampleRate:16000,peaks:Array(192).fill(1)};
  const merged=mergeWaveforms([long,short]);
  assert.equal(merged.length,192);assert.ok(merged.slice(0,48).every(v=>v===1));assert.ok(merged.slice(48).every(v=>v===0));
  assert.throws(()=>mergeWaveforms([{...long,peaks:[NaN]}]),/Invalid/);
});

test('time entry and waveform ticks support long recordings with clear validation', () => {
  assert.equal(parsePlaybackTime(' 08:36 '),516);assert.equal(parsePlaybackTime('2:12:59'),7979);
  for(const invalid of ['', '2:60','-1:20','3:10:70','abc']) assert.equal(parsePlaybackTime(invalid),null);
  assert.deepEqual(waveformTicks(10800),[0,2700,5400,8100,10800]);assert.deepEqual(waveformTicks(0),[]);
});

async function playerFixture(failWaveform=false) {
  const { transform }=await import('esbuild'),vm=await import('node:vm');
  const source=await readFile(new URL('../apps/web/src/components/AudioPlayer.tsx',import.meta.url),'utf8');
  const code=(await transform(source.replace(/^import .*$/gm,''),{loader:'tsx',format:'cjs'})).code;
  let cursor=0,refCursor=0,effectCursor=0;
  const states=[],refs=[],deps=[],cleanups=[],effects=[],requests=[];
  const makeTrack=duration=>({duration,currentTime:0,paused:true,ended:false,error:null,playbackRate:1,preservesPitch:true,seeks:[],
    async play(){this.paused=false;},pause(){this.paused=true;},load(){}});
  const tracks=[makeTrack(90),makeTrack(60)];
  const icon=()=>null, sandbox={module:{exports:{}},AbortController,performance,PlaybackTransport,PlaybackScrub,PlaybackClock,memo:fn=>fn,mergeWaveforms,parsePlaybackTime,waveformTicks,waveformSeekTime,
    useId:()=> 'c-player',useRef:value=>refs[refCursor++]??={current:value},
    useState(initial){const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return[states[index],next=>{states[index]=next;}];},
    useEffect(fn,next){const i=effectCursor++;if(JSON.stringify(next)!==deps[i]){deps[i]=JSON.stringify(next);effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}},
    api:async(path,method,body,signal)=>{requests.push({path,signal});if(failWaveform)throw Error('network');return {samples:(path.includes('mic')?90:60)*16000,sampleRate:16000,peaks:Array(192).fill(.25)};},
    Button:props=>({tag:'button',props}),Select:props=>({tag:'select',props}),Toast:icon,Play:icon,Pause:icon,ArrowCounterClockwise:icon,ArrowClockwise:icon,Waveform:icon,Timer:icon,ArrowRight:icon,Gauge:icon};
  sandbox.React={createElement:(tag,props,...children)=>typeof tag==='function'?tag({...props,children}):({tag,props:props||{},children:children.flat()})};
  vm.runInNewContext(code,sandbox);
  const sources=[{id:'mic',src:'/api/records/r/audio/mic',label:'我的声音'},{id:'meeting',src:'/api/records/r/audio/meeting',label:'会议声音'}];
  const render=()=>{cursor=0;refCursor=0;effectCursor=0;return sandbox.module.exports.AudioPlayer({sources:[...sources]});};
  let tree=render();refs[0].current=tracks;
  effects.splice(0).forEach(fn=>fn());await new Promise(resolve=>setImmediate(resolve));
  const walk=(node,predicate)=>{if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of node.children||[]){const found=walk(child,predicate);if(found)return found;}return null;};
  walk(tree,node=>node.tag==='audio').props.onLoadedMetadata();tree=render();
  return {tracks,requests,render,find:predicate=>walk(render(),predicate),dispose:()=>cleanups.forEach(fn=>fn?.())};
}

test('compact C player seeks by waveform click and drag, keeps both tracks aligned and removes duplicate controls', async () => {
  const fixture=await playerFixture();
  try {
    const find=fixture.find;
    assert.ok(find(node=>node.props.className==='player-waveform'));
    assert.ok(find(node=>node.props.className==='player-wave-ticks'));
    assert.equal(find(node=>node.props['aria-label']==='跳转时间'),null);
    assert.equal(find(node=>node.props.className==='player-time'),null);
    assert.equal(fixture.requests.length,2);
    find(node=>node.props['aria-label']==='播放原音').props.onClick();await new Promise(resolve=>setImmediate(resolve));
    let captured=false,focused=false;
    const target={focus(){focused=true;},getBoundingClientRect:()=>({left:10,width:180}),setPointerCapture(){captured=true;},hasPointerCapture(){return captured;},releasePointerCapture(){captured=false;}};
    const event=clientX=>({clientX,pointerId:1,isPrimary:true,button:0,currentTarget:target,preventDefault(){}});
    let slider=find(node=>node.props.className==='player-seek');
    slider.props.onPointerDown(event(90));assert.equal(focused,true,'clicking the waveform must focus the keyboard slider');
    assert.ok(fixture.tracks.every(track=>track.currentTime===0&&track.paused),'press previews without seeking decoded media');
    slider.props.onPointerUp(event(90));await new Promise(resolve=>setImmediate(resolve));
    assert.ok(fixture.tracks.every(track=>track.currentTime===40&&!track.paused),'a click seeks to its position and resumes');
    slider=find(node=>node.props.className==='player-seek');
    slider.props.onPointerDown(event(50));slider.props.onPointerMove(event(160));
    assert.ok(fixture.tracks.every(track=>track.currentTime===40&&track.paused),'drag previews without repeated media seeks');
    slider.props.onPointerUp(event(160));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(fixture.tracks[0].currentTime,75);assert.equal(fixture.tracks[1].currentTime,60);
    const speed=find(node=>node.tag==='select'&&node.props.label.startsWith('播放速度'));
    assert.ok(speed.props.triggerContent,'speed uses the shared icon trigger');
    speed.props.onChange('1.25');assert.ok(fixture.tracks.every(track=>track.playbackRate===1.25&&track.preservesPitch));
  } finally {fixture.dispose();}
});

test('waveform failure stays explicit and leaves playback/seek available', async () => {
  const fixture=await playerFixture(true);try {
    assert.equal(fixture.find(node=>node.props['data-waveform-state'])?.props['data-waveform-state'],'error');
    assert.equal(fixture.find(node=>node.props.className==='player-seek').props.disabled,false);
    assert.ok(fixture.find(node=>node.props['aria-label']==='播放原音'));
  } finally {fixture.dispose();}
});

test('parallel waveform scans keep exact bins, offsets and an eight-buffer read limit',async()=>{
 let seed=71;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};
 const chunks=[],objects=[];let offset=0;
 for(let i=0;i<31;i++){const count=1+random()%1234,data=Buffer.alloc(count*2);for(let n=0;n<count;n++)data.writeInt16LE((random()%65536)-32768,n*2);chunks.push({object:i,sampleOffset:offset,sampleCount:count});objects.push(data);offset+=count;}
 const leading=333,samples=leading+offset,expected=Array(192).fill(0);for(const c of chunks)for(let i=0;i<c.sampleCount;i++){const bin=Math.floor((leading+c.sampleOffset+i)*192/samples);expected[bin]=Math.max(expected[bin],Math.abs(objects[c.object].readInt16LE(i*2))/32768);}
 let active=0,max=0;const actual=await recordingWaveform(chunks,async object=>{active++;max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;return objects[object];},()=>false,leading);
 assert.deepEqual(actual.peaks,expected);assert.equal(actual.samples,samples);assert.equal(max,8);
});
