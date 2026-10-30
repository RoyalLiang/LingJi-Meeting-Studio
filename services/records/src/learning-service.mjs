import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shellQuote } from '../../../scripts/alpha-learning/run.mjs';
import { learningServiceTarget, validLearningServiceTarget } from '../../../packages/records/src/learning.mjs';
import { readConfig } from './config.mjs';

const execute = promisify(execFile);
export async function probeLearningService(target = learningServiceTarget(process.env), executeCommand = execute) {
  if(!validLearningServiceTarget(target))return false;
  const { host, remoteBase } = target;
  try {
    await executeCommand('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-o', 'ConnectionAttempts=1',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', host,
      `test -x ${shellQuote(remoteBase + '/.venv/bin/python')} && test -r ${shellQuote(remoteBase + '/model/tokenizer/tokenizer.json')} && ${shellQuote(remoteBase + '/.venv/bin/python')} -c ${shellQuote("import importlib.util,sys;sys.exit(not all(importlib.util.find_spec(name) for name in ('neohorse_decision','transformers')))" )}`],
    { timeout: 4500, maxBuffer: 4096, windowsHide: true });
    return true;
  } catch { return false; }
}

export function createLearningService({ probe = probeLearningService, now = Date.now, ttl = 30000 } = {}) {
  let value = { available: false, status: 'checking', checkedAt: null }, expires = 0, pending, generation=0;
  const snapshot = () => ({ ...value });
  const check = () => {
    if (pending) return pending;
    if (now() < expires) return Promise.resolve(snapshot());
    value = { ...value, status: 'checking' };
    const version=generation;
    pending = Promise.resolve().then(probe).then(available => {
      if(version!==generation)return;
      value = { available: available === true, status: available === true ? 'ready' : 'unavailable', checkedAt: now() };
    }, () => { if(version===generation)value = { available: false, status: 'unavailable', checkedAt: now() }; }).then(() => {
      if(version===generation){expires = now() + ttl; pending = undefined;} return snapshot();
    });
    return pending;
  };
  return { snapshot, check, invalidate() { generation++;pending=undefined;expires=0;value={available:false,status:'checking',checkedAt:null}; }, read() { void check(); return snapshot(); } };
}

const services = new WeakMap();
export function learningServiceFor(repo, probe) {
  if (!services.has(repo)) services.set(repo, createLearningService({probe:probe || (async()=>probeLearningService(learningServiceTarget(await readConfig(repo.root))))}));
  return services.get(repo);
}
