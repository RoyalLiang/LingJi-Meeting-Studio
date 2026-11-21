import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {transformSync} from 'esbuild';

async function component(path,modules,globals={}){
  const source=await readFile(new URL('../apps/web/src/'+path,import.meta.url),'utf8');
  const compiled=transformSync(source,{loader:'tsx',format:'cjs',jsx:'automatic'}).code;
  const exports={},sandbox={exports,module:{exports},require:name=>modules[name]||{},...globals};
  vm.runInNewContext(compiled,sandbox);return sandbox.module.exports;
}
const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};

test('native recording reports stay independent from the visible clock and return idle after clearing a paused record',async()=>{
  const reports=[];
  const module=await component('components/RecordingProgress.tsx',{'react':{useSyncExternalStore:(_subscribe,read)=>read()},'react/jsx-runtime':jsx,'../audio/signal':{capturedDurationMs:saved=>saved},'../model':{timecode:ms=>String(ms)},'../useRecordingDuration':{useRecordingDuration:(_id,saved)=>saved},'../useRecordingWidget':{useRecordingWidget:report=>reports.push(report)}});
  const signals=module.createCaptureSignals(),record={id:'meeting',capture:'paused',durationMs:2000,sources:[]},props={record,recording:false,busy:false,signals,manifests:[],onError(){}};
  module.RecordingRuntime(props);assert.equal(reports.at(-1).paused,true);
  module.RecordingProgress(props);assert.equal(reports.length,1,'reading clock must not own native reports');
  module.RecordingRuntime({...props,record:null});assert.equal(reports.at(-1).paused,false);assert.equal(reports.at(-1).canResume,false);assert.equal(reports.at(-1).recording,false);
});

test('virtual segments track preceding layout while visible and disconnect when hidden', async () => {
  const effects = [], effectDeps = [], values = [], observers = [], options = [];
  let refs = 0, top = 100;
  const previous = {};
  const container = { scrollTop: 0, clientTop: 0, getBoundingClientRect: () => ({ top: 0 }), parentElement: null };
  const root = { closest: () => container, getBoundingClientRect: () => ({ top }), parentElement: container, previousElementSibling: previous };
  const module = await component('components/VirtualSegments.tsx', {
    react: {
      useRef: initial => ({ current: refs++ === 0 ? root : initial }),
      useState: initial => [initial, update => values.push(update(values.at(-1) ?? initial))],
      useLayoutEffect: (effect, deps) => { effects.push(effect); effectDeps.push(deps); },
      useCallback: callback => callback
    },
    'react/jsx-runtime': jsx,
    '@tanstack/react-virtual': { useVirtualizer: settings => {
      options.push(settings);
      return { getTotalSize: () => 160, getVirtualItems: () => [] };
    } },
    '../virtual-segments': { segmentRange: () => [] }
  }, {
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
      observe(target) { this.targets.push(target); }
      disconnect() { this.disconnected = true; }
    },
    requestAnimationFrame: callback => { callback(); return 1; },
    cancelAnimationFrame() {}
  });
  const props = { segments: [{ id: 'segment' }], children: () => null };
  module.VirtualSegments(props);
  assert.equal(effectDeps[0][0], true, 'margin ResizeObserver effect must depend on active');
  const cleanup = effects[0]();
  assert.equal(values.at(-1), 100);
  assert.ok(observers[0].targets.includes(previous));
  top = 200;
  observers[0].callback();
  assert.equal(values.at(-1), 200);
  cleanup();
  assert.equal(observers[0].disconnected, true);

  refs = 0;
  effects.length = 0;
  effectDeps.length = 0;
  module.VirtualSegments({ ...props, active: false });
  assert.equal(effectDeps[0][0], false, 'margin ResizeObserver effect must re-run when active toggles');
  effects[0]();
  assert.equal(options.at(-1).enabled, false);
  assert.equal(observers.length, 1);
});
