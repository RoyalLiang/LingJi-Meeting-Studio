import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readConfig, saveConfig, publicConfig, normalizeConfig } from '../services/records/src/config.mjs';
import { providerStatus } from '../services/records/src/providers.mjs';
import { transcribeDoubaoAsr } from '../services/records/src/doubao.mjs';
import { createRepository } from '../services/records/src/repository.mjs';
import { createAuth } from '../services/records/src/auth.mjs';
import { createRecord, editSegment } from '../packages/records/src/record.mjs';
import { ruleIntents, commitIntents } from '../packages/records/src/intents.mjs';

async function temporary(fn) {
  const root = await mkdtemp(join(tmpdir(), 'meeting-providers-'));
  try { await fn(root); } finally { await rm(root, {recursive:true, force:true}); }
}

test('reasoning strength persists publicly and rejects unsupported values',()=>temporary(async root=>{
  const saved=await saveConfig(root,{LLM_REASONING_EFFORT:'high'},{});
  assert.equal(saved.LLM_REASONING_EFFORT,'high');
  assert.equal((await readConfig(root,{})).LLM_REASONING_EFFORT,'high');
  await assert.rejects(saveConfig(root,{LLM_REASONING_EFFORT:'ultra'},{}),/invalid_llm_reasoning_effort/);
}));

test('explicit reasoning strength overrides staged automatic minutes policy in both protocols',async()=>{
  const {generateMinutes}=await import('../services/records/src/providers.mjs');
  const original=globalThis.fetch,evidence=[{segmentId:'s1',revision:1}];
  const output={title:'合成纪要',sections:[{heading:'要点',items:[{text:'合成内容',evidence}]}],actions:[]};
  try {
    for(const protocol of ['responses','chat-completions'])for(const scope of ['live','final'])for(const effort of ['high','max','default','auto']){
      let body;
      globalThis.fetch=async(_url,request)=>{body=JSON.parse(request.body);return new Response(JSON.stringify(protocol==='responses'?{output_text:JSON.stringify(output)}:{choices:[{message:{content:JSON.stringify(output)}}]}));};
      await generateMinutes({template:'meeting',scope,snapshot:[{id:'s1',revision:1,text:'合成内容'}]},
        {LLM_API_URL:'https://unused.invalid',LLM_API_KEY:'synthetic-key',LLM_MODEL:'kimi-k3-1-pro-261024',LLM_PROTOCOL:protocol,LLM_REASONING_EFFORT:effort});
      const actual=protocol==='responses'?body.reasoning?.effort:body.reasoning_effort;
      assert.equal(actual,effort==='auto'?(scope==='live'?'low':'high'):effort==='default'?undefined:effort);
    }
  }finally{globalThis.fetch=original;}
});
test('new model base addresses default to Responses and explicit Chat endpoints remain compatible', () => {
  const config=normalizeConfig({LLM_API_URL:'https://models.example/v1'});
  assert.equal(config.LLM_PROTOCOL,'responses');
  assert.equal(config.LLM_API_URL,'https://models.example/v1');
  const legacy=normalizeConfig({LLM_API_URL:'https://models.example/v1/chat/completions'});
  assert.equal(legacy.LLM_PROTOCOL,'chat-completions');
  assert.equal(normalizeConfig({LLM_API_URL:'https://models.example/v1',LLM_PROTOCOL:'chat-completions'}).LLM_PROTOCOL,'chat-completions');
});
test('removed AST credentials cannot enable recognition; persisted settings never return keys', async () => temporary(async root => {
  const legacy = {DOUBAO_AST_SECRET:'valid-app',DOUBAO_AST_ACCESS_TOKEN:'valid-token'};
  assert.equal(providerStatus(legacy).asr,false);
  assert.equal(providerStatus(legacy).asrProvider,'doubao');
  assert.equal(providerStatus({...legacy,ASR_PROVIDER:'doubao-ast'}).asr,false);
  assert.equal(providerStatus({...legacy,ASR_PROVIDER:'doubao-ast'}).asrProvider,'doubao');
  await assert.rejects(saveConfig(root,{ASR_PROVIDER:'doubao-ast'},{}),/invalid_asr_provider/);
  assert.equal(providerStatus({}).asrProvider,'doubao');
  assert.equal(providerStatus({DOUBAO_API_KEY:'your-key'}).asr,false);
  await saveConfig(root,{DOUBAO_API_KEY:'voice-secret',LLM_API_KEY:'model-secret',DOUBAO_ASR_URL:'wss://speech.example.test/asr'},{});
  await saveConfig(root,{DOUBAO_API_KEY:'',LLM_MODEL:'ep-approved'},{});
  const config = await readConfig(root,{});
  assert.equal(config.DOUBAO_API_KEY,'voice-secret');
  assert.equal(config.LLM_MODEL,'ep-approved');
  assert.equal(publicConfig(config).DOUBAO_API_KEY,true);
  assert.equal(JSON.stringify(publicConfig(config)).includes('voice-secret'),false);
  assert.equal((await stat(join(root,'providers.json'))).mode & 0o777,0o600);
  await assert.rejects(saveConfig(root,{DOUBAO_ASR_URL:'file:///private/key'},{}),/invalid_provider_url/);
  await saveConfig(root,{clearSecrets:['DOUBAO_API_KEY']},{});
  assert.equal(providerStatus(await readConfig(root,{})).asr,false);
}));

