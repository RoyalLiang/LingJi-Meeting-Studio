import { randomUUID } from 'node:crypto';
import { link, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as opaque from '@serenity-kit/opaque';
import { parseVault } from './private-sync-routes.mjs';
import { accountId, normalizeAccountEmail, validAccountEmail, validAccountEnvelope } from './auth.mjs';
import { DomainError, requireThat } from '../../../packages/records/src/record.mjs';

const lifetime = 3 * 60_000;
const maxChallenges = 2048;
const frame = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^[\w-]+$/.test(value);

async function openSetup(root) {
  const path = join(root, 'opaque-account.key');
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path + '.' + randomUUID();
  try {
    await writeFile(temporary, opaque.server.createSetup(), { mode: 0o600, flag: 'wx' });
    try { await link(temporary, path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return await readFile(path, 'utf8');
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function createAccountAuth({ repo, auth, store, origin }) {
  await opaque.ready;
  const serverSetup = await openSetup(repo.root);
  opaque.server.getPublicKey(serverSetup);
  // shortcut: challenges live in one process; use shared single-use storage before running multiple instances.
  const pending = new Map();

  function remember(state) {
    const now = Date.now();
    for (const [id, entry] of pending) {
      if (entry.expires <= now) pending.delete(id);
      else break;
    }
    requireThat(pending.size < maxChallenges, 'authentication_busy', 429);
    const challenge = randomUUID();
    pending.set(challenge, { ...state, expires: now + lifetime });
    return challenge;
  }

  function claim(challenge, phase, owner) {
    const state = pending.get(challenge);
    requireThat(state && state.phase === phase && state.upgrade?.id === owner && state.expires > Date.now(), 'account_challenge_expired', 409);
    pending.delete(challenge);
    return state;
  }

  function protocol(code, run, status = 400) {
    try { return run(); }
    catch { throw new DomainError(code, status); }
  }

  return async function accountAuth({ req, res, user, readBody, send, limit }) {
    requireThat(req.method === 'POST' && req.headers.origin === origin.origin, 'origin_rejected', 403);
    const { step, email: input, message, challenge, registrationRecord, currentPassword, envelope, replacementVault, factor } = await readBody(req, 8192);
    requireThat(frame(message), 'account_message_invalid', 400);

    if (step === 'login' || step === 'register') {
      const email = user?.email ?? normalizeAccountEmail(input);
      requireThat(validAccountEmail(email), 'invalid_email', 400);
      const id = accountId(email);
      limit('account-start:' + id, 12, 'login_rate_limited');
      if (step === 'register') {
        let upgrade;
        if (user) {
          requireThat(!user.opaqueRecord, 'account_already_upgraded', 409);
          requireThat(typeof currentPassword === 'string' && currentPassword.length >= 10 && currentPassword.length <= 128, 'invalid_credentials', 401);
          const confirmed = await auth.login({ email, password: currentPassword });
          requireThat(confirmed.authVersion === user.authVersion, 'account_changed', 409);
          const vault = await store.vault(user.id);
          requireThat(vault, 'sync_vault_unavailable', 404);
          upgrade = { id: user.id, version: user.authVersion, vault: vault.id };
        } else {
          requireThat(!await repo.get(id), 'already_exists', 409);
        }
        const { registrationResponse } = protocol('account_message_invalid', () => opaque.server.createRegistrationResponse({
          serverSetup, userIdentifier: id, registrationRequest: message,
        }));
        send(res, 200, { challenge: remember({ phase: 'prove', email, id, upgrade }), message: registrationResponse });
        return;
      }
      requireThat(!user, 'account_message_invalid', 400);
      const account = await repo.get(id);
      requireThat(!account || account.opaqueRecord, 'account_legacy', 409);
      const { serverLoginState, loginResponse } = protocol('account_message_invalid', () => opaque.server.startLogin({
        serverSetup, userIdentifier: id, registrationRecord: account?.opaqueRecord, startLoginRequest: message,
      }));
      const token = remember({ phase: 'finish', id, version: account?.authVersion, serverLoginState });
      send(res, 200, { challenge: token, message: loginResponse });
      return;
    }

    if (step === 'prove') {
      const state = claim(challenge, 'prove', user?.id);
      requireThat(frame(registrationRecord), 'account_message_invalid', 400);
      const replacement = user && replacementVault ? parseVault(replacementVault) : undefined;
      if (user) requireThat(validAccountEnvelope(envelope) && envelope.vault === (replacement?.id ?? state.upgrade.vault) &&
        (!replacement || replacement.id !== state.upgrade.vault), 'sync_invalid_envelope', 400);
      const { serverLoginState, loginResponse } = protocol('account_message_invalid', () => opaque.server.startLogin({
        serverSetup, userIdentifier: state.id, registrationRecord, startLoginRequest: message,
      }));
      const token = remember({
        ...state, phase: 'finish', serverLoginState, registrationRecord, replacement,
        envelope: state.upgrade ? { vault: envelope.vault, nonce: envelope.nonce, body: envelope.body } : undefined,
      });
      send(res, 200, { challenge: token, message: loginResponse });
      return;
    }

    requireThat(step === 'finish', 'account_message_invalid', 400);
    const state = claim(challenge, 'finish', user?.id);
    protocol('invalid_credentials', () => opaque.server.finishLogin({ serverLoginState: state.serverLoginState, finishLoginRequest: message }), 401);
    let account;
    if (!state.registrationRecord) {
      account = await repo.get(state.id);
      requireThat(account?.opaqueRecord && account.authVersion === state.version, 'invalid_credentials', 401);
    } else if (state.upgrade) {
      const fence = state.replacement && await store.reserveEmptyUpgrade(state.id, state.upgrade.vault);
      try {
        account = await repo.change(state.id, current => {
          requireThat(current.kind === 'user' && !current.opaqueRecord && current.authVersion === state.upgrade.version, 'account_changed', 409);
          current.opaqueRecord = state.registrationRecord;
          current.accountEnvelope = state.envelope;
          if (state.replacement) current.replacementVault = state.replacement;
          delete current.password;
          delete current.salt;
          current.authVersion++;
        });
      } catch (error) {
        if (fence) await store.releaseEmptyUpgrade(state.id, fence).catch(() => {});
        throw error;
      }
    } else {
      account = { id: state.id, kind: 'user', email: state.email, opaqueRecord: state.registrationRecord, authVersion: 1 };
      await repo.insert(account);
    }
    if (account.totp && factor) limit('account-factor:' + account.id, 5, 'login_rate_limited');
    const cookie = await auth.issue(account, req, factor);
    send(res, 200, { email: account.email, csrf: auth.csrf(account) }, { 'Set-Cookie': cookie });
  };
}
