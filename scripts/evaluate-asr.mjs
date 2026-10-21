import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateAsr } from '../packages/records/src/asr-evaluation.mjs';

export async function main(args=process.argv.slice(2)) {
  const [input,output]=args;
  if(!input || args.length>2)throw new Error('Usage: node scripts/evaluate-asr.mjs GOLD.jsonl [REPORT.json]');
  if((await stat(input)).size>16*1024*1024)throw new Error('evaluation_file_too_large');
  const rows=(await readFile(input,'utf8')).split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line));
  const report=evaluateAsr(rows),json=JSON.stringify(report,null,2)+'\n';
  if(output)await writeFile(output,json,{flag:'wx',mode:0o600});
  else process.stdout.write(json);
  return report;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
