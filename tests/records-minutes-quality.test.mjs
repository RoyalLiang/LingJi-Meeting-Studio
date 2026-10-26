import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { validateMinutes, createRecord, requestMinutes, commitMinutes } from '../packages/records/src/record.mjs';
import { mergeLiveMinutes, minutesContext } from '../packages/records/src/live-minutes.mjs';
import { sharedMinutes } from '../packages/records/src/shared-content.mjs';
import { minutesQualityInstructions, groundSpeakerSummaries, manualMinutesContent, orderMinutesTimelines } from '../packages/records/src/minutes-quality.mjs';
import { audioMinutesInstructions } from '../services/records/src/audio-minutes.mjs';
import { exportMinutesMarkdown } from '../services/records/src/markdown-export.mjs';
import { createRepository } from '../services/records/src/repository.mjs';
import { runMinutesPipeline } from '../services/records/src/minutes-pipeline.mjs';

const snapshot = [
  {id:'schedule',revision:1,text:'周五先完成测试，下周一发布候选版。',sourceId:'mic',startMs:0,endMs:1000},
  {id:'budget-a',revision:2,text:'甲方案预算100万元。',sourceId:'mic',startMs:130000,endMs:131000},
  {id:'budget-b',revision:1,text:'乙方案预算80万元。',sourceId:'mic',startMs:260000,endMs:261000},
];
const ref = index => ({segmentId:snapshot[index].id,revision:snapshot[index].revision});
const fixture = () => ({title:'方案评审',sections:[{heading:'发布安排',items:[{text:'先测试，再发布。',label:'推进顺序',topicId:'release',evidence:[ref(0)]}]}],actions:[],topics:[{id:'release',title:'发布安排',summary:'发布时间取决于测试完成。',evidence:[ref(0)]},{id:'budget',title:'预算对比',summary:'两方案预算存在差异。',evidence:[ref(1),ref(2)]}],highlights:[{text:'候选版安排在下周一发布。',evidence:[ref(0)]}],visuals:[{kind:'timeline',topicId:'release',title:'推进节点',entries:[{label:'周五',text:'完成测试',evidence:[ref(0)]},{label:'下周一',text:'发布候选版',evidence:[ref(0)]}]},{kind:'bar',topicId:'budget',title:'方案预算',unit:'万元',entries:[{label:'甲方案',valueText:'100',quote:'甲方案预算100万元',evidence:[ref(1)]},{label:'乙方案',valueText:'80',quote:'乙方案预算80万元',evidence:[ref(2)]}]}],evidenceSnapshot:structuredClone(snapshot)});
const compiled = await build({entryPoints:['apps/web/src/components/MinutesViews.tsx'],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/jsx-runtime','react-dom']});
const module = {exports:{}};
vm.runInNewContext(compiled.outputFiles[0].text,{module,exports:module.exports,require:createRequire(resolve('package.json')),console});
const render = minutes => renderToStaticMarkup(React.createElement(module.exports.MinutesTree,{minutes,cite:()=>{}}));
test('the first streamed minutes are visible without opening advanced settings and remain marked provisional',async()=>{
 const compiledPanel=await build({entryPoints:['apps/web/src/components/Minutes.tsx'],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/jsx-runtime','react-dom']});
 const panel={exports:{}};
 vm.runInNewContext(compiledPanel.outputFiles[0].text,{module:panel,exports:panel.exports,require:createRequire(resolve('package.json')),console,matchMedia:()=>({matches:false})});
 const record=createRecord('fixture');record.capture='recording';record.transcriptRevision=1;
 record.jobs=[{id:'streaming',scope:'live',status:'running',transcriptRevision:1,preview:[{kind:'item',text:'先排查依赖，再确认上线时间。'}]}];
 const props={record,busy:false,onClose(){},generate:async()=>{},edit:async()=>true,cite(){},automate:async()=>{},inline:true};
 const html=renderToStaticMarkup(React.createElement(panel.exports.MinutesPanel,props));
 assert.match(html,/先排查依赖，再确认上线时间/);assert.match(html,/实时草稿/);assert.match(html,/引用将在完整结果校验后显示/);assert.doesNotMatch(html,/class="empty"/,"first draft must replace the large empty placeholder");
 record.minutes={...fixture(),edited:true};
 const protectedHtml=renderToStaticMarkup(React.createElement(panel.exports.MinutesPanel,props));
 assert.doesNotMatch(protectedHtml,/先排查依赖，再确认上线时间/);
});

test('project minutes render sourced highlights, timeline and actual same-unit numbers',()=>{
  const value=fixture();assert.equal(validateMinutes(value,snapshot),value);
  const html=render(value);
  for(const text of ['重点速览','推进顺序','周五','下周一','方案预算','单位：','100','80','原文 · '])assert.ok(html.includes(text),text);
  assert.equal(html.split('class="minutes-visual is-timeline"').length-1,1);
  assert.equal(html.split('class="minutes-visual is-bar"').length-1,1);
  assert.doesNotMatch(html,/纪要条目分布|主题引用覆盖|2026/);
});

test('quality schema rejects fake dates, computed numbers, stale evidence, units and ambiguous quotes',()=>{
  for(const mutate of [
    m=>m.visuals[0].entries[0].label='2026年10月23日',
    m=>m.visuals[1].entries[0].valueText='20',
    m=>m.visuals[1].entries[0].evidence=[{segmentId:'budget-a',revision:1}],
    m=>m.visuals[1].unit='元',
    m=>m.visuals[1].entries[0].quote='乙方案预算100万元',
    m=>m.visuals[1].entries[0].label='不存在的方案',
    m=>m.visuals[1].topicId='unknown',
    m=>m.visuals[1].entries[0].valueText='1e2',
    m=>m.visuals[0].entries=[m.visuals[0].entries[0]],
  ]){const m=fixture();mutate(m);assert.throws(()=>validateMinutes(m,snapshot),{code:'invalid_minutes_visuals'});}
  const wrong=fixture();wrong.sections[0].items[0].topicId='missing';assert.throws(()=>validateMinutes(wrong,snapshot),{code:'invalid_minutes_structure'});
  const source=[{...snapshot[0],text:'甲方案100万元，乙方案80万元'}],m=fixture();m.visuals=[{...m.visuals[1],entries:[{label:'甲方案',valueText:'80',quote:source[0].text,evidence:[ref(0)]},{label:'乙方案',valueText:'80',quote:'乙方案80万元',evidence:[ref(0)]}]}];
  assert.throws(()=>validateMinutes(m,[...source,...snapshot.slice(1)]),{code:'invalid_minutes_visuals'});
});

test('bar values handle negative, zero, decimals and comma separators without fabricated calculations',()=>{
  const m=fixture();m.visuals=[m.visuals[1]];
  const values=['-1,200.5','0'];
  const sources=structuredClone(snapshot);
  m.visuals[0].entries.forEach((entry,i)=>{entry.valueText=values[i];entry.quote=`${entry.label}预算${values[i]}万元`;sources[i+1].text=entry.quote;});
  validateMinutes(m,sources);const html=render(m);
  assert.match(html,/-1,200.5/);assert.doesNotMatch(html,/NaN|Infinity|width:-/);
});

test('interviews, lessons and legacy prose do not get forced charts, dates or actions',()=>{
  for(const title of ['访谈观点与分歧','培训中的核心概念','旧版文字纪要']){
    const m={title,sections:[{heading:'核心观点',items:[{text:'应区分观察与推测。',evidence:[ref(0)]}]}],actions:[]};
    validateMinutes(m,snapshot);const html=render(m);
    assert.match(html,/应区分观察与推测/);assert.doesNotMatch(html,/minutes-visual is-|待确认|行动候选汇总|重点速览/);
  }
});

test('explicit topic membership separates facts sharing the same transcript and keeps important risks visible',()=>{
  const m=fixture();m.topics[1].evidence=[ref(0)];m.visuals=[];
  m.sections[0].items=Array.from({length:5},(_,i)=>({text:`讨论细节${i}`,topicId:'release',evidence:[ref(0)]}));
  m.sections[0].items.push({text:'预算仍有缺口',kind:'risk',label:'预算风险',topicId:'budget',evidence:[ref(0)]});
  const html=render(m),branches=html.split('class="minutes-branch"');
  assert.doesNotMatch(branches[1],/预算仍有缺口/);assert.match(branches[2],/预算仍有缺口/);
  assert.match(branches[1],/<details class="branch-detail"><summary>展开 3 条讨论细节/);
  assert.doesNotMatch(branches[2],/<details/);
});

test('live merge, bounded deduplication context and share/export preserve rich evidence without runtime secrets',()=>{
  const first=fixture(),next=fixture();next.highlights=[{text:'新增预算核对事项',evidence:[ref(1)]}];
  const merged=mergeLiveMinutes(first,next,snapshot);validateMinutes(merged,merged.evidenceSnapshot);
  assert.equal(merged.visuals.length,2);assert.equal(merged.visuals[0].entries.length,2);assert.equal(merged.highlights[0].text,'新增预算核对事项');
  merged.notesRevision=0;const context=minutesContext(merged);assert.ok(context.recentPoints.length);assert.ok(Buffer.byteLength(JSON.stringify(context))<=12000);
  merged.providerSecret='do-not-share';merged.visuals[0].providerSecret='do-not-share';merged.visuals[0].entries[0].raw='do-not-share';
  const shared=sharedMinutes(merged);assert.equal(shared.sections[0].items[0].topicId,'release');assert.equal(shared.highlights.length,2);assert.equal(shared.evidenceSnapshot.length,3);assert.doesNotMatch(JSON.stringify(shared),/do-not-share/);
  const md=exportMinutesMarkdown({title:'合成验收',capture:'completed',minutes:merged});
  for(const text of ['重点速览','推进节点','下周一','方案预算','100','万元'])assert.ok(md.includes(text),text);
  assert.doesNotMatch(md,/do-not-share/);
});

test('all audio and text modes share the content selection rules',()=>{
  assert.ok(audioMinutesInstructions.includes(minutesQualityInstructions));
  for(const text of ['闲聊','不推测姓名','不重复','访谈','valueText','topicId'])assert.ok(minutesQualityInstructions.includes(text),text);
});

test('hierarchical synthesis validates charts against frozen raw evidence and bounded prompt excerpts',async()=>{
  const root=await mkdtemp(join(tmpdir(),'minutes-quality-')),repo=await createRepository({root,databaseUrl:''});
  try{
    const record=createRecord('owner');Object.assign(record,{capture:'completed',transcription:'completed',transcriptRevision:1,segments:structuredClone(snapshot)});await repo.insert(record);
    let claim;await repo.change(record.id,r=>{const job=requestMinutes(r,{scope:'final',mode:'model'});job.status='running';job.fence='quality-fence';job.lease=Date.now()+300000;claim=structuredClone(job);});
    let syntheses=0;
    const result=await runMinutesPipeline(repo,record.id,claim,{LLM_MODEL:'fixture',LLM_API_URL:'http://fixture.invalid'},async job=>{
      if(job.stage==='synthesis'){
        syntheses++;assert.ok(job.snapshot.some(s=>typeof s.text==='string'));assert.ok(Buffer.byteLength(JSON.stringify(job.snapshot))<=96000);assert.ok(job.validationSnapshot.every(s=>typeof s.text==='string'));
        return {...fixture(),usageTokens:1};
      }
      return {title:'窗口',sections:[{heading:'讨论',items:job.snapshot.filter(s=>!s.contextOnly).map(s=>({text:s.text,evidence:[{segmentId:s.id,revision:s.revision}]}))}],actions:[],usageTokens:1};
    });
    assert.ok(syntheses>0);await repo.change(record.id,r=>commitMinutes(r,claim.id,result,claim.fence));
    assert.equal((await repo.get(record.id)).minutes.visuals.length,2);
  }finally{await repo.close();await rm(root,{recursive:true,force:true});}
});


test('timeline order follows cited mention positions rather than guessing relative-date chronology',()=>{
  const m=fixture();m.visuals[0].entries.reverse();orderMinutesTimelines(m,snapshot);
  assert.deepEqual(m.visuals[0].entries.map(entry=>entry.label),['周五','下周一']);
  const result=mergeLiveMinutes(fixture(),m,snapshot);assert.deepEqual(result.visuals[0].entries.map(entry=>entry.label),['周五','下周一']);
});

test('unknown speakers cannot acquire model-invented identities and manual edits discard stale derived labels',()=>{
  const m=fixture();m.speakerSummaries=[{speaker:'总经理',speakerId:null,summary:'发布',evidence:[ref(0)]}];
  groundSpeakerSummaries(m,snapshot);assert.deepEqual(m.speakerSummaries,[]);
  const before=JSON.stringify(m),manual=manualMinutesContent(m);
  assert.equal(manual.sections[0].items[0].text,m.sections[0].items[0].text);assert.equal(manual.sections[0].items[0].topicId,undefined);assert.equal(manual.visuals,undefined);assert.equal(manual.highlights,undefined);assert.equal(JSON.stringify(m),before);
});

test('direct-audio synthesis paths validate rich content against raw frozen evidence, not compact metadata',async()=>{
  const {generateDoubaoAudioMinutes}=await import('../services/records/src/doubao-audio-minutes.mjs');
  const {generateRealtimeMinutes}=await import('../services/records/src/realtime-minutes.mjs');
  const record={generation:1,realtimeAudioConsent:true,sources:[],chunks:[]},repo={get:async()=>record};
  const job={generation:1,modelVersion:'default',stage:'synthesis',scope:'final',snapshot:snapshot.map(({text:_text,...segment})=>segment),validationSnapshot:snapshot};
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(fixture())}]}]}),{headers:{'Content-Type':'application/json'}});
    const value=await generateDoubaoAudioMinutes(repo,'synthetic',job,{LLM_PROTOCOL:'responses',LLM_API_URL:'https://synthetic.invalid',LLM_API_KEY:'synthetic-key',LLM_MODEL:'synthetic'});
    assert.equal(value.visuals.length,2);
  } finally {globalThis.fetch=original;}
  const value=await generateRealtimeMinutes(repo,'synthetic',job,{OPENAI_REALTIME_URL:'wss://synthetic.invalid',OPENAI_REALTIME_MODEL:'synthetic',OPENAI_REALTIME_API_KEY:'synthetic-key'},{},()=>({ready:Promise.resolve(),respond:async()=>fixture(),close:()=>{}}));
  assert.equal(value.visuals.length,2);
});


