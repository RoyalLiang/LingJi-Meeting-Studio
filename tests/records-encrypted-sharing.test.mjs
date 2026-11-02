import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptShare, decryptShare, normalizeEncryptedEnvelope, shareFingerprint } from '../packages/records/src/encrypted-share.mjs';
import { encryptedShareRoute } from '../apps/site/src/encrypted-shares.mjs';
import { createPublishedContent } from '../packages/records/src/published-content.mjs';
import { exampleContent } from '../apps/site/src/example.mjs';
import { createEncryptedSharing } from '../services/records/src/encrypted-sharing.mjs';
import { createRepository } from '../services/records/src/repository.mjs';
import { createRecord, digest } from '../packages/records/src/record.mjs';
import { createRecordServer } from '../services/records/src/server.mjs';

async function relay(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(await readFile(new URL('../apps/site/migrations/0002_encrypted_shares.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  let loseResponse = false;
  const db = { withSession() { return this; }, prepare(sql) { return { bind(...args) { return { async first() { return sqlite.prepare(sql).get(...args); }, async run() { const result = sqlite.prepare(sql).run(...args); if (loseResponse && sql.startsWith('INSERT')) { loseResponse = false; throw Error('response lost'); } return { meta: { changes: Number(result.changes) } }; } }; } }; } };
  const call = (path, method = 'GET', value, ip = '192.0.2.1') => encryptedShareRoute(new Request('https://fixture.invalid' + path, { method, headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip }, ...(value ? { body: JSON.stringify(value) } : {}) }), { DB: db, ASSETS: { fetch: async () => new Response(await readFile(new URL('../apps/site/public/encrypted.html', import.meta.url), 'utf8')) } });
  return { sqlite, call, loseNextCommit() { loseResponse = true; } };
}
const wire = encrypted => ({ requestId: crypto.randomUUID(), token: encrypted.token, revokeToken: encrypted.revokeToken, envelope: encrypted.envelope });
const record = () => ({ ...createRecord('owner-a', { title: exampleContent.title }), id: exampleContent.sourceRecordId, capture: 'completed', minutes: structuredClone(exampleContent.minutes), segments: [], notes: 'never share this note' });

test('AES-GCM roundtrip rejects changed content, a wrong key, a different link and oversized input', async () => {
  const encrypted = await encryptShare(exampleContent);
  assert.equal((await decryptShare(encrypted.envelope, encrypted.key, encrypted.token)).title, exampleContent.title);
  assert.doesNotMatch(JSON.stringify(encrypted.envelope), /上线|验证|sourceRecordId/);
  const other = await encryptShare(exampleContent);
  await assert.rejects(decryptShare(encrypted.envelope, other.key, encrypted.token), { code: 'share_decryption_failed' });
  await assert.rejects(decryptShare(encrypted.envelope, encrypted.key, other.token), { code: 'share_decryption_failed' });
  const changed = { ...encrypted.envelope, ciphertext: (encrypted.envelope.ciphertext[0] === 'A' ? 'B' : 'A') + encrypted.envelope.ciphertext.slice(1) };
  await assert.rejects(decryptShare(changed, encrypted.key, encrypted.token), { code: 'share_decryption_failed' });
  assert.throws(() => normalizeEncryptedEnvelope({ ...encrypted.envelope, key: encrypted.key }));
  const huge = structuredClone(exampleContent); huge.minutes.sections = Array.from({ length: 9 }, () => ({ heading: 'x', items: [{ text: 'x'.repeat(95000), evidence: [] }] }));
  await assert.rejects(encryptShare(huge), { code: 'encrypted_share_too_large' });
});

test('anonymous relay stores only ciphertext, retries a committed insert, and requires the separate revoke capability', async t => {
  const remote = await relay(t), encrypted = await encryptShare(exampleContent), body = wire(encrypted);
  remote.loseNextCommit();
  const created = await remote.call('/api/encrypted-shares', 'POST', body);
  assert.equal(created.status, 200);
  const first = await created.json(), duplicate = await (await remote.call('/api/encrypted-shares', 'POST', body)).json();
  assert.deepEqual(first, duplicate);
  assert.equal(remote.sqlite.prepare('SELECT COUNT(*) AS n FROM encrypted_shares').get().n, 1);
  const stored = JSON.stringify(remote.sqlite.prepare('SELECT * FROM encrypted_shares').get());
  for (const secret of [encrypted.key, encrypted.token, encrypted.revokeToken, exampleContent.title, exampleContent.sourceRecordId]) assert.ok(!stored.includes(secret));
  const read = await remote.call('/api/encrypted-shares/' + encrypted.token);
  assert.equal(read.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await decryptShare((await read.json()).envelope, encrypted.key, encrypted.token)).title, exampleContent.title);
  await assert.rejects(remote.call('/api/encrypted-shares/' + encrypted.token, 'DELETE', { requestId: body.requestId, revokeToken: encrypted.key }), { status: 404 });
  const conflict = { ...body, envelope: (await encryptShare(exampleContent)).envelope };
  await assert.rejects(remote.call('/api/encrypted-shares', 'POST', conflict), { status: 409 });
  assert.equal((await remote.call('/api/encrypted-shares/' + encrypted.token, 'DELETE', { requestId: body.requestId, revokeToken: encrypted.revokeToken })).status, 200);
  assert.equal(remote.sqlite.prepare('SELECT payload FROM encrypted_shares').get().payload, null);
  await assert.rejects(remote.call('/api/encrypted-shares/' + encrypted.token), { status: 404 });
  await assert.rejects(remote.call('/api/encrypted-shares', 'POST', body), { status: 410 });
});

test('relay enforces expiry, hourly upload limits and bounded envelopes without plaintext acceptance', async t => {
  const remote = await relay(t);
  await assert.rejects(remote.call('/api/encrypted-shares', 'POST', { ...wire(await encryptShare(exampleContent)), content: exampleContent }), { status: 400 });
  let last;
  for (let index = 0; index < 20; index++) { last = await encryptShare(exampleContent); assert.equal((await remote.call('/api/encrypted-shares', 'POST', wire(last))).status, 201); }
  await assert.rejects(remote.call('/api/encrypted-shares', 'POST', wire(await encryptShare(exampleContent))), { status: 429 });
  remote.sqlite.prepare('UPDATE encrypted_shares SET expires_at=1').run();
  await assert.rejects(remote.call('/api/encrypted-shares/' + last.token + '/status'), { status: 404 });
  assert.equal((await remote.call('/api/encrypted-shares', 'POST', wire(await encryptShare(exampleContent)), '192.0.2.2')).status, 201);
  assert.equal(remote.sqlite.prepare('SELECT COUNT(*) AS n FROM encrypted_shares WHERE expires_at=1 AND payload IS NOT NULL').get().n, 0);
});

test('a persistent revocation tombstone prevents a delayed create from reviving an unknown upload', async t => {
  const remote = await relay(t), encrypted = await encryptShare(exampleContent), body = wire(encrypted);
  remote.loseNextCommit();
  const revoked = await remote.call('/api/encrypted-shares/' + encrypted.token, 'DELETE', { requestId: body.requestId, revokeToken: encrypted.revokeToken });
  assert.equal(revoked.status, 200);
  await assert.rejects(remote.call('/api/encrypted-shares', 'POST', body), { status: 410 });
  assert.equal(remote.sqlite.prepare('SELECT payload FROM encrypted_shares').get().payload, null);
  await assert.rejects(remote.call('/api/encrypted-shares/' + encrypted.token), { status: 404 });
});

test('content changes invalidate confirmation and old pending snapshots cannot be retried under a new preview', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lingji-share-fence-')), repo = await createRepository({ root, databaseUrl: '' });
  t.after(async () => { await repo.close(); await rm(root, { recursive: true, force: true }); });
  let calls = 0;
  const sharing = createEncryptedSharing(repo, { fetcher: async () => { calls++; throw Error('unknown network outcome'); } });
  const source = record(), requestId = crypto.randomUUID(), fingerprint = await shareFingerprint(createPublishedContent(source, 'minutes'));
  const input = { requestId, scope: 'minutes', confirmed: true, fingerprint };
  await assert.rejects(sharing.create('owner-a', source, { ...input, fingerprint: 'a'.repeat(64) }), { code: 'share_content_changed' });
  assert.equal(calls, 0);
  await assert.rejects(sharing.create('owner-a', source, input), { code: 'encrypted_share_unavailable' });
  source.minutes.sections[0].items[0].text = '修订后不再包含先前内容';
  const current = await shareFingerprint(createPublishedContent(source, 'minutes'));
  await assert.rejects(sharing.create('owner-a', source, { ...input, fingerprint: current }), { code: 'share_content_changed' });
  assert.equal(calls, 1, 'changed content does not upload the old envelope');
  const pending = (await repo.list('encrypted-share'))[0];
  const unavailable = createEncryptedSharing(repo, { fetcher: async () => Response.json({ error: 'not_found' }, { status: 404 }) });
  await assert.rejects(unavailable.revoke('owner-a', source.id, pending.id), { code: 'encrypted_share_missing' });
  assert.ok((await repo.get(pending.id)).revokeToken, 'unconfirmed revocation retains management capability');
  assert.equal((await repo.get(pending.id)).revoked, false);
});

