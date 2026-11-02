import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encryptShare, decryptShare } from '../packages/records/src/encrypted-share.mjs';
import { exampleContent } from '../apps/site/src/example.mjs';

export async function verifyEncryptedSite(origin, fetcher = fetch) {
  const encrypted = await encryptShare(exampleContent), requestId = randomUUID();
  const path = `/api/encrypted-shares/${encrypted.token}`;
  const revoke = () => fetcher(origin + path, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, revokeToken: encrypted.revokeToken }), signal: AbortSignal.timeout(30000) });
  let revoked = false;
  try {
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, token: encrypted.token, revokeToken: encrypted.revokeToken, envelope: encrypted.envelope }), signal: AbortSignal.timeout(30000) };
    const created = await fetcher(origin + '/api/encrypted-shares', options);
    assert.ok(created.ok, 'Anonymous encrypted creation failed');
    const first = await created.json();
    const retried = await fetcher(origin + '/api/encrypted-shares', { ...options, signal: AbortSignal.timeout(30000) });
    assert.ok(retried.ok, 'Encrypted creation retry failed');
    assert.deepEqual(await retried.json(), first, 'Creation retry was not idempotent');
    const shell = await fetcher(origin + '/s/' + encrypted.token, { signal: AbortSignal.timeout(30000) });
    assert.equal(shell.status, 200, 'Encrypted reader shell unavailable');
    assert.match(await shell.text(), /encrypted-reader\.js/);
    const bundle = await fetcher(origin + '/encrypted-reader.js', { signal: AbortSignal.timeout(30000) });
    assert.equal(bundle.status, 200, 'Encrypted reader bundle unavailable');
    assert.match(bundle.headers.get('content-type') || '', /(?:application|text)\/(?:java|ecma)script\b/i, 'Encrypted reader bundle has incorrect MIME');
    assert.ok((await bundle.text()).trim(), 'Encrypted reader bundle empty');
    const read = await fetcher(origin + path, { signal: AbortSignal.timeout(30000) });
    assert.equal(read.status, 200, 'Encrypted content unavailable');
    assert.equal(read.headers.get('cache-control'), 'no-store');
    const wire = await read.text();
    assert.ok(!wire.includes(exampleContent.title) && !wire.includes(encrypted.key), 'Relay returned plaintext or key');
    const value = JSON.parse(wire);
    assert.equal((await decryptShare(value.envelope, encrypted.key, encrypted.token)).title, exampleContent.title);
    assert.ok(value.expires > Date.now() + 23 * 3600000 && value.expires < Date.now() + 25 * 3600000, 'Unexpected expiry');
    const response = await revoke();
    assert.ok(response.ok && (await response.json()).revoked, 'Encrypted revocation unconfirmed');
    revoked = true;
    assert.equal((await fetcher(origin + path, { signal: AbortSignal.timeout(30000) })).status, 404, 'Revoked ciphertext still readable');
    return { anonymousCreate: true, idempotency: true, readerShell: true, readerBundle: true, ciphertextOnly: true, payloadDecrypted: true, expiry: true, revoked: true };
  } finally {
    if (!revoked) {
      const response = await revoke();
      assert.ok(response.ok && (await response.json()).revoked, 'Verification cleanup revocation unconfirmed');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const checks = await verifyEncryptedSite('https://rookiecode.com');
    const receipt = { sha: process.env.GITHUB_SHA || '', origin: 'https://rookiecode.com', verifiedAt: new Date().toISOString(), checks };
    await writeFile('encrypted-site-verification.json', JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify(receipt));
  } catch (error) {
    const message = String(error.message).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]');
    await writeFile('encrypted-site-verification.json', JSON.stringify({ sha: process.env.GITHUB_SHA || '', origin: 'https://rookiecode.com', verifiedAt: new Date().toISOString(), status: 'failed', error: message }, null, 2) + '\n');
    console.error(message);
    process.exitCode = 1;
  }
}
