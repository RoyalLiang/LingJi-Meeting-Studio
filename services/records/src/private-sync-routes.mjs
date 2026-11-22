import { createHash } from 'node:crypto';
import { DomainError, requireThat } from '../../../packages/records/src/record.mjs';
import { SYNC_PAGE_BYTES } from './private-sync-store.mjs';
import { billingCatalog, billingQuote } from './account-billing.mjs';
import { validAccountEnvelope } from './auth.mjs';

const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const validId = value => typeof value === 'string' && idPattern.test(value);
const base64url = (value, min, max = min) => typeof value === 'string' && value.length >= min && value.length <= max && /^[\w-]+$/.test(value);
const keyEnvelope = value => {
  requireThat(base64url(value?.nonce, 16) && base64url(value?.body, 64), 'sync_invalid_envelope', 400);
  return { nonce: value.nonce, body: value.body };
};

export function parseVault({ id, salt, recovery }) {
  requireThat(validId(id) && base64url(salt, 43), 'sync_invalid_vault', 400);
  return { id, salt, recovery: keyEnvelope(recovery) };
}

export function privateSyncOrigin(value) {
  if (!value) return null;
  const url = new URL(value);
  const secure = url.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && url.hostname === 'localhost');
  if (!secure || value !== url.origin || url.username || url.password) throw new Error('Invalid RECORD_SYNC_ORIGIN');
  return url;
}

