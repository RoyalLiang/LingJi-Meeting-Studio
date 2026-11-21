import { api, ApiError, setCsrf } from '../api';
import { decodeBytes, seal, unseal, type Envelope, type Vault } from './vault';

type Session = { email: string; csrf?: string; companion?: string };
type Exchange = { message: string; challenge: string };
const purpose = 'account-wrap/1';

export function wrapAccountVault(material: Uint8Array<ArrayBuffer>, vault: Vault, root: Uint8Array<ArrayBuffer>) {
  return seal(material, vault, purpose, vault.id, root);
}

export function openAccountVault(material: Uint8Array<ArrayBuffer>, vault: Vault, envelope: Envelope) {
  return unseal(material, vault, purpose, vault.id, envelope);
}

export async function authenticateAccount(input: {
  email: string; password: string; factor?: string; register?: boolean; desktop?: boolean; signal?: AbortSignal;
  upgrade?: { currentPassword: string; vault: Vault; root: Uint8Array<ArrayBuffer>; replaceEmpty?: boolean };
}) {
  const { email, password, signal, upgrade, register, desktop } = input;
  if (password.length < 10 || password.length > 128) throw new ApiError('password_length_10_128', 400);
  if (upgrade?.currentPassword === password) throw new Error('请设置与当前密码不同的新密码');
  const opaque = await import('@serenity-kit/opaque');
  await opaque.ready;
  signal?.throwIfAborted();
  const path = upgrade ? '/private-sync/account-upgrade' : desktop ? '/private-sync/session' : '/auth/account';
  const begin = opaque.client.startLogin({ password });
  let response: Exchange;
  if (register || upgrade) {
    const registration = opaque.client.startRegistration({ password });
    const reply = await api<Exchange>(path, 'POST', {
      step: 'register', email, message: registration.registrationRequest, ...(upgrade ? { currentPassword: upgrade.currentPassword } : {}),
    }, signal);
    const { exportKey, registrationRecord } = opaque.client.finishRegistration({
      clientRegistrationState: registration.clientRegistrationState, password, registrationResponse: reply.message,
    });
    const material = decodeBytes(exportKey);
    try {
      const envelope = upgrade
        ? { ...await wrapAccountVault(material, upgrade.vault, upgrade.root), vault: upgrade.vault.id }
        : undefined;
      response = await api<Exchange>(path, 'POST', {
        step: 'prove', challenge: reply.challenge, registrationRecord, message: begin.startLoginRequest, ...(envelope ? { envelope } : {}),
        ...(upgrade?.replaceEmpty ? { replacementVault: upgrade.vault } : {}),
      }, signal);
    } finally { material.fill(0); }
  } else {
    response = await api<Exchange>(path, 'POST', { step: 'login', email, message: begin.startLoginRequest }, signal);
  }
  const login = opaque.client.finishLogin({ clientLoginState: begin.clientLoginState, password, loginResponse: response.message });
  if (!login) throw new ApiError('invalid_credentials', 401);
  const user = await api<Session>(path, 'POST', { step: 'finish', challenge: response.challenge, message: login.finishLoginRequest, ...(input.factor ? { factor: input.factor } : {}) }, signal);
  if (user.csrf) setCsrf(user.csrf);
  return { user, material: decodeBytes(login.exportKey) };
}
