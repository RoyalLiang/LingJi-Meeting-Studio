import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {createRecord,requestMinutes,commitMinutes,validateMinutes,seal} from '../packages/records/src/record.mjs';
import {createRepository} from '../services/records/src/repository.mjs';
import {runMinutesPipeline} from '../services/records/src/minutes-pipeline.mjs';
import {generateMinutes} from '../services/records/src/providers.mjs';
import {completeModelJson} from '../services/records/src/llm.mjs';

const ref=s=>({segmentId:s.id,revision:s.revision});
const segment=i=>({id:`s${i}`,revision:1,sourceId:'mic',speakerId:'person-1',speaker:'说话人1',startMs:i*300001,endMs:i*300001+1000,text:`对象编号${i}，颜色蓝色，材质金属。`});
const minutes=(title,snapshot)=>({title,sections:[{heading:title,items:snapshot.map(s=>({text:s.text,evidence:[ref(s)]}))}],topics:[],actions:[],evidenceSnapshot:snapshot,revision:1,transcriptRevision:1});

test('a partial refresh must not hide already displayed complete minutes',async()=>{
 const compiled=await build({entryPoints:['apps/web/src/components/Minutes.tsx'],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/jsx-runtime','react-dom']});
 const module={exports:{}};vm.runInNewContext(compiled.outputFiles[0].text,{module,exports:module.exports,require:createRequire(resolve('package.json')),console,matchMedia:()=>({matches:false})});
 const r=createRecord('fixture');r.capture='recording';r.transcriptRevision=2;r.segments=[segment(0),segment(1),segment(2)];
 r.liveMinutes=minutes('已有完整纪要',r.segments.slice(0,2));
 r.jobs=[{id:'next',scope:'live',status:'running',transcriptRevision:2,progress:{completed:1,total:8},partialMinutes:minutes('本轮第一小段',r.segments.slice(2))}];
 const html=renderToStaticMarkup(React.createElement(module.exports.MinutesPanel,{record:r,busy:false,onClose(){},generate:async()=>{},edit:async()=>true,cite(){},automate:async()=>{},inline:true}));
 assert.match(html,/对象编号0/,'a first partial window cannot replace the full document');
 assert.match(html,/对象编号1/);
});

test('synthesis cannot silently discard represented source facts after all windows finish',async()=>{
 const root=await mkdtemp(join(tmpdir(),'minutes-complete-')),repo=await createRepository({root});
 try{
  const r=createRecord('fixture');r.capture='completed';r.transcriptRevision=1;r.segments=Array.from({length:12},(_,i)=>({...segment(i),text:segment(i).text+'背景描述'.repeat(200)}));await repo.insert(r);let claim;
  await repo.change(r.id,value=>{const j=requestMinutes(value,{scope:'final'});j.status='running';j.fence=j.id;claim=structuredClone(j);});
  const result=await runMinutesPipeline(repo,r.id,claim,{RECORD_MINUTES_INPUT_BYTES:4096},async j=>{
   if(j.summaries)return {...j.summaries.at(-1),title:'高度压缩的最终摘要'};
   const sources=j.snapshot.filter(s=>!s.contextOnly);return {title:'分段纪要',sections:[{heading:'设备属性',items:sources.map(s=>({text:s.text.split('背景描述')[0],evidence:[ref(s)]}))}],actions:[]};
  });
  const ids=new Set(result.sections.flatMap(s=>s.items.flatMap(i=>i.evidence.map(e=>e.segmentId))));
  assert.equal(ids.size,12,'processed windows must not be confused with retained meeting content');
 }finally{await repo.close();await rm(root,{recursive:true,force:true});}
});

test('local extraction does not silently stop after the first twelve ordinary facts',async()=>{
 const snapshot=Array.from({length:32},(_,i)=>segment(i));const result=await generateMinutes({mode:'extractive',snapshot},{});
 const ids=new Set(result.sections.flatMap(s=>s.items.flatMap(i=>i.evidence.map(e=>e.segmentId))));assert.equal(ids.size,32);
});

test('buffered Chat Completions with length termination cannot commit valid-looking partial JSON',async()=>{
 const fetch=globalThis.fetch;globalThis.fetch=async()=>Response.json({choices:[{finish_reason:'length',message:{content:'{"title":"仅一小部分","sections":[],"actions":[]}'}}]});
 try{await assert.rejects(completeModelJson([{role:'user',content:'fixture'}],{LLM_PROTOCOL:'chat-completions',LLM_API_URL:'https://example.test/v1/chat/completions',LLM_API_KEY:'fixture-only',LLM_MODEL:'fixture'}),{code:'llm_stream_incomplete'});}
 finally{globalThis.fetch=fetch;}
});


async function savedPipeline(count,generate,mode='model',textFor){
 const root=await mkdtemp(join(tmpdir(),'minutes-kept-')),repo=await createRepository({root});
 try{
  const r=createRecord('fixture');r.capture='completed';r.transcriptRevision=1;r.segments=Array.from({length:count},(_,i)=>({...segment(i),text:textFor?textFor(i):segment(i).text+'背景描述'.repeat(200)}));await repo.insert(r);let claim;
  await repo.change(r.id,value=>{const j=requestMinutes(value,{scope:'final',mode});j.status='running';j.fence=j.id;claim=structuredClone(j);});
  const result=await runMinutesPipeline(repo,r.id,claim,{RECORD_MINUTES_INPUT_BYTES:4096},generate);
  await repo.change(r.id,value=>commitMinutes(value,claim.id,result,claim.fence));
  return (await repo.get(r.id)).minutes;
 }finally{await repo.close();await rm(root,{recursive:true,force:true});}
}

test('citing all inputs in one vague summary does not discard their individual attributes',async()=>{
 const result=await savedPipeline(12,async j=>j.summaries?{title:'概要',sections:[{heading:'结论',items:[{text:'会议讨论了设备。',evidence:j.summaries.flatMap(m=>m.sections.flatMap(s=>s.items.flatMap(i=>i.evidence)))}]}],actions:[]}:{title:'完整分段',sections:[{heading:'属性',items:j.snapshot.filter(s=>!s.contextOnly).flatMap(s=>['颜色','材质','位置'].map((field,index)=>({text:`${s.id}的${field}是属性${index}。`,evidence:[ref(s)]})))}],actions:[]});
 const body=result.sections.flatMap(s=>s.items).map(i=>i.text).join('\n');
 for(let i=0;i<12;i++)for(const field of ['颜色','材质','位置'])assert.ok(body.includes(`s${i}的${field}`));
 assert.equal(result.evidenceSnapshot.length,12);
});

test('more than twenty retained sections commit without relaxing final action limits',async()=>{
 const result=await savedPipeline(12,async j=>j.summaries?j.summaries.at(-1):{title:'完整分段',sections:j.snapshot.filter(s=>!s.contextOnly).flatMap(s=>Array.from({length:3},(_,i)=>({heading:`${s.id}议题${i}`,items:[{text:`${s.id}独立事实${i}`,evidence:[ref(s)]}]}))),actions:[]});
 assert.ok(result.sections.length>20);assert.equal(result.sections.flatMap(s=>s.items).length,36);
 const item={text:'测试行动',owner:null,due:null,evidence:[ref(segment(0))]};
 assert.throws(()=>validateMinutes({...minutes('test',[segment(0)]),actions:Array.from({length:101},()=>item)},[segment(0)],undefined,{newEvidenceOnly:true,maxSections:650}),{code:'invalid_actions'});
});

test('historical decisions stay visible as process records without becoming final decisions',async()=>{
 const result=await savedPipeline(2,async j=>{
  if(j.summaries)return {title:'最终安排',sections:[{heading:'最终结论',items:[{text:'取消周五上线，日期待复评确认。',evidence:j.summaries.at(-1).sections[0].items[0].evidence}]}],actions:[]};
  const source=j.snapshot.find(s=>!s.contextOnly),first=source.id==='s0';
  const item={text:first?'早先提议周五上线。':'取消周五上线，日期待复评确认。',kind:first?'decision':'question',label:first?'已明确':'待确认',evidence:[ref(source)]};
  return {title:'分段',sections:[{heading:'已达成决定',items:[item]}],decisions:first?[item]:[],actions:[]};
 });
 assert.deepEqual(result.decisions,[]);assert.deepEqual(result.actions,[]);
 const history=result.sections.filter(s=>s.heading.startsWith('讨论过程')).flatMap(s=>s.items);
 const old=history.find(i=>i.text.endsWith('早先提议周五上线。'));assert.ok(old);assert.equal(old.kind,'fact');assert.equal(old.label,'过程记录');assert.equal(old.topicId,undefined);
});

test('rule matches do not suppress unrelated ordinary local facts',async()=>{
 const snapshot=[...Array.from({length:32},(_,i)=>segment(i)),{...segment(32),text:'下一步由李工负责提交验收材料。'}];
 const result=await generateMinutes({mode:'extractive',snapshot},{});
 const ids=new Set(result.sections.flatMap(s=>s.items.flatMap(i=>i.evidence.map(e=>e.segmentId))));assert.equal(ids.size,33);
});

test('local multiwindow synthesis preserves every source without invoking a text model',async()=>{
 const result=await savedPipeline(12,generateMinutes,'extractive');
 const ids=new Set(result.sections.flatMap(s=>s.items.flatMap(i=>i.evidence.map(e=>e.segmentId))));assert.equal(ids.size,12);assert.equal(result.method,'extractive');
});

test('model-supplied coverage cannot authorize extra sections at commit',()=>{
 const r=createRecord('fixture');r.capture='completed';r.transcriptRevision=1;r.segments=[segment(0)];
 const job=requestMinutes(r);job.status='running';job.fence=job.id;
 const result={title:'伪造容量',sections:Array.from({length:21},()=>({heading:'测试',items:[{text:'测试',evidence:[ref(segment(0))]}]})),actions:[],coverage:{windows:512},maxSections:25650};
 assert.throws(()=>commitMinutes(r,job.id,result,job.fence),{code:'invalid_minutes_schema'});
});

test('retained cached windows can repair an old short result without another paid model call',async()=>{
 const root=await mkdtemp(join(tmpdir(),'minutes-repair-')),repo=await createRepository({root});
 try{
  const r=createRecord('fixture');r.capture='completed';r.transcriptRevision=1;r.segments=Array.from({length:12},(_,i)=>({...segment(i),text:segment(i).text+'背景描述'.repeat(200)}));await repo.insert(r);
  const claim=async()=>{let claim;await repo.change(r.id,value=>{const j=requestMinutes(value,{scope:'final',retry:true});j.status='running';j.fence=j.id;claim=structuredClone(j);});return claim;};
  const config={RECORD_MINUTES_INPUT_BYTES:4096};const first=await claim();
  const complete=await runMinutesPipeline(repo,r.id,first,config,async j=>j.summaries?j.summaries.at(-1):{title:'分段',sections:[{heading:'属性',items:j.snapshot.filter(s=>!s.contextOnly).map(s=>({text:s.text.split('背景描述')[0],evidence:[ref(s)]}))}],actions:[]});
  await repo.change(r.id,value=>commitMinutes(value,first.id,{...complete,sections:complete.sections.slice(0,1)},first.fence));
  const next=await claim(),repaired=await runMinutesPipeline(repo,r.id,next,config,async()=>assert.fail('already validated cached windows must be reused'));
  await repo.change(r.id,value=>commitMinutes(value,next.id,repaired,next.fence));const saved=await repo.get(r.id);
  assert.equal(new Set(saved.minutes.sections.flatMap(s=>s.items.flatMap(i=>i.evidence.map(e=>e.segmentId)))).size,12);
  assert.equal(repaired.coverage.calls,0);assert.ok(repaired.coverage.reused>0);assert.equal(saved.minutesRevision,2);
 }finally{await repo.close();await rm(root,{recursive:true,force:true});}
});


test('non-prose leaf details remain readable without reviving their action state',async()=>{
 const result=await savedPipeline(2,async j=>{
  if(j.summaries)return {title:'最终',sections:[{heading:'结论',items:[{text:'设备清单仍需跟进。',evidence:j.summaries.at(-1).actions[0].evidence}]}],actions:[],decisions:[]};
  const source=j.snapshot.find(s=>!s.contextOnly),evidence=[ref(source)];
    return {title:'记录',sections:[{heading:'概览',items:[]}],topics:[{id:'data',title:'设备属性',summary:'清单和属性',evidence}],actions:[{text:'提交设备清单',owner:'李工',due:'周五',evidence}],tables:[{title:'设备属性',topicId:'data',columns:['设备','颜色'],rows:[{cells:[`设备${source.id.slice(1)}`,'蓝色'],evidence}]}],visuals:[{kind:'timeline',title:'提交节点',entries:[{label:'周五',text:'提交设备清单',evidence},{label:'周六',text:'复核清单',evidence}]}]};
  },'model',i=>`李工负责周五提交设备清单，周六复核清单，设备${i}颜色蓝色。`+'.'.repeat(2600));
 const body=result.sections.flatMap(s=>s.items).map(i=>i.text).join('\n');
 for(const text of ['负责人：李工','时间：周五','颜色：蓝色','周五：提交设备清单'])assert.ok(body.includes(text),text);
  assert.ok(body.includes('设备：设备0；颜色：蓝色'));
 assert.deepEqual(result.actions,[]);
});

test('equal facts under different project headings retain their original context',async()=>{
  const result=await savedPipeline(2,async job=>{
    const evidence=job.summaries?job.summaries[0].sections[0].items[0].evidence:[ref(job.snapshot.find(source=>!source.contextOnly))];
    return job.summaries?{title:'概要',sections:[{heading:'概要',items:[{text:'两个项目已讨论。',evidence}]}],actions:[]}:{title:'分段',sections:['项目A','项目B'].map(heading=>({heading,items:[{text:'颜色蓝色',evidence},{label:'负责人',text:'李工',evidence}]})),actions:[]};
  });
  for(const name of ['项目A','项目B']){
    const section=result.sections.find(section=>section.heading===`讨论过程 · ${name}`);
    assert.ok(section);
    assert.ok(section.items.some(item=>item.text==='颜色蓝色'));
    assert.ok(section.items.some(item=>item.text==='负责人：李工'));
  }
});

test('facts that occur only in leaf topic summaries remain in the complete document',async()=>{
  const result=await savedPipeline(2,async job=>{
    const evidence=job.summaries?job.summaries[0].topics[0].evidence:[ref(job.snapshot.find(source=>!source.contextOnly))];
    return job.summaries?{title:'概要',sections:[{heading:'概要',items:[{text:'这里只作高度概括',evidence}]}],actions:[]}:{title:'分段',sections:[{heading:'讨论',items:[]}],topics:[{id:'device',title:'设备属性',summary:'设备颜色蓝色、材质金属',evidence}],actions:[]};
  });
  assert.ok(result.sections.find(section=>section.heading==='讨论过程 · 设备属性')?.items.some(item=>item.text==='设备颜色蓝色、材质金属'));
});

test('stopping preserves validated partial minutes with an expanded complete baseline',()=>{
  const record=createRecord('fixture'),old=segment(0),next=segment(1);
  record.capture='recording';record.transcriptRevision=2;record.segments=[old,next];
  record.liveMinutes={...minutes('完整纪要',[old]),notesRevision:record.notesRevision,template:'meeting',sections:Array.from({length:41},(_,i)=>({heading:`议题${i}`,items:[{text:`已整理事实${i}`,evidence:[ref(old)]}]}))};
  const job=requestMinutes(record,{scope:'live'});job.status='running';job.fence=job.id;
  job.progress={completed:1,total:1};job.manifest={windows:[{key:'next'}]};
  job.partialMinutes={...minutes('追加纪要',[old,next]),sections:[...record.liveMinutes.sections,{heading:'新增内容',items:[{text:'新事实',evidence:[ref(next)]}]}]};
  seal(record,[]);
  assert.equal(record.liveMinutes.sections.length,42);
  assert.equal(record.jobs.find(j=>j.id===job.id).status,'cancelled');
});

test('a single new live window extends a complete baseline beyond twenty sections',()=>{
  const record=createRecord('fixture'),old=segment(0),next=segment(1);
  record.capture='recording';record.transcriptRevision=2;record.segments=[old,next];
  record.liveMinutes={...minutes('完整纪要',[old]),notesRevision:record.notesRevision,template:'meeting',sections:Array.from({length:41},(_,i)=>({heading:`议题${i}`,items:[{text:`已整理事实${i}`,evidence:[ref(old)]}]}))};
  const job=requestMinutes(record,{scope:'live'});job.status='running';job.fence=job.id;job.manifest={windows:[{key:'next'}]};
  commitMinutes(record,job.id,minutes('追加纪要',[next]),job.fence);
  assert.equal(record.liveMinutes.sections.length,42);
});

test('stopping after a notes change cannot replace the complete document with the first window',()=>{
  for(const count of [1,2]){
  const record=createRecord('fixture'),sources=[segment(0),segment(1)];
  sources.splice(count);
  record.capture='recording';record.transcriptRevision=2;record.segments=sources;
  record.liveMinutes={...minutes('完整纪要',sources),notesRevision:0,template:'meeting'};
  record.notesRevision=1;
  const job=requestMinutes(record,{scope:'live'});job.status='running';job.fence=job.id;
  job.progress={completed:1,total:2};job.manifest={windows:[{key:'first'},{key:'second'}]};
  job.partialMinutes=minutes('第一窗',[sources[0]]);
  job.partialMinutes.sections[0].items=[{text:'颜色蓝色',evidence:[ref(sources[0])]}];
  seal(record,[]);
  assert.equal(record.liveMinutes.title,'完整纪要');
  assert.equal(record.liveMinutes.evidenceSnapshot.length,count);
  assert.ok(record.liveMinutes.sections[0].items[0].text.includes('材质金属'));
  }
});

test('local multiwindow extraction keeps all facts with bounded current action candidates',async()=>{
  const result=await savedPipeline(180,job=>generateMinutes(job,{}),'extractive',i=>`李工负责周五提交设备${i}清单。`);
  assert.equal(new Set(result.sections.flatMap(section=>section.items.flatMap(item=>item.evidence.map(ref=>ref.segmentId)))).size,180);
  assert.equal(result.actions.length,50);
});

test('a cited leaf topic title survives when its allowed summary is empty',async()=>{
  const result=await savedPipeline(2,async job=>{
    const evidence=job.summaries?job.summaries[0].topics[0].evidence:[ref(job.snapshot.find(source=>!source.contextOnly))];
    return job.summaries?{title:'概要',sections:[{heading:'概要',items:[{text:'设备已经讨论',evidence}]}],actions:[]}:{title:'分段',sections:[{heading:'讨论',items:[]}],topics:[{id:'device',title:'设备颜色蓝色、材质金属',summary:'',evidence}],actions:[]};
  });
  assert.ok(result.sections.some(section=>section.items.some(item=>item.text==='设备颜色蓝色、材质金属')));
});

test('long retained headings keep their complete project context when the display prefix is truncated',async()=>{
  const headings=[...['方案A','方案B'].map(name=>'项目背景'.repeat(49)+name),'𠮷'.repeat(99)+'甲'];
  const result=await savedPipeline(2,async job=>{
    const evidence=job.summaries?job.summaries[0].sections[0].items[0].evidence:[ref(job.snapshot.find(source=>!source.contextOnly))];
    return job.summaries?{title:'概要',sections:[{heading:'概要',items:[{text:'项目已经讨论',evidence}]}],actions:[]}:{title:'分段',sections:headings.map(heading=>({heading,items:[{text:'颜色蓝色',evidence}]})),actions:[]};
  });
  const body=result.sections.flatMap(section=>section.items).map(item=>item.text).join('\n');
  for(const heading of headings)assert.ok(body.includes(heading));
  assert.ok(result.sections.every(section=>section.heading.isWellFormed()));
});