test('client persists the original key before upload, recovers from unknown outcomes, isolates owners and revokes after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lingji-encrypted-')), repo = await createRepository({ root, databaseUrl: '' }), remote = await relay(t);
  t.after(async () => { await repo.close(); await rm(root, { recursive: true, force: true }); });
  const requests = []; let lost = true;
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    const result = await remote.call(new URL(url).pathname, init.method, body);
    if (lost) { lost = false; throw Error('lost after commit'); }
    return result;
  };
  const sharing = createEncryptedSharing(repo, { fetcher }), source = record(), input = { requestId: crypto.randomUUID(), scope: 'minutes', confirmed: true, fingerprint: await shareFingerprint(createPublishedContent(source, 'minutes')) };
  await assert.rejects(sharing.create('owner-a', source, { ...input, confirmed: false }), { status: 400 });
  await assert.rejects(sharing.create('owner-a', source, input), { code: 'encrypted_share_unavailable' });
  const pending = (await repo.list('encrypted-share'))[0];
  assert.ok(pending.key && pending.envelope);
  const link = await sharing.create('owner-a', source, input);
  assert.deepEqual(requests[0], requests[1]);
  assert.ok(!JSON.stringify(requests).includes(pending.key));
  assert.ok(!JSON.stringify(requests).includes('never share this note'));
  assert.ok(link.url.endsWith('#' + pending.key));
  assert.equal((await sharing.list('owner-b', source.id)).length, 0);
  await assert.rejects(sharing.create('owner-b', source, input), { status: 404 });
  assert.equal((await repo.get(link.id)).envelope, undefined);
  await createEncryptedSharing(repo, { fetcher }).revoke('owner-a', source.id, link.id);
  assert.equal((await repo.get(link.id)).key, undefined);
  assert.equal((await sharing.list('owner-a', source.id))[0].revoked, true);
});