test('development account is idempotent, preserves existing credentials and is never seeded in production', async () => temporary(async root => {
  const repo = await createRepository({root});
  const before = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV='development';
    let auth=await createAuth(repo,{secret:'test-secret',seedDevelopment:true});
    const user=await auth.login({email:'dev@local.test',password:'LocalMeeting2026!'});
    await repo.change(user.id,u=>{u.authVersion=8;});
    auth=await createAuth(repo,{secret:'test-secret',seedDevelopment:true});
    assert.equal((await auth.login({email:'dev@local.test',password:'LocalMeeting2026!'})).authVersion,8);
    process.env.NODE_ENV='production';
    await temporary(async productionRoot=> {
      const productionRepo=await createRepository({root:productionRoot});
      try { await createAuth(productionRepo,{secret:'long-enough-production-secret-for-test',seedDevelopment:true}); assert.equal((await productionRepo.list('user')).length,0); } finally {await productionRepo.close();}
    });
  } finally {if(before===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=before; await repo.close();}
}));

function serverFrame(text, final) {
  const payload=gzipSync(Buffer.from(JSON.stringify({result:{text}}))), header=Buffer.from([0x11,final?0x93:0x91,0x11,0]);
  const sequence=Buffer.alloc(4);sequence.writeInt32BE(final?-2:1);
  const size=Buffer.alloc(4);size.writeUInt32BE(payload.length);
  return Buffer.concat([header,sequence,size,payload]);
}
test('Doubao ASR frames PCM at 16k, commits only final response and rejects an unfinished stream', async () => {
  const server=new WebSocketServer({port:0,host:'127.0.0.1'});
  await new Promise(resolve=>server.once('listening',resolve));
  let requests=0;
  server.on('connection',(socket,request)=> {
    assert.equal(request.headers['x-api-key'],'fixture-key');requests++;
    socket.on('message',frame=> {
      const type=frame[1]>>4;
      if(type===1){ const init=JSON.parse(gunzipSync(frame.subarray(8)).toString());assert.equal(init.audio.rate,16000);assert.equal(init.request.enable_punc,true);socket.send(serverFrame('临时草稿',false)); }
      if(type===2 && (frame[1]&2)){ if(requests===1)socket.send(serverFrame('已确认文本。',true)); else socket.close(); }
    });
  });
  const config={DOUBAO_API_KEY:'fixture-key',DOUBAO_ASR_URL:`ws://127.0.0.1:${server.address().port}`,DOUBAO_ASR_RESOURCE_ID:'fixture-resource'};
  try {
    assert.equal(await transcribeDoubaoAsr(Buffer.alloc(6400),'zh',config,{interval:1}),'已确认文本。');
    await assert.rejects(transcribeDoubaoAsr(Buffer.alloc(6400),'zh',config,{interval:1}),/doubao_incomplete_session/);
  } finally {server.clients.forEach(s=>s.terminate());await new Promise(resolve=>server.close(resolve));}
});

test('intent candidates preserve evidence revisions and never promote negation into an action',()=> {
  const record=createRecord('owner');record.segments=[{id:'one',revision:1,text:'不要发给客户，撤回之前的决定。'},{id:'two',revision:1,text:'建议下周再讨论。'}];record.transcriptRevision=1;
  const snapshot=structuredClone(record.segments), result=ruleIntents(snapshot);
  assert.deepEqual(result.items.map(i=>i.kind),['withdrawal','proposal']);
  assert.equal(commitIntents(record,snapshot,result,'rules',1,record.generation),true);
  editSegment(record,'one',{revision:1,text:'我来负责复核',speaker:''});
  assert.equal(commitIntents(record,snapshot,result,'rules',1,record.generation),false);
  const bad={items:[{kind:'action',text:'臆造任务',evidence:[{segmentId:'missing',revision:1}]}]};
  assert.throws(()=>commitIntents(record,record.segments,bad,'model',record.transcriptRevision,record.generation),/invalid_intent_evidence/);
});

