import { totpCode, totpStep } from '../services/records/src/account-totp.mjs';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
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

async function cloud(t, databaseUrl = '', options = {}) {
  if (databaseUrl) assert.match(new URL(databaseUrl).pathname, /test/i);
  const root = await mkdtemp(join(tmpdir(), 'lingji-private-sync-cloud-'));
  const start = () => createRecordServer({ ...options, root, databaseUrl, port: 0, syncOrigin: fixtureOrigin });
  let app = await start();
  let { port } = await app.start();
  t.after(async () => { await app.stop(); await rm(root, { recursive: true, force: true }); });
  async function request(path, method = 'GET', body, headers = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = httpRequest('http://127.0.0.1:' + port + '/api' + path, {
        method, headers: { Host: new URL(fixtureOrigin).host, Origin: fixtureOrigin, 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
      }, async response => {
        try {
          const chunks = [];
          for await (const bytes of response) chunks.push(bytes);
          resolve({ status: response.statusCode, cookies: response.headers['set-cookie'] ?? [], data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (error) { reject(error); }
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
  async function account(email) {
    const registered = await request('/auth/register', 'POST', { email, password: 'synthetic-backend-phrase' });
    assert.equal(registered.status, 200, JSON.stringify(registered.data));
    const headers = { Cookie: registered.cookies[0].split(';')[0], 'X-CSRF-Token': registered.data.csrf };
    return (path, method, value, overrides) => request(path, method, value, { ...headers, ...overrides });
  }
  async function restart() {
    await app.stop();
    app = await start();
    ({ port } = await app.start());
  }
  return { request, account, restart };
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
  const platform = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform];
  if (platform) {
    const { items } = (await call('devices', 'GET')).data;
    assert.equal(items.find(device => device.current)?.name, '聆记 ' + platform);
  }
  assert.deepEqual((await call('profile', 'PATCH', { name: '  设备验收  ' })).data, { name: '设备验收' });
  assert.deepEqual((await call('profile', 'GET')).data, { name: '设备验收' });
  assert.equal((await call('profile', 'PATCH', { name: 'x'.repeat(61) })).status, 400);
  assert.deepEqual((await call('vault', 'GET')).data, { vault: null, legacy: true, liveAudio: true, liveAudioV2: true });
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
  assert.equal((await request('/private-sync/usage')).status, 401);
  assert.equal((await request('/private-sync/mobile-session')).status, 401);
  const mobile = await first('/private-sync/mobile-session');
  assert.equal(mobile.data.email, 'sync-first@example.test');
  assert.match(mobile.data.csrf, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(mobile.data).sort(), ['csrf', 'email', 'expiresAt']);
  assert.ok(mobile.data.expiresAt > Date.now());
  const originalDevice = (await first('/private-sync/devices')).data.items[0];
  await first('/bootstrap', 'GET', undefined, { 'User-Agent': 'Mozilla/5.0 (iPhone)' });
  if (originalDevice.name === '浏览器') assert.equal((await first('/private-sync/devices')).data.items[0].name, 'iPhone / iPad');
  const identified = await first('/private-sync/mobile-session', 'GET', undefined, {
    'User-Agent': 'Mozilla/5.0', 'X-LingJi-Client': 'android',
  });
  assert.equal(identified.status, 200);
  assert.deepEqual((await first('/private-sync/devices')).data.items[0],
    { ...originalDevice, name: '聆记 Android' }, 'legacy sessions learn the App label even after a proxy rewrites User-Agent');
  assert.equal((await first('/private-sync/mobile-session', 'POST', undefined, { 'X-CSRF-Token': '' })).status, 403);
  const renewed = await first('/private-sync/mobile-session', 'POST', undefined, { 'User-Agent': 'Mozilla/5.0 LingJi-Android' });
  assert.equal(renewed.status, 200);
  assert.ok(renewed.data.expiresAt >= mobile.data.expiresAt);
  assert.equal(renewed.data.csrf, mobile.data.csrf);
  assert.match(renewed.cookies[0], /HttpOnly; SameSite=Strict/);
  const device = (await first('/private-sync/devices', 'GET', undefined, { Cookie: renewed.cookies[0].split(';')[0] })).data.items[0];
  assert.deepEqual(device, { ...originalDevice, name: '聆记 Android' }, 'refresh preserves the device ID and original sign-in time');
  assert.equal((await first('/private-sync/vault', 'PUT', vault, { Origin: 'https://other.example.test' })).status, 403);
  assert.equal((await first('/private-sync/vault', 'PUT', vault, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await first('/private-sync/vault', 'PUT', vault)).status, 201);
  assert.equal((await first('/private-sync/vault', 'PUT', vault)).status, 409);
  assert.deepEqual((await second('/private-sync/vault')).data, { vault: null, legacy: true, liveAudio: true, liveAudioV2: true });
  const id = randomUUID();
  const operation = { id, ...await seal(root, vault, 'revision', id, encoder.encode(stamp)) };
  const payload = { vault: vault.id, operations: [operation] };
  const sent = await first('/private-sync/delta', 'POST', payload);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.deepEqual(sent.data.acknowledgements, [{ id, seq: 1 }]);
  assert.deepEqual((await first('/private-sync/delta', 'POST', payload)).data, sent.data);
  assert.equal((await first('/private-sync/delta', 'POST', {vault: vault.id, operations: [{...operation, nonce: randomBytes(12).toString('base64url')}]})).status, 409);
  assert.equal((await second('/private-sync/delta?vault=' + vault.id)).status, 404);
  const quota = 1024 * 1024 * 1024;
  const audioId = randomUUID();
  const audio = { id: audioId, ...await seal(root, vault, 'audio', audioId, encoder.encode(stamp)) };
  assert.equal((await first('/private-sync/audio', 'POST', { vault: vault.id, operations: [audio] })).status, 200);
  assert.deepEqual((await first('/private-sync/usage')).data, {
    meetings: Buffer.byteLength(JSON.stringify(operation)), audio: Buffer.byteLength(JSON.stringify(audio)), quota,
  });
  assert.deepEqual((await second('/private-sync/usage')).data, { meetings: 0, audio: 0, quota });
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
  assert.equal((await owner('/private-sync/vault')).data.hasPasskey, undefined);
  assert.equal((await owner('/private-sync/passkey/unlock', 'POST', {})).data.error, 'sync_no_passkey');
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
  assert.equal((await owner('/private-sync/vault')).data.hasPasskey, true);
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
  assert.deepEqual((await phone('/private-sync/audio' + after)).data, { cursor: 0, more: false, operations: [], acknowledged: 0 });
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
  assert.equal(copy.syncSourceId, input.id);
  assert.equal(copy.realtimeAudioConsent, false);
  const { recordMinutesConfig } = await import('../services/records/src/config.mjs');
  assert.deepEqual(recordMinutesConfig(copy, { ASR_PROVIDER: 'doubao', MINUTES_MODE: 'doubao-audio-only' }),
    { ASR_PROVIDER: 'sensevoice-local', MINUTES_MODE: 'asr-llm' });
});

test('live audio is visible before sealing and has an isolated durable receipt journal', async t => {
  const { account } = await cloud(t);
  const phone = await account('live-owner@example.test');
  const other = await account('live-other@example.test');
  const { vault, root } = await createVault();
  await phone('/private-sync/vault', 'PUT', vault);
  const capability = (await phone('/private-sync/vault')).data;
  assert.equal(capability.liveAudio, true);
  assert.equal(capability.emptyUpgrade, true);
  const query = '?vault=' + vault.id;

  const folder = await mkdtemp(join(tmpdir(), 'lingji-live-import-'));
  const { createRepository } = await import('../services/records/src/repository.mjs');
  const { preparePrivateRecording } = await import('../services/records/src/private-sync-restore.mjs');
  const { runCycle } = await import('../services/records/src/worker.mjs');
  const repo = await createRepository({ root: folder, databaseUrl: '' });
  t.after(async () => { await repo.close(); await rm(folder, { recursive: true, force: true }); });
  const recording = { id: randomUUID(), vault: vault.id, title: '手机录音', live: true };
  const [record, retry] = await Promise.all([
    preparePrivateRecording(repo, 'desktop', recording),
    preparePrivateRecording(repo, 'desktop', recording)
  ]);
  assert.equal(record.capture, 'recording');
  assert.equal(record.sources.length, 1);
  assert.equal(retry.sources[0].id, record.sources[0].id);
  assert.equal(record.realtimeAudioConsent, false);

  const pcm = Buffer.alloc(32000);
  pcm.writeInt16LE(1024);
  const frame = { kind: 'pcm', id: recording.id, title: recording.title, sequence: 0, offset: 0, data: pcm.toString('base64url') };
  async function append(path, value) {
    const id = randomUUID();
    const operation = { id, ...await seal(root, vault, 'mobile-live-audio/1', id, encoder.encode(JSON.stringify(value))) };
    const payload = { vault: vault.id, operations: [operation] };
    const first = await phone(path, 'POST', payload);
    assert.deepEqual(first.data, { acknowledgements: [{ id, seq: 1 }] });
    assert.deepEqual((await phone(path, 'POST', payload)).data, first.data);
    assert.equal((await other(path + query)).status, 404);
    const pulled = (await phone(path + query)).data;
    assert.equal(pulled.cursor, 1);
    assert(!JSON.stringify(pulled).includes(recording.title));
    return JSON.parse(new TextDecoder().decode(await unseal(root, vault, 'mobile-live-audio/1', id, pulled.operations[0])));
  }
  const received = await append('/private-sync/live-audio', frame);
  assert.deepEqual(received, frame);
  const confirmed = await phone('/private-sync/live-audio' + query + '&before=1', 'DELETE');
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.acknowledged, 1);
  const later = (await phone('/private-sync/live-audio' + query)).data;
  assert.equal(later.acknowledged, 1);
  assert.equal(later.operations[0]?.seq, 1, 'an independent reader at cursor zero still gets the audio');
  assert.equal((await phone('/private-sync/audio' + query)).data.cursor, 0);
  assert.equal((await phone('/private-sync/live-receipts' + query)).data.cursor, 0);
  assert.equal((await phone('/private-sync/vault')).data.emptyUpgrade, undefined);
  const source = record.sources[0];
  const chunk = {
    sourceId: source.id, sessionId: source.sessionId, epoch: source.epoch, sequence: received.sequence,
    sampleOffset: received.offset, sampleRate: 16000, sampleCount: pcm.byteLength / 2,
    digest: createHash('sha256').update(pcm).digest('hex')
  };
  assert.equal((await repo.ingestAudio('desktop', record.id, chunk, pcm)).watermark, 0);
  assert.equal((await repo.ingestAudio('desktop', record.id, chunk, pcm)).watermark, 0);
  await runCycle(repo, { transcribe: async () => '录音中的转录' });
  const live = await repo.get(record.id);
  assert.equal(live.capture, 'recording');
  assert(live.segments.length > 0);
  assert.equal(live.chunks.length, 1);
  const receipt = { kind: 'received', id: recording.id, title: recording.title };
  assert.deepEqual(await append('/private-sync/live-receipts', receipt), receipt);
});

async function accountExchange(call, email, password, { register = false, currentPassword, vault, root, replaceEmpty = false, factor } = {}) {
  await opaque.ready;
  const begin = opaque.client.startLogin({ password });
  let response;
  if (register) {
    const registration = opaque.client.startRegistration({ password });
    const started = await call({ step: 'register', email, currentPassword, message: registration.registrationRequest });
    if (started.status !== 200) return started;
    const learned = opaque.client.finishRegistration({
      password, clientRegistrationState: registration.clientRegistrationState, registrationResponse: started.data.message,
    });
    response = await call({
      step: 'prove', challenge: started.data.challenge, message: begin.startLoginRequest, registrationRecord: learned.registrationRecord,
      ...(vault ? { envelope: { vault: vault.id, ...await seal(decodeBytes(learned.exportKey), vault, 'account-wrap/1', vault.id, root) } } : {}),
      ...(replaceEmpty ? { replacementVault: vault } : {}),
    });
  } else {
    response = await call({ step: 'login', email, message: begin.startLoginRequest });
  }
  if (response.status !== 200) return response;
  const proof = opaque.client.finishLogin({ password, clientLoginState: begin.clientLoginState, loginResponse: response.data.message });
  if (!proof) return { status: 401 };
  const finish = { step: 'finish', challenge: response.data.challenge, message: proof.finishLoginRequest, ...(factor ? { factor } : {}) };
  const result = await call(finish);
  return { ...result, key: decodeBytes(proof.exportKey), finish };
}

test('per-device revocation and TOTP recovery protect OPAQUE login after restart', async t => {
  const { request, restart } = await cloud(t, process.env.RECORD_TEST_DATABASE_URL, { accountFactorKey: randomBytes(32).toString('hex') });
  assert.equal(totpCode(Buffer.from('12345678901234567890'), 1, 8), '94287082');
  const email = 'factor@example.test', password = 'synthetic-account-factor-password';
  const login = (body, platform = 'iPhone') => request('/auth/account', 'POST', body, { 'User-Agent': platform });
  const primary = await accountExchange(login, email, password, { register: true });
  const guest = await accountExchange(body => login(body, 'Android'), email, password);
  assert.equal(primary.status, 200);
  assert.equal(guest.status, 200);
  function signed(session) {
    const authorization = { Cookie: session.cookies[0].split(';')[0], 'X-CSRF-Token': session.data.csrf };
    return (path, method, body) => request(path, method, body, authorization);
  }
  let owner = signed(primary);
  const second = signed(guest);
  const devices = (await owner('/private-sync/devices')).data;
  assert.equal(devices.items.length, 2);
  const remote = devices.items.find(device => !device.current);
  assert.equal(remote.name, 'Android');
  assert.equal((await owner('/private-sync/devices', 'DELETE', { id: remote.id })).status, 200);
  assert.equal((await second('/private-sync/devices')).status, 401);
  assert.equal((await second('/private-sync/mobile-session', 'POST')).status, 401);
  assert.equal((await owner('/private-sync/devices')).data.items.length, 1);

  const plans = await owner('/private-sync/billing/plans');
  assert.equal(plans.data.checkout, false);
  assert.equal(plans.data.plans.length, 4);
  const quote = await owner('/private-sync/billing/quote', 'POST', { planId: 'storage-20g', period: 'yearly', amount: 1 });
  assert.deepEqual(quote.data, { planId: 'storage-20g', period: 'yearly', amount: 36500, currency: 'CNY', payable: false });
  assert.equal((await request('/private-sync/billing/plans')).status, 401);

  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 11 * 60_000 });
  assert.equal((await owner('/private-sync/factor')).data.recent, false);
  const renewed = await accountExchange(body => request('/auth/account', 'POST', body, {
    Cookie: primary.cookies[0].split(';')[0], 'X-LingJi-Client': 'android',
  }), email, password);
  assert.equal(renewed.status, 200);
  assert.equal((await owner('/private-sync/devices')).status, 401);
  owner = signed(renewed);
  assert.equal((await owner('/private-sync/factor')).data.recent, true);
  const renewedDevices = (await owner('/private-sync/devices')).data.items;
  assert.equal(renewedDevices.length, 1);
  assert.equal(renewedDevices[0].name, '聆记 Android');

  const configured = await owner('/private-sync/factor/enroll', 'POST', {});
  assert.equal(configured.status, 200);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const base32 = new URL(configured.data.uri).searchParams.get('secret');
  const bits = [...base32].map(character => alphabet.indexOf(character).toString(2).padStart(5, '0')).join('');
  const seed = Buffer.from(bits.match(/.{8}/g).map(byte => parseInt(byte, 2)));
  const code = totpCode(seed, totpStep());
  const enrolled = await owner('/private-sync/factor', 'POST', { code });
  assert.equal(enrolled.status, 200);
  const backup = enrolled.data.recovery[0];
  assert.equal((await owner('/private-sync/factor')).data.enabled, true);
  await restart();
  const blocked = await accountExchange(login, email, password);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error, 'account_factor_required');
  assert.equal(blocked.cookies.length, 0);
  assert.equal((await accountExchange(login, email, password, { factor: code })).status, 401);
  const recovered = await accountExchange(login, email, password, { factor: backup });
  assert.equal(recovered.status, 200);
  assert.equal((await accountExchange(login, email, password, { factor: backup })).status, 401);
  assert.equal((await signed(recovered)('/private-sync/factor')).data.enabled, true);
});

test('one account login unlocks across clients after restart without transferring raw meeting keys', async t => {
  const { request, restart } = await cloud(t, process.env.RECORD_TEST_DATABASE_URL);
  const email = 'new-opaque@example.test', password = 'new-synthetic-test-credential';
  const login = body => request('/auth/account', 'POST', body);
  assert.deepEqual((await request('/auth/account')).data, { opaque: true });
  const first = await accountExchange(login, email, password, { register: true });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual(Object.keys(first.data).sort(), ['csrf', 'email']);
  assert.equal((await login(first.finish)).status, 409, 'login verification is single use');
  const headers = res => ({ Cookie: res.cookies[0].split(';')[0], 'X-CSRF-Token': res.data.csrf });
  const { vault, root } = await createVault();
  assert.equal((await request('/private-sync/vault', 'PUT', vault, headers(first))).status, 400, 'new accounts must keep a login-wrapped vault');
  const wrapped = await seal(first.key, vault, 'account-wrap/1', vault.id, root);
  assert.equal((await request('/private-sync/vault', 'PUT', { ...vault, account: wrapped }, headers(first))).status, 201);

  await restart();
  const phone = await accountExchange(login, '  NEW-OPAQUE@example.test  ', password);
  assert.equal(phone.status, 200, JSON.stringify(phone.data));
  const remote = await request('/private-sync/vault', 'GET', undefined, headers(phone));
  assert.equal(remote.data.legacy, false);
  assert.deepEqual(await unseal(phone.key, remote.data.vault, 'account-wrap/1', vault.id, remote.data.account), root);
  await assert.rejects(unseal(randomBytes(32), vault, 'account-wrap/1', vault.id, remote.data.account));
  assert.equal((await accountExchange(login, email, password + '-incorrect')).status, 401);
  assert.equal((await request('/auth/login', 'POST', { email, password })).status, 401, 'migrated accounts cannot downgrade');
  assert.equal((await request('/auth/account', 'POST', first.finish, { Origin: 'https://other.test' })).status, 403);
});

test('legacy upgrade preserves existing vault, invalidates old logins and cannot replay a challenge', async t => {
  const { request } = await cloud(t, process.env.RECORD_TEST_DATABASE_URL);
  const email = 'upgrade-opaque@example.test', oldPassword = 'old-synthetic-account-password', newPassword = 'new-synthetic-account-password';
  const old = await request('/auth/register', 'POST', { email, password: oldPassword });
  assert.equal(old.status, 200);
  const headers = { Cookie: old.cookies[0].split(';')[0], 'X-CSRF-Token': old.data.csrf };
  const legacy = body => request('/private-sync/account-upgrade', 'POST', body, headers);
  const login = body => request('/auth/account', 'POST', body);
  assert.equal((await accountExchange(login, email, oldPassword)).data.error, 'account_legacy');
  const { vault, root } = await createVault();
  assert.equal((await request('/private-sync/vault', 'PUT', vault, headers)).status, 201);
  const registration = { register: true, currentPassword: oldPassword, vault, root };
  assert.equal((await accountExchange(legacy, email, newPassword, { ...registration, currentPassword: 'wrong-current-password' })).status, 401);
  const migrated = await accountExchange(legacy, email, newPassword, registration);
  assert.equal(migrated.status, 200, JSON.stringify(migrated.data));
  assert.equal((await request('/private-sync/vault', 'GET', undefined, headers)).status, 401);
  assert.equal((await legacy(migrated.finish)).status, 401);
  assert.equal((await request('/auth/login', 'POST', { email, password: oldPassword })).status, 401);

  const other = await accountExchange(login, email, newPassword);
  assert.equal(other.status, 200, JSON.stringify(other.data));
  const session = { Cookie: other.cookies[0].split(';')[0], 'X-CSRF-Token': other.data.csrf };
  const changed = await request('/private-sync/vault', 'GET', undefined, session);
  assert.deepEqual(changed.data.vault, vault);
  assert.deepEqual(await unseal(other.key, vault, 'account-wrap/1', vault.id, changed.data.account), root);
});


test('a blank device can upgrade an empty legacy vault, but cannot replace meetings or mobile audio', async t => {
  const { request, restart } = await cloud(t, process.env.RECORD_TEST_DATABASE_URL);
  const password = 'legacy-password-device-test';
  const newPassword = 'new-password-device-test';
  const headers = res => ({ Cookie: res.cookies[0].split(';')[0], 'X-CSRF-Token': res.data.csrf });
  for (const stream of ['delta', 'audio', null]) {
    const email = randomUUID() + '@example.test';
    const old = await request('/auth/register', 'POST', { email, password });
    assert.equal(old.status, 200);
    const oldSession = headers(old);
    const legacy = await createVault();
    assert.equal((await request('/private-sync/vault', 'PUT', legacy.vault, oldSession)).status, 201);
    assert.equal((await request('/private-sync/vault', 'GET', undefined, oldSession)).data.emptyUpgrade, true);
    if (stream) {
      const id = randomUUID();
      const operation = { id, ...await seal(legacy.root, legacy.vault, stream, id, encoder.encode(stamp)) };
      assert.equal((await request('/private-sync/' + stream, 'POST', { vault: legacy.vault.id, operations: [operation] }, oldSession)).status, 200);
    }
    const replacement = await createVault();
    const upgrade = body => request('/private-sync/account-upgrade', 'POST', body, oldSession);
    const result = await accountExchange(upgrade, email, newPassword, { register: true, currentPassword: password, ...replacement, replaceEmpty: true });
    if (stream) {
      assert.equal(result.status, 409);
      assert.equal(result.data.error, 'sync_legacy_history');
      const previous = await request('/private-sync/' + stream + '?vault=' + legacy.vault.id, 'GET', undefined, oldSession);
      assert.equal(previous.data.operations.length, 1);
    } else {
      assert.equal(result.status, 200, JSON.stringify(result.data));
      await restart();
      assert.equal((await request('/private-sync/vault', 'GET', undefined, oldSession)).status, 401);
      const other = await accountExchange(body => request('/auth/account', 'POST', body), email, newPassword);
      assert.equal(other.status, 200);
      const changed = await request('/private-sync/vault', 'GET', undefined, headers(other));
      assert.deepEqual(changed.data.vault, replacement.vault);
      assert.deepEqual(await unseal(other.key, changed.data.vault, 'account-wrap/1', replacement.vault.id, changed.data.account), replacement.root);
      const id = randomUUID(), operation = { id, ...await seal(replacement.root, replacement.vault, 'mobile-audio/1', id, encoder.encode(stamp)) };
      assert.equal((await request('/private-sync/audio', 'POST', { vault: replacement.vault.id, operations: [operation] }, headers(other))).status, 200);
    }
  }
});

test('a full live audio journal still accepts an independent desktop receipt', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'lingji-private-sync-full-audio-'));
  const store = await createPrivateSyncStore({ root });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const owner = 'receipt-reserve-owner';
  const { vault } = await createVault();
  await store.initialize(owner, vault);
  await store.initialize(owner + ':live-audio', vault);
  await store.initialize(owner + ':live-receipts', vault);
  const previousQuota = 64 * 1024 * 1024;
  const operation = { id: randomUUID(), nonce: 'test', body: 'test' };
  const db = new DatabaseSync(join(root, 'private-sync.sqlite'));
  try {
    const setBytes = db.prepare('UPDATE sync_vaults SET bytes=? WHERE owner=?');
    setBytes.run(previousQuota - 1, owner + ':live-audio');
    const crossing = await store.push(owner + ':live-audio', vault.id, [operation], owner);
    assert.equal(crossing.acknowledgements[0]?.seq, 1);
    assert.ok((await store.usage(owner)).audio > previousQuota);
    setBytes.run(1024 ** 3, owner + ':live-audio');
  }
  finally { db.close(); }
  await assert.rejects(store.push(owner + ':live-audio', vault.id, [{ ...operation, id: randomUUID() }], owner), { code: 'sync_quota_exceeded' });
  const written = await store.push(owner + ':live-receipts', vault.id, [operation], owner);
  assert.equal(written.acknowledgements[0]?.seq, 1);
  assert.equal((await store.usage(owner)).audio, 1024 * 1024 * 1024);
});

