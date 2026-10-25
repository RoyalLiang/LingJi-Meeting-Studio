import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chronologicalSegments } from '../packages/records/src/live-minutes.mjs';
import { ruleIntents } from '../packages/records/src/intents.mjs';
import { validateMinutes } from '../packages/records/src/record.mjs';
import { analyzeIntents, generateMinutes } from '../services/records/src/providers.mjs';
import { MINUTES_PROMPT_VERSION } from '../services/records/src/minutes-prompts.mjs';

export async function evaluateMinutes({provider=false,env=process.env}={}) {
  const cases=JSON.parse(await readFile(new URL('../tests/fixtures/minutes-context.json',import.meta.url),'utf8'));
  const results=[];let correct=0,total=0,wrongDecisions=0,missingDecisions=0,expectedDecisions=0,actualDecisions=0;
  for(const entry of cases){
    const turns=entry.turns.map((text,index)=>({id:`s${index}`,revision:1,text,startMs:entry.times?.[index]??index*1000,endMs:(entry.times?.[index]??index*1000)+1000,speakerId:`speaker-${index%2}`,speaker:`发言人${index%2+1}`,sourceId:`source-${index%2}`}));
    const arrival=(entry.arrival || turns.map((_,index)=>index)).map(index=>turns[index]);
    const snapshot=chronologicalSegments(arrival),started=performance.now();
    const intents=provider?await analyzeIntents(snapshot,env):ruleIntents(snapshot);
    const predicted=turns.map(turn=>intents.items.find(item=>item.evidence.some(ref=>ref.segmentId===turn.id))?.kind??null);
    predicted.forEach((kind,index)=>{total++;if(kind===entry.kinds[index])correct++;});
    let minutes;
    if(provider){
      minutes=await generateMinutes({scope:'final',template:'meeting',snapshot,notes:''},env);validateMinutes(minutes,snapshot);
      const expected=new Set(entry.activeDecisions.map(index=>turns[index].id)),decisions=minutes.decisions || [];
      expectedDecisions+=expected.size;actualDecisions+=decisions.length;
      wrongDecisions+=decisions.filter(item=>!item.evidence.some(ref=>expected.has(ref.segmentId))).length;
      missingDecisions+=[...expected].filter(id=>!decisions.some(item=>item.evidence.some(ref=>ref.segmentId===id))).length;
    }
    results.push({name:entry.name,expectedKinds:entry.kinds,predictedKinds:predicted,durationMs:Math.round(performance.now()-started),...(minutes?{minutes}:{} )});
  }
  return {mode:provider?'provider':'local-rules',promptVersion:MINUTES_PROMPT_VERSION,cases:cases.length,intentAccuracy:correct/total,
    ...(provider?{decisionPrecision:actualDecisions?(actualDecisions-wrongDecisions)/actualDecisions:expectedDecisions?0:1,decisionRecall:expectedDecisions?(expectedDecisions-missingDecisions)/expectedDecisions:1,wrongDecisions,missingDecisions}:{}),
    limitation:'合成样例；意图逐项比对，决定按预期证据匹配。不能替代真实会议人工语义评分。',results};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const provider=process.argv.includes('--provider');
  if(provider&&existsSync('.env'))process.loadEnvFile('.env');
  const report=await evaluateMinutes({provider});
  const outputIndex=process.argv.indexOf('--output');
  if(outputIndex>=0){if(!process.argv[outputIndex+1])throw Error('missing_output_path');await writeFile(process.argv[outputIndex+1],JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify(report,null,2));
}
