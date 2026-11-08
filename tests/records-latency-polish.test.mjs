import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecord} from '../packages/records/src/record.mjs';
import {setAutomation,automaticMinutesAt,queueAutomaticMinutes} from '../packages/records/src/automation.mjs';
import {minutesReasoningEffort} from '../services/records/src/minutes-reasoning.mjs';

test('first live minutes start within 10 seconds without changing subsequent cadence',()=>{
  const r=createRecord('fixture');r.capture='recording';r.segments=[{id:'s',revision:1,text:'决定周五评审',startMs:0,endMs:1000}];r.transcriptRevision=1;
  setAutomation(r,{enabled:true,intervalSeconds:90},1000);
  assert.equal(automaticMinutesAt(r,1000),11000);
  const job=queueAutomaticMinutes(r,'fixture',11000);assert.ok(job);
  job.status='completed';r.transcriptRevision++;
  assert.equal(automaticMinutesAt(r,11000),101000);
});

test('automatic live minutes use low reasoning while final synthesis keeps depth',()=>{
  const env={LLM_MODEL:'fixture'};
  assert.equal(minutesReasoningEffort({scope:'live',stage:'single'},env),'low');
  assert.equal(minutesReasoningEffort({scope:'live',stage:'synthesis'},env),'low');
  assert.equal(minutesReasoningEffort({scope:'final',stage:'synthesis'},env),'high');
  assert.equal(minutesReasoningEffort({scope:'live'},{...env,LLM_REASONING_EFFORT:'high'}),'high');
});

async function hooked(entry){
 const {build}=await import('esbuild'),vm=await import('node:vm'),{createRequire}=await import('node:module'),{resolve}=await import('node:path');
 const require=createRequire(resolve('package.json')),React=require('react'),states=[],refs=[];let stateIndex=0,refIndex=0;
 const hooks={...React,useState(initial){const index=stateIndex++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return[states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value;}];},useRef(initial){const index=refIndex++;return refs[index]??=( {current:initial} );},useMemo:fn=>fn(),useCallback:fn=>fn,useEffect(){},useLayoutEffect(){}};
 const result=await build({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/jsx-runtime','react-dom']});const module={exports:{}};
 vm.runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,require:id=>id==='react'?hooks:require(id),console,matchMedia:()=>({matches:false})});
 return{...module.exports,render(fn,...args){stateIndex=0;refIndex=0;return fn(...args);}};
}
function elements(node,predicate,result=[]){if(!node||typeof node!=='object')return result;if(predicate(node))result.push(node);for(const child of [node.props?.children].flat(Infinity))elements(child,predicate,result);return result;}

test('virtual transcript range stays bounded and retains an offscreen editing row',async()=>{
  const {segmentRange}=await import('../apps/web/src/virtual-segments.ts');
  const visible=segmentRange(500,510,10000,10);assert.ok(visible.length<=50);assert.ok(visible.includes(500)&&visible.includes(510)&&visible.includes(10));
  assert.equal(segmentRange(0,5,10000).length,30);assert.deepEqual(segmentRange(0,0,0),[]);
});

test('retained partial minutes stay read-only and are fenced by notes, template and generation',async()=>{
 const h=await hooked('apps/web/src/components/Minutes.tsx'),record=createRecord('fixture');record.capture='recording';record.transcriptRevision=1;
 record.segments=[{id:'s',revision:1,text:'合成发言',speaker:'',sourceId:'text-import',startMs:0,endMs:1000}];
 const partial={title:'已校验分批',transcriptRevision:1,sections:[{heading:'主题',items:[{text:'合成结论',evidence:[{segmentId:'s',revision:1}]}]}],actions:[],evidenceSnapshot:record.segments};
 const base={scope:'live',status:'running',transcriptRevision:1,notesRevision:0,template:'meeting',generation:1};
 const render=()=>h.render(h.MinutesPanel,{record,inline:true,busy:false,focusSuspended:true,onClose(){},generate(){},edit(){},cite(){},automate(){}});
 record.jobs=[{...base,id:'a',partialMinutes:partial}];let tree=render();assert.equal(elements(tree,e=>e.props?.['aria-label']==='修订纪要')[0].props.disabled,true);
 record.jobs=[{...base,id:'b',status:'queued'}];tree=render();assert.equal(elements(tree,e=>e.props?.['aria-label']==='修订纪要')[0].props.disabled,true);
 for(const change of [{notesRevision:1},{template:'lecture'},{generation:2}]){
  record.notesRevision=0;record.jobs=[{...base,id:'a',partialMinutes:partial}];render();record.jobs=[{...base,id:'c',status:'queued',...change}];if(change.notesRevision)record.notesRevision=1;
  assert.equal(elements(render(),e=>e.props?.['aria-label']==='修订纪要').length,0);
 }
});