test('lagging desktops retain audio until quota pressure reclaims acknowledged ciphertext', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'lingji-private-sync-prune-'));
  const store = await createPrivateSyncStore({ root });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const owner = 'prune-owner';
  const { vault } = await createVault();
  await store.initialize(owner, vault);
  await store.initialize(owner + ':live-audio', vault);
  const firstBatch = Array.from({ length: 4 }, () => ({ id: randomUUID(), nonce: 'n'.repeat(16), body: 'a'.repeat(1024) }));
  await store.push(owner + ':live-audio', vault.id, firstBatch, owner);
  const beforePrune = (await store.usage(owner)).audio;
  assert.ok(beforePrune > 4096);
  await store.acknowledgeAudio(owner + ':live-audio', vault.id, 3, owner);
  const pulled = await store.pullSubstream(owner, owner + ':live-audio', vault.id, 0);
  assert.equal(pulled.acknowledged, 3);
  assert.equal(pulled.trimmed, undefined);
  assert.deepEqual(pulled.operations.map(operation => operation.seq), [1, 2, 3, 4]);
  assert.equal((await store.usage(owner)).audio, beforePrune);
  await assert.rejects(store.acknowledgeAudio(owner + ':live-audio', vault.id, 99, owner), { code: 'sync_cursor_ahead' });
  const db = new DatabaseSync(join(root, 'private-sync.sqlite'));
  const quota = 1024 * 1024 * 1024;
  try { db.prepare('UPDATE sync_vaults SET bytes=? WHERE owner=?').run(quota, owner + ':live-audio'); }
  finally { db.close(); }
  const nextOp = { id: randomUUID(), nonce: 'n'.repeat(16), body: 'b'.repeat(512) };
  const appended = await store.push(owner + ':live-audio', vault.id, [nextOp], owner);
  assert.equal(appended.acknowledgements[0]?.seq, 5);
  assert.ok((await store.usage(owner)).audio < quota);
  const late = await store.pullSubstream(owner, owner + ':live-audio', vault.id, 0);
  assert.equal(late.trimmed, true);
  assert.deepEqual(late.operations.map(operation => operation.seq), [2, 3, 4, 5]);
  assert.equal(late.cursor, 5);
  const replay = await store.push(owner + ':live-audio', vault.id, [firstBatch[0]], owner);
  assert.deepEqual(replay.acknowledgements, [{ id: firstBatch[0].id, seq: 1 }]);
  await assert.rejects(store.push(owner + ':live-audio', vault.id, [{ ...firstBatch[0], body: 'changed' }], owner), { code: 'sync_operation_conflict' });
  assert.equal((await store.pullSubstream(owner, owner + ':live-audio', vault.id, 5)).cursor, 5);
  await store.initialize(owner + ':audio', vault);
  const refill = new DatabaseSync(join(root, 'private-sync.sqlite'));
  try { refill.prepare('UPDATE sync_vaults SET bytes=? WHERE owner=?').run(quota, owner + ':live-audio'); }
  finally { refill.close(); }
  const archive = await store.push(owner + ':audio', vault.id, [{ ...nextOp, id: randomUUID() }], owner);
  assert.equal(archive.acknowledgements[0].seq, 1);
  assert.deepEqual((await store.pullSubstream(owner, owner + ':live-audio', vault.id, 0)).operations.map(operation => operation.seq), [3, 4, 5]);
  await assert.rejects(store.push(owner + ':audio', vault.id, [{ ...nextOp, id: randomUUID(), body: 'u'.repeat(6000) }], owner), { code: 'sync_quota_exceeded' });
  assert.deepEqual((await store.pullSubstream(owner, owner + ':live-audio', vault.id, 0)).operations.map(operation => operation.seq), [3, 4, 5], 'quota failure rolls back reclamation');
});