export function createPrivateSyncRoutes({ store, origin, repo, auth }) {
  const rpID = origin.hostname;
  const webauthn = () => import('@simplewebauthn/server');
  const time = () => Date.now();
  async function verify(callback) {
    try { return await callback(); }
    catch { throw new DomainError('sync_webauthn_verification_failed', 400); }
  }
  return async ({ req, res, path, url, user, readBody, send, limit }) => {
    const method = req.method;
    const owner = user.replacementVault ? user.id + ':current' : user.id;
    if (!path.startsWith('/api/private-sync/')) return false;
    requireThat(req.headers.host === origin.host && (method === 'GET' || req.headers.origin === origin.origin), 'origin_rejected', 403);
    const route = path.slice('/api/private-sync/'.length);
    const liveStream = route === 'live-audio' || route === 'live-audio-v2' || route === 'live-receipts';
    if (liveStream) limit('private-sync-live:' + user.id, 360);
    else limit('private-sync:' + user.id, 160);
    const audioStream = route === 'audio' || liveStream;
    if (route.startsWith('passkey/')) limit('sync-passkey:' + owner, 24);
    if (route === 'mobile-session' && (method === 'GET' || method === 'POST')) {
      let expiresAt = auth.sessionExpiry(req);
      if (method === 'POST') {
        const renewed = await auth.refreshSession(user, req);
        res.setHeader('Set-Cookie', renewed.cookie);
        expiresAt = renewed.expires;
      } else await auth.identifyDevice(user, req);
      send(res, 200, { email: user.email, csrf: auth.csrf(user), expiresAt });
    } else if (route === 'profile' && method === 'GET') {
      send(res, 200, { name: user.profile?.name || '' });
    } else if (route === 'profile' && method === 'PATCH') {
      const { name } = await readBody(req, 1024);
      requireThat(typeof name === 'string' && name.trim().length <= 60 && !/[\p{Cc}\p{Cf}]/u.test(name), 'sync_invalid_profile', 400);
      const profile = { name: name.trim() };
      await repo.change(user.id, account => { account.profile = profile; });
      send(res, 200, profile);
    } else if (route === 'billing/plans' && method === 'GET') {
      send(res, 200, billingCatalog());
    } else if (route === 'billing/quote' && method === 'POST') {
      const { planId, period } = await readBody(req, 1024);
      send(res, 200, billingQuote(planId, period));
    } else if (route === 'devices' && method === 'GET') {
      await auth.identifyDevice(user, req);
      send(res, 200, auth.devices(user, req));
    } else if (route === 'devices' && method === 'DELETE') {
      const { id } = await readBody(req, 1024);
      requireThat(validId(id), 'account_device_unavailable', 400);
      await auth.revoke(user, req, id);
      send(res, 200, { ok: true });
    } else if (route === 'factor' && method === 'GET') {
      send(res, 200, auth.factorStatus(user, req));
    } else if (route === 'factor/enroll' && method === 'POST') {
      limit('account-factor:' + user.id, 5, 'login_rate_limited');
      send(res, 200, await auth.beginTotp(user, req));
    } else if (route === 'factor' && ['POST', 'DELETE'].includes(method)) {
      limit('account-factor:' + user.id, 5, 'login_rate_limited');
      const { code } = await readBody(req, 1024);
      requireThat(typeof code === 'string' && code.length <= 24, 'account_factor_invalid', 400);
      if (method === 'POST') send(res, 200, await auth.confirmTotp(user, req, code));
      else {
        await auth.disableTotp(user, req, code);
        send(res, 200, { ok: true });
      }
    } else if (route === 'usage' && method === 'GET') {
      send(res, 200, await store.usage(owner));
    } else if (route === 'vault' && method === 'GET') {
      let vault = await store.vault(owner);
      if (!vault && user.replacementVault) {
        try { vault = await store.initialize(owner, user.replacementVault); }
        catch (error) {
          if (error?.code !== 'sync_vault_exists') throw error;
          vault = await store.vault(owner);
        }
      }
      const account = user.accountEnvelope?.vault === vault?.id ? user.accountEnvelope : vault?.account;
      const hasPasskey = vault && (await store.credentials(owner)).length > 0;
      const emptyUpgrade = !user.opaqueRecord && vault && await store.emptyUpgradeAvailable(owner);
      send(res, 200, { vault, account, legacy: !user.opaqueRecord, ...(hasPasskey ? { hasPasskey } : {}), ...(emptyUpgrade ? { emptyUpgrade } : {}), liveAudio: true, liveAudioV2: true });
    } else if (route === 'vault' && method === 'PUT') {
      requireThat(!user.replacementVault, 'sync_vault_exists', 409);
      const { account, ...descriptor } = await readBody(req, 1024);
      requireThat(user.opaqueRecord ? validAccountEnvelope(account) : account === undefined, 'sync_invalid_envelope', 400);
      send(res, 201, { vault: await store.initialize(owner, { ...parseVault(descriptor), ...(account ? { account: keyEnvelope(account) } : {}) }) });
    } else if ((route === 'delta' || audioStream) && method === 'GET') {
      const after = url.searchParams.get('after') ?? '0';
      const id = url.searchParams.get('vault');
      requireThat(validId(id) && /^\d{1,15}$/.test(after), 'sync_invalid_cursor', 400);
      const result = audioStream
        ? await store.pullSubstream(owner, owner + ':' + route, id, Number(after))
        : await store.pull(owner, id, Number(after));
      send(res, 200, result);
    } else if (audioStream && route !== 'live-receipts' && method === 'DELETE') {
      const before = url.searchParams.get('before') ?? '';
      const id = url.searchParams.get('vault');
      requireThat(validId(id) && /^\d{1,15}$/.test(before) && Number(before) > 0, 'sync_invalid_cursor', 400);
      send(res, 200, await store.acknowledgeAudio(owner + ':' + route, id, Number(before), owner));
    } else if ((route === 'delta' || audioStream) && method === 'POST') {
      const { vault, operations } = await readBody(req, SYNC_PAGE_BYTES);
      requireThat(validId(vault) && Array.isArray(operations) && operations.length >= 1 && operations.length <= 64, 'sync_invalid_operations', 400);
      const batch = operations.map(operation => {
        requireThat(validId(operation?.id) && base64url(operation?.nonce, 16) && base64url(operation?.body, 22, 256 * 1024), 'sync_invalid_operation', 400);
        return { id: operation.id, nonce: operation.nonce, body: operation.body };
      });
      let stream = owner;
      if (audioStream) {
        const descriptor = await store.vault(owner);
        requireThat(descriptor?.id === vault, 'sync_vault_unavailable', 404);
        stream += ':' + route;
        if (!await store.vault(stream)) {
          try { await store.initialize(stream, descriptor); }
          catch (error) { if (error?.code !== 'sync_vault_exists') throw error; }
        }
      }
      send(res, 200, await store.push(stream, vault, batch, audioStream ? owner : undefined));
    } else if (route === 'pair/start' && method === 'POST') {
      const { id, proof } = await readBody(req, 1024);
      requireThat(validId(id) && base64url(proof, 43), 'sync_invalid_pair', 400);
      await store.startPair(owner, id, createHash('sha256').update(proof).digest('hex'), time());
      send(res, 201, { ok: true });
    } else if (route === 'pair/exchange' && method === 'POST') {
      const { id, proof, frame } = await readBody(req, 8000);
      requireThat(validId(id) && base64url(proof, 43), 'sync_invalid_pair', 400);
      requireThat(!frame || ([1, 2, 3, 4].includes(frame.step) && base64url(frame.data, 16, 6000)), 'sync_invalid_pair_frame', 400);
      send(res, 200, await store.pair(owner, id, createHash('sha256').update(proof).digest('hex'), frame, time()));
    } else if (route === 'passkey/register' && method === 'POST') {
      requireThat(await store.vault(owner), 'sync_vault_unavailable', 404);
      const { generateRegistrationOptions } = await webauthn();
      const credentials = await store.credentials(owner);
      const options = await generateRegistrationOptions({
        rpID, rpName: '聆记', userName: user.email, userID: createHash('sha256').update(owner).digest(),
        attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: credentials.map(({ id, transports }) => ({ id, transports })),
      });
      await store.challenge(owner, 'register', options.challenge, time());
      send(res, 200, options);
    } else if (route === 'passkey/register/finish' && method === 'POST') {
      const { response, envelope } = await readBody(req, 64 * 1024);
      const sealed = keyEnvelope(envelope);
      const challenge = await store.takeChallenge(owner, 'register', time());
      requireThat(challenge, 'sync_challenge_expired', 409);
      const { verifyRegistrationResponse } = await webauthn();
      const result = await verify(() => verifyRegistrationResponse({
        response, expectedChallenge: challenge, expectedOrigin: origin.origin, expectedRPID: rpID, requireUserVerification: true,
      }));
      requireThat(result.verified && result.registrationInfo, 'sync_webauthn_verification_failed', 400);
      const { id, publicKey, counter, transports } = result.registrationInfo.credential;
      await store.addCredential(owner, { id, publicKey: Buffer.from(publicKey).toString('base64url'), counter, transports, envelope: sealed });
      send(res, 201, { id });
    } else if (route === 'passkey/unlock' && method === 'POST') {
      const credentials = await store.credentials(owner);
      requireThat(credentials.length > 0, 'sync_no_passkey', 404);
      const { generateAuthenticationOptions } = await webauthn();
      const options = await generateAuthenticationOptions({
        rpID, userVerification: 'required', allowCredentials: credentials.map(({ id, transports }) => ({ id, transports })),
      });
      await store.challenge(owner, 'unlock', options.challenge, time());
      send(res, 200, options);
    } else if (route === 'passkey/unlock/finish' && method === 'POST') {
      const { response } = await readBody(req, 32 * 1024);
      const challenge = await store.takeChallenge(owner, 'unlock', time());
      requireThat(challenge, 'sync_challenge_expired', 409);
      const credential = (await store.credentials(owner)).find(item => item.id === response?.id);
      requireThat(credential, 'sync_webauthn_verification_failed', 400);
      const { verifyAuthenticationResponse } = await webauthn();
      const result = await verify(() => verifyAuthenticationResponse({
        response, expectedChallenge: challenge, expectedOrigin: origin.origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: credential.id, publicKey: Buffer.from(credential.publicKey, 'base64url'), counter: credential.counter, transports: credential.transports },
      }));
      requireThat(result.verified, 'sync_webauthn_verification_failed', 400);
      await store.finishAssertion(owner, credential, result.authenticationInfo.newCounter);
      send(res, 200, { envelope: credential.envelope });
    } else {
      throw new DomainError('not_found', 404);
    }
    return true;
  };
}
