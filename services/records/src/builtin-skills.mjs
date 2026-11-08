import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {compile} from '@earendil-works/pi-schema';
import {requireThat} from '../../../packages/records/src/record.mjs';

const ids=['meeting-review','minutes-runtime'],cache=new Map();
const hash=value=>createHash('sha256').update(value).digest('hex');
const json=value=>JSON.stringify(value);
const read=(id,name)=>readFileSync(new URL(`./data/skills/${id}/${name}`,import.meta.url),'utf8').replaceAll('\r\n','\n');
const digestNames=['instructions','schema','inputs','expected'];
function load(id){
  requireThat(ids.includes(id),'builtin_skill_validation_failed',503);
  const raw={instructions:read(id,'SKILL.md'),schema:read(id,'output-schema.json'),inputs:read(id,'examples-input.json'),expected:read(id,'examples-expect.json')};
  const digests=Object.fromEntries(digestNames.map(key=>[key,hash(raw[key])]));
  return {id,...digests,instructionsText:raw.instructions,outputSchema:JSON.parse(raw.schema),cases:JSON.parse(raw.inputs),expectations:JSON.parse(raw.expected)};
}
function reviewValue(value){return {summary:value.summary,decisions:value.decisions,actions:value.actions?.map(item=>({...item,owner:item.owner??null})),artifacts:value.artifacts||[]};}
function citations(value,snapshots){
  const known=new Set(snapshots.flatMap(source=>source.segments.map(segment=>`${source.recordId}:${segment.id}:${segment.revision}`))),refs=[];
  const visit=item=>{
    if(!item||typeof item!=='object')return;
    if(Array.isArray(item.evidence))for(const ref of item.evidence){requireThat(known.has(`${ref.recordId||snapshots[0]?.recordId}:${ref.segmentId}:${ref.revision}`),'invalid_agent_output',502);refs.push(ref.segmentId);}
    for(const child of Object.values(item))if(child!==item.evidence)Array.isArray(child)?child.forEach(visit):visit(child);
  };visit(value);return refs;
}
function checkCases(pack,results){
  requireThat(Array.isArray(results)&&results.length===pack.cases.length&&new Set(results.map(item=>item.caseId)).size===results.length,'builtin_skill_validation_failed',503);
  const validator=compile(pack.outputSchema);
  for(const entry of pack.cases){
    const candidate=results.find(item=>item.caseId===entry.id)?.output;
    requireThat(candidate&&validator.check(pack.id==='meeting-review'?reviewValue(candidate):candidate),'builtin_skill_validation_failed',503);
    const refs=citations(candidate,entry.snapshots),expected=pack.expectations[entry.id],artifacts=candidate.artifacts||[],decisions=json(candidate.decisions||[]);
    requireThat(expected&&(!expected.noDecisions||!candidate.decisions?.length)&&(!expected.nonemptySections||candidate.sections.some(section=>section.items.length)),'builtin_skill_validation_failed',503);
    requireThat((expected.requiredEvidence||[]).every(id=>refs.includes(id))&&(expected.artifactKinds||[]).every(kind=>artifacts.some(item=>item.kind===kind)),'builtin_skill_validation_failed',503);
    requireThat(!(expected.forbiddenDecisionTerms||[]).some(term=>decisions.includes(term))&&(!expected.decisionTermsAny||expected.decisionTermsAny.some(term=>decisions.includes(term))),'builtin_skill_validation_failed',503);
    for(const artifact of artifacts){
      requireThat(artifact.status==='draft'&&(!expected.minOptions||artifact.kind!=='adr-draft'||artifact.options.length>=expected.minOptions),'builtin_skill_validation_failed',503);
      if(expected.unknownLikelihood&&artifact.kind==='risk-register')requireThat(artifact.risks.every(row=>row.likelihood==='unknown'),'builtin_skill_validation_failed',503);
    }
    if(expected.nullOwners){const rows=[...(candidate.actions||[]),...artifacts.flatMap(item=>item.risks||[])];requireThat(rows.every(row=>row.owner==null),'builtin_skill_validation_failed',503);}
  }
}
export function evaluateBuiltinSkill(id,results,sourceDigests){
  const pack=load(id);requireThat(['instructions','schema','inputs'].every(key=>sourceDigests?.[key]===pack[key]),'builtin_skill_examples_stale',409);checkCases(pack,results);
  return {version:1,skill:id,digests:Object.fromEntries(digestNames.map(key=>[key,pack[key]])),results};
}
export function verifyBuiltinEvaluation(id,evaluation){
  try{const pack=load(id);requireThat(evaluation?.skill===id&&evaluation.version===1&&digestNames.every(key=>evaluation.digests?.[key]===pack[key]),'builtin_skill_validation_failed',503);checkCases(pack,evaluation.results);return true;}catch{return false;}
}
export function builtinSkill(id){
  try{
  const pack=load(id),receipt=read(id,'evaluation.json'),key=id+digestNames.map(name=>pack[name]).join('')+hash(receipt);
  if(cache.get(id)!==key){requireThat(verifyBuiltinEvaluation(id,JSON.parse(receipt)),'builtin_skill_validation_failed',503);cache.set(id,key);}
  return {id,name:id==='meeting-review'?'会议复盘':'会中纪要',version:'1.0.0',contractVersion:1,contractDigest:hash(digestNames.map(name=>pack[name]).join('')),content:pack.instructionsText+'\n输出契约：'+json(pack.outputSchema),instructions:pack.instructionsText,outputSchema:pack.outputSchema};
  }catch{requireThat(false,'builtin_skill_validation_failed',503);}
}
export function builtinSkillStatuses(){return ids.map(id=>{try{const skill=builtinSkill(id);return {id,name:skill.name,version:skill.version,contractVersion:skill.contractVersion,ready:true,instructions:skill.instructions.replace(/^---[\s\S]*?---\s*/,'')};}catch{return {id,name:id==='meeting-review'?'会议复盘':'会中纪要',version:'1.0.0',contractVersion:1,ready:false};}});}
export function builtinOutputSchema(id){try{return load(id).outputSchema;}catch{return null;}}