test('live alias normalization covers prose, decisions and actions when the model changes a same-title topic ID',()=>{
  const before=fixture(),incoming=fixture();
  before.actions=[];before.decisions=[];
  incoming.topics[0].id='window-release';incoming.sections[0].items[0].topicId='window-release';incoming.visuals[0].topicId='window-release';
  incoming.actions=[{text:'完成测试',topicId:'window-release',owner:null,due:'周五',evidence:[ref(0)]}];
  incoming.decisions=[{text:'下周一发布',topicId:'window-release',evidence:[ref(0)]}];
  validateMinutes(before,snapshot);validateMinutes(incoming,snapshot);
  const merged=mergeLiveMinutes(before,incoming,snapshot);validateMinutes(merged,merged.evidenceSnapshot);
  for (const item of [...merged.sections.flatMap(section=>section.items),...merged.actions,...merged.decisions])assert.equal(item.topicId,'release');
  assert.equal(merged.visuals[0].topicId,'release');
});


test('a repeated object cannot fabricate a two-object numeric comparison',()=>{
  const m=fixture();m.visuals[1].entries[1]=structuredClone(m.visuals[1].entries[0]);
  assert.throws(()=>validateMinutes(m,snapshot),{code:'invalid_minutes_visuals'});
});


test('explicit regeneration after upgrade queues the new content policy instead of reusing completed v5 minutes',()=>{
  const record=createRecord('synthetic',{autoMinutes:false});Object.assign(record,{capture:'completed',transcriptRevision:1,segments:structuredClone(snapshot)});
  const legacy=requestMinutes(record,{mode:'model'});legacy.status='completed';legacy.key=legacy.key.replace(':v6:',':v5:');
  record.minutes={...fixture(),edited:false};const oldMinutes=JSON.stringify(record.minutes);
  const next=requestMinutes(record,{mode:'model'});assert.notEqual(next.id,legacy.id);assert.equal(next.status,'queued');
  assert.equal(requestMinutes(record,{mode:'model'}).id,next.id);assert.equal(JSON.stringify(record.minutes),oldMinutes);
});