test('explicit local minutes work without a cloud model and keep quoted evidence',async()=> {
  const {generateMinutes}=await import('../services/records/src/providers.mjs');
  const {validateMinutes}=await import('../packages/records/src/record.mjs');
  const snapshot=[{id:'s',revision:2,text:'小林负责整理需求。'},{id:'n',revision:1,text:'不要发送给客户。'}];
  const result=await generateMinutes({mode:'extractive',snapshot},{});
  validateMinutes(result,snapshot);
  assert.equal(result.method,'extractive');assert.equal(result.actions.length,1);assert.equal(result.actions[0].owner,null);
  assert.deepEqual(result.actions[0].evidence,[{segmentId:'s',revision:2}]);
  assert.equal(result.sections.some(s=>s.heading.includes('撤回')),true);
});

test('settings API requires CSRF and masks secrets; importing text does not authorize cloud intent analysis',async()=>temporary(async root=> {
  const {createRecordServer}=await import('../services/records/src/server.mjs');
  const repo=await createRepository({root}),app=await createRecordServer({repo,secret:'settings-test'}),server=app.server;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api`;
  try {
    const login=await fetch(`${base}/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'settings@example.test',password:'test-password-123'})});
    const cookie=login.headers.get('set-cookie').split(';')[0],user=await login.json(),headers={Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':user.csrf};
    let response=await fetch(`${base}/settings/providers`,{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,403);
    response=await fetch(`${base}/settings/providers`,{method:'PUT',headers,body:JSON.stringify({DOUBAO_API_KEY:'secret-never-return',ASR_PROVIDER:'doubao'})});assert.equal(response.status,200);assert.equal((await response.text()).includes('secret-never-return'),false);
    response=await fetch(`${base}/records`,{method:'POST',headers,body:JSON.stringify({title:'settings fixture'})});const record=await response.json();
    await fetch(`${base}/records/${record.id}/import-text`,{method:'POST',headers,body:JSON.stringify({text:'我们决定明天评审。'})});
    assert.notEqual((await repo.get(record.id)).analysisConsent,true);
    response=await fetch(`${base}/records/${record.id}/minutes`,{method:'POST',headers,body:JSON.stringify({mode:'extractive'})});assert.equal(response.status,200);
    assert.equal((await repo.get(record.id)).jobs[0].mode,'extractive');
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await repo.close();}
}));

test('worker progresses two sources concurrently while preserving durable sequence and finalization',async()=>temporary(async root=> {
  const {runCycle}=await import('../services/records/src/worker.mjs');
  const {addSource,acknowledge,seal,digest}=await import('../packages/records/src/record.mjs');
  const repo=await createRepository({root}),record=createRecord('two-sources',{retainAudio:true});
  const sources=[addSource(record,{kind:'microphone'}),addSource(record,{kind:'display'})];
  const bytes=Buffer.alloc(3200);
  for(const source of sources){ const hash=digest(bytes),object=await repo.putAudio(record.id,hash,bytes);acknowledge(record,{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence:0,sampleOffset:0,sampleCount:1600,sampleRate:16000,...object}); }
  seal(record,sources.map(s=>({sessionId:s.sessionId,sourceId:s.id,epoch:s.epoch,lastSequence:0})));await repo.insert(record);
  let active=0,peak=0;
  try {await runCycle(repo,{transcribe:async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,15));active--;return '合成来源';}});const result=await repo.get(record.id);assert.equal(peak,2);assert.equal(result.capture,'completed');assert.equal(result.segments.length,2);}
  finally {await repo.close();}
}));

