import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateMinutes } from '../services/records/src/providers.mjs';

test('minutes requests apply matched personal spelling references to all summary views', async t => {
  let request;
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;request=JSON.parse(body);
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({title:'项目推进',sections:[{heading:'进展',items:[{text:'本周讨论星河调度进度。',evidence:[0]}]}],actions:[]})}}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const job={mode:'model',scope:'final',template:'meeting',notes:'',snapshot:[{id:'s1',revision:1,text:'本周讨论星河调渡进度。',startMs:0,endMs:1000}],vocabularyEntries:[{kind:'terms',text:'星河调度',aliases:['星河调渡']}]};
  const original=structuredClone(job.snapshot);
  await generateMinutes(job,{LLM_API_URL:`http://127.0.0.1:${server.address().port}/v1/chat/completions`,LLM_PROTOCOL:'chat-completions',LLM_MODEL:'fixture-model',LLM_API_KEY:'fixture-key'});
  const input=JSON.parse(request.messages.findLast(item=>item.role==='user').content);
  assert.ok(input.vocabulary?.terms.includes('星河调度'),'matched dictionary references must reach the minutes request');
  assert.deepEqual(input.vocabulary.aliases,[{from:'星河调渡',to:'星河调度'}]);
  assert.match(request.messages.find(item=>item.role==='system').content,/highlights|速览/);
  assert.deepEqual(job.snapshot,original,'matching must not rewrite source transcript');
});

import { createHash } from 'node:crypto';
import { parseBuiltinVocabulary } from '../services/records/src/builtin-vocabulary.mjs';
import { selectMinutesVocabulary, withMinutesVocabulary } from '../services/records/src/minutes-vocabulary.mjs';
import { buildMinutesManifest } from '../services/records/src/minutes-pipeline.mjs';
function pack(entries){
  const bytes=Buffer.from(JSON.stringify({schemaVersion:1,version:'synthetic.1',entries}));
  return parseBuiltinVocabulary(bytes,{schemaVersion:1,version:'synthetic.1',entries:entries.length,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
test('minutes retrieval covers middle source windows and synthesis summaries',()=>{
  const builtin=pack([{text:'星河调度',kind:'term'},{text:'星桥校验',kind:'term'},{text:'陆明轩',kind:'name'}]);
  const job={snapshot:[{text:'天气晴朗。'.repeat(4500)+'星河调度已确认。'+'天气晴朗。'.repeat(4500)}],summaries:[{topics:[{summary:'星桥校验待复核。'}]}]};
  const result=selectMinutesVocabulary(job,[],builtin);
  assert.ok(result.terms.includes('星河调度'));assert.ok(result.terms.includes('星桥校验'));
  assert.ok(!result.terms.includes('陆明轩'),'unmentioned names must not be introduced');
});
test('personal aliases require lexical boundaries and unrelated entries stay out',()=>{
  const entries=[{text:'星河调度',kind:'terms',aliases:['星河调渡']},{text:'安宁',kind:'names',aliases:['Ann']},{text:'无关项目',kind:'terms',aliases:[]}];
  assert.equal(selectMinutesVocabulary({snapshot:[{text:'Annual report'}]},entries),undefined);
  const result=selectMinutesVocabulary({notes:'请核对星河调渡。',snapshot:[{text:'Ann 提到下一次会议。'}]},entries);
  assert.deepEqual(new Set(result.terms),new Set(['星河调度','安宁']));
  assert.equal(result.aliases.length,2);
});
test('minutes references keep strict word, name and character budgets',()=>{
  const entries=Array.from({length:80},(_,i)=>({text:`合成测试名称${i}`,kind:i<20?'names':'terms',aliases:[]}));
  const result=selectMinutesVocabulary({notes:entries.map(e=>e.text).join('。')},entries);
  assert.ok(result.terms.length<=48);
  assert.ok(result.terms.filter(t=>entries.find(e=>e.text===t).kind==='names').length<=8);
  assert.ok(result.terms.reduce((sum,t)=>sum+[...t].length+1,0)<=1000);
});
test('reference enrichment never pushes an existing request over its transport budget',async()=>{
  const payload={padding:'x'.repeat(179970)};
  const job={notes:'星河调渡',snapshot:[],vocabularyEntries:[{kind:'terms',text:'星河调度',aliases:['星河调渡']}]};
  assert.equal(await withMinutesVocabulary(payload,job),payload);
});
test('changed vocabulary snapshots invalidate cached minutes windows',()=>{
  const job={mode:'model',scope:'final',snapshot:[{id:'s1',revision:1,text:'讨论星河调度。',startMs:0,endMs:1000}],notes:'',meetingTitle:'项目周会',vocabularyFingerprint:'revision-1'};
  const first=buildMinutesManifest(job,{}),same=buildMinutesManifest({...job},{}),changed=buildMinutesManifest({...job,vocabularyFingerprint:'revision-2'},{});
  assert.equal(first.policy,same.policy);assert.notEqual(first.policy,changed.policy);assert.notEqual(first.windows[0].key,changed.windows[0].key);
});
