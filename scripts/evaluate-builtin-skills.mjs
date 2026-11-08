import {readFile,writeFile,rename} from 'node:fs/promises';
import {evaluateBuiltinSkill,builtinSkillStatuses} from '../services/records/src/builtin-skills.mjs';
const args=process.argv.slice(2),input=args.find(value=>!value.startsWith('--'));
if(input){
  const results=JSON.parse(await readFile(input,'utf8'));
  const receipts=['meeting-review','minutes-runtime'].map(id=>({id,value:evaluateBuiltinSkill(id,results[id],results.sourceDigests?.[id])}));
  if(args.includes('--write'))for(const {id,value}of receipts){const path=new URL(`../services/records/src/data/skills/${id}/evaluation.json`,import.meta.url),temp=new URL(path.href+'.tmp');await writeFile(temp,JSON.stringify(value,null,2)+'\n');await rename(temp,path);}
  for(const {id,value}of receipts)console.log(`${id}: ${value.results.length} examples passed${args.includes('--write')?'; activation receipt updated':''}`);
}else{
  const states=builtinSkillStatuses();for(const state of states)console.log(`${state.id}: ${state.ready?'validated':'disabled; examples or receipt invalid'}`);
  if(states.some(state=>!state.ready))process.exitCode=1;
}
