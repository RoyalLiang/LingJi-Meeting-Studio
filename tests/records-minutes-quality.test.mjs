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
import { minutesQualityInstructions, groundSpeakerSummaries, manualMinutesContent, orderMinutesTimelines, minutesTextChunks, minutesActionText } from '../packages/records/src/minutes-quality.mjs';
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
test('validated partial minutes remain visible by default while unchecked generation stays hidden',async()=>{
 const compiledPanel=await build({entryPoints:['apps/web/src/components/Minutes.tsx'],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/jsx-runtime','react-dom']});
 const panel={exports:{}};
 vm.runInNewContext(compiledPanel.outputFiles[0].text,{module:panel,exports:panel.exports,require:createRequire(resolve('package.json')),console,matchMedia:()=>({matches:false})});
 const record=createRecord('fixture');record.capture='recording';record.transcriptRevision=1;
 record.jobs=[{id:'streaming',scope:'live',status:'running',transcriptRevision:1,preview:[{kind:'item',text:'先排查依赖，再确认上线时间。'}]}];
 const props={record,busy:false,onClose(){},generate:async()=>{},edit:async()=>true,cite(){},automate:async()=>{},inline:true};
 const html=renderToStaticMarkup(React.createElement(panel.exports.MinutesPanel,props));
 assert.doesNotMatch(html,/先排查依赖，再确认上线时间|实时草稿/);
 record.jobs[0].partialMinutes=fixture();
 const partial=renderToStaticMarkup(React.createElement(panel.exports.MinutesPanel,props));assert.match(partial,/方案评审/);assert.doesNotMatch(partial,/class="empty"/,"validated partial replaces the empty placeholder");
 record.minutes={...fixture(),edited:true};
 const protectedHtml=renderToStaticMarkup(React.createElement(panel.exports.MinutesPanel,props));
 assert.doesNotMatch(protectedHtml,/先排查依赖，再确认上线时间/);
});

test('project minutes render sourced highlights, timeline and actual same-unit numbers',()=>{
  const value=fixture();assert.equal(validateMinutes(value,snapshot),value);
  const html=render(value);
  for(const text of ['重点速览','推进顺序','周五','下周一','方案预算','单位：','100','80'])assert.ok(html.includes(text),text);
  assert.doesNotMatch(html,/引用原文|citation-entry/);
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
  for(let i=0;i<5;i++)assert.match(branches[1],new RegExp(`讨论细节${i}`));assert.doesNotMatch(branches[1],/<details class="branch-detail"/);
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
    const record=createRecord('owner');Object.assign(record,{capture:'completed',transcription:'completed',transcriptRevision:1,segments:structuredClone(snapshot)});record.segments[1].startMs+=300000;record.segments[1].endMs+=300000;await repo.insert(record);
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
  assert.equal(manual.sections[0].items[0].text,`${m.sections[0].items[0].label}：${m.sections[0].items[0].text}`);assert.equal(manual.sections[0].items[0].topicId,undefined);assert.equal(manual.visuals,undefined);assert.equal(manual.highlights,undefined);assert.equal(JSON.stringify(m),before);
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

test('manual drafts retain rich-only facts as editable text and preserve explicit deletion',()=>{
  const before=fixture(),manual=manualMinutesContent(before);
  const body=manual.sections.flatMap(section=>section.items).map(item=>item.text).join('\n');
  for(const fact of ['甲方案','100万元','乙方案','80万元','周五','下周一'])assert.ok(body.includes(fact),fact);
  assert.deepEqual(manualMinutesContent(manual),manual);
  for(const section of manual.sections)section.items=section.items.filter(item=>!item.text.includes('100万元'));
  assert.ok(!manualMinutesContent(manual).sections.flatMap(section=>section.items).some(item=>item.text.includes('100万元')));
});

test('manual drafts keep withdrawal text without reviving action or decision candidates',()=>{
  const minutes=fixture(),evidence=[ref(0)];
  minutes.actions=[{text:'旧行动',owner:'李工',due:'周五',evidence,status:'withdrawn'}];
  minutes.decisions=[{text:'旧决定',evidence,status:'withdrawn'}];
  const manual=manualMinutesContent(minutes),body=manual.sections.flatMap(section=>section.items).map(item=>item.text).join('\n');
  assert.deepEqual(manual.actions,[]);assert.deepEqual(manual.decisions,[]);
  assert.ok(body.includes('已撤回'));assert.ok(body.includes('旧行动'));assert.ok(body.includes('旧决定'));
});

test('Markdown preserves item labels and uses the same numbered speaker annotations as the app',()=>{
  const sources=['张工','李工','王工'].map((speaker,index)=>({id:`voice-${index}`,revision:1,speakerId:`person-${index}`,speaker,startMs:index*1000,endMs:(index+1)*1000,text:`讨论设备${index}`}));
  const evidence=index=>[{segmentId:sources[index].id,revision:1}];
  const minutes={title:'编号核验',revision:1,transcriptRevision:1,sections:[{heading:'设备属性',items:['项目A','项目B'].map(label=>({text:'颜色蓝色',label,evidence:evidence(0)}))}],actions:[],speakerSummaries:sources.map((source,index)=>({speakerId:source.speakerId,speaker:source.speaker,summary:`讨论设备${index}`,evidence:evidence(index)})),evidenceSnapshot:sources};
  const record={title:'虚构会议',capture:'completed',segments:sources,speakers:sources.map(source=>({id:source.speakerId,label:source.speaker})),minutes};
  const before=JSON.stringify(record),markdown=exportMinutesMarkdown(record);
  for(const label of ['项目A','项目B','说话人1','说话人2','说话人3'])assert.ok(markdown.includes(label),label);
  assert.doesNotMatch(markdown,/张工|李工|王工/);assert.equal(JSON.stringify(record),before);
});

test('manual normalization splits full-length labelled paragraphs and preserves the per-section item limit',()=>{
  for(const count of [1,100]){
    const original={title:'长正文',sections:[{heading:'详细记录',items:Array.from({length:count},()=>({text:'甲'.repeat(7999),label:'负责人',status:'pending',evidence:[ref(0)]}))}],actions:[]};
    validateMinutes(original,snapshot);
    const manual=manualMinutesContent(original);
    assert.ok(manual.sections.every(section=>section.items.length<=100&&section.items.every(item=>item.text.length<8000)));
    validateMinutes(manual,snapshot,undefined,{aggregate:true});
    const text=manual.sections.flatMap(section=>section.items).map(item=>item.text).join('');
    assert.equal((text.match(/甲/g)||[]).length,count*7999);
    assert.equal((text.match(/待确认/g)||[]).length,count);
    assert.deepEqual(manualMinutesContent(manual),manual);
  }
});

test('manual text retains visible uncertainty and kind labels when no explicit label exists',()=>{
  for(const [kind,label] of [['question','待确认'],['risk','风险'],['decision','已明确'],['action','下一步']]){
    const minutes={title:'语义核验',sections:[{heading:'讨论',items:[{text:'周五上线',kind,evidence:[ref(0)]}]}],actions:[]};
    const manual=manualMinutesContent(minutes);
    assert.ok(manual.sections[0].items[0].text.includes(label));
    assert.deepEqual(manualMinutesContent(manual),manual);
  }
});

test('Markdown numbering uses frozen speaker identity after the current transcript revision changes',()=>{
  const frozen={id:'frozen-voice',revision:1,speakerId:'person-a',speaker:'',text:'周五上线待确认',startMs:0,endMs:1000};
  const current={...frozen,revision:2,speakerId:null,speaker:'',text:'修订后的原文'};
  const minutes={title:'冻结归属',revision:1,transcriptRevision:1,sections:[{heading:'讨论',items:[{text:frozen.text,evidence:[{segmentId:frozen.id,revision:1}]}]}],actions:[],evidenceSnapshot:[frozen]};
  const markdown=exportMinutesMarkdown({title:'归属测试',capture:'completed',minutes,segments:[current]});
  assert.ok(markdown.includes('说话人1'));assert.ok(!markdown.includes('未区分说话人'));
});

test('minute text chunks preserve non-BMP names at UTF-16 boundaries',()=>{
  const text='甲'.repeat(7899)+'𠮷'+'设备';
  const chunks=minutesTextChunks(text);
  assert.equal(chunks.join(''),text);assert.ok(chunks.every(chunk=>chunk.length<=7900&&chunk.isWellFormed()));
  assert.throws(()=>minutesTextChunks(text,0),/invalid_minutes_text_limit/);
});

test('canonical action fields remain independent of editable rich-only supplements',()=>{
  const text='甲'.repeat(2000),minutes={title:'行动状态',sections:[{heading:'讨论',items:[]}],actions:[{text,owner:null,due:null,evidence:[ref(0)],status:'pending',kind:'action'}]};
  validateMinutes(minutes,snapshot);
  const manual=manualMinutesContent(minutes);
  assert.equal(manual.actions[0].text,text);assert.equal(manual.actions[0].status,'pending');
  assert.equal(manual.sections.length,1);assert.equal(manual.sections[0].items.length,0);
  validateMinutes(manual,snapshot,undefined,{aggregate:true});
  assert.deepEqual(manualMinutesContent(manual),manual);
});

test('manual action context survives equal text, full length, and repeated normalization',()=>{
 const evidence=[ref(0)],topics=[{id:'project-a',title:'甲'.repeat(200),summary:'项目A',evidence}];
 const minutes={title:'独立行动',sections:[{heading:'概要',items:[]}],topics,actions:[
  {text:'提交报告',label:'项目A',kind:'action',owner:null,due:null,evidence},
  {text:'提交报告',label:'项目B',kind:'question',owner:null,due:null,evidence},
  {text:'乙'.repeat(8000),topicId:'project-a',label:'项目C',kind:'risk',owner:null,due:null,evidence}
 ]};
 validateMinutes(minutes,snapshot);
 const manual=manualMinutesContent(minutes);
 assert.equal(minutesActionText(minutes.actions[0],[{title:'无关联主题'}]),'项目A：提交报告');
 assert.equal(manual.actions[0].label,'项目A');assert.equal(manual.actions[1].kind,'question');
 assert.match(minutesActionText(manual.actions[1]),/待确认.*项目B.*提交报告/);
 assert.equal(manual.actions[2].text,minutes.actions[2].text);
 assert.match(minutesActionText(manual.actions[2]),/风险.*项目C/);
 assert.equal(manual.actions[2].label,topics[0].title+' · 项目C');
 validateMinutes(manual,snapshot,undefined,{aggregate:true});
 assert.deepEqual(manualMinutesContent(manual),manual);
 const markdown=exportMinutesMarkdown({capture:'completed',minutes:manual,segments:snapshot,speakers:[],notes:''});
 assert.match(markdown,/项目A.*提交报告/);assert.match(markdown,/待确认.*项目B.*提交报告/);
});
