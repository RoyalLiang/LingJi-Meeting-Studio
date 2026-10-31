import test from 'node:test';
import assert from 'node:assert/strict';
import {modelEndpoint,completeModelJson} from '../services/records/src/llm.mjs';
import {compactMinutesPayload} from '../services/records/src/minutes-wire.mjs';
test('base addresses resolve once; explicit custom paths and query strings survive',()=>{
 assert.equal(modelEndpoint('https://gateway.test/v1','responses'),'https://gateway.test/v1/responses');
 assert.equal(modelEndpoint('https://gateway.test/v1/','chat-completions'),'https://gateway.test/v1/chat/completions');
 assert.equal(modelEndpoint('https://gateway.test','chat-completions'),'https://gateway.test');
 for(const path of ['/v1/chat/completions','/v1/responses','/custom/inference','/custom/v1'])assert.equal(modelEndpoint('https://gateway.test'+path,'responses'),'https://gateway.test'+path);
 assert.equal(modelEndpoint('https://gateway.test/proxy/v1?api-version=1','responses'),'https://gateway.test/proxy/v1?api-version=1');
});
test('actual requests use the resolved endpoint for both protocols',async()=>{
 const previous=globalThis.fetch,seen=[];
 globalThis.fetch=async(url,request)=>{seen.push([url,JSON.parse(request.body)]);return Response.json(url.endsWith('responses')?{output_text:'{"ok":true}'}:{choices:[{message:{content:'{"ok":true}'}}]});};
 try{for(const protocol of ['responses','chat-completions'])assert.equal((await completeModelJson([{role:'user',content:'JSON'}],{LLM_API_URL:'https://gateway.test/v1',LLM_PROTOCOL:protocol,LLM_MODEL:'fixture-model',LLM_API_KEY:'fixture-secret'})).ok,true);
 assert.deepEqual(seen.map(([url])=>url),['https://gateway.test/v1/responses','https://gateway.test/v1/chat/completions']);assert.ok(seen[0][1].input);assert.ok(seen[1][1].messages);
 }finally{globalThis.fetch=previous;}
});
const id='00000000-0000-4000-8000-000000000001',source='10000000-0000-4000-8000-000000000001',speaker='20000000-0000-4000-8000-000000000001',fact='fact-00000000000000000001';
test('compact identities restore citations, speakers and correction targets without changing source content',()=>{
 const ref={segmentId:id,revision:3},job={snapshot:[{id,revision:3,text:'不是周五，是下周一；负责人尚未确认。',sourceId:source,speakerId:speaker,startMs:0,endMs:1000}],notes:'保留笔记',liveContext:{title:'历史上下文',items:[{id:fact,text:'原结论',evidence:[ref]}]},summaries:[{sections:[{items:[{text:'窗口摘要',evidence:[ref]}]}]}]};
 const original=structuredClone(job),wire=compactMinutesPayload(job),segment=wire.payload.transcript[0];
 assert.equal(segment.text,job.snapshot[0].text);assert.equal(segment.startMs,0);assert.equal(wire.payload.notes,job.notes);assert.notEqual(segment.id,id);
 const restored=wire.restore({sections:[{items:[{text:'周一，负责人待确认',evidence:[{segmentId:segment.id,revision:3}]}]}],speakerSummaries:[{speakerId:segment.speakerId,speaker:'张工'}],corrections:[{targetId:wire.payload.context.items[0].id,evidence:[{segmentId:segment.id,revision:3}]}]});
 assert.deepEqual(restored.sections[0].items[0].evidence,[ref]);assert.equal(restored.speakerSummaries[0].speakerId,speaker);assert.equal(restored.corrections[0].targetId,fact);assert.deepEqual(job,original);
 assert.equal(wire.restore({evidence:[{segmentId:'@s999',revision:3}]}).evidence[0].segmentId,'@s999');
});
test('50-minute fixture retains every condition and citation with fewer wire bytes',()=>{
 const snapshot=Array.from({length:300},(_,i)=>({id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,sourceId:source,speakerId:speaker,revision:1,startMs:i*10000,endMs:(i+1)*10000,text:`议题${i}：如果验收通过，才安排下一步；日期与负责人仍待确认。`}));
 const summaries=snapshot.map(s=>({sections:[{items:[{text:s.text,evidence:[{segmentId:s.id,revision:1}]}]}]}));
 const job={snapshot,summaries,notes:'不得丢失否定、条件与引用'},wire=compactMinutesPayload(job);
 const oldBytes=Buffer.byteLength(JSON.stringify({transcript:snapshot,summaries,notes:job.notes})),newBytes=Buffer.byteLength(JSON.stringify(wire.payload));
 assert.equal(wire.payload.transcript.length,300);assert.ok(newBytes<oldBytes*.82,`${newBytes}/${oldBytes}`);assert.deepEqual(wire.restore(wire.payload.summaries),summaries);
 for(let i=0;i<300;i++)assert.equal(wire.payload.transcript[i].text,snapshot[i].text);
});