test('Record API protects anonymous-relay creation with local identity, ownership, CSRF and explicit confirmation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lingji-share-http-')), remote = await relay(t);
  const app = await createRecordServer({ root, databaseUrl: '', port: 0, encryptedSharing: { fetcher: (url, init) => remote.call(new URL(url).pathname, init.method, JSON.parse(init.body)) } });
  const address = await app.start(), base = `http://127.0.0.1:${address.port}/api`;
  t.after(async () => { await app.stop(); await rm(root, { recursive: true, force: true }); });
  const registration = await fetch(base + '/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'share@example.test', password: 'fixture-password' }) });
  const account = await registration.json(), headers = { Cookie: registration.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', 'X-CSRF-Token': account.csrf };
  const source = record(); source.id = crypto.randomUUID(); source.owner = `user:${digest('share@example.test')}`; await app.repo.insert(source);
  const path = base + '/records/' + source.id + '/encrypted-shares', body = JSON.stringify({ requestId: crypto.randomUUID(), scope: 'minutes', confirmed: true, fingerprint: await shareFingerprint(createPublishedContent(source, 'minutes')) });
  assert.equal((await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
  assert.equal((await fetch(path, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': 'wrong' }, body })).status, 403);
  const created = await fetch(path, { method: 'POST', headers, body }); assert.equal(created.status, 200);
  const link = await created.json(); assert.match(link.url, /^https:\/\/rookiecode.com\/s\/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43}$/);
  assert.equal((await fetch(path + '/' + encodeURIComponent(link.id), { method: 'DELETE', headers })).status, 200);
});

test('deployment probe creates, decrypts and revokes only its own encrypted fixture', async t => {
  const { verifyEncryptedSite } = await import('../scripts/verify-encrypted-site.mjs');
  const remote = await relay(t);
  const fetcher = async (url, options = {}) => {
    if (new URL(url).pathname === '/encrypted-reader.js') return new Response(await readFile(new URL('../apps/site/src/encrypted-reader.mjs', import.meta.url), 'utf8'), { headers: { 'Content-Type': 'application/javascript' } });
    try { return await remote.call(new URL(url).pathname, options.method || 'GET', options.body ? JSON.parse(options.body) : undefined); }
    catch (error) { return Response.json({ error: error.code }, { status: error.status || 500 }); }
  };
  assert.deepEqual(await verifyEncryptedSite('https://fixture.invalid', fetcher), { anonymousCreate: true, idempotency: true, readerShell: true, readerBundle: true, ciphertextOnly: true, payloadDecrypted: true, expiry: true, revoked: true });
  const row = remote.sqlite.prepare('SELECT payload,revoked_at FROM encrypted_shares').get();
  assert.equal(row.payload, null); assert.ok(row.revoked_at);
});

test('deployment probe rejects missing or HTML reader bundle and revokes its uploaded content', async t => {
  const { verifyEncryptedSite } = await import('../scripts/verify-encrypted-site.mjs');
  for (const response of [() => new Response('', { status: 404 }), () => new Response('<html>fallback</html>', { headers: { 'Content-Type': 'text/html' } }), () => { throw Error('Fixture bundle network failure'); }]) {
    const remote = await relay(t);
    const fetcher = async (url, options = {}) => {
      if (new URL(url).pathname === '/encrypted-reader.js') return response();
      try { return await remote.call(new URL(url).pathname, options.method || 'GET', options.body ? JSON.parse(options.body) : undefined); }
      catch (error) { return Response.json({ error: error.code }, { status: error.status || 500 }); }
    };
    await assert.rejects(verifyEncryptedSite('https://fixture.invalid', fetcher), /bundle unavailable|incorrect MIME|network failure/);
    const row = remote.sqlite.prepare('SELECT payload,revoked_at FROM encrypted_shares').get();
    assert.equal(row.payload, null); assert.ok(row.revoked_at);
  }
});
