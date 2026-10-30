import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { learningServiceTarget, shellQuote } from '../../../scripts/alpha-learning/run.mjs';

const execute = promisify(execFile);
export async function probeLearningService() {
  const { host, remoteBase } = learningServiceTarget;
  try {
    await execute('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-o', 'ConnectionAttempts=1',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', host,
      `test -x ${shellQuote(remoteBase + '/.venv/bin/python')} && test -r ${shellQuote(remoteBase + '/model/tokenizer/tokenizer.json')} && ${shellQuote(remoteBase + '/.venv/bin/python')} -c ${shellQuote("import importlib.util,sys;sys.exit(not all(importlib.util.find_spec(name) for name in ('neohorse_decision','transformers')))" )}`],
    { timeout: 4500, maxBuffer: 4096, windowsHide: true });
    return true;
  } catch { return false; }
}

export function createLearningService({ probe = probeLearningService, now = Date.now, ttl = 30000 } = {}) {
  let value = { available: false, status: 'checking', checkedAt: null }, expires = 0, pending;
  const snapshot = () => ({ ...value });
  const check = () => {
    if (pending) return pending;
    if (now() < expires) return Promise.resolve(snapshot());
    value = { ...value, status: 'checking' };
    pending = Promise.resolve().then(probe).then(available => {
      value = { available: available === true, status: available === true ? 'ready' : 'unavailable', checkedAt: now() };
    }, () => { value = { available: false, status: 'unavailable', checkedAt: now() }; }).then(() => {
      expires = now() + ttl; pending = undefined; return snapshot();
    });
    return pending;
  };
  return { snapshot, check, read() { void check(); return snapshot(); } };
}

const services = new WeakMap();
export function learningServiceFor(repo, probe) {
  if (!services.has(repo)) services.set(repo, createLearningService(probe ? { probe } : {}));
  return services.get(repo);
}