test('desktop skips a trimmed recording suffix and resends a lost durable acknowledgement', async t => {
  const bundled = await build({ entryPoints: ['apps/web/src/sync/mobile-desktop.ts'], bundle: true, write: false, format: 'esm' });
  const { receiveLiveAudio } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  const { vault, root } = await createVault();
  const incomplete = randomUUID(), complete = randomUUID(), signal = new AbortController().signal;
  const frame = (id, sequence, kind = 'pcm') => ({ id, title: '手机录音', sequence, kind,
    ...(kind === 'pcm' ? { offset: sequence, data: 'AAA' } : {}) });
  const events = [frame(incomplete, 1), frame(incomplete, 2, 'finish'), frame(complete, 0), frame(complete, 1, 'finish')];
  const encryptedEvents = (key, target) => Promise.all(events.map(async (event, i) => {
    const id = randomUUID();
    return { id, seq: i + 2, ...await seal(key, target, 'mobile-live-audio/1', id, encoder.encode(JSON.stringify(event))) };
  }));
  let operations = await encryptedEvents(root, vault);
  const requests = [], sourceId = randomUUID(), sessionId = randomUUID(), epoch = randomUUID(), recordId = randomUUID();
  let acknowledged = 1, failAck = true;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url, fixtureOrigin);
    const { method } = options;
    requests.push([method, target.pathname, target.searchParams.get('before')]);
    if (target.pathname.endsWith('/live-audio')) {
      if (method === 'GET') {
        const after = Number(target.searchParams.get('after'));
        return Response.json({ acknowledged, cursor: 5, more: false,
          ...(after === 0 ? { trimmed: true, operations } : { operations: [] }) });
      }
      if (failAck) return Response.json({ error: 'service_unavailable' }, { status: 503 });
      acknowledged = Number(target.searchParams.get('before'));
      return Response.json({ acknowledged });
    }
    if (target.pathname.endsWith('/recording')) {
      const input = JSON.parse(options.body);
      assert.equal(input.existingOnly, input.id === incomplete);
      if (input.existingOnly) return Response.json({ error: 'sync_recording_prefix_unavailable' }, { status: 404 });
      return Response.json({ id: recordId, capture: 'recording', sources: [{ kind: 'import', id: sourceId, sessionId, epoch, watermark: -1 }] });
    }
    if (target.pathname.endsWith('/audio')) return Response.json({ durable: true, watermark: 0 });
    assert.equal(target.pathname, '/api/records/' + recordId + '/seal');
    assert.equal(JSON.parse(options.body).sources[0].lastSequence, 0);
    return Response.json({ ok: true });
  });
  // The first two retained frames already belong to the other desktop's durable recording.
  acknowledged = 3;
  await assert.rejects(receiveLiveAudio(vault, root, signal, () => {}), { status: 503 });
  assert.equal(requests.filter(([, path]) => path.endsWith('/recording')).length, 2);
  assert.equal(requests.filter(([, path]) => path.endsWith('/audio')).length, 1);
  failAck = false;
  assert.equal(await receiveLiveAudio(vault, root, signal, () => {}), false);
  assert.deepEqual(requests.filter(([method]) => method === 'DELETE').map(([, , cursor]) => cursor), ['5', '5']);
  assert.equal(requests.filter(([, path]) => path.endsWith('/audio')).length, 1);

  const slow = await createVault();
  operations = await encryptedEvents(slow.root, slow.vault);
  acknowledged = 0;
  assert.equal(await receiveLiveAudio(slow.vault, slow.root, signal, () => {}), false);
  assert.equal(await receiveLiveAudio(slow.vault, slow.root, signal, () => {}), false);
  assert.equal(requests.filter(([method]) => method === 'DELETE').length, 2, 'skipped frames do not become acknowledged on the next poll');

  const legacy = await createVault();
  const open = indexedDB.open('lingji-mobile-audio', 2);
  const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
  try {
    const tx = db.transaction('live-cursor', 'readwrite');
    tx.objectStore('live-cursor').put(5, [legacy.vault.id, 'desktop']);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
  } finally { db.close(); }
  assert.equal(await receiveLiveAudio(legacy.vault, legacy.root, signal, () => {}), false);
  assert.deepEqual(requests.filter(([method]) => method === 'DELETE').map(([, , cursor]) => cursor), ['5', '5', '5'],
    'an upgraded desktop confirms its previously consumed cursor even when the page is empty');
});