test('cache and reasoning are measured subsets, never added again to total usage',async()=>{
 const {tokenUsage,beginMinutesUsage,updateMinutesUsage}=await import('../packages/records/src/usage.mjs');
 const usage=tokenUsage({prompt_tokens:100,completion_tokens:60,total_tokens:160,prompt_tokens_details:{cached_tokens:80},completion_tokens_details:{reasoning_tokens:40}});
 assert.deepEqual(usage,{inputTokens:100,outputTokens:60,totalTokens:160,cachedInputTokens:80,reasoningTokens:40});
 const {createRecord}=await import('../packages/records/src/record.mjs'),record=createRecord('owner'),claim={id:'call-job',fence:'f',generation:record.generation};
 record.jobs.push({...claim,status:'running'});beginMinutesUsage(record,claim,'request');updateMinutesUsage(record,claim,'request',usage);updateMinutesUsage(record,claim,'request',usage);
 assert.equal(record.usage.llmTokens,160);assert.equal(record.usage.minutesMeter.cachedInputTokens,80);assert.equal(record.usage.minutesMeter.reasoningTokens,40);
 assert.deepEqual(tokenUsage({input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:20},output_tokens_details:{reasoning_tokens:6}}),{inputTokens:10,outputTokens:5,totalTokens:15});
});

test('numeric wire references carry the exact frozen revision back into persisted evidence',()=>{
 const wire=compactMinutesPayload({snapshot:[{id,revision:7,text:'不得提前上线'}]});
 assert.equal(typeof wire.payload.transcript[0].id,'number');
 assert.deepEqual(wire.restore({evidence:[wire.payload.transcript[0].id]}),{evidence:[{segmentId:id,revision:7}]});
 assert.deepEqual(wire.restore({evidence:[999]}),{evidence:[999]});
 assert.equal(wire.restore({evidence:[{segmentId:0,revision:8}]}).evidence[0].segmentId,0,'a mismatched revision must not be silently repaired');
});

test('wire prompts and schema consistently use numeric references; old-context references remain reversible',async()=>{
 const {minutesInstructions,minutesSchema}=await import('../services/records/src/minutes-prompts.mjs');
 const {compactMinutesSchema}=await import('../services/records/src/minutes-wire.mjs');
 assert.doesNotMatch(minutesInstructions({compactEvidence:true}),/segmentId:string/);
 assert.deepEqual(compactMinutesSchema(minutesSchema).properties.sections.items.properties.items.items.properties.evidence.items,{type:'integer',minimum:0});
 const old={segmentId:'old-evidence-000000000000',revision:2};
 const wire=compactMinutesPayload({snapshot:[{id,revision:1,text:'新事实'}],liveContext:{items:[{id:fact,text:'不得丢失的旧条件',evidence:[old]}]}});
 assert.equal(typeof wire.payload.context.items[0].evidence[0],'number');
 assert.deepEqual(wire.restore({evidence:wire.payload.context.items[0].evidence}),{evidence:[old]});
});

test('untrusted property names cannot access codec prototypes',()=>{
 const wire=compactMinutesPayload({snapshot:[{id,revision:1,text:'原文'}]});
 const value=JSON.parse('{"constructor":"unchanged","__proto__":"data","evidence":[0]}');
 const result=wire.restore(value);assert.equal(result.constructor,'unchanged');assert.equal(Object.getOwnPropertyDescriptor(result,'__proto__').value,'data');assert.deepEqual(result.evidence,[{segmentId:id,revision:1}]);
});

test('dedicated translation inherits version base routing without leaking its key to another address',async()=>{
 const {translateSeedText}=await import('../services/records/src/seed-translation.mjs');
 const previous=globalThis.fetch;let seen;
 globalThis.fetch=async(url,options)=>{seen={url,authorization:options.headers.Authorization};return Response.json({output_text:'Hello'});};
 try{
  assert.equal(await translateSeedText('你好','en',{LLM_API_URL:'https://gateway.test/v1',LLM_API_KEY:'fixture-secret',DOUBAO_TRANSLATION_MODEL:'doubao-seed-translation-250915'}),'Hello');
  assert.equal(seen.url,'https://gateway.test/v1/responses');assert.equal(seen.authorization,'Bearer fixture-secret');
  await assert.rejects(translateSeedText('你好','en',{LLM_API_URL:'https://gateway.test/v1',LLM_API_KEY:'fixture-secret',DOUBAO_TRANSLATION_API_URL:'https://other.test/v1'}));
  assert.equal(seen.url,'https://gateway.test/v1/responses','no key is inherited by a different dedicated address');
 }finally{globalThis.fetch=previous;}
});
