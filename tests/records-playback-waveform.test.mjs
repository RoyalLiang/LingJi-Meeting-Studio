import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { recordingWaveform } from '../services/records/src/waveform.mjs';

const load = async path => import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(await readFile(new URL(path, import.meta.url), 'utf8'), {mode:'transform'})).toString('base64')}`);
const { mergeWaveforms, parsePlaybackTime, waveformTicks } = await load('../apps/web/src/audio/playback-waveform.ts');
const { PlaybackTransport, PlaybackScrub } = await load('../apps/web/src/audio/playback-transport.ts');

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
  const icon=()=>null, sandbox={module:{exports:{}},AbortController,PlaybackTransport,PlaybackScrub,mergeWaveforms,parsePlaybackTime,waveformTicks,
    useId:()=> 'c-player',useRef:value=>refs[refCursor++]??={current:value},
    useState(initial){const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return[states[index],next=>{states[index]=next;}];},
    useEffect(fn,next){const i=effectCursor++;if(JSON.stringify(next)!==deps[i]){deps[i]=JSON.stringify(next);effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}},
    api:async(path,method,body,signal)=>{requests.push({path,signal});if(failWaveform)throw Error('network');return {samples:(path.includes('mic')?90:60)*16000,sampleRate:16000,peaks:Array(192).fill(.25)};},
    Button:props=>({tag:'button',props}),Select:props=>({tag:'select',props}),Toast:icon,Play:icon,Pause:icon,ArrowCounterClockwise:icon,ArrowClockwise:icon,Waveform:icon,Timer:icon,ArrowRight:icon};
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

test('C player renders real waveform, ticks and centered controls; time jump and drag retain dual-track semantics', async () => {
  const fixture=await playerFixture();try {
    const find=fixture.find;
    assert.ok(find(node=>node.props.className==='player-waveform'));
    assert.ok(find(node=>node.props.className==='player-wave-ticks'));
    assert.ok(find(node=>node.props.className==='player-bottomline'));
    assert.equal(fixture.requests.length,2,'fresh sources array does not re-request unchanged waveforms');
    find(node=>node.props['aria-label']==='播放原音').props.onClick();await new Promise(resolve=>setImmediate(resolve));
    find(node=>node.props['aria-label']==='跳转时间').props.onChange({target:{value:'00:40'}});
    find(node=>node.tag==='form').props.onSubmit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));
    assert.ok(fixture.tracks.every(track=>track.currentTime===40&&!track.paused));
    const slider=find(node=>node.props.className==='player-seek');
    slider.props.onPointerDown({pointerId:1,currentTarget:{setPointerCapture(){}}});
    slider.props.onChange({currentTarget:{value:'75'}});
    assert.ok(fixture.tracks.every(track=>track.currentTime===40&&track.paused));
    slider.props.onPointerUp();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(fixture.tracks[0].currentTime,75);assert.equal(fixture.tracks[1].currentTime,60);
    find(node=>node.props['aria-label']==='跳转时间').props.onChange({target:{value:'3:10'}});
    find(node=>node.tag==='form').props.onSubmit({preventDefault(){}});
    assert.equal(find(node=>node.props['aria-label']==='跳转时间').props['aria-invalid'],true);
  } finally {fixture.dispose();}
  assert.ok(fixture.requests.every(request=>request.signal.aborted));
});

test('waveform failure stays explicit and leaves playback/seek available', async () => {
  const fixture=await playerFixture(true);try {
    assert.equal(fixture.find(node=>node.props['data-waveform-state'])?.props['data-waveform-state'],'error');
    assert.equal(fixture.find(node=>node.props.className==='player-seek').props.disabled,false);
    assert.ok(fixture.find(node=>node.props['aria-label']==='播放原音'));
  } finally {fixture.dispose();}
});
