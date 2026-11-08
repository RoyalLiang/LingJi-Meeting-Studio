import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseBuiltinVocabulary, readBuiltinVocabulary, selectBuiltinVocabulary, loadBuiltinVocabulary } from '../services/records/src/builtin-vocabulary.mjs';
import { materializeBuiltinVocabulary } from '../scripts/materialize-builtin-vocabulary.mjs';
import { loadRecordVocabulary, recordAsrConfig } from '../services/records/src/vocabulary.mjs';
import { analyzeIntents } from '../services/records/src/providers.mjs';

function fixture(entries = [{text:'星河调度',kind:'term'}, {text:'NXGate',kind:'term'}, {text:'陆明轩',kind:'name'}, {text:'NX',kind:'term'}]) {
  const bytes = Buffer.from(JSON.stringify({schemaVersion:1,version:'fixture.1',entries}));
  const manifest = {schemaVersion:1,version:'fixture.1',entries:entries.length,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  return {bytes,manifest,pack:parseBuiltinVocabulary(bytes,manifest)};
}

test('context retrieval keeps names exact, word boundaries and budgets, independent of file order', () => {
  const {pack}=fixture();
  assert.deepEqual(selectBuiltinVocabulary(pack,''),[]);
  assert.deepEqual(selectBuiltinVocabulary(pack,'天气预报'),[]);
  assert.deepEqual(selectBuiltinVocabulary(pack,'陆明宣讨论'),[]);
  assert.deepEqual(selectBuiltinVocabulary(pack,'annxservice'),[]);
  assert.ok(selectBuiltinVocabulary(pack,'星河调渡还没有启用').some(e=>e.text==='星河调度'));
  const input='陆明轩讨论 NXGate、星河调度和 NX';
  const result=selectBuiltinVocabulary(pack,input,{budget:12});
  assert.ok(result.reduce((sum,e)=>sum+[...e.text].length+1,0)<=12);
  const reversed=fixture([...pack.entries].reverse().map(e=>({text:e.text,kind:e.kind==='names'?'name':'term'}))).pack;
  assert.deepEqual(selectBuiltinVocabulary(pack,input),selectBuiltinVocabulary(reversed,input));
  assert.deepEqual(pack.entries.map(e=>e.aliases),[[],[],[],[]]);
  const accented=fixture([{text:'Ann',kind:'name'},{text:'Åsa',kind:'name'}]).pack;
  assert.deepEqual(selectBuiltinVocabulary(accented,'éAnn xxÅsa'),[]);
  assert.equal(selectBuiltinVocabulary(accented,'联系Åsa讨论')[0].text,'Åsa');
  const codes=fixture([{text:'IN',kind:'term'},{text:'ON',kind:'term'}]).pack;
  assert.deepEqual(selectBuiltinVocabulary(codes,'worked in rain on Monday'),[]);
  assert.equal(selectBuiltinVocabulary(codes,'IN 模块')[0].text,'IN');
});

test('corpus co-occurrence recalls related business terms without adding names or spelling aliases', () => {
  const {pack}=fixture([{text:'星河调度',kind:'term'},{text:'托盘',kind:'term',frequency:20,anchors:['星河调度']},{text:'陆明轩',kind:'name'}]);
  assert.ok(selectBuiltinVocabulary(pack,'星河调度改造').some(e=>e.text==='托盘'));
  assert.ok(!selectBuiltinVocabulary(pack,'星河调度改造').some(e=>e.kind==='names'));
  assert.deepEqual(selectBuiltinVocabulary(pack,'天气晴朗'),[]);
  assert.throws(()=>fixture([{text:'星河调度',kind:'term'},{text:'陆明轩',kind:'name',anchors:['星河调度']}]),/anchors/);
});

test('fuzzy retrieval stays bounded with a maximum-sized pack and repeated context', () => {
  const entries=Array.from({length:30_000},(_,i)=>({text:'星河'+String.fromCharCode(0x4e00+Math.floor(i/200))+String.fromCharCode(0x4e00+i%200),kind:'term'}));
  const {pack}=fixture(entries),start=performance.now();
  const result=selectBuiltinVocabulary(pack,'星河风雨'.repeat(3000));
  assert.ok(performance.now()-start<1500,'retrieval must not block the audio worker for seconds');
  assert.ok(result.length<=64);
});

test('private pack validates digest, schema, duplicate normalization and term boundaries', () => {
  const {bytes,manifest}=fixture();
  assert.throws(()=>parseBuiltinVocabulary(Buffer.concat([bytes,Buffer.from(' ')]),manifest),/digest/);
  assert.throws(()=>fixture([{text:'NXGate',kind:'term'},{text:'nxgate',kind:'term'}]),/entry/);
  assert.throws(()=>fixture([{text:'词语\n指令',kind:'term'}]),/entry/);
  assert.throws(()=>fixture([{text:'一',kind:'term'}]),/entry/);
  assert.throws(()=>parseBuiltinVocabulary(bytes,{...manifest,entries:99}),/vocabulary/);
});

test('private materialization fails closed on missing or mismatched input and emits metadata only', async () => {
  const root=await mkdtemp(join(tmpdir(),'lingji-private-vocabulary-')),base=pathToFileURL(root+'/');
  const {bytes,manifest}=fixture();
  try {
    await writeFile(new URL('builtin-vocabulary.manifest.json',base),JSON.stringify(manifest));
    assert.equal((await readBuiltinVocabulary(base)).available,false);
    await assert.rejects(materializeBuiltinVocabulary({base,encoded:''}),/required/);
    await assert.rejects(materializeBuiltinVocabulary({base,encoded:gzipSync(Buffer.from('{}')).toString('base64')}),/digest/);
    await assert.rejects(access(new URL('builtin-vocabulary.private.json',base)));
    const result=await materializeBuiltinVocabulary({base,encoded:gzipSync(bytes).toString('base64')});
    assert.deepEqual(result,{version:manifest.version,entries:4,sha256:manifest.sha256});
    assert.deepEqual(await readFile(new URL('builtin-vocabulary.private.json',base)),bytes);
    assert.equal((await readBuiltinVocabulary(base)).entries.length,4);
    assert.deepEqual(await materializeBuiltinVocabulary({base,encoded:''}),result);
    const first='TTS_BUILTIN_VOCABULARY_GZIP_BASE64_PART1',second='TTS_BUILTIN_VOCABULARY_GZIP_BASE64_PART2';
    const previous=[process.env[first],process.env[second]],encoded=gzipSync(bytes).toString('base64');
    try {
      process.env[first]=encoded.slice(0,20);process.env[second]=encoded.slice(20);
      await rm(new URL('builtin-vocabulary.private.json',base));
      assert.deepEqual(await materializeBuiltinVocabulary({base}),result);
    } finally {
      for (const [index,key] of [first,second].entries()) {
        if (previous[index]===undefined) delete process.env[key];else process.env[key]=previous[index];
      }
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('bundled data reaches ASR hints and intent input without rewriting transcript or owner evidence', async t => {
  const pack=await loadBuiltinVocabulary();
  if (!pack.available) { t.skip('private build input is not available in this source checkout'); return; }
  const entry=pack.entries.find(e=>e.kind==='terms'&&e.text.length>=4&&e.text.length<=12);
  const record={owner:'fixture-owner',language:'zh',title:entry.text,notes:'',segments:[]};
  const repo={get:async()=>undefined};
  assert.ok((await loadRecordVocabulary(repo,record)).entries.some(e=>e.text===entry.text));
  assert.ok((await recordAsrConfig(repo,record,{})).ASR_VOCABULARY_HINTS.includes(entry.text));
  const snapshot=[{id:'fixture-segment',revision:7,text:`暂不采用${entry.text}，需要再确认。`}],before=JSON.stringify(snapshot);
  const previous=globalThis.fetch;let request;
  globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return Response.json({choices:[{message:{content:'{"items":[]}'}}]});};
  try {
    await analyzeIntents(snapshot,{LLM_PROTOCOL:'chat-completions',LLM_API_URL:'https://unused.invalid',LLM_API_KEY:'fixture',LLM_MODEL:'fixture'});
    const input=JSON.parse(request.messages.at(-1).content);
    assert.deepEqual(input.transcript,snapshot);assert.ok(input.vocabulary.terms.includes(entry.text));
    assert.match(request.messages[0].content,/不是事实证据/);
    assert.equal(JSON.stringify(snapshot),before);
    const context={padding:''};
    context.padding='x'.repeat(179990-JSON.stringify({transcript:snapshot,context}).length);
    await analyzeIntents(snapshot,{LLM_PROTOCOL:'chat-completions',LLM_API_URL:'https://unused.invalid',LLM_API_KEY:'fixture',LLM_MODEL:'fixture'},context);
    const bounded=JSON.parse(request.messages.at(-1).content);
    assert.deepEqual(bounded.transcript,snapshot);assert.equal(bounded.vocabulary,undefined);
    assert.equal(JSON.stringify(bounded).length,179990);
  } finally { globalThis.fetch=previous; }
});

test('fuzzy-only candidates do not each scan the entire repeated context for impossible exact matches',()=>{
 const entries=Array.from({length:30_000},(_,i)=>({text:'星河'+String.fromCharCode(0x4e00+Math.floor(i/200))+String.fromCharCode(0x4e00+i%200),kind:'term'}));
 const {pack}=fixture(entries),input='星河风雨'.repeat(3000),original=String.prototype.indexOf;let scans=0;
 String.prototype.indexOf=function(word,...args){if(this.length===input.length&&typeof word==='string'&&word.length>2)scans++;return original.call(this,word,...args);};
 try{assert.ok(selectBuiltinVocabulary(pack,input).length<=64);assert.ok(scans<256,`whole-context exact scans: ${scans}`);}finally{String.prototype.indexOf=original;}
});
