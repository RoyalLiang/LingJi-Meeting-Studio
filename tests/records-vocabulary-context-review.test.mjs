import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadBuiltinVocabulary, parseBuiltinVocabulary, selectBuiltinVocabulary } from '../services/records/src/builtin-vocabulary.mjs';
import { correctionCandidates, loadCorrectionVocabulary } from '../services/records/src/vocabulary.mjs';
import { phoneticCandidates } from '../packages/records/src/phonetic-vocabulary.mjs';
import { commonVocabulary } from '../packages/records/src/common-vocabulary.mjs';

function pack(entries) {
  const bytes=Buffer.from(JSON.stringify({schemaVersion:1,version:'context-review.fixture',entries}));
  return parseBuiltinVocabulary(bytes,{schemaVersion:1,version:'context-review.fixture',entries:entries.length,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}

test('exact-reference terms do not activate from a one-character near miss',()=>{
  const vocabulary=pack([{text:'待验收',kind:'term',match:'exact'},{text:'星河调度',kind:'term'}]);
  assert.ok(!selectBuiltinVocabulary(vocabulary,'该项待验售').some(e=>e.text==='待验收'));
  assert.ok(selectBuiltinVocabulary(vocabulary,'该项待验收').some(e=>e.text==='待验收'));
  assert.ok(selectBuiltinVocabulary(vocabulary,'星河调渡').some(e=>e.text==='星河调度'));
});

test('exact-reference terms never become phonetic replacements',()=>{
  const vocabulary=pack([{text:'已验收',kind:'term',match:'exact'}]);
  const result=phoneticCandidates([{id:'s1',revision:1,text:'以验收为准'}],vocabulary.entries,{version:'fixture',readings:{已:['yi3'],以:['yi3'],验:['yan4'],收:['shou1'],为:['wei2'],准:['zhun3']}});
  assert.equal(result.candidates.length,0);
});

test('unknown matching policy fails pack validation',()=>{
  assert.throws(()=>pack([{text:'待验收',kind:'term',match:'fuzzy'}]),/invalid_builtin_vocabulary_match/);
});

test('model review cannot turn an exact reference into a factual replacement',async t=>{
  const builtin=await loadBuiltinVocabulary();
  if(!builtin.available){t.skip('private pack not materialized');return;}
  const entry=builtin.entries.find(e=>e.match==='exact' && /^[\p{Script=Han}]{3,8}$/u.test(e.text));
  if(!entry){t.skip('pack has no exact reference fixture');return;}
  const original='丁'+entry.text.slice(1);
  const record={owner:'fixture',language:'zh',title:entry.text,segments:[{id:'s1',revision:1,startMs:0,endMs:1000,text:original}]};
  const result=await correctionCandidates({get:async()=>undefined},record,{model:true,complete:async()=>({corrections:[{segmentId:'s1',revision:1,original,replacement:entry.text}]})});
  assert.ok(!result.candidates.some(c=>c.segmentId==='s1' && c.replacement===entry.text),'exact references must not become model replacements');
});

test('bounded manual review retains middle-topic references in long records',async t=>{
  const builtin=await loadBuiltinVocabulary();
  if(!builtin.available){t.skip('private pack not materialized');return;}
  const unrelated='天气晴朗，今天聊聊午餐。'.repeat(20);
  const alreadySelected=new Set(selectBuiltinVocabulary(builtin,unrelated).map(e=>e.text));
  const entry=builtin.entries.find(e=>e.kind==='terms'&&e.match!=='exact'&&/^[\p{Script=Han}]{4,10}$/u.test(e.text)&&!alreadySelected.has(e.text));
  assert.ok(entry,'private pack must provide a contextual reference fixture');
  const record={owner:'fixture',language:'zh',title:'',segments:Array.from({length:121},(_,i)=>({id:'s'+i,revision:1,startMs:i*1000,text:i===60?entry.text:unrelated})).reverse()};
  const before=JSON.stringify(record);
  const result=await loadCorrectionVocabulary({get:async()=>undefined},record);
  assert.equal(result.segments.length,120);
  assert.ok(result.entries.some(e=>e.text===entry.text),'middle-topic reference must survive long review input');
  assert.ok(result.entries.filter(e=>e.builtin).length<=64);
  assert.ok(JSON.stringify(record)===before,'retrieval must preserve source order and revisions');
});

test('common vocabulary cannot bypass the private matching policy or retrieval budget',async t=>{
  const builtin=await loadBuiltinVocabulary();
  if(!builtin.available){t.skip('private pack not materialized');return;}
  const common=new Set(commonVocabulary.map(e=>e.text));
  const entry=builtin.entries.find(e=>e.match==='exact'&&common.has(e.text));
  if(!entry){t.skip('no policy overlap in current private input');return;}
  const longer=builtin.entries.filter(e=>e.kind==='terms'&&e.text.length>entry.text.length).slice(0,70);
  assert.equal(longer.length,70);
  const title=[...longer.map(e=>e.text),entry.text].join('；');
  assert.ok(!selectBuiltinVocabulary(builtin,title,{includeRelated:false}).some(e=>e.text===entry.text),'fixture must saturate the private retrieval budget');
  const record={owner:'fixture',language:'zh',title,segments:[{id:'s1',revision:1,startMs:0,text:entry.text}]};
  const result=await loadCorrectionVocabulary({get:async()=>undefined},record);
  assert.ok(!result.entries.some(e=>e.text===entry.text),'common fallback must not reintroduce an excluded private reference');
});

test('manual correction reviews retrieve terms from earlier reviewed utterances',async t=>{
  const builtin=await loadBuiltinVocabulary();
  if(!builtin.available){t.skip('private build input is not available in this source checkout');return;}
  const entry=builtin.entries.find(e=>e.kind==='terms'&&e.match!=='exact'&&/^[\p{Script=Han}]{4,10}$/u.test(e.text));
  assert.ok(entry,'bundled corpus must contain a business phrase');
  const mistaken=entry.text.slice(0,-1)+(entry.text.endsWith('错')?'试':'错');
  const record={owner:'review-owner',language:'zh',title:'',notes:'',segments:[
    {id:'early',revision:7,startMs:0,endMs:1000,text:entry.text+'；'+mistaken+'仍待核对。'},
    ...Array.from({length:3},(_,i)=>({id:'tail-'+i,revision:1,startMs:1000+i*1000,endMs:2000+i*1000,text:'天气晴朗，今天聊聊午餐。'})),
  ]};
  const before=JSON.stringify(record);let called=false;
  const result=await correctionCandidates({get:async()=>undefined},record,{model:true,complete:async messages=>{
    called=true;const input=JSON.parse(messages.at(-1).content);
    assert.ok(input.vocabulary.some(e=>e.text===entry.text),'earlier reviewed context must supply the spelling reference');
    return {corrections:[{segmentId:'early',revision:7,original:mistaken,replacement:entry.text}]};
  }});
  assert.ok(called,'review should not lose vocabulary because the last three utterances changed topic');
  assert.ok(result.candidates.some(c=>c.segmentId==='early'&&c.replacement===entry.text),'earlier review candidate missing');
  assert.ok(JSON.stringify(record)===before,'preview must preserve original text and versions');
  assert.equal(result.fingerprint,(await loadCorrectionVocabulary({get:async()=>undefined},record)).fingerprint);
});
