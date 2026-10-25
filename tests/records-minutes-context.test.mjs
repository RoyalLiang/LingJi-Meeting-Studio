import test from 'node:test';
import assert from 'node:assert/strict';
import { liveInput, minutesContext, mergeLiveMinutes, minutesItemId } from '../packages/records/src/live-minutes.mjs';
import { requestMinutes, createRecord, validateMinutes } from '../packages/records/src/record.mjs';
import { ruleIntents } from '../packages/records/src/intents.mjs';
import { completeModelJson } from '../services/records/src/llm.mjs';
import { generateMinutes } from '../services/records/src/providers.mjs';
import { minutesInstructions, minutesSchema } from '../services/records/src/minutes-prompts.mjs';
import { evaluateMinutes } from '../scripts/evaluate-minutes.mjs';

const segment = (id, startMs, text) => ({id, revision:1, startMs, endMs:startMs+1000, text, sourceId:'mic', speakerId:'speaker-1', speaker:'张工'});
const ref = s => ({segmentId:s.id, revision:s.revision});
test('labelled synthetic intent cases run without cloud requests',async()=>{
  const report=await evaluateMinutes();assert.equal(report.cases,12);assert.equal(report.mode,'local-rules');assert.equal(report.intentAccuracy,1);
});
function meeting() {
  const before=segment('before',0,'考虑周五上线。'), after=segment('after',60000,'只是备选，需通过安全评审。');
  const record=createRecord('owner'); record.capture='recording'; record.segments=[before,after];record.transcriptRevision=2;
  record.liveMinutes={title:'上线评审',template:'meeting',notesRevision:0,transcriptRevision:2,sections:[{heading:'上线计划',items:[{id:'decision-1',text:'周五上线',evidence:[ref(before)]}]}],decisions:[{id:'decision-1',text:'周五上线',evidence:[ref(before)]}],actions:[],topics:[],evidenceSnapshot:[before,after]};
  return {record,before,after};
}
test('late ASR gets both earlier and later event-time context, without mutating stored arrival order',()=>{
  const {record}=meeting();const late=segment('late',30000,'刚才只是建议，不是已决定。');record.segments.push(late);record.transcriptRevision++;
  assert.deepEqual(liveInput(record,'meeting').map(s=>s.id),['before','late','after']);
  assert.deepEqual(record.segments.map(s=>s.id),['before','after','late']);
  assert.deepEqual(requestMinutes(record,{scope:'live'}).snapshot.map(s=>s.id),['before','late','after']);
});
test('bounded context carries correctable facts and their original evidence',()=>{
  const {record}=meeting();const context=minutesContext(record.liveMinutes,record.segments);
  assert.equal(context.items.find(item=>item.id===minutesItemId(record.liveMinutes.decisions[0])).text,'周五上线');
  assert.ok(Buffer.byteLength(JSON.stringify(context))<=12000);
});
test('withdrawal removes obsolete decisions and prose but retains cited correction history',()=>{
  const {record}=meeting(), late=segment('late',180000,'取消周五上线，等安全评审。');
  const incoming={title:'上线评审',sections:[{heading:'上线计划',items:[]}],actions:[],decisions:[],corrections:[{targetId:minutesItemId(record.liveMinutes.decisions[0]),status:'withdrawn',text:'已撤回周五上线安排，等待安全评审。',evidence:[ref(late)]}]};
  const result=mergeLiveMinutes(record.liveMinutes,incoming,[late]);
  assert.equal(result.decisions.length,0);
  assert.ok(!result.sections.some(section=>section.items.some(item=>item.text==='周五上线')));
  assert.equal(result.correctionHistory[0].previous.text,'周五上线');
  assert.ok(result.sections.some(section=>section.items.some(item=>item.text.includes('已撤回'))));
  validateMinutes(result,result.evidenceSnapshot);
});
test('unknown correction targets cannot silently delete historical facts',()=>{
  const {record}=meeting();const result={title:'评审',sections:[{heading:'评审',items:[]}],actions:[],corrections:[{targetId:'unknown',status:'withdrawn',text:'取消安排',evidence:[ref(record.segments[0])]}]};
  assert.throws(()=>validateMinutes(result,record.segments,minutesContext(record.liveMinutes)),/invalid_minutes_correction_target/);
});
test('conditional agreement and factual negation are not confirmed decisions or withdrawals',()=>{
  const conditional=ruleIntents([segment('c',0,'如果客户同意采用，就按方案一推进。')]);
  assert.ok(!conditional.items.some(item=>item.kind==='decision'));
  const factual=ruleIntents([segment('f',0,'设备不需要人工干预，也不再断连。')]);
  assert.ok(!factual.items.some(item=>item.kind==='withdrawal'));
});
test('withdrawal invalidates tables and speaker digests that depended on the old fact',()=>{
  const {record,before}=meeting(), late=segment('late',180000,'取消周五上线');
  record.liveMinutes.tables=[{title:'安排',columns:['事项','日期'],rows:[{cells:['上线','周五'],evidence:[ref(before)]}]}];
  record.liveMinutes.speakerSummaries=[{speaker:'张工',speakerId:'speaker-1',summary:'周五上线',evidence:[ref(before)]}];
  const result=mergeLiveMinutes(record.liveMinutes,{title:'评审',sections:[],actions:[],corrections:[{targetId:minutesItemId(record.liveMinutes.decisions[0]),status:'withdrawn',text:'取消上线',evidence:[ref(late)]}]},[late]);
  assert.deepEqual(result.tables,[]);assert.deepEqual(result.speakerSummaries,[]);
});
test('a correction cannot cite only old context or omit its trusted context',()=>{
  const {record}=meeting(), context=minutesContext(record.liveMinutes);
  const result={title:'评审',sections:[{heading:'评审',items:[]}],actions:[],corrections:[{targetId:minutesItemId(record.liveMinutes.decisions[0]),status:'withdrawn',text:'取消',evidence:[ref(record.segments[0])]}]};
  assert.throws(()=>validateMinutes(result,record.segments),/invalid_minutes_correction_target/);
  assert.throws(()=>validateMinutes(result,record.segments.map(s=>({...s,contextOnly:true})),context),/minutes_correction_without_new_evidence/);
});
test('context-only facts cannot be presented as new decisions',()=>{
  const {record}=meeting();const snapshot=record.segments.map((s,index)=>({...s,contextOnly:index===0}));
  const result={title:'评审',sections:[{heading:'安排',items:[]}],actions:[],decisions:[{text:'周五上线',evidence:[ref(snapshot[0])]}]};
  assert.throws(()=>validateMinutes(result,snapshot,undefined,{newEvidenceOnly:true}),/minutes_without_new_evidence/);
});
test('same wording from different projects does not delete the other project on correction',()=>{
  const {record,before,after}=meeting(), late=segment('late',200000,'取消甲项目检查');
  record.liveMinutes.actions=[{id:'project-a',text:'检查设备',owner:'甲',due:'周五',evidence:[ref(before)]},{id:'project-b',text:'检查设备',owner:'乙',due:'周一',evidence:[ref(after)]}];
  const result=mergeLiveMinutes(record.liveMinutes,{title:'评审',sections:[],actions:[],corrections:[{targetId:minutesItemId(record.liveMinutes.actions[0]),status:'withdrawn',text:'甲项目取消检查',evidence:[ref(late)]}]},[late]);
  assert.equal(result.actions.length,1);assert.equal(result.actions[0].id,'project-b');
});
test('older event-time corrections cannot reverse a later correction when ASR arrives late',()=>{
  const {record}=meeting(), later=segment('later',300000,'取消上线'), earlier=segment('earlier',180000,'上线时间待确认');
  const update=(status,text,evidence)=>({title:'评审',sections:[],actions:[],corrections:[{targetId:minutesItemId(record.liveMinutes.decisions[0]),status,text,evidence}]});
  const current=mergeLiveMinutes(record.liveMinutes,update('withdrawn','取消上线',[ref(later)]),[later]);
  const result=mergeLiveMinutes(current,update('pending','上线时间待确认',[ref(earlier)]),[earlier]);
  assert.equal(result.correctionHistory.length,1);
  assert.ok(result.sections.flatMap(s=>s.items).filter(item=>item.text.includes('上线时间待确认')).every(item=>item.text.startsWith('待复核')));
});
test('provider-local item IDs cannot merge different projects or enter trusted identities',()=>{
  const a=segment('a',0,'甲项目检查'),b=segment('b',1000,'乙项目检查');
  const first={id:'a1',text:'甲项目检查',evidence:[ref(a)]},second={id:'a1',text:'乙项目检查',evidence:[ref(b)]};
  assert.notEqual(minutesItemId(first),minutesItemId(second));
  const result=mergeLiveMinutes({title:'检查',sections:[{heading:'检查',items:[]}],actions:[first],evidenceSnapshot:[a]},{title:'检查',sections:[{heading:'检查',items:[]}],actions:[second]},[b]);
  assert.equal(result.actions.length,2);
  assert.throws(()=>validateMinutes({title:'检查',sections:[{heading:'检查',items:[]}],actions:[second]},[b],undefined,{newEvidenceOnly:true}),/invalid_minutes_item_identity/);
});
test('paraphrased prose sharing a withdrawn decision source is retained as pending review',()=>{
  const {record,before}=meeting(),later=segment('later',300000,'取消周五上线');
  const original='团队已确认本周五发布新版本。';
  record.liveMinutes.sections=[{heading:'上线',items:[{text:original,evidence:[ref(before)]},{text:'服务器已准备好。',evidence:[ref(before)]}]}];
  const incoming={title:'上线',sections:[],actions:[],decisions:[],corrections:[{targetId:minutesItemId(record.liveMinutes.decisions[0]),status:'withdrawn',text:'取消周五上线',evidence:[ref(later)]}]};
  const result=mergeLiveMinutes(record.liveMinutes,incoming,[later]);
  const prose=result.sections.flatMap(section=>section.items);
  assert.ok(!prose.some(item=>item.text===original));
  assert.ok(prose.some(item=>item.text.startsWith('待复核')&&item.text.includes(original)));
  assert.ok(prose.some(item=>item.text.includes('服务器已准备好')));
  assert.equal(result.decisions.length,0);
});
test('correction aliases and newer context cannot reactivate a decision using older evidence',()=>{
  const {record}=meeting(),later=segment('later',300000,'取消周五上线'),early=segment('early',180000,'上线待确认'),context=segment('context',500000,'其他讨论');
  const first=mergeLiveMinutes(record.liveMinutes,{title:'上线',sections:[],actions:[],corrections:[{targetId:minutesItemId(record.liveMinutes.decisions[0]),status:'withdrawn',text:'取消上线',evidence:[ref(later)]}]},[later]);
  const note=minutesContext(first).items.find(item=>item.text.startsWith('已撤回'));
  const incoming={title:'上线',sections:[],decisions:[{text:'周五上线',evidence:[ref(early)]}],actions:[],corrections:[{targetId:note.id,status:'pending',text:'上线待确认',evidence:[ref(early),ref(context)]}]};
  const snapshot=[early,{...later,contextOnly:true},{...context,contextOnly:true}];
  const result=mergeLiveMinutes(first,incoming,snapshot);
  assert.equal(result.decisions.length,0);assert.equal(result.correctionHistory.at(-1).status,'withdrawn');
  assert.ok(result.sections.flatMap(s=>s.items).some(item=>item.text.startsWith('已撤回')));
  const quarantined=minutesContext(result).items.find(item=>item.text.startsWith('待复核')&&item.text.includes('周五上线'));
  const retry=mergeLiveMinutes(result,{title:'上线',sections:[],actions:[],decisions:[{text:'周五上线',evidence:[ref(early)]}],corrections:[{targetId:quarantined.id,status:'corrected',text:'周五上线',evidence:[ref(early)]}]},[early]);
  assert.equal(retry.decisions.length,0);
});
test('null provider output raises a domain validation error',()=>{
  assert.throws(()=>validateMinutes(null,[]),error=>error.code==='invalid_minutes'&&error.status===422);
});
test('a later correction of one fact preserves other facts sharing its source',()=>{
  const {record,before}=meeting(),cancel=segment('cancel',300000,'取消周五上线'),change=segment('change',400000,'改为周一');
  record.liveMinutes.actions=[{text:'乙项目提交报告',owner:'乙',due:'明天',evidence:[ref(before)]}];
  const first=mergeLiveMinutes(record.liveMinutes,{title:'上线',sections:[],actions:[],corrections:[{targetId:minutesItemId(record.liveMinutes.decisions[0]),status:'withdrawn',text:'取消上线',evidence:[ref(cancel)]}]},[cancel]);
  const note=minutesContext(first).items.find(item=>item.text.startsWith('已撤回'));
  const result=mergeLiveMinutes(first,{title:'上线',sections:[],actions:[],corrections:[{targetId:note.id,status:'corrected',text:'改周一',evidence:[ref(change)]}]},[change]);
  const related=result.sections.flatMap(section=>section.items).find(item=>item.text.includes('乙项目提交报告'));
  assert.ok(related);assert.equal(related.owner,'乙');assert.equal(related.due,'明天');assert.deepEqual(related.evidence,[ref(before)]);
});
test('structured output is opt-in for both transports and keeps the default JSON mode',async()=>{
  const original=globalThis.fetch;let request;
  try{
    globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return new Response(JSON.stringify(request.input?{status:'completed',output_text:'{}'}:{choices:[{message:{content:'{}'}}]}));};
    for(const protocol of ['responses','chat-completions'])for(const enabled of ['true','false']){
      await completeModelJson([{role:'system',content:'Return JSON'}],{LLM_PROTOCOL:protocol,LLM_API_URL:'https://unused.invalid',LLM_API_KEY:'synthetic',LLM_MODEL:'synthetic',LLM_STRUCTURED_OUTPUTS:enabled},{jsonSchema:minutesSchema});
      const format=protocol==='responses'?request.text.format:request.response_format;
      assert.equal(format.type,enabled==='true'?'json_schema':'json_object');
    }
  }finally{globalThis.fetch=original;}
});
test('all templates and audio use the same correction and uncertainty contract',()=>{
  for(const template of ['meeting','interview','lecture'])for(const audio of [false,true]){
    const prompt=minutesInstructions({template,scope:'live',stage:'synthesis'},audio);
    assert.ok(prompt.includes('corrections'));assert.ok(prompt.includes('不生成确定决定'));assert.ok(prompt.includes('targetId'));
  }
  assert.ok(minutesInstructions({template:'interview'}).includes('采访者假设'));
  assert.ok(minutesInstructions({template:'lecture'}).includes('教学举例'));
});
test('strict schema preserves grounded chart data and normalizes only absent optional metadata',async()=>{
  const source=segment('chart',0,'甲2台，乙3台。'),evidence=[ref(source)],original=globalThis.fetch;
  const output={title:'设备',sections:[{heading:'设备',items:[{text:'甲2台，乙3台。',evidence,topicId:null,label:null,kind:null}]}],topics:[],decisions:[],actions:[],speakerSummaries:[],currentDiscussion:[],highlights:[],corrections:[],tables:[],visuals:[{kind:'bar',title:'设备数量',topicId:null,unit:'台',entries:[{label:'甲',valueText:'2',quote:'甲2台',evidence},{label:'乙',valueText:'3',quote:'乙3台',evidence}]}]};
  try{
    globalThis.fetch=async()=>new Response(JSON.stringify({status:'completed',output_text:JSON.stringify(output)}));
    const result=await generateMinutes({template:'meeting',scope:'final',snapshot:[source]},{LLM_PROTOCOL:'responses',LLM_API_URL:'https://unused.invalid',LLM_API_KEY:'synthetic',LLM_MODEL:'synthetic',LLM_STRUCTURED_OUTPUTS:'true'});
    assert.equal(result.visuals[0].entries[0].valueText,'2');assert.equal(result.sections[0].items[0].topicId,undefined);
    validateMinutes(result,[source]);
  }finally{globalThis.fetch=original;}
});
test('text provider validates model identities even when no tables are returned',async()=>{
  const source=segment('identity',0,'检查设备'),original=globalThis.fetch;
  const output={title:'检查',sections:[{heading:'检查',items:[]}],actions:[{id:'a1',text:'检查设备',owner:null,due:null,evidence:[ref(source)]}]};
  try{
    globalThis.fetch=async()=>new Response(JSON.stringify({status:'completed',output_text:JSON.stringify(output)}));
    await assert.rejects(generateMinutes({scope:'final',snapshot:[source]},{LLM_PROTOCOL:'responses',LLM_API_URL:'https://unused.invalid',LLM_API_KEY:'synthetic',LLM_MODEL:'synthetic'}),{code:'invalid_minutes_item_identity'});
  }finally{globalThis.fetch=original;}
});
