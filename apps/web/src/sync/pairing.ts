import * as opaque from '@serenity-kit/opaque';
import { api } from '../api';
import { decodeBytes, encodeBytes, newPairSecret, seal, unseal, type Envelope, type Vault } from './vault';

type PairState = { frames: string[]; expires: number };
type Invitation = { id: string; sender: string; secret: string; proof: string; code: string; setup: string; registration: string; expires: number };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const pack = (obj: unknown) => encodeBytes(encoder.encode(JSON.stringify(obj)));
const unpack = <T,>(data: string) => JSON.parse(decoder.decode(decodeBytes(data))) as T;
const pairPath = '/private-sync/pair/exchange';

function scope(vault: Vault, id: string, sender: string, relay: string) {
  const context = JSON.stringify(['lingji-pair/1', new URL(relay).origin, vault.id, id, sender]);
  return { client: context + '/recipient', server: context + '/sender' };
}

function exchange(id: string, proof: string, step?: number, data?: unknown, signal?: AbortSignal) {
  return api<PairState>(pairPath, 'POST', { id, proof, ...(step ? { frame: { step, data: pack(data) } } : {}) }, signal);
}

async function waitForFrame<T>(id: string, proof: string, step: number, expires: number, signal: AbortSignal) {
  while (!signal.aborted && Date.now() < expires) {
    const state = await exchange(id, proof, undefined, undefined, signal);
    if (state.frames[step - 1]) return unpack<T>(state.frames[step - 1]);
    await new Promise(resolve => window.setTimeout(resolve, 1800));
  }
  throw new Error(signal.aborted ? '配对已取消' : '配对已过期，请重新生成邀请');
}

export async function createInvitation(vault: Vault, relay: string): Promise<Invitation> {
  await opaque.ready;
  const id = crypto.randomUUID(), sender = crypto.randomUUID();
  const secret = newPairSecret(), proof = newPairSecret();
  const setup = opaque.server.createSetup();
  const identifiers = scope(vault, id, sender, relay);
  const registration = opaque.client.startRegistration({ password: secret });
  const response = opaque.server.createRegistrationResponse({
    serverSetup: setup, userIdentifier: id, registrationRequest: registration.registrationRequest,
  });
  const { registrationRecord } = opaque.client.finishRegistration({
    ...registration, ...response, password: secret, identifiers,
  });
  await api('/private-sync/pair/start', 'POST', { id, proof });
  return { id, sender, secret, proof, setup, registration: registrationRecord, expires: Date.now() + 5 * 60_000, code: ['LJPAIR1', vault.id, id, sender, secret].join('.') };
}

export async function authorizeInvite(vault: Vault, root: Uint8Array<ArrayBuffer>, invite: Invitation, relay: string, signal: AbortSignal, approve: () => Promise<void>) {
  const { request, recipient } = await waitForFrame<{ request: string; recipient: string }>(invite.id, invite.proof, 1, invite.expires, signal);
  if (!uuid.test(recipient)) throw new Error('配对设备标识无效');
  const identifiers = scope(vault, invite.id, invite.sender, relay);
  const login = opaque.server.startLogin({
    serverSetup: invite.setup, registrationRecord: invite.registration, startLoginRequest: request,
    userIdentifier: invite.id, identifiers,
  });
  await exchange(invite.id, invite.proof, 2, login.loginResponse, signal);
  const confirmation = await waitForFrame<string>(invite.id, invite.proof, 3, invite.expires, signal);
  const { sessionKey } = opaque.server.finishLogin({
    serverLoginState: login.serverLoginState, finishLoginRequest: confirmation, identifiers,
  });
  await approve();
  signal.throwIfAborted();
  const material = decodeBytes(sessionKey);
  try {
    const encrypted = await seal(material, vault, 'pair', invite.id + ':' + recipient, root);
    await exchange(invite.id, invite.proof, 4, encrypted, signal);
  } finally {
    material.fill(0);
  }
}

export async function joinInvite(vault: Vault, input: string, relay: string, signal: AbortSignal) {
  const [prefix, vaultId, id, sender, secret, extra] = input.trim().split('.');
  if (prefix !== 'LJPAIR1' || vaultId !== vault.id || !uuid.test(id) || !uuid.test(sender) || !/^[\w-]{43}$/.test(secret) || extra !== undefined) {
    throw new Error('配对码与当前账号不匹配');
  }
  await opaque.ready;
  const proof = newPairSecret(), recipient = crypto.randomUUID();
  const begin = opaque.client.startLogin({ password: secret });
  const { expires } = await exchange(id, proof, 1, { request: begin.startLoginRequest, recipient }, signal);
  const loginResponse = await waitForFrame<string>(id, proof, 2, expires, signal);
  const login = opaque.client.finishLogin({ clientLoginState: begin.clientLoginState, loginResponse, password: secret, identifiers: scope(vault, id, sender, relay) });
  if (!login) throw new Error('配对校验失败，请从原设备重新发起');
  await exchange(id, proof, 3, login.finishLoginRequest, signal);
  const wrapped = await waitForFrame<Envelope>(id, proof, 4, expires, signal);
  const material = decodeBytes(login.sessionKey);
  try {
    return await unseal(material, vault, 'pair', id + ':' + recipient, wrapped);
  } finally {
    material.fill(0);
  }
}
