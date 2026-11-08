import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {builtinSkill,builtinSkillStatuses,verifyBuiltinEvaluation,evaluateBuiltinSkill,validateReviewArtifacts,artifactMarkdown} from '../services/records/src/builtin-skills.mjs';
import {minutesSchema} from '../services/records/src/minutes-prompts.mjs';
const data=new URL('../services/records/src/data/skills/',import.meta.url);
const load=(id,name)=>readFile(new URL(`${id}/${name}`,data),'utf8').then(JSON.parse);
test('built-in activation requires current instructions/schema/examples and passing independent outputs',async()=>{
  assert.ok(builtinSkillStatuses().every(item=>item.ready));
  for(const id of ['meeting-review','minutes-runtime']){
    const receipt=await load(id,'evaluation.json');assert.equal(verifyBuiltinEvaluation(id,receipt),true);assert.ok(builtinSkill(id).content.includes('输出契约'));
    const stale=structuredClone(receipt);stale.digests.instructions='0'.repeat(64);assert.equal(verifyBuiltinEvaluation(id,stale),false);
    const broken=structuredClone(receipt);broken.results[0].output.decisions=[{text:'invented',evidence:[{recordId:'outside',segmentId:'unknown',revision:99}]}];assert.equal(verifyBuiltinEvaluation(id,broken),false);
  }
  assert.deepEqual(await load('minutes-runtime','output-schema.json'),minutesSchema);
});
test('risk and ADR examples reject invented owners, approvals and missing alternatives',async()=>{
  const receipt=await load('meeting-review','evaluation.json'),results=structuredClone(receipt.results);
  results.find(item=>item.caseId==='risk-draft').output.artifacts[0].risks[0].owner='猜测负责人';assert.throws(()=>evaluateBuiltinSkill('meeting-review',results,receipt.digests),{code:'builtin_skill_validation_failed'});
  const approved=structuredClone(receipt.results);approved.find(item=>item.caseId==='adr-draft').output.artifacts[0].status='approved';assert.throws(()=>evaluateBuiltinSkill('meeting-review',approved,receipt.digests),{code:'builtin_skill_validation_failed'});
  const noChoice=structuredClone(receipt.results);noChoice.find(item=>item.caseId==='adr-draft').output.artifacts[0].options=[];assert.throws(()=>evaluateBuiltinSkill('meeting-review',noChoice,receipt.digests),{code:'builtin_skill_validation_failed'});
  assert.throws(()=>evaluateBuiltinSkill('meeting-review',receipt.results,{...receipt.digests,instructions:'old-source'}),{code:'builtin_skill_examples_stale'});
});
test('runtime validates every artifact citation and renders an explicitly unapproved draft',async()=>{
  const receipt=await load('meeting-review','evaluation.json'),inputs=await load('meeting-review','examples-input.json');
  for(const entry of inputs){const value=receipt.results.find(item=>item.caseId===entry.id).output,artifacts=validateReviewArtifacts(value,{...entry,requireFormat:true});if(artifacts.length){const text=artifactMarkdown(artifacts);assert.ok(text.includes('草稿'));assert.ok(text.includes(entry.snapshots[0].recordId));}}
  const input=inputs.find(item=>item.id==='risk-draft'),bad=structuredClone(receipt.results.find(item=>item.caseId==='risk-draft').output);bad.artifacts[0].risks[0].evidence[0].revision=999;
  assert.throws(()=>validateReviewArtifacts(bad,input),{code:'invalid_agent_output'});
});
