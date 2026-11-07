import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {downloadPinned} from './prepare-local-asr.mjs';

const fixtures={zh:'b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373',en:'eb1eb008904465b74c304aad8342e8c7d3c6e61ffe9f66adcaca9cf0f76a93f4'};
const source='https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/test_wavs';
export async function prepareAsrFixtures(directory){
 for(const [language,sha256] of Object.entries(fixtures))await downloadPinned(`${source}/${language}.wav`,join(directory,`${sha256}.wav`),'sha256',sha256);
 return directory;
}
export async function readAsrFixtures(directory){
 const result=[];
 for(const [language,sha256] of Object.entries(fixtures)){
  const wave=await readFile(join(directory,`${sha256}.wav`));
  assert.equal(createHash('sha256').update(wave).digest('hex'),sha256,`Public ASR fixture changed: ${language}`);
  result.push({language,sha256,wave});
 }
 return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const directory=resolve(process.argv[2]||'.agent-runtime/runtimes/asr-fixtures');await prepareAsrFixtures(directory);console.log('Pinned public ASR fixtures prepared');
}
