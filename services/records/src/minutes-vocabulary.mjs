import { loadBuiltinVocabulary, selectBuiltinVocabulary } from './builtin-vocabulary.mjs';
import { correctionSpan } from '../../../packages/records/src/vocabulary.mjs';

const normalize = text => text.normalize('NFKC').toLowerCase();
function mentioned(context, word) {
  const value=normalize(word);if(!value)return false;
  for(let start=context.indexOf(value);start>=0;start=context.indexOf(value,start+1))if(correctionSpan(context,start,value))return true;
  return false;
}
function collectText(value, output) {
  if(Array.isArray(value)){for(const item of value)collectText(item,output);return;}
  if(!value||typeof value!=='object')return;
  for(const [key,item] of Object.entries(value)){
    if(['text','title','heading','summary','label'].includes(key)&&typeof item==='string')output.push(item);
    else if(item&&typeof item==='object')collectText(item,output);
  }
}
export function selectMinutesVocabulary(job, personal=[], builtin={available:false}) {
  const texts=[job.meetingTitle||'',job.notes||''];
  collectText(job.snapshot,texts);collectText(job.summaries,texts);collectText(job.liveContext,texts);
  const source=texts.join('\n').slice(0,180000),context=normalize(source),candidates=new Map();
  for(const entry of personal){
    const aliases=(entry.aliases||[]).filter(word=>mentioned(context,word));
    if(mentioned(context,entry.text)||aliases.length)candidates.set(normalize(entry.text),{entry,aliases,rank:3});
  }
  // Scan each bounded source window so terms in the middle of a long meeting survive.
  for(let start=0;start<source.length;start+=11000){
    for(const entry of selectBuiltinVocabulary(builtin,source.slice(start,start+12000))){
      const key=normalize(entry.text);if(candidates.has(key))continue;
      const rank=mentioned(context,entry.text)?2:(entry.anchors||[]).some(anchor=>mentioned(context,anchor))?0:1;
      candidates.set(key,{entry,aliases:[],rank});
    }
  }
  const ordered=[...candidates.values()].sort((a,b)=>b.rank-a.rank||a.entry.text.localeCompare(b.entry.text));
  const terms=[],aliases=[];let used=0,names=0,related=0;
  for(const candidate of ordered){
    const {entry,rank}=candidate,size=[...entry.text].length+1;
    if(used+size>1000||(entry.kind==='names'&&names>=8)||(rank===0&&related>=12))continue;
    terms.push(entry.text);used+=size;names+=Number(entry.kind==='names');related+=Number(rank===0);
    for(const from of candidate.aliases){const cost=[...from].length+[...entry.text].length+2;if(used+cost<=1000){aliases.push({from,to:entry.text});used+=cost;}}
    if(terms.length>=48)break;
  }
  return terms.length?{terms,...(aliases.length?{aliases}:{})}:undefined;
}
export async function withMinutesVocabulary(payload, job) {
  const vocabulary=selectMinutesVocabulary(job,job.vocabularyEntries||[],await loadBuiltinVocabulary());
  if(!vocabulary)return payload;
  const enriched={...payload,vocabulary};
  return JSON.stringify(enriched).length<180000?enriched:payload;
}
