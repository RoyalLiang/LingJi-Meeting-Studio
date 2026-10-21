import test from 'node:test';
import assert from 'node:assert/strict';
import { editCounts, evaluateAsr } from '../packages/records/src/asr-evaluation.mjs';
import { doubaoRecognitionRequest, doubaoRecognitionForLanguage, doubaoAudioConfig } from '../services/records/src/asr-terms.mjs';
import { saveConfig, readConfig } from '../services/records/src/config.mjs';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const config={DOUBAO_ASR_URL:'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'};
test('second-pass language follows the endpoint contract, while nostream allows explicit English',()=>{
  for(const language of ['zh','en','zhen'])assert.equal(doubaoAudioConfig(config,language).language,undefined);
  assert.equal(doubaoAudioConfig({...config,DOUBAO_ASR_URL:config.DOUBAO_ASR_URL.replace('async','nostream')},'en').language,'en-US');
});
test('opt-in domain context coexists with terminology and requires second-pass mode',()=>{
  const request=doubaoRecognitionRequest({...config,DOUBAO_ASR_CONTEXT:'港口车辆路径规划',DOUBAO_ASR_HOTWORDS:'FMS,Redis'});
  assert.equal(request.enable_ddc,false);
  assert.deepEqual(JSON.parse(request.corpus.context),{hotwords:[{word:'FMS'},{word:'Redis'}],context_type:'dialog_ctx',context_data:[{text:'港口车辆路径规划'}]});
  assert.equal(doubaoRecognitionRequest({}).corpus,undefined);
  assert.throws(()=>doubaoRecognitionRequest({DOUBAO_ASR_CONTEXT:'测试'},{secondPass:false}),{code:'asr_context_requires_second_pass'});
});
test('global context does not block non-second-pass languages',()=>{
  const contextual={...config,DOUBAO_ASR_CONTEXT:'港口调度',DOUBAO_ASR_HOTWORDS:'Redis'};
  const japanese=doubaoRecognitionForLanguage(contextual,'ja');
  assert.equal(japanese.enable_nonstream,undefined);
  assert.deepEqual(JSON.parse(japanese.corpus.context),{hotwords:[{word:'Redis'}]});
  assert.equal(JSON.parse(doubaoRecognitionForLanguage(contextual,'en').corpus.context).context_data[0].text,'港口调度');
});
test('context configuration can be saved and cleared without overwriting transcript history',async()=>{
  const root=await mkdtemp(join(tmpdir(),'asr-context-'));
  try {
    await saveConfig(root,{DOUBAO_ASR_CONTEXT:'业务背景'},{});assert.equal((await readConfig(root,{})).DOUBAO_ASR_CONTEXT,'业务背景');
    await assert.rejects(saveConfig(root,{DOUBAO_ASR_CONTEXT:'字'.repeat(401)},{}),{code:'invalid_asr_context'});
    await assert.rejects(saveConfig(root,{DOUBAO_ASR_URL:'wss://example.test/bigmodel'},{ }),{code:'asr_context_requires_second_pass'});
    await saveConfig(root,{DOUBAO_ASR_CONTEXT:''},{});assert.equal((await readConfig(root,{})).DOUBAO_ASR_CONTEXT,'');
  } finally {await rm(root,{recursive:true,force:true});}
});
const row=(extra={})=>({id:'test-a',meetingId:'meeting-a',split:'test',audioSha256:'a'.repeat(64),language:'zh',reference:'不能在周五发布',baseline:'能在周五发布',candidate:'不能在周五发布',annotation:{listened:true,blind:true,guidelineVersion:'v1'},...extra});
test('paired scoring counts substitutions deletions and insertions without capping rates',()=>{
  assert.deepEqual(editCounts(['甲','乙'],['甲','丙','丁']),{errors:2,substitutions:1,deletions:0,insertions:1,referenceUnits:2});
  const report=evaluateAsr([row()]);assert.equal(report.groups[0].baseline.cer.deletions,1);assert.equal(report.groups[0].candidate.cer.rate,0);assert.equal(report.groups[0].cerRelativeReduction,1);
  const inserted=evaluateAsr([row({reference:'甲',baseline:'甲乙丙',candidate:'甲'})]);assert.equal(inserted.groups[0].baseline.cer.rate,2);
  assert.equal(report.groups[0].candidate.wer,undefined);assert.ok(!JSON.stringify(report).includes('不能在周五发布'));
});
test('normalized and raw scores stay separate and English WER uses explicit language',()=>{
  const report=evaluateAsr([row({language:'en',reference:'Do NOT ship 12 units.',baseline:'Do ship 13 units.',candidate:'do not ship 12 units'})]);
  const group=report.groups[0];assert.equal(group.candidate.cer.rate,0);assert.ok(group.candidate.rawCer.rate>0);assert.equal(group.candidate.wer.rate,0);assert.ok(group.baseline.wer.rate>0);
});
test('gold scoring refuses missing listening confirmation, duplicate IDs and split leakage',()=>{
  assert.throws(()=>evaluateAsr([row({annotation:{listened:false}})]),/blind_audio_gold/);
  assert.throws(()=>evaluateAsr([row(),row()]),/identity/);
  assert.throws(()=>evaluateAsr([row(),row({id:'b',split:'train'})]),/split_leakage/);
  assert.throws(()=>evaluateAsr([row(),row({id:'b',meetingId:'other',split:'dev'})]),/split_leakage/);
  assert.throws(()=>evaluateAsr([row({reference:''})]),/empty_gold/);
  assert.throws(()=>evaluateAsr([row(),row({id:'b',meetingId:'other',split:'dev',audioSha256:'A'.repeat(64)})]),/split_leakage/);
  assert.throws(()=>evaluateAsr([row({audioSha256:['a'.repeat(64)]})]),/audio_identity/);
});
