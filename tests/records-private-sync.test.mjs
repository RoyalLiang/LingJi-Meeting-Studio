import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as opaque from '@serenity-kit/opaque';
import { encodeCBOR } from '@levischuck/tiny-cbor';
import 'fake-indexeddb/auto';
import { createRecordServer } from '../services/records/src/server.mjs';
import { createPrivateSyncStore } from '../services/records/src/private-sync-store.mjs';
import { createDesktopPrivateSync } from '../services/records/src/private-sync-desktop.mjs';
import { createVault, newPairSecret, recoverVault, seal, unseal, decodeBytes } from '../apps/web/src/sync/vault.ts';
import { readDeviceVault, rememberDeviceVault } from '../apps/web/src/sync/device.ts';

const stamp = '合成会议正文，仅在端上解密';
const encoder = new TextEncoder();
const fixtureOrigin = 'http://localhost:32141';

async function cloud(t) {
  const root = await mkdtemp(join(tmpdir(), 'lingji-private-sync-cloud-'));
  const app = await createRecordServer({ root, databaseUrl: '', port: 0, syncOrigin: fixtureOrigin });
  const { port } = await app.start();
  t.after(async () => { await app.stop(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + port;
  async function request(path, method = 'GET', body, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(base + '/api' + path, {
        method, headers: { Host: new URL(fixtureOrigin).host, Origin: fixtureOrigin, 'Content-Type': 'application/json', ...headers },
      }, async response => {
        try {
          const chunks = [];
          for await (const bytes of response) chunks.push(bytes);
          resolve({ status: response.statusCode, cookies: response.headers['set-cookie'] ?? [], data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (error) { reject(error); }
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function account(email) {
    const registered = await request('/auth/register', 'POST', { email, password: 'synthetic-backend-phrase' });
    assert.equal(registered.status, 200, JSON.stringify(registered.data));
    const headers = { Cookie: registered.cookies[0].split(';')[0], 'X-CSRF-Token': registered.data.csrf };
    return (path, method, value, overrides) => request(path, method, value, { ...headers, ...overrides });
  }
  return { request, account };
}

test('desktop account registration authenticates once and logout clears the sync session', async t => {
  const { request } = await cloud(t);
  const desktop = createDesktopPrivateSync({
    origin: fixtureOrigin,
    fetcher: async (url, options) => {
      const response = await request(url.pathname.slice('/api'.length) + url.search, options.method,
        options.body ? JSON.parse(options.body) : undefined, options.headers);
      const headers = new Headers();
      for (const cookie of response.cookies) headers.append('Set-Cookie', cookie);
      return new Response(JSON.stringify(response.data), { status: response.status, headers });
    },
  });
  async function call(route, method, body) {
    const path = '/api/private-sync/' + route;
    let result;
    await desktop({
      path, url: new URL(path, fixtureOrigin), req: { method, headers: { origin: fixtureOrigin } },
      readBody: async () => body, send: (_res, status, data) => { result = { status, data }; }, limit: () => {},
    });
    return result;
  }
  const email = 'desktop-account@example.test', password = 'synthetic-backend-phrase';
  assert.deepEqual(await call('session', 'POST', { email, password, register: true }),
    { status: 200, data: { email, companion: fixtureOrigin } });
  assert.deepEqual((await call('profile', 'GET')).data, { name: '' });
  assert.deepEqual((await call('profile', 'PATCH', { name: '  设备验收  ' })).data, { name: '设备验收' });
  assert.deepEqual((await call('profile', 'GET')).data, { name: '设备验收' });
  assert.equal((await call('profile', 'PATCH', { name: 'x'.repeat(61) })).status, 400);
  assert.deepEqual((await call('vault', 'GET')).data, { vault: null });
  await call('session', 'DELETE');
  assert.equal((await call('session', 'GET')).data.email, null);
  await assert.rejects(call('vault', 'GET'), { code: 'sync_sign_in_required' });
  assert.equal((await call('session', 'POST', { email, password })).data.email, email);
});

test('encrypted delta across authenticated accounts preserves ordering and idempotent retry', async t => {
  const { account, request } = await cloud(t);
  const first = await account('sync-first@example.test');
  const second = await account('sync-second@example.test');
  const { vault, root, kit } = await createVault();
  assert.equal((await request('/private-sync/vault')).status, 401);
  assert.equal((await first('/private-sync/vault', 'PUT', vault, { Origin: 'https://other.example.test' })).status, 403);
  assert.equal((await first('/private-sync/vault', 'PUT', vault, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await first('/private-sync/vault', 'PUT', vault)).status, 201);
  assert.equal((await first('/private-sync/vault', 'PUT', vault)).status, 409);
  assert.deepEqual((await second('/private-sync/vault')).data, { vault: null });
  const id = randomUUID();
  const operation = { id, ...await seal(root, vault, 'revision', id, encoder.encode(stamp)) };
  const payload = { vault: vault.id, operations: [operation] };
  const sent = await first('/private-sync/delta', 'POST', payload);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.deepEqual(sent.data.acknowledgements, [{ id, seq: 1 }]);
  assert.deepEqual((await first('/private-sync/delta', 'POST', payload)).data, sent.data);
  assert.equal((await first('/private-sync/delta', 'POST', {vault: vault.id, operations: [{...operation, nonce: randomBytes(12).toString('base64url')}]})).status, 409);
  assert.equal((await second('/private-sync/delta?vault=' + vault.id)).status, 404);
  assert.equal((await first('/records')).status, 404, 'the companion does not expose plaintext meeting endpoints');
  const delta = (await first('/private-sync/delta?vault=' + vault.id)).data;
  assert.equal(delta.cursor, 1);
  assert.equal(delta.more, false);
  assert.ok(!JSON.stringify(delta).includes(stamp));
  const otherDevice = await recoverVault(vault, kit);
  assert.equal(new TextDecoder().decode(await unseal(otherDevice, vault, 'revision', id, delta.operations[0])), stamp);
  await assert.rejects(unseal(otherDevice, vault, 'revision', randomUUID(), delta.operations[0]));
  await assert.rejects(recoverVault(vault, 'LJ1.' + vault.id + '.' + newPairSecret()));
});

test('OPAQUE pairing relay enforces account and turn order; only the endpoints recover the key', async t => {
  await opaque.ready;
  const { account } = await cloud(t);
  const owner = await account('sync-owner@example.test');
  const stranger = await account('sync-stranger@example.test');
  const { vault, root } = await createVault();
  assert.equal((await owner('/private-sync/vault', 'PUT', vault)).status, 201);
  const id = randomUUID(), proof = newPairSecret(), guestProof = newPairSecret(), secret = newPairSecret();
  assert.equal((await owner('/private-sync/pair/start', 'POST', { id, proof })).status, 201);
  const send = (who, step, data, session = owner) => session('/private-sync/pair/exchange', 'POST', { id, proof: who, frame: { step, data } });
  const serverSetup = opaque.server.createSetup();
  const identifiers = { client: 'guest:' + id, server: 'host:' + id };
  const registration = opaque.client.startRegistration({ password: secret });
  const answer = opaque.server.createRegistrationResponse({ serverSetup, userIdentifier: id, registrationRequest: registration.registrationRequest });
  const { registrationRecord } = opaque.client.finishRegistration({ ...registration, ...answer, password: secret, identifiers });
  const start = opaque.client.startLogin({ password: secret });
  assert.equal((await send(guestProof, 1, start.startLoginRequest, stranger)).status, 404);
  assert.equal((await send(guestProof, 1, start.startLoginRequest)).status, 200);
  assert.equal((await send(guestProof, 2, start.startLoginRequest)).status, 403);
  assert.equal((await send(newPairSecret(), 1, start.startLoginRequest)).status, 404);
  const host = opaque.server.startLogin({ serverSetup, registrationRecord, userIdentifier: id, identifiers, startLoginRequest: start.startLoginRequest });
  assert.equal((await send(proof, 2, host.loginResponse)).status, 200);
  const guest = opaque.client.finishLogin({ password: secret, identifiers, clientLoginState: start.clientLoginState, loginResponse: host.loginResponse });
  assert.ok(guest);
  assert.equal((await send(guestProof, 3, guest.finishLoginRequest)).status, 200);
  const { sessionKey } = opaque.server.finishLogin({ serverLoginState: host.serverLoginState, identifiers, finishLoginRequest: guest.finishLoginRequest });
  assert.equal(guest.sessionKey, sessionKey);
  const envelope = await seal(decodeBytes(sessionKey), vault, 'pair', id, root);
  const frame = Buffer.from(JSON.stringify(envelope)).toString('base64url');
  assert.equal((await send(proof, 4, frame)).status, 200);
  assert.equal((await send(proof, 4, newPairSecret())).status, 409);
  const reply = await owner('/private-sync/pair/exchange', 'POST', { id, proof: guestProof });
  const wrapped = JSON.parse(Buffer.from(reply.data.frames[3], 'base64url'));
  assert.deepEqual(await unseal(decodeBytes(guest.sessionKey), vault, 'pair', id, wrapped), root);
});

test('a trusted device keeps the first key and unlocks only its account and matching vault', async () => {
  const account = 'trusted-device@example.test';
  const original = await createVault();
  const other = await createVault();
  assert.equal(await readDeviceVault(account), null);
  assert.equal(await rememberDeviceVault(account, original, true), true);
  assert.equal(await rememberDeviceVault(account, other, true), false);
  assert.equal(await readDeviceVault('another@example.test', original.vault), null);
  assert.equal(await readDeviceVault(account, other.vault), null);
  assert.deepEqual(await readDeviceVault(account, original.vault), original);
});

test('journal commit serialization and a new reader survive reopen', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lingji-private-sync-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await createPrivateSyncStore({ root });
  const id = randomUUID();
  await first.initialize('acct', { id });
  const operations = Array.from({ length: 81 }, () => ({ id: randomUUID(), nonce: randomBytes(12).toString('base64url'), body: newPairSecret() }));
  await Promise.all(operations.map(op => first.push('acct', id, [op])));
  await first.close();
  const second = await createPrivateSyncStore({ root });
  t.after(() => second.close());
  const beginning = await second.pull('acct', id, 0);
  assert.equal(beginning.cursor, 64);
  assert.equal(beginning.more, true);
  const ending = await second.pull('acct', id, beginning.cursor);
  assert.equal(ending.cursor, 81);
  assert.equal(ending.more, false);
  assert.equal(new Set([...beginning.operations, ...ending.operations].map(op => op.id)).size, operations.length);
  await second.challenge('acct', 'join', 'fixture', 1000);
  assert.equal(await second.takeChallenge('acct', 'join', 1001), 'fixture');
  assert.equal(await second.takeChallenge('acct', 'join', 1002), null);
});

test('WebAuthn registration and assertion release only the credential envelope', async t => {
  const { account } = await cloud(t);
  const owner = await account('sync-passkey@example.test');
  const { vault, root } = await createVault();
  assert.equal((await owner('/private-sync/vault', 'PUT', vault)).status, 201);
  const rpHash = createHash('sha256').update(new URL(fixtureOrigin).hostname).digest();
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { x, y } = publicKey.export({ format: 'jwk' });
  const id = randomBytes(32), b64id = id.toString('base64url');
  const cose = encodeCBOR(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(x, 'base64url')], [-3, Buffer.from(y, 'base64url')]]));
  const client = (challenge, type, origin = fixtureOrigin) => Buffer.from(JSON.stringify({ challenge, type, origin, crossOrigin: false }));
  const registration = await owner('/private-sync/passkey/register', 'POST', {});
  assert.equal(registration.status, 200, JSON.stringify(registration.data));
  const attested = Buffer.concat([rpHash, Buffer.from([0x45, 0, 0, 0, 0]), Buffer.alloc(16), Buffer.from([0, id.length]), id, cose]);
  const object = encodeCBOR(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', attested]]));
  const prf = randomBytes(32);
  const envelope = await seal(prf, vault, 'passkey', b64id, root);
  const start = await owner('/private-sync/passkey/register/finish', 'POST', {
    envelope,
    response: {
      id: b64id, rawId: b64id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: client(registration.data.challenge, 'webauthn.create').toString('base64url'),
        attestationObject: Buffer.from(object).toString('base64url'), transports: ['internal'] },
    },
  });
  assert.equal(start.status, 201, JSON.stringify(start.data));
  const challenge = await owner('/private-sync/passkey/unlock', 'POST', {});
  assert.equal(challenge.status, 200, JSON.stringify(challenge.data));
  assert.equal(challenge.data.allowCredentials[0].id, b64id);
  function assertion(challenge, origin = fixtureOrigin) {
    const authData = Buffer.concat([rpHash, Buffer.from([0x05, 0, 0, 0, 1])]);
    const clientData = client(challenge, 'webauthn.get', origin);
    const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), privateKey);
    return { response: {
      id: b64id, rawId: b64id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: clientData.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url') },
    } };
  }
  const finish = await owner('/private-sync/passkey/unlock/finish', 'POST', assertion(challenge.data.challenge));
  assert.equal(finish.status, 200, JSON.stringify(finish.data));
  assert.deepEqual(finish.data, { envelope });
  assert.deepEqual(await unseal(prf, vault, 'passkey', b64id, finish.data.envelope), new Uint8Array(root));
  assert.equal((await owner('/private-sync/passkey/unlock/finish', 'POST', assertion(challenge.data.challenge))).status, 409);
  const fresh = await owner('/private-sync/passkey/unlock', 'POST', {});
  assert.equal((await owner('/private-sync/passkey/unlock/finish', 'POST', assertion(fresh.data.challenge, 'https://wrong-origin.example'))).status, 400);
});

test('restoring a revision keeps its source citations and never overwrites local changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lingji-private-sync-restore-'));
  const { createRepository } = await import('../services/records/src/repository.mjs');
  const { restorePrivateMeeting } = await import('../services/records/src/private-sync-restore.mjs');
  const repo = await createRepository({ root, databaseUrl: '' });
  t.after(async () => { await repo.close(); await rm(root, { recursive: true, force: true }); });
  const segment = { id: 's1', revision: 2, text: stamp, speaker: '参会者', startMs: 125, endMs: 540 };
  const citation = { segmentId: segment.id, revision: segment.revision };
  const content = {
    schemaVersion: 1, sourceRecordId: randomUUID(), title: '合成会议', scope: 'full', draft: false,
    minutes: { title: '纪要', revision: 3, transcriptRevision: 2, sections: [{ heading: '结论', items: [{ text: stamp, evidence: [citation] }] }],
      actions: [], evidenceSnapshot: [segment] },
    segments: [segment],
  };
  const input = { id: randomUUID(), content, notes: '原始手记' };
  const first = await restorePrivateMeeting(repo, 'local', input);
  const record = await repo.get(first.id);
  assert.equal(record.retainAudio, false);
  assert.equal(record.syncSourceId, content.sourceRecordId);
  assert.equal(record.syncParent, input.id);
  assert.equal(record.minutesRevision, 3);
  assert.deepEqual(record.minutes.sections[0].items[0].evidence, [citation]);
  assert.equal(record.minutes.evidenceSnapshot[0].text, stamp);
  assert.equal(record.segments[0].revision, 2);
  await repo.change(first.id, value => { value.notes = '本机已校订'; });
  const second = await restorePrivateMeeting(repo, 'local', input);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);
  assert.equal((await repo.get(second.id)).notes, '本机已校订');
});

