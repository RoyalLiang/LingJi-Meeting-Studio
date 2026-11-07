import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage as message,fauxToolCall as call} from '@earendil-works/pi-ai/providers/faux';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord,requestMinutes,commitMinutes} from '../packages/records/src/record.mjs';
import {queueAutomaticMinutes} from '../packages/records/src/automation.mjs';
import {createMeetingAgentRuntime} from '../services/records/src/meeting-agent.mjs';
import {runMinutesPipeline} from '../services/records/src/minutes-pipeline.mjs';
import {generateMinutes} from '../services/records/src/providers.mjs';
import {transcriptInterpretation} from '../packages/records/src/transcript-interpretation.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'interpretation-runtime-')),repo=await createRepository({root,databaseUrl:''});
 t.after(async()=>{await repo.close();await rm(root,{recursive:true,force:true});});
 const record=createRecord('owner',{title:'户外品牌讨论',autoMinutes:false});
 Object.assign(record,{capture:'completed',transcription:'ready',transcriptRevision:2,minutesRevision:0,segments:[{id:'source-original',revision:2,startMs:0,endMs:1000,text:'户外品牌巴塔戈迪亚的预算不是1000元，金额还没确认。'}]});
 await repo.insert(record);return {repo,record};
}

test('minutes interpretation may normalize a term while persisted citations retain raw text and human edits',async t=>{
 const h=await fixture(t),originalFetch=globalThis.fetch;let requests=0;
 t.after(()=>{globalThis.fetch=originalFetch;});
 globalThis.fetch=async(url,options)=>{
  assert.equal(new URL(url).hostname,'fixture.invalid');requests++;
  const body=JSON.parse(options.body);assert.ok(body.messages.some(item=>item.role==='system'&&item.content.includes(transcriptInterpretation)));
  assert.match(JSON.stringify(body.messages),/巴塔戈迪亚/);
  return Response.json({choices:[{message:{content:JSON.stringify({title:'户外品牌预算',sections:[{heading:'待确认',items:[{text:'巴塔哥尼亚品牌预算不是1000元，金额待确认；术语理解：巴塔戈迪亚→巴塔哥尼亚。',evidence:[0]}]}],decisions:[],actions:[]})}}],usage:{prompt_tokens:20,completion_tokens:20,total_tokens:40}});
 };
 const config={LLM_MODEL:'fixture-model',LLM_API_KEY:'synthetic',LLM_API_URL:'https://fixture.invalid/v1',LLM_PROTOCOL:'chat-completions'};
 let claim;await h.repo.change(h.record.id,row=>{const job=requestMinutes(row,{scope:'final',modelVersion:'fixture-model'});job.status='running';job.fence='fixture-fence';claim=structuredClone(job);});
 const output=await runMinutesPipeline(h.repo,h.record.id,claim,config,generateMinutes);
 await h.repo.change(h.record.id,row=>{commitMinutes(row,claim.id,output,claim.fence);});
 let saved=await h.repo.get(h.record.id),item=saved.minutes.sections[0].items[0];
 assert.match(item.text,/巴塔哥尼亚/);assert.match(item.text,/不是1000元/);assert.match(item.text,/待确认/);
 assert.deepEqual(item.evidence,[{segmentId:'source-original',revision:2}]);
 assert.equal(saved.segments[0].text,h.record.segments[0].text);assert.equal(saved.minutes.evidenceSnapshot[0].text,h.record.segments[0].text);
 await h.repo.change(h.record.id,row=>{row.minutes.edited=true;row.minutes.title='人工确认保留的纪要';row.minutesRevision++;row.autoMinutes={enabled:true,lastRevision:row.transcriptRevision,lastScope:'final',intervalSeconds:30};});
 saved=await h.repo.get(h.record.id);const before=structuredClone(saved.minutes),calls=requests;
 assert.equal(queueAutomaticMinutes(saved,'fixture-model'),undefined);
 assert.deepEqual(saved.minutes,before);assert.equal((await h.repo.get(h.record.id)).minutes.title,'人工确认保留的纪要');assert.equal(requests,calls);
});

test('real Agent tool loop accepts normalized interpretation only with original revision and preserves manually edited minutes',async t=>{
 const h=await fixture(t),model={provider:'interpretation-fixture',modelId:'synthetic'};
 const fake=fauxProvider({provider:model.provider,models:[{id:model.modelId}],tokensPerSecond:Infinity}),models=createModels();models.setProvider(fake.provider);
 const evidence=[{segmentId:'source-original',revision:2}];
 await h.repo.change(h.record.id,row=>{row.minutesRevision=3;row.minutes={title:'人工保留原词',edited:true,revision:3,transcriptRevision:2,sections:[{heading:'人工核对',items:[{text:'人工标记：巴塔戈迪亚，待核实。',evidence}]}],decisions:[],actions:[],evidenceSnapshot:structuredClone(row.segments)};});
 const before=await h.repo.get(h.record.id),runtime=await createMeetingAgentRuntime({repo:h.repo,models,model});t.after(()=>runtime.close());
 const final={summary:'术语理解：巴塔戈迪亚→巴塔哥尼亚；金额待确认。',decisions:[{text:'巴塔哥尼亚预算不是1000元，金额仍待确认。',evidence:[{recordId:h.record.id,segmentId:'source-original',revision:2}]}],actions:[]};
 function responses(result){return [message(call('read_selected_meeting',{recordId:h.record.id}),{stopReason:'toolUse'}),context=>{
  const source=JSON.parse(context.messages.find(item=>item.role==='toolResult'&&item.toolName==='read_selected_meeting').content.find(item=>item.type==='text').text);
  assert.equal(source.segments[0].text,h.record.segments[0].text);assert.equal(source.segments[0].revision,2);assert.equal(source.minutes.title,'人工保留原词');
  assert.match(JSON.stringify(context),/原始转录和人工修订不得被覆盖/);return message(JSON.stringify(result));
 }];}
 async function run(requestId,result){fake.setResponses(responses(result));const task=await runtime.request('owner',{recordIds:[h.record.id],prompt:'结合上下文整理品牌名称，保留待核实事项。',requestId,scopeConfirmed:true});for(let i=0;i<200;i++){const value=await runtime.get('owner',task.id);if(['completed','failed','blocked','cancelled'].includes(value.status))return value;await delay(10);}assert.fail('fixture Agent did not finish');}
 const completed=await run('normalized-original-ref',final);assert.equal(completed.status,'completed',JSON.stringify(completed));assert.deepEqual(completed.result,final);
 const wrongRevision=structuredClone(final);wrongRevision.decisions[0].evidence[0].revision=3;
 const rejected=await run('normalized-fabricated-ref',wrongRevision);assert.equal(rejected.status,'failed');assert.equal(rejected.error,'invalid_agent_output');assert.equal(rejected.result,undefined);
 const after=await h.repo.get(h.record.id);assert.deepEqual(after.minutes,before.minutes);assert.deepEqual(after.segments,before.segments);assert.equal(after.minutesRevision,3);
});
