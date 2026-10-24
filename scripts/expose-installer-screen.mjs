// Publish bounded synthetic CI screenshots as check annotations, one page per step.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const name = process.argv[2];
assert.ok(['welcome', 'directory', 'settings', 'installing', 'finish', 'unexpected'].includes(name));
const bytes = await readFile(join('.agent-runtime/installer-ui', name + '.jpg')).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
if (bytes) {
  const encoded = bytes.toString('base64');
  assert.ok(encoded.length <= 60000, 'Screenshot exceeds ten check annotations');
  const parts = Math.ceil(encoded.length / 6000);
  for (let i = 0; i < parts; i++) console.log(`::notice title=LingJi installer ${name} ${i + 1}/${parts}::${encoded.slice(i * 6000, (i + 1) * 6000)}`);
} else console.log('Installer page not reached: ' + name);