test('chat request preserves its configured route and accounts model usage', async()=> {
  const {createServer}=await import('node:http'),{completeJson}=await import('../services/records/src/providers.mjs');
  const server=createServer((req,res)=>{assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer fixture-key');req.resume();res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}],usage:{total_tokens:17}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {const result=await completeJson([{role:'user',content:'fixture'}],{LLM_API_URL:`http://127.0.0.1:${server.address().port}/v1/chat/completions`,LLM_PROTOCOL:'chat-completions',LLM_MODEL:'fixture-model',LLM_API_KEY:'fixture-key'});assert.equal(result.ok,true);assert.equal(result.usageTokens,17);}
  finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('new model tables require explicit valid topic associations while table-free output remains compatible', async()=> {
  const {generateMinutes}=await import('../services/records/src/providers.mjs');
  const original=globalThis.fetch,evidence=[{segmentId:'s1',revision:1}];
  const job={template:'meeting',scope:'live',snapshot:[{id:'s1',revision:1,text:'合成会议内容'}]};
  const valid={title:'合成纪要',sections:[{heading:'主题',items:[{text:'合成内容',evidence}]}],topics:[{id:'topic-1',title:'主题',summary:'合成内容',evidence}],tables:[{title:'统计',topicId:'topic-1',columns:['项目','状态'],rows:[{cells:['项目','待确认'],evidence}]}],actions:[]};
  let output=valid;
  try {
    for(const protocol of ['chat-completions','responses']){
      globalThis.fetch=async()=>new Response(JSON.stringify(protocol==='responses'?{output_text:JSON.stringify(output)}:{choices:[{message:{content:JSON.stringify(output)}}]}),{headers:{'Content-Type':'application/json'}});
      const env={LLM_API_URL:'https://unused.invalid',LLM_API_KEY:'synthetic-local-key',LLM_MODEL:'synthetic',LLM_PROTOCOL:protocol};
      output=valid;const result=await generateMinutes(job,env);assert.deepEqual(result.tables,valid.tables);assert.deepEqual(result.topics,valid.topics);
      for(const [mutation,code] of [
        [value=>{delete value.tables[0].topicId;},'invalid_minutes_tables'],
        [value=>{value.tables[0].topicId='unknown';},'invalid_minutes_tables'],
        [value=>{delete value.topics[0].id;},'invalid_minutes_topics'],
        [value=>{value.topics.push({...value.topics[0]});},'invalid_minutes_topics'],
        [value=>{value.topics[0].id=' topic-1 ';},'invalid_minutes_topics'],
        [value=>{value.tables[0].rows[0].evidence=[{segmentId:'unknown',revision:1}];},'invalid_minutes_tables'],
      ]){
        output=structuredClone(valid);mutation(output);await assert.rejects(generateMinutes(job,env),error=>error.code===code);
      }
      output=structuredClone(valid);delete output.tables;delete output.topics[0].id;
      assert.equal((await generateMinutes(job,env)).topics[0].id,undefined);
      output.tables=[];assert.deepEqual((await generateMinutes(job,env)).tables,[]);
    }
  } finally {globalThis.fetch=original;}
});

test('Pi minutes repairs invalid topic structure once and accounts both attempts',async()=>{
 const {generateMinutes}=await import('../services/records/src/providers.mjs');const original=globalThis.fetch,evidence=[{segmentId:'s',revision:1}];let calls=0;const requests=[],usage=[];
 const valid={title:'候选方案核对',topics:[{id:'candidate',title:'候选方案',summary:'仍需验证',evidence}],sections:[{heading:'候选方案',items:[{text:'候选尚未实测，不承诺零丢失。',evidence,topicId:'candidate'}]}],actions:[]};
 globalThis.fetch=async(_url,options)=>{requests.push(JSON.parse(options.body));const output=structuredClone(valid);if(++calls===1)output.topics.push({...output.topics[0]});return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}}),{headers:{'content-type':'application/json'}});};
 try{
  const result=await generateMinutes({scope:'live',snapshot:[{id:'s',revision:1,text:'候选尚未实测，不承诺零丢失。'}]},{LLM_API_URL:'https://fixture.invalid/chat/completions',LLM_API_KEY:'synthetic-key',LLM_MODEL:'synthetic',LLM_PROTOCOL:'chat-completions'},{onUsage:value=>usage.push(value)});
  assert.equal(calls,2);assert.equal(result.runtime.engine,'pi');assert.equal(result.runtime.structureRepairs,1);assert.equal(result.usageTokens,60);assert.equal(result.tokenUsage.totalTokens,60);assert.equal(usage.at(-1).totalTokens,60);assert.equal(result.sections[0].items[0].text,valid.sections[0].items[0].text);assert.match(requests[1].messages[0].content,/上次.*未通过校验/);
 }finally{globalThis.fetch=original;}
});

