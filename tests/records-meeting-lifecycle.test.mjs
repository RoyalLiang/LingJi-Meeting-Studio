import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function stopHarness({ backgroundWait = Promise.resolve(), refreshFails = false } = {}) {
  const app = await readFile(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const start = app.indexOf('  async function stopCapture('), end = app.indexOf('  function captureAllowed(', start);
  assert.ok(start >= 0 && end > start);
  const code = (await transform(app.slice(start, end) + '\nexports.stopCapture = stopCapture;', { loader: 'ts' })).code;
  const current = { id: 'meeting', title: '会议', capture: 'recording', sources: [{ id: 'mic', epoch: 'epoch', watermark: 0 } ] };
  const state = { busy: false, phase: 'idle', recording: true, record: current, modal: 'finish', error: '', calls: [] };
  const controller = { active: true, async stop() { this.active = false; state.calls.push('local-stop'); } };
  const sandbox = {
    exports: {}, stopping: { current: false }, capture: { current: controller }, activeId: { current: current.id },
    setBusy: value => { state.busy = value; }, setCapturePhase: value => { state.phase = value; },
    setError: value => { state.error = value; }, setRecording: value => { state.recording = value; },
    rememberRecord: value => { state.record = value; }, setModal: value => { state.modal = value; },
    api: async (path, method, body) => { state.calls.push({ path, method, body }); return method === 'POST' ? { ...current, capture: 'sealed' } : current; },
    localManifests: async () => [{ sourceId: 'mic', lastSequence: 3 }],
    upload: () => backgroundWait,
    refresh: async () => { if (refreshFails) throw new Error('refresh unavailable'); },
    loadList: async () => {}, showToast: value => { state.toast = value; }, messageOf: error => error.message,
    AbortSignal, Promise, console,
  };
  vm.runInNewContext(code, sandbox);
  return { state, ...sandbox.exports };
}

test('ending a meeting releases the controls after sealing even while background audio upload is pending', async () => {
  let release;
  const backgroundWait = new Promise(resolve => { release = resolve; });
  const h = await stopHarness({ backgroundWait });
  let ended = false;
  const stopping = h.stopCapture().then(value => { ended = value; });
  await tick(); await tick();
  try {
    assert.equal(h.state.record.capture, 'sealed');
    assert.equal(ended, true, 'a durable sealed meeting must not wait on background upload');
    assert.equal(h.state.busy, false);
    assert.equal(h.state.modal, null);
    assert.equal(h.state.recording, false);
    assert.equal(h.state.phase, 'idle');
    assert.equal(h.state.calls.find(call => call.method === 'POST').body.sources[0].lastSequence, 3, 'seal preserves the locally saved tail watermark');
  } finally { release(); await stopping; }
});

test('a failed refresh after a successful seal cannot report the meeting as unfinished', async () => {
  const h = await stopHarness({ refreshFails: true });
  assert.equal(await h.stopCapture(), true);
  assert.equal(h.state.record.capture, 'sealed');
  assert.equal(h.state.busy, false);
});

async function renderControls(props) {
  const source = await readFile(new URL('../apps/web/src/components/MeetingControls.tsx', import.meta.url), 'utf8');
  const code = (await transform(source.replace(/^import .*$/gm, '').replace('export function', 'function') + '\nexports.render = MeetingControls;', { loader: 'tsx' })).code;
  const element = (tag, attributes, ...children) => ({ tag: typeof tag === 'string' ? tag : 'component', attributes, children });
  const sandbox = { exports: {}, React: { createElement: element, Fragment: 'fragment' }, Button() {}, CaptureSignals() {} };
  for (const icon of ['Headphones','Microphone','MicrophoneSlash','Play','Plus','Record','Square','FileAudio']) sandbox[icon] = () => {};
  vm.runInNewContext(code, sandbox);
  return JSON.stringify(sandbox.exports.render({ record: { capture: 'recording', sources: [] }, ready: true, signals: [], ...props }));
}

test('audio processing and import progress stay inside the capture status container',async()=>{
  const findStatus=node=>{
    if(!node||typeof node!=='object')return null;
    if(node.attributes?.className==='capture-status')return node;
    return (Array.isArray(node)?node:Object.values(node)).map(findStatus).find(Boolean);
  };
  const props={record:{capture:'recording',sources:[],pendingChunks:3},recording:true,busy:false};
  const processing=await renderControls(props);
  assert.match(JSON.stringify(findStatus(JSON.parse(processing))),/正在处理音频/);
  assert.equal(processing.match(/正在处理音频/g).length,1);
  const importing=await renderControls({...props,progress:'正在导入音频 75%'});
  assert.match(JSON.stringify(findStatus(JSON.parse(importing))),/正在导入音频 75%/);
});

test('meeting controls distinguish ending capture from starting audio or unrelated page work', async () => {
  const ending = await renderControls({ recording: false, busy: true, phase: 'stopping' });
  assert.doesNotMatch(ending, /正在接入声音/);
  assert.match(ending, /正在收尾/);
  const saving = await renderControls({ recording: false, busy: true, phase: 'idle' });
  assert.doesNotMatch(saving, /正在接入声音/);
  const starting = await renderControls({ recording: false, busy: true, phase: 'starting' });
  assert.match(starting, /正在接入声音/);
});

test('ending capture keeps visible summary progress until the final job completes',async()=>{
 const record={capture:'completed',sources:[],segments:[{id:'s1'}],transcriptRevision:3,pendingChunks:0,autoMinutes:{enabled:true},jobs:[{scope:'final',status:'running',progress:{completed:2,total:5,stage:'window'}}]};
 const processing=await renderControls({record,recording:false,busy:false});
 assert.match(processing,/录音已结束，正在后台收尾/);
 assert.match(processing,/纪要与重点速览/);assert.match(processing,/2\/5/);
 assert.doesNotMatch(processing,/本场已收好/);
 record.jobs[0].status='completed';record.minutes={transcriptRevision:3};
 assert.match(await renderControls({record,recording:false,busy:false}),/本场已收好/);
});

test('sealed local tail remains visibly processing before packets reach the backend',async()=>{
 const html=await renderControls({record:{capture:'sealed',sources:[{watermark:1,lastSequence:2}],pendingChunks:0,jobs:[],segments:[]},recording:false,busy:false});
 assert.match(html,/正在后台收尾/);assert.match(html,/尾段音频/);assert.doesNotMatch(html,/本场已收好/);
});

test('a preserved manual summary is not reported as failed when its background job becomes stale',async()=>{
 const record={capture:'completed',sources:[],pendingChunks:0,segments:[{id:'s1'}],transcriptRevision:3,autoMinutes:{enabled:true},minutes:{edited:true,transcriptRevision:3},jobs:[{scope:'final',status:'stale',transcriptRevision:3}]};
 const html=await renderControls({record,recording:false,busy:false});
 assert.match(html,/本场已收好/);assert.doesNotMatch(html,/纪要待重试|整理未完成/);
 record.jobs[0].status='failed';
 assert.match(await renderControls({record,recording:false,busy:false}),/纪要待重试/);
});

test('synthesis remains visibly processing after all nodes finish',async()=>{
 const record={capture:'completed',sources:[],segments:[{id:'s1'}],transcriptRevision:3,pendingChunks:0,autoMinutes:{enabled:true},jobs:[{scope:'final',status:'running',progress:{completed:4,total:4,stage:'synthesis'}}]};
 const html=await renderControls({record,recording:false,busy:false});
 assert.match(html,/is-processing/);assert.match(html,/正在汇总会议终稿/);assert.match(html,/4\/4/);assert.doesNotMatch(html,/本场已收好/);
 record.jobs[0].status='completed';record.minutes={transcriptRevision:3};
 assert.doesNotMatch(await renderControls({record,recording:false,busy:false}),/is-processing/);
});

test('exhausted tail transcription requires retry while independent minutes can continue',async()=>{
 const record={capture:'sealed',transcription:'failed',sources:[],segments:[{id:'s1'}],transcriptRevision:3,pendingChunks:1,autoMinutes:{enabled:true},jobs:[]};
 const failed=await renderControls({record,recording:false,busy:false});
 assert.match(failed,/尾段转录待重试/);assert.match(failed,/is-blocked/);assert.match(failed,/音频包等待重试/);assert.doesNotMatch(failed,/个音频包正在处理/);assert.match(failed,/转录已暂停/);assert.doesNotMatch(failed,/is-processing|正在处理尾段转录|将继续更新/);
 record.jobs.push({scope:'final',status:'running',progress:{completed:2,total:5,stage:'window'}});
 const summarizing=await renderControls({record,recording:false,busy:false});
 assert.match(summarizing,/is-processing/);assert.match(summarizing,/2\/5/);assert.match(summarizing,/尾段转录待重试/);assert.doesNotMatch(summarizing,/正在处理尾段转录|将继续更新/);
 record.jobs=[];record.transcription='queued';
 const retried=await renderControls({record,recording:false,busy:false});
 assert.match(retried,/is-processing/);assert.match(retried,/正在处理尾段转录/);assert.doesNotMatch(retried,/尾段转录待重试|is-blocked/);
});