test('encrypted mobile audio has its own idempotent cursor and imports only once per vault', async t => {
  const { account } = await cloud(t);
  const phone = await account('mobile-owner@example.test');
  const unrelated = await account('mobile-other@example.test');
  const { vault, root } = await createVault();
  assert.equal((await phone('/private-sync/vault', 'PUT', vault)).status, 201);
  const after = '?vault=' + vault.id;
  assert.deepEqual((await phone('/private-sync/audio' + after)).data, { cursor: 0, more: false, operations: [] });
  const partId = randomUUID();
  const operation = { id: partId, ...await seal(root, vault, 'mobile-audio/1', partId, encoder.encode(stamp)) };
  const payload = { vault: vault.id, operations: [operation] };
  const first = await phone('/private-sync/audio', 'POST', payload);
  assert.deepEqual(first.data, { acknowledgements: [{ id: partId, seq: 1 }] });
  assert.deepEqual((await phone('/private-sync/audio', 'POST', payload)).data, first.data);
  assert.equal((await unrelated('/private-sync/audio' + after)).status, 404);
  assert.deepEqual((await phone('/private-sync/delta' + after)).data.operations, []);
  const inbound = (await phone('/private-sync/audio' + after)).data;
  assert.equal(inbound.cursor, 1);
  assert(!JSON.stringify(inbound).includes(stamp));
  assert.equal(new TextDecoder().decode(await unseal(root, vault, 'mobile-audio/1', partId, inbound.operations[0])), stamp);

  const folder = await mkdtemp(join(tmpdir(), 'lingji-mobile-import-'));
  const { createRepository } = await import('../services/records/src/repository.mjs');
  const { preparePrivateRecording } = await import('../services/records/src/private-sync-restore.mjs');
  const repo = await createRepository({ root: folder, databaseUrl: '' });
  t.after(async () => { await repo.close(); await rm(folder, { recursive: true, force: true }); });
  const input = { id: randomUUID(), vault: vault.id, title: '手机录音' };
  const [copy, retry] = await Promise.all([preparePrivateRecording(repo, 'desktop', input), preparePrivateRecording(repo, 'desktop', input)]);
  assert.equal(copy.id, retry.id);
  assert.notEqual(copy.id, (await preparePrivateRecording(repo, 'desktop', { ...input, vault: randomUUID() })).id);
  assert.equal(copy.capture, 'idle');
  assert.equal(copy.realtimeAudioConsent, false);
  const { recordMinutesConfig } = await import('../services/records/src/config.mjs');
  assert.deepEqual(recordMinutesConfig(copy, { ASR_PROVIDER: 'doubao', MINUTES_MODE: 'doubao-audio-only' }),
    { ASR_PROVIDER: 'sensevoice-local', MINUTES_MODE: 'asr-llm' });
});
