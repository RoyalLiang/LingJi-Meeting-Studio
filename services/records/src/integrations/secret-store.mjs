import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Credentials stay encrypted in aggregates; the local key never enters exports or the client bundle.
export async function createSecretStore(root) {
  const file = join(root, 'integrations.key');
  let key;
  try { key = await readFile(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await writeFile(file, randomBytes(32), {flag:'wx', mode:0o600}); }
    catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
    key = await readFile(file);
  }
  if (key.length !== 32) throw new Error('integrations_key_invalid');
  return {
    seal(scope, value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(scope));
      const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
    },
    open(scope, value) {
      const bytes = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0,12));
      decipher.setAAD(Buffer.from(scope)); decipher.setAuthTag(bytes.subarray(12,28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
    }
  };
}