export function validateReviewArtifacts(value,{snapshots,prompt='',requireFormat=false}){
  const normalized=reviewValue(value),schema=builtinOutputSchema('meeting-review');
  requireThat(schema&&compile(schema).check(normalized),'invalid_agent_output',502);citations(normalized,snapshots);
  const artifacts=normalized.artifacts;
  if(requireFormat){
    const kind=/\bADR\b|架构决策.*草稿/i.test(prompt)?'adr-draft':/风险登记表/.test(prompt)?'risk-register':null;
    if(kind)requireThat(artifacts.some(item=>item.kind===kind),'invalid_agent_output',502);
  }
  return artifacts;
}
const cell=value=>String(value??'待确认').replaceAll('|','\\|').replace(/[\r\n]+/g,'；');
const evidenceText=refs=>refs.map(ref=>`${ref.recordId}/${ref.segmentId}@${ref.revision}`).join('、');
export function artifactMarkdown(artifacts){return artifacts.map(artifact=>{
  if(artifact.kind==='risk-register')return `## ${cell(artifact.title)}（草稿）\n\n| 风险 | 影响 | 可能性 | 应对建议 | 负责人 | 依据 |\n| --- | --- | --- | --- | --- | --- |\n`+artifact.risks.map(row=>`| ${cell(row.text)} | ${cell(row.impact)} | ${{unknown:'待确认',low:'低',medium:'中',high:'高'}[row.likelihood]} | ${cell(row.mitigation)} | ${cell(row.owner)} | ${cell(evidenceText(row.evidence))} |`).join('\n');
  const list=items=>items.map(item=>`- ${item.text}（依据：${evidenceText(item.evidence)}）`).join('\n');
  return `## ${cell(artifact.title)}（ADR 草稿）\n\n### 背景\n${list(artifact.context)}\n\n### 备选方案\n${artifact.options.map(item=>`- ${item.title}：${item.description}（依据：${evidenceText(item.evidence)}）`).join('\n')}\n\n### 建议（待批准）\n${list([artifact.proposal])}\n\n### 影响\n${list(artifact.consequences)}\n\n### 待确认\n${list(artifact.openQuestions)}`;
}).join('\n\n');}
