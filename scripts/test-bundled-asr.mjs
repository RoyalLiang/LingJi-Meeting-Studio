// Run with the installed package's Node. Only locally prepared, pinned public fixtures are read;
// model/runtime must already exist in the installed application.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readAsrFixtures} from './asr-test-fixtures.mjs';
const directory=resolve(process.argv[2]);
const {transcribeLocalAsr,closeLocalAsr,LOCAL_ASR_MODEL}=await import(pathToFileURL(join(directory,'services/records/src/local-asr.mjs')));
const config={LINGJI_LOCAL_ASR_DIR:join(directory,'local-asr')},samples=[];
const manifest=JSON.parse(await readFile(join(config.LINGJI_LOCAL_ASR_DIR,'manifest.json')));
function pcm(wave){
  assert.equal(wave.toString('ascii',0,4),'RIFF');
  let format;
  for(let at=12;at+8<=wave.length;){
    const length=wave.readUInt32LE(at+4),kind=wave.toString('ascii',at,at+4);
    if(kind==='fmt ')format={codec:wave.readUInt16LE(at+8),channels:wave.readUInt16LE(at+10),rate:wave.readUInt32LE(at+12),bits:wave.readUInt16LE(at+22)};
    if(kind==='data'){
      assert.deepEqual(format,{codec:1,channels:1,rate:16000,bits:16});
      return wave.subarray(at+8,at+8+length);
    }
    at+=8+length+(length%2);
  }
  throw new Error('fixture_audio_missing');
}
// Download before inference starts; no model downloads or Python processes.
for(const {language,sha256,wave} of await readAsrFixtures(resolve(process.env.TTS_ASR_FIXTURE_CACHE||'.agent-runtime/runtimes/asr-fixtures'))){
  samples.push({language,sha256,bytes:pcm(wave)});
}
samples.push({language:'silence',bytes:Buffer.alloc(16000*2*5)});
const results=[];
try{
  for(const sample of samples){
    const began=performance.now(),text=await transcribeLocalAsr(sample.bytes,config);
    assert.equal(sample.language==='silence'?text.length===0:text.trim().length>0,true,sample.language);
    results.push({language:sample.language,fixtureSha256:sample.sha256,text,seconds:sample.bytes.length/32000,elapsedMs:Math.round(performance.now()-began)});
  }
}finally{await closeLocalAsr();}
const report={model:LOCAL_ASR_MODEL,runtime:manifest.runtime,onnxruntime:manifest.onnxruntime,node:process.version,platform:process.platform,arch:process.arch,packagedResourcesVerified:true,nativeInference:true,pythonRequired:false,modelDownloadedDuringInference:false,publicFixturesOnly:true,fixtureNetworkUsed:false,realAudioDevicesTested:false,meetingAccuracyEvaluated:false,results};
await writeFile(process.argv[3],JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
