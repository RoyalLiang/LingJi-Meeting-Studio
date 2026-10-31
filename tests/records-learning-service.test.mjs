import test from 'node:test';
import assert from 'node:assert/strict';
import { createLearningService, probeLearningService, learningServiceFor } from '../services/records/src/learning-service.mjs';
import { learningServiceTarget } from '../packages/records/src/learning.mjs';
import { readConfig, saveConfig, publicConfig } from '../services/records/src/config.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('learning has no default remote target and settings persist, validate and clear it',async()=>{
  const root=await mkdtemp(join(tmpdir(),'learning-settings-'));
  try{
    assert.deepEqual(learningServiceTarget({}),{host:'',remoteBase:''});
    assert.equal(publicConfig(await readConfig(root,{})).LEARNING_SSH_HOST,'');
    const values={LEARNING_SSH_HOST:'learning-host',LEARNING_REMOTE_BASE:'/opt/learning'};
    assert.equal((await saveConfig(root,values,{})).LEARNING_REMOTE_BASE,values.LEARNING_REMOTE_BASE);
    assert.deepEqual(learningServiceTarget(await readConfig(root,{})),{host:'learning-host',remoteBase:'/opt/learning'});
    await assert.rejects(saveConfig(root,{LEARNING_SSH_HOST:'-oProxyCommand=evil'},{}),{code:'invalid_learning_service_config'});
    await assert.rejects(saveConfig(root,{LEARNING_REMOTE_BASE:'relative/path'},{}),{code:'invalid_learning_service_config'});
    await assert.rejects(saveConfig(root,{LEARNING_SSH_HOST:''},{}),{code:'invalid_learning_service_config'});
    await saveConfig(root,{LEARNING_SSH_HOST:'',LEARNING_REMOTE_BASE:''},{});
    assert.deepEqual(learningServiceTarget(await readConfig(root,{})),{host:'',remoteBase:''});
    assert.equal((await learningServiceFor({root}).check()).available,false);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('an unconfigured probe never opens SSH and an explicit target uses the saved host and directory',async()=>{
  let calls=0;
  const execute=async(command,args)=>{calls++;assert.equal(command,'ssh');assert.equal(args.at(-2),'learning-host');assert.match(args.at(-1),/\/opt\/learning\/\.venv/);};
  assert.equal(await probeLearningService(learningServiceTarget({}),execute),false);assert.equal(calls,0);
  assert.equal(await probeLearningService({host:'learning-host',remoteBase:'/opt/learning'},execute),true);assert.equal(calls,1);
});

test('a settings change rejects a late probe from the previous target and checks again immediately',async()=>{
  let finish,calls=0;
  const service=createLearningService({probe:()=>++calls===1?new Promise(resolve=>{finish=resolve;}):false});
  const old=service.check();await Promise.resolve();service.invalidate();
  assert.equal((await service.check()).available,false);finish(true);await old;
  assert.equal(service.snapshot().available,false);assert.equal(calls,2);
});

test('learning detection is non-blocking, deduplicated, cached and recovers', async () => {
  let time = 100, calls = 0, done;
  const service = createLearningService({ now: () => time, ttl: 30, probe: () => { calls++; return new Promise(resolve => { done = resolve; }); } });
  assert.deepEqual(service.read(), { available:false, status:'checking', checkedAt:null });
  const first = service.check(), second = service.check();
  assert.equal(first, second);
  await Promise.resolve(); assert.equal(calls, 1);
  done(false); await first;
  assert.equal(service.read().available, false); assert.equal(service.snapshot().status, 'unavailable');
  await service.check(); assert.equal(calls, 1);
  time += 31; const retry = service.check(); await Promise.resolve(); done(true); await retry;
  assert.equal(service.snapshot().available, true); assert.equal(calls, 2);
});

test('a failed probe disables learning without exposing connection details', async () => {
  const service = createLearningService({ probe: async () => { throw Error('private connection details'); } });
  const result = await service.check();
  assert.equal(result.available, false); assert.equal(result.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result), /private/);
});


test('preparation publishes frozen review data without training, predictions or weak labels', async () => {
  const { finishPreparation } = await import('../scripts/alpha-learning/run.mjs');
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'learning-fast-'));
  try {
    await mkdir(join(dir,'prelabel'));
    const cases = [{sample_id:'one',input_hash:'same',family:'asr',source:{audioSha256:'audio'}}];
    await writeFile(join(dir,'prelabel/cases.jsonl'),cases.map(JSON.stringify).join('\n')+'\n');
    await writeFile(join(dir,'prelabel/manifest.json'),JSON.stringify({per_family:{asr:1},counts:{'train.jsonl':0}}));
    await writeFile(join(dir,'prelabel/asr-candidates.jsonl'),'original candidate\n');
    const report = await finishPreparation(dir,'r001',{fingerprint:'frozen'});
    assert.equal(report.trained,false);assert.equal(report.goldTestReady,false);assert.equal(report.baseScores,null);
    assert.equal(await readFile(join(dir,'teacher.jsonl'),'utf8'),'');
    assert.equal(await readFile(join(dir,'dataset/asr-candidates.jsonl'),'utf8'),'original candidate\n');
    const row = JSON.parse((await readFile(join(dir,'annotation-results.jsonl'),'utf8')).trim());
    assert.equal(row.input_hash,'same');assert.equal(row.target,null);assert.equal(row.audioVerified,false);
    assert.equal(row.basePrediction,undefined);
  } finally {await rm(dir,{recursive:true,force:true});}
});