test('minutes structure retry records a missing second usage report as unknown',async()=>{
 const {generateMinutes}=await import('../services/records/src/providers.mjs'),{meteredMinutesCall}=await import('../services/records/src/minutes-usage.mjs');
 const original=globalThis.fetch,evidence=[{segmentId:'s',revision:1}],record=createRecord('owner');let calls=0;
 const claim={id:'repair-usage',generation:record.generation,fence:'f',mode:'model',scope:'live',snapshot:[{id:'s',revision:1,text:'候选仍待验证'}]};record.jobs=[{...claim,status:'running'}];
 const output={title:'候选',topics:[{id:'t',title:'候选',summary:'待验证',evidence}],sections:[{heading:'候选',items:[{text:'候选仍待验证',evidence}]}],actions:[]};
 globalThis.fetch=async()=>{const result=structuredClone(output);if(++calls===1)result.topics.push({...result.topics[0]});return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}],...(calls===1?{usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}}:{})}),{headers:{'content-type':'application/json'}});};
 try{
  const result=await meteredMinutesCall({change:async(_id,change)=>change(record)},record.id,claim,generateMinutes,claim,{LLM_API_URL:'https://fixture.invalid/chat/completions',LLM_API_KEY:'synthetic-key',LLM_MODEL:'synthetic',LLM_PROTOCOL:'chat-completions'});
  assert.equal(calls,2);assert.equal(result.usageReported,false);assert.equal(record.usage.minutesMeter.requests,2);assert.equal(record.usage.minutesMeter.reportedRequests,1);assert.equal(record.usage.minutesMeter.totalTokens,30);assert.equal(record.usage.minutesMeter.totalTokensRequests,1);
 }finally{globalThis.fetch=original;}
});

test('minutes structure repair shares the original deadline instead of renewing the lease budget',async()=>{
 const {generateMinutes}=await import('../services/records/src/providers.mjs');const original=globalThis.fetch,originalNow=Date.now;let clock=originalNow(),calls=0;Date.now=()=>clock;
 const evidence=[{segmentId:'s',revision:1}],topic={id:'t',title:'候选',summary:'待验证',evidence};
 globalThis.fetch=async()=>{calls++;clock+=120001;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({title:'候选',topics:[topic,topic],sections:[{heading:'候选',items:[{text:'仍待验证',evidence}]}],actions:[]})}}]}),{headers:{'content-type':'application/json'}});};
 try{await assert.rejects(generateMinutes({scope:'live',snapshot:[{id:'s',revision:1,text:'仍待验证'}]},{LLM_API_URL:'https://fixture.invalid/chat/completions',LLM_API_KEY:'synthetic-key',LLM_MODEL:'synthetic',LLM_PROTOCOL:'chat-completions'}),{code:'llm_timeout'});assert.equal(calls,1);}finally{globalThis.fetch=original;Date.now=originalNow;}
});
test('minutes repairs invalid citations once with stronger automatic reasoning and retains both usages',async()=>{
  const {generateMinutes}=await import('../services/records/src/providers.mjs');
  const original=globalThis.fetch,efforts=[];let calls=0;
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);efforts.push(body.reasoning_effort);
    const output={title:'引用核对',sections:[{heading:'结论',items:[{text:'先核对来源',evidence:[{segmentId:++calls===1?'missing':'s1',revision:1}]}]}],actions:[]};
    return Response.json({choices:[{message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});
  };
  try{
    const result=await generateMinutes({scope:'live',snapshot:[{id:'s1',revision:1,text:'先核对来源'}]},{LLM_API_URL:'https://fixture.invalid/chat/completions',LLM_API_KEY:'synthetic-key',LLM_MODEL:'synthetic',LLM_PROTOCOL:'chat-completions',LLM_MODEL_PROFILES:JSON.stringify({synthetic:{reasoningEfforts:['low','medium','high','xhigh']}})});
    assert.deepEqual(efforts,['low','xhigh']);assert.equal(result.usageTokens,30);assert.equal(result.runtime.citationRepairs,1);assert.equal(result.sections[0].items[0].evidence[0].segmentId,'s1');
  }finally{globalThis.fetch=original;}
});
test('minutes citation repair shares the six-request window budget across Pi roots',async()=>{
  const {generateMinutes}=await import('../services/records/src/providers.mjs');const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{
    calls++;const output=calls<6?{toolCalls:[{name:'read_selected_meeting',arguments:{part:'transcript',page:0}}]}:{title:'Invalid citation',sections:[{heading:'Read',items:[{text:'Fixed source',evidence:[{segmentId:calls===6?'missing':'s',revision:1}]}]}],actions:[]};
    return Response.json({choices:[{message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});
  };
  try{await assert.rejects(generateMinutes({scope:'live',snapshot:[{id:'s',revision:1,text:'Fixed source'}]},{LLM_API_URL:'https://fixture.invalid/chat/completions',LLM_API_KEY:'synthetic-key',LLM_MODEL:'synthetic',LLM_PROTOCOL:'chat-completions',LLM_MODEL_PROFILES:JSON.stringify({synthetic:{contextWindow:128000}})}),{code:'pi_minutes_round_limit'});assert.equal(calls,6);}finally{globalThis.fetch=original;}
});
