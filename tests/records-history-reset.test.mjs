import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deleteRefsWithLease} from '../scripts/release-ref-lease.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lingji-history-lease-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const cwd = join(root, 'work'), remote = join(root, 'remote.git');
  const env = {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0'};
  await mkdir(cwd);
  const git = (...args) => execFileSync('git', args, {cwd, env, stdio: ['ignore', 'pipe', 'pipe']}).toString().trim();
  git('init', '--bare', '--initial-branch=main', remote);
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'History fixture');
  git('config', 'user.email', 'fixture@local.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  await writeFile(join(cwd, 'source.txt'), 'original\n');
  git('add', 'source.txt');
  git('commit', '-m', 'original');
  const original = git('rev-parse', 'HEAD');
  const names = ['refs/heads/dev_old', 'refs/heads/dev_unchanged', 'refs/tags/v0.2.51'];
  git('push', remote, 'HEAD:refs/heads/main', 'HEAD:refs/tags/v0.3.0', ...names.map(name => `HEAD:${name}`));
  const revision = name => git('--git-dir', remote, 'rev-parse', '--verify', name);
  const exists = name => {
    try { git('--git-dir', remote, 'show-ref', '--verify', '--quiet', name); return true; }
    catch (error) { if (error.status === 1) return false; throw error; }
  };
  return {cwd, remote, env, git, original, names, revision, exists, refs: names.map(name => ({name, sha: original}))};
}

test('history reset refuses every planned deletion atomically when one branch advances after preflight', async t => {
  const h = await fixture(t);
  const planned = structuredClone(h.refs);
  await writeFile(join(h.cwd, 'source.txt'), 'parallel user change\n');
  h.git('add', 'source.txt');
  h.git('commit', '-m', 'parallel user change');
  const advanced = h.git('rev-parse', 'HEAD');
  h.git('push', h.remote, 'HEAD:refs/heads/dev_old');
  assert.notEqual(advanced, h.original);
  assert.throws(() => deleteRefsWithLease(planned, {cwd: h.cwd, remote: h.remote, env: h.env}));
  assert.equal(h.revision('refs/heads/dev_old'), advanced, 'preserve the newly pushed commit');
  assert.equal(h.revision('refs/heads/dev_unchanged'), h.original, 'atomic rejection preserves the other branch');
  assert.equal(h.revision('refs/tags/v0.2.51'), h.original, 'atomic rejection preserves the old tag');
  assert.equal(h.revision('refs/heads/main'), h.original);
  assert.equal(h.revision('refs/tags/v0.3.0'), h.original);
});

test('history reset deletes the matching old branch and tag inventory while retaining main and the new release', async t => {
  const h = await fixture(t);
  deleteRefsWithLease(h.refs, {cwd: h.cwd, remote: h.remote, env: h.env});
  for (const name of h.names) assert.equal(h.exists(name), false, name);
  assert.equal(h.revision('refs/heads/main'), h.original);
  assert.equal(h.revision('refs/tags/v0.3.0'), h.original);
});

test('history reset validates protected refs before attempting any deletion', async t => {
  const h = await fixture(t);
  for (const name of ['refs/heads/main', 'refs/tags/v0.3.0']) {
    assert.throws(() => deleteRefsWithLease([h.refs[0], {name, sha: h.original}], {cwd: h.cwd, remote: h.remote, env: h.env}));
    for (const original of h.refs) assert.equal(h.revision(original.name), original.sha);
    assert.equal(h.revision(name), h.original);
  }
});
