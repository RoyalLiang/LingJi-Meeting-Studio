import test from 'node:test';
import assert from 'node:assert/strict';
import { createLearningService } from '../services/records/src/learning-service.mjs';

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
