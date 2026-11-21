import { totpCode, totpStep } from '../services/records/src/account-totp.mjs';
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
  assert.deepEqual((await call('profile', 'PATCH', { name: '  设备验收  ' })).data, { name: '设备验收' });
  assert.deepEqual((await call('profile', 'GET')).data, { name: '设备验收' });
  assert.equal((await call('profile', 'PATCH', { name: 'x'.repeat(61) })).status, 400);
  assert.deepEqual((await call('vault', 'GET')).data, { vault: null, legacy: true, liveAudio: true });
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
  assert.deepEqual(Object.keys(mobile.data).sort(), ['csrf', 'email']);
  assert.equal((await first('/private-sync/vault', 'PUT', vault, { Origin: 'https://other.example.test' })).status, 403);
  assert.equal((await first('/private-sync/vault', 'PUT', vault, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await first('/private-sync/vault', 'PUT', vault)).status, 201);
  assert.equal((await first('/private-sync/vault', 'PUT', vault)).status, 409);
  assert.deepEqual((await second('/private-sync/vault')).data, { vault: null, legacy: true, liveAudio: true });
  const id = randomUUID();
  const operation = { id, ...await seal(root, vault, 'revision', id, encoder.encode(stamp)) };
  const payload = { vault: vault.id, operations: [operation] };
  const sent = await first('/private-sync/delta', 'POST', payload);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.deepEqual(sent.data.acknowledgements, [{ id, seq: 1 }]);
  assert.deepEqual((await first('/private-sync/delta', 'POST', payload)).data, sent.data);
  assert.equal((await first('/private-sync/delta', 'POST', {vault: vault.id, operations: [{...operation, nonce: randomBytes(12).toString('base64url')}]})).status, 409);
  assert.equal((await second('/private-sync/delta?vault=' + vault.id)).status, 404);
  const quota = 64 * 1024 * 1024;
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
  const owner = signed(primary);
  const second = signed(guest);
  const devices = (await owner('/private-sync/devices')).data;
  assert.equal(devices.items.length, 2);
  const remote = devices.items.find(device => !device.current);
  assert.equal(remote.name, 'Android');
  assert.equal((await owner('/private-sync/devices', 'DELETE', { id: remote.id })).status, 200);
  assert.equal((await second('/private-sync/devices')).status, 401);
  assert.equal((await owner('/private-sync/devices')).data.items.length, 1);

  const plans = await owner('/private-sync/billing/plans');
  assert.equal(plans.data.checkout, false);
  assert.equal(plans.data.plans.length, 4);
  const quote = await owner('/private-sync/billing/quote', 'POST', { planId: 'storage-20g', period: 'yearly', amount: 1 });
  assert.deepEqual(quote.data, { planId: 'storage-20g', period: 'yearly', amount: 36500, currency: 'CNY', payable: false });
  assert.equal((await request('/private-sync/billing/plans')).status, 401);

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
  const db = new DatabaseSync(join(root, 'private-sync.sqlite'));
  try { db.prepare('UPDATE sync_vaults SET bytes=? WHERE owner=?').run(64 * 1024 * 1024, owner + ':live-audio'); }
  finally { db.close(); }
  const operation = { id: randomUUID(), nonce: 'test', body: 'test' };
  await assert.rejects(store.push(owner + ':live-audio', vault.id, [operation], owner), { code: 'sync_quota_exceeded' });
  const written = await store.push(owner + ':live-receipts', vault.id, [operation], owner);
  assert.equal(written.acknowledgements[0]?.seq, 1);
  assert.equal((await store.usage(owner)).audio, 64 * 1024 * 1024);
});