test('a compressed phone recording beyond five minutes plays locally and seals on a desktop', async t => {
  const bundled = await build({
    stdin: { contents: ['mobile', 'mobile-desktop', 'mobile-library', 'mobile-pcm']
      .map(file => `export * from './apps/web/src/sync/${file}';`).join('\n'), resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm',
  });
  const mobile = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  const { account } = await cloud(t);
  const signed = await account('mobile-long@example.test');
  const { vault, root } = await createVault();
  assert.equal((await signed('/private-sync/vault', 'PUT', vault)).status, 201);
  const id = randomUUID(), signal = new AbortController().signal;
  const directory = await mkdtemp(join(tmpdir(), 'lingji-long-desktop-'));
  const { createRepository } = await import('../services/records/src/repository.mjs');
  const { preparePrivateRecording } = await import('../services/records/src/private-sync-restore.mjs');
  const { publicRecord, seal: sealCapture } = await import('../packages/records/src/record.mjs');
  const desktop = await createRepository({ root: directory, databaseUrl: '' });
  t.after(async () => { await desktop.close(); await rm(directory, { recursive: true, force: true }); });
  const plain = new Uint8Array(32_000);
  plain.fill(15, 200, 400);
  const pcm = await mobile.packMobilePcm(plain);
  assert.equal(pcm.codec, 'gzip');
  assert.ok(pcm.bytes.length < plain.length / 10);
  assert.deepEqual(await mobile.unpackMobilePcm(pcm), plain);
  await assert.rejects(mobile.unpackMobilePcm({ ...pcm, length: 256 }), /超出标记大小/);
  const entry = { id, title: '长录音', at: Date.now(), seconds: 302, marks: [] };
  for (let sequence = 0; sequence < entry.seconds; sequence++) {
    await mobile.appendMobileRecording(vault, root, { ...entry, seconds: sequence + 1 }, sequence, pcm);
    await mobile.queueLiveAudio(vault, root, id, entry.title, { kind: 'pcm', sequence, offset: sequence * 16_000, pcm });
  }
  await mobile.finishMobileRecording(vault, root, entry);
  await mobile.queueLiveAudio(vault, root, id, entry.title, { kind: 'finish', sequence: entry.seconds });
  let recordId, received = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url, fixtureOrigin), input = options.body ? JSON.parse(options.body) : undefined;
    if (target.pathname === '/api/private-sync/recording') {
      const record = await preparePrivateRecording(desktop, 'local', input);
      recordId = record.id;
      return Response.json(publicRecord(record));
    }
    if (target.pathname === '/api/records/' + recordId + '/audio') {
      const { pcm: encoded, ...chunk } = input;
      assert.equal(chunk.sequence, received++);
      assert.equal(chunk.sampleOffset, chunk.sequence * 16_000);
      const bytes = Buffer.from(encoded, 'base64');
      assert.deepEqual(bytes, Buffer.from(plain));
      return Response.json(await desktop.ingestAudio('local', recordId, chunk, bytes));
    }
    if (target.pathname === '/api/records/' + recordId + '/seal') {
      assert.equal(input.sources[0].lastSequence, 301);
      await desktop.change(recordId, record => sealCapture(record, input.sources));
      return Response.json({ ok: true });
    }
    const response = await signed(target.pathname.slice(4) + target.search, options.method, input);
    return Response.json(response.data, { status: response.status });
  });
  while ((await mobile.pushLiveAudio(vault, 'phone-v2', signal)).length) { /* drain all durable batches */ }
  assert.deepEqual((await signed('/private-sync/live-audio?vault=' + vault.id)).data.operations, [], 'older desktops never see v2 packets');
  while (await mobile.receiveLiveAudio(vault, root, signal, () => {}, true)) { /* consume all pages */ }
  const stored = await desktop.get(recordId);
  assert.equal(stored.capture, 'sealed');
  assert.equal(stored.chunks.length, 302);
  assert.equal((await signed('/private-sync/live-audio-v2?vault=' + vault.id)).data.acknowledged, 303);
  const data = await mobile.mobilePlayback(vault, root, id);
  assert.equal(data.size, 44 + entry.seconds * 32_000);
  assert.deepEqual(Buffer.from(await data.slice(-32_000).arrayBuffer()), Buffer.from(plain));
  await mobile.deleteMobileRecording(vault, id);
  assert.equal(await mobile.mobilePlayback(vault, root, id), null);
  assert.ok((await mobile.hiddenMobileRecordings(vault)).has(id));
  assert.deepEqual(await mobile.mobileRecordings(vault, root), []);
  const wave = new Uint8Array(32_000);
  const samples = new DataView(wave.buffer);
  for (let offset = 0; offset < wave.length; offset += 2) samples.setUint16(offset, 13 * offset, true);
  const wire = await mobile.packMobilePcm(wave);
  const compact = await mobile.packLocalMobilePcm(wave, wire);
  assert.equal(compact.codec, 'delta-gzip');
  assert.ok(compact.bytes.length < wire.bytes.length);
  const legacyEntry = { ...entry, id: randomUUID(), seconds: 1 };
  await mobile.appendMobileRecording(vault, root, legacyEntry, 0, compact);
  const playback = await mobile.mobilePlayback(vault, root, legacyEntry.id);
  assert.deepEqual(Buffer.from(await playback.slice(44).arrayBuffer()), Buffer.from(wave));
  await mobile.queueLiveAudio(vault, root, legacyEntry.id, legacyEntry.title, { kind: 'pcm', sequence: 0, offset: 0, pcm: wire, recordedAt: legacyEntry.at }, true);
  await mobile.queueLiveAudio(vault, root, legacyEntry.id, legacyEntry.title, { kind: 'finish', sequence: 1 }, true);
  assert.equal((await mobile.pushLiveAudio(vault, 'phone', signal)).length, 2);
  const receivedLegacy = [];
  await mobile.pullLiveAudio(vault, root, 'desktop', signal, frame => {
    assert.equal(frame.id, legacyEntry.id);
    receivedLegacy.push(frame.kind);
    if (frame.kind === 'pcm') {
      assert.equal(frame.recordedAt, legacyEntry.at);
      assert.equal(frame.offset, 0);
      assert.deepEqual(frame.pcm.bytes, wave);
    }
  });
  assert.deepEqual(receivedLegacy, ['pcm', 'finish']);
});

