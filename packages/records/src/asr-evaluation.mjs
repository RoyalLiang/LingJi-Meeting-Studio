import { createHash } from 'node:crypto';

export const normalizeAsrText = text => text.normalize('NFKC').toLowerCase().replace(/\p{P}/gu, ' ').replace(/\s+/gu, ' ').trim();
export function editCounts(reference, hypothesis) {
  if(reference.length>4000 || hypothesis.length>4000)throw new Error('evaluation_segment_too_long');
  let previous=Array.from({length:hypothesis.length+1},(_,i)=>({errors:i,substitutions:0,deletions:0,insertions:i}));
  for(let i=1;i<=reference.length;i++) {
    const current=[{errors:i,substitutions:0,deletions:i,insertions:0}];
    for(let j=1;j<=hypothesis.length;j++) {
      if(reference[i-1]===hypothesis[j-1]){current.push(previous[j-1]);continue;}
      const choices=[['substitutions',previous[j-1]],['deletions',previous[j]],['insertions',current[j-1]]];
      const [kind,best]=choices.reduce((a,b)=>b[1].errors<a[1].errors?b:a);
      current.push({...best,errors:best.errors+1,[kind]:best[kind]+1});
    }
    previous=current;
  }
  return {...previous.at(-1),referenceUnits:reference.length};
}
const empty=()=>({errors:0,substitutions:0,deletions:0,insertions:0,referenceUnits:0});
const add=(total,value)=>{for(const key of Object.keys(total))total[key]+=value[key];};
const scored=counts=>({...counts,rate:counts.referenceUnits?counts.errors/counts.referenceUnits:null});
function score(reference,hypothesis,language) {
  const ref=normalizeAsrText(reference),hyp=normalizeAsrText(hypothesis);
  return {rawCer:editCounts(Array.from(reference),Array.from(hypothesis)),
    cer:editCounts(Array.from(ref.replace(/\s/gu,'')),Array.from(hyp.replace(/\s/gu,''))),
    ...(language==='en' ? {wer:editCounts(ref?ref.split(' '):[],hyp?hyp.split(' '):[])} : {})};
}
export function evaluateAsr(rows) {
  if(!Array.isArray(rows) || !rows.length || rows.length>10000)throw new Error('invalid_evaluation_dataset');
  const ids=new Set(),meetings=new Map(),audio=new Map(),groups=new Map();let evaluated=0;
  for(const row of rows) {
    if(!row || typeof row.id!=='string' || !row.id || ids.has(row.id) || typeof row.meetingId!=='string' || !row.meetingId || !['train','dev','test'].includes(row.split))throw new Error('invalid_evaluation_identity');
    ids.add(row.id);
    if(typeof row.audioSha256!=='string' || !/^[a-f0-9]{64}$/i.test(row.audioSha256))throw new Error('missing_audio_identity');
    for(const [map,key] of [[meetings,row.meetingId],[audio,row.audioSha256.toLowerCase()]]) {
      if(map.has(key)&&map.get(key)!==row.split)throw new Error('evaluation_split_leakage');
      map.set(key,row.split);
    }
    if(row.split==='train')continue;
    if(row.annotation?.listened!==true || row.annotation?.blind!==true || typeof row.annotation.guidelineVersion!=='string' || !row.annotation.guidelineVersion.trim())throw new Error('evaluation_requires_blind_audio_gold');
    if(!['zh','en','mixed'].includes(row.language) || ['reference','baseline','candidate'].some(key=>typeof row[key]!=='string' || [...row[key]].length>4000))throw new Error('invalid_evaluation_transcript');
    if(!normalizeAsrText(row.reference).replace(/\s/gu,'').length)throw new Error('empty_gold_reference');
    const key=`${row.split}:${row.language}`;
    if(!groups.has(key))groups.set(key,{split:row.split,language:row.language,samples:0,baseline:{rawCer:empty(),cer:empty(),...(row.language==='en'?{wer:empty()}:{})},candidate:{rawCer:empty(),cer:empty(),...(row.language==='en'?{wer:empty()}:{})}});
    const group=groups.get(key);group.samples++;evaluated++;
    for(const mode of ['baseline','candidate'])for(const [metric,value] of Object.entries(score(row.reference,row[mode],row.language)))add(group[mode][metric],value);
  }
  if(!evaluated)throw new Error('no_evaluation_gold');
  return {format:'lingji-asr-evaluation/v1',samples:evaluated,trainingSamplesExcluded:rows.length-evaluated,
    datasetSha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    normalization:'raw: verbatim Unicode code points; normalized: NFKC, lowercase, punctuation and whitespace removed for CER; whitespace words for English WER; digits and negation retained',
    groups:[...groups.values()].map(group=>({...group,
      baseline:Object.fromEntries(Object.entries(group.baseline).map(([metric,counts])=>[metric,scored(counts)])),
      candidate:Object.fromEntries(Object.entries(group.candidate).map(([metric,counts])=>[metric,scored(counts)])),
      cerRelativeReduction:group.baseline.cer.errors ? 1-group.candidate.cer.errors/group.baseline.cer.errors : null})),
    limitations:['Offline paired text scoring only; no recognition or acoustic training.', 'English WER is reported only for en samples.', 'Gold provenance flags must be audited; they do not prove human listening.', 'Overlapping slices must be assigned the same meetingId before evaluation.']};
}