test('phone audio becomes a source-linked transcript and final minutes in its original vault', async t => {
  const { account } = await cloud(t);
  const signed = await account('phone-roundtrip@example.test');
  const { vault, root } = await createVault();
  assert.equal((await signed('/private-sync/vault', 'PUT', vault)).status, 201);
  const { build } = await import('esbuild');
  const { IDBFactory } = await import('fake-indexeddb');
  const browser = await build({
    stdin: { contents: ['sync/mobile', 'sync/mobile-desktop', 'sync/journal', 'sync/mobile-direct']
      .map(file => `export * from './apps/web/src/${file}';`).join('\n'), resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'node',
  });
  const moduleURL = 'data:text/javascript;base64,' + Buffer.from(browser.outputFiles[0].text).toString('base64');
  const desktopJournal = await import(moduleURL + '#phone-roundtrip-desktop');
  const phoneJournal = await import(moduleURL + '#phone-roundtrip-phone');
  const mdns = 'a=candidate:1 1 udp 2122260223 test.local 12345 typ host';
  assert.equal(phoneJournal.withLanCandidates(mdns, ['8.8.8.8', '192.168.1.400', '192.168.1.5']),
    mdns + '\r\n' + mdns.replace('test.local', '192.168.1.5'));
  const desktopDb = new IDBFactory(), phoneDb = new IDBFactory();
  const { createRepository } = await import('../services/records/src/repository.mjs');
  const { preparePrivateRecording, privateRecordingResults } = await import('../services/records/src/private-sync-restore.mjs');
  const { publicRecord, seal: sealCapture } = await import('../packages/records/src/record.mjs');
  const { setAutomation, automaticMinutesAt } = await import('../packages/records/src/automation.mjs');
  const { runCycle } = await import('../services/records/src/worker.mjs');
  const { writeFile } = await import('node:fs/promises');
  const folder = await mkdtemp(join(tmpdir(), 'lingji-phone-roundtrip-'));
  const repo = await createRepository({ root: folder, databaseUrl: '' });
  t.after(async () => { await repo.close(); await rm(folder, { recursive: true, force: true }); });
  await writeFile(join(folder, 'providers.json'), JSON.stringify({
    LLM_API_URL: 'https://llm.example.test/v1/chat/completions', LLM_API_KEY: 'fixture-key', LLM_MODEL: 'fixture-model',
  }));
  const signal = new AbortController().signal;
  const sourceId = randomUUID(), title = '手机合成录音';
  const recordedAt = Date.parse('2026-09-03T08:15:00+08:00');
  const otherVault = randomUUID();
  let desktopId;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url, fixtureOrigin);
    const body = options.body ? JSON.parse(options.body) : undefined;
    const path = target.pathname.slice(4);
    if (path === '/private-sync/recording') {
      const record = await preparePrivateRecording(repo, 'local', body);
      desktopId = record.id;
      return Response.json(publicRecord(record));
    }
    if (path === `/records/${desktopId}/audio`) {
      const { pcm, ...chunk } = body;
      return Response.json(await repo.ingestAudio('local', desktopId, chunk, Buffer.from(pcm, 'base64')));
    }
    if (path === `/records/${desktopId}/seal`) {
      await repo.change(desktopId, record => sealCapture(record, body.sources));
      return Response.json({});
    }
    const reply = await signed(path + target.search, options.method, body);
    return Response.json(reply.data, { status: reply.status });
  });
  const originalIDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  t.after(() => Object.defineProperty(globalThis, 'indexedDB', originalIDB));
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: phoneDb });
  await phoneJournal.queueLiveAudio(vault, root, sourceId, title, { kind: 'pcm', sequence: 0, offset: 0, recordedAt,
    pcm: { codec: 'pcm', length: 32000, bytes: new Uint8Array(32000).fill(4) } }, false, true);
  await phoneJournal.queueLiveAudio(vault, root, sourceId, title, { kind: 'finish', sequence: 1 }, false, true);
  assert.deepEqual(await phoneJournal.pushLiveAudio(vault, 'phone-v2', signal), []);
  const packet = await phoneJournal.heldAudio(vault, sourceId, 0);
  const frame = await desktopJournal.openLiveAudio(vault, root, packet.operation, packet.v2);
  const receive = desktopJournal.createMobileAudioReceiver(vault, signal);
  assert.deepEqual(await receive(frame), {next: 1, done: false, stored: true});
  assert.equal((await signed('/private-sync/live-audio-v2?vault=' + vault.id)).data.operations.length, 0);
  await phoneJournal.releaseHeldAudio(vault, sourceId, true);
  assert.equal(await phoneJournal.heldAudio(vault, sourceId, 0), undefined);
  await phoneJournal.pushLiveAudio(vault, 'phone-v2', signal);
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: desktopDb });
  await desktopJournal.receiveLiveAudio(vault, root, signal, () => {}, true);
  assert.equal((await repo.get(desktopId)).capture, 'sealed');
  assert.equal((await repo.get(desktopId)).chunks.length, 1);
  await runCycle(repo, { transcribe: async () => '决定周五进行发布评审' }, { lane: 'audio' });
  const finished = await repo.get(desktopId);
  assert.equal(finished.capture, 'completed');
  assert.equal(finished.realtimeAudioConsent, false);
  assert.equal(automaticMinutesAt(finished, 1234), 1234);
  await runCycle(repo, { minutes: async job => ({ title: '发布评审', sections: [{ heading: '决定', items: [{
    text: '周五进行发布评审', evidence: [{ segmentId: job.snapshot[0].id, revision: job.snapshot[0].revision }],
  }] }], actions: [] }) }, { lane: 'minutes' });
  const final = await repo.get(desktopId);
  assert.equal(final.minutes.title, '发布评审');
  assert.equal(final.minutes.transcriptRevision, final.transcriptRevision);
  assert.deepEqual(await privateRecordingResults(repo, 'local', { vault: otherVault, includeDesktop: true }), []);
  assert.deepEqual((await privateRecordingResults(repo, 'local', { vault: vault.id })).map(value => value.id), [desktopId]);
  await desktopJournal.queueMeeting(vault, root, publicRecord(final));
  await desktopJournal.syncMeetings(vault, root, signal);
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: phoneDb });
  assert.equal((await phoneJournal.syncMeetings(vault, root, signal)).received, true);
  const [copy] = await phoneJournal.meetingCopies(vault, root);
  assert.equal(copy.sourceId, sourceId);
  assert.equal(copy.recordedAt, recordedAt);
  const opened = await phoneJournal.loadMeetingCopy(vault, root, copy.id);
  assert.equal(opened.recordedAt, recordedAt);
  assert.equal(opened.content.segments[0].text, '决定周五进行发布评审');
  assert.equal(opened.content.minutes.title, '发布评审');

  const oldDesktop = { ...publicRecord(final), id: randomUUID(), syncSourceId: undefined, syncRecording: false,
    createdAt: undefined, recordedAt: undefined, sessions: undefined };
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: desktopDb });
  await desktopJournal.queueMeeting(vault, root, oldDesktop);
  await desktopJournal.syncMeetings(vault, root, signal);
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: phoneDb });
  await phoneJournal.syncMeetings(vault, root, signal);
  const oldCopy = (await phoneJournal.meetingCopies(vault, root)).find(item => item.sourceId === oldDesktop.id);
  assert.equal(oldCopy.recordedAt, undefined);
  await phoneJournal.annotateMeeting(vault, root, oldCopy.id, { notes: '手机手记' });
  await phoneJournal.syncMeetings(vault, root, signal);

  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: desktopDb });
  await desktopJournal.syncMeetings(vault, root, signal);
  const desktopMeeting = { ...oldDesktop, createdAt: '2026-09-01T00:00:00Z', sessions: [{ startedAt: '2026-09-02T18:15:00Z' }] };
  await desktopJournal.queueMeeting(vault, root, desktopMeeting);
  await desktopJournal.queueMeeting(vault, root, desktopMeeting);
  await desktopJournal.syncMeetings(vault, root, signal);
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: phoneDb });
  await phoneJournal.syncMeetings(vault, root, signal);
  const updated = (await phoneJournal.meetingCopies(vault, root)).filter(item => item.sourceId === oldDesktop.id);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].recordedAt, Date.parse('2026-09-02T18:15:00Z'));
  assert.equal((await phoneJournal.loadMeetingCopy(vault, root, updated[0].id)).notes, '手机手记');
  await repo.change(desktopId, record => { record.autoMinutes = { enabled: false, intervalSeconds: 90 }; });
  await privateRecordingResults(repo, 'local', { vault: vault.id });
  assert.equal((await repo.get(desktopId)).autoMinutes.enabled, true);
  await repo.change(desktopId, record => setAutomation(record, { enabled: false }));
  await privateRecordingResults(repo, 'local', { vault: vault.id });
  assert.equal((await repo.get(desktopId)).autoMinutes.enabled, false);
});
