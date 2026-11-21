import { api } from '../api';
import { decodeBytes, encodeBytes, seal, unseal, type Envelope, type Vault } from './vault';

type RegistrationOptions = Omit<PublicKeyCredentialCreationOptions, 'challenge' | 'user' | 'excludeCredentials'> & {
  challenge: string;
  user: Omit<PublicKeyCredentialUserEntity, 'id'> & { id: string };
  excludeCredentials?: (Omit<PublicKeyCredentialDescriptor, 'id'> & { id: string })[];
};
type AuthenticationOptions = Omit<PublicKeyCredentialRequestOptions, 'challenge' | 'allowCredentials'> & {
  challenge: string;
  allowCredentials?: (Omit<PublicKeyCredentialDescriptor, 'id'> & { id: string })[];
};
type PrfResults = { prf?: { enabled?: boolean; results?: { first: ArrayBuffer } } };

function extractPrf(credential: PublicKeyCredential) {
  const extra = credential.getClientExtensionResults() as PrfResults;
  const output = extra.prf?.results?.first;
  return output?.byteLength === 32 ? new Uint8Array(output) : null;
}

async function credentialGet(options: AuthenticationOptions, vault: Vault, signal: AbortSignal) {
  const credential = await navigator.credentials.get({
    signal,
    publicKey: {
      ...options,
      challenge: decodeBytes(options.challenge),
      allowCredentials: options.allowCredentials?.map(item => ({ ...item, id: decodeBytes(item.id) })),
      extensions: { prf: { eval: { first: decodeBytes(vault.salt) } } },
      userVerification: 'required',
    },
  }) as PublicKeyCredential | null;
  if (!credential || !extractPrf(credential)) throw new Error('此设备的通行密钥不支持资料库解锁。可以使用恢复密钥或设备配对。');
  return credential;
}

const bytes = (buffer: ArrayBuffer) => encodeBytes(new Uint8Array(buffer));

export async function enrollPasskey(vault: Vault, root: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
  const options = await api<RegistrationOptions>('/private-sync/passkey/register', 'POST', {}, signal);
  const credential = await navigator.credentials.create({
    signal,
    publicKey: {
      ...options,
      challenge: decodeBytes(options.challenge),
      user: { ...options.user, id: decodeBytes(options.user.id) },
      excludeCredentials: options.excludeCredentials?.map(item => ({ ...item, id: decodeBytes(item.id) })),
      extensions: { prf: { eval: { first: decodeBytes(vault.salt) } } },
    },
  }) as PublicKeyCredential | null;
  if (!credential) throw new Error('未创建通行密钥');
  const registrationPrf = credential.getClientExtensionResults() as PrfResults;
  if (registrationPrf.prf?.enabled === false) throw new Error('此通行密钥不支持资料库解锁');
  const local = extractPrf(credential) ?? extractPrf(await credentialGet({
    challenge: encodeBytes(crypto.getRandomValues(new Uint8Array(32))),
    rpId: options.rp.id, allowCredentials: [{ id: credential.id, type: 'public-key' }],
  }, vault, signal));
  if (!local) throw new Error('无法从通行密钥获得解锁材料');
  const response = credential.response as AuthenticatorAttestationResponse;
  try {
    signal.throwIfAborted();
    const envelope = await seal(local, vault, 'passkey', credential.id, root);
    signal.throwIfAborted();
    await api('/private-sync/passkey/register/finish', 'POST', {
      envelope,
      response: {
        id: credential.id, rawId: bytes(credential.rawId), type: credential.type,
        response: {
          attestationObject: bytes(response.attestationObject), clientDataJSON: bytes(response.clientDataJSON),
          transports: response.getTransports?.(),
        },
        clientExtensionResults: {},
      },
    }, signal);
  } finally {
    local.fill(0);
  }
}

export async function unlockPasskey(vault: Vault, signal: AbortSignal) {
  const options = await api<AuthenticationOptions>('/private-sync/passkey/unlock', 'POST', {}, signal);
  const credential = await credentialGet(options, vault, signal);
  const local = extractPrf(credential)!;
  const response = credential.response as AuthenticatorAssertionResponse;
  try {
    const { envelope } = await api<{ envelope: Envelope }>('/private-sync/passkey/unlock/finish', 'POST', {
      response: {
        id: credential.id, rawId: bytes(credential.rawId), type: credential.type,
        response: {
          clientDataJSON: bytes(response.clientDataJSON), authenticatorData: bytes(response.authenticatorData),
          signature: bytes(response.signature), userHandle: response.userHandle ? bytes(response.userHandle) : undefined,
        },
        clientExtensionResults: {},
      },
    }, signal);
    return await unseal(local, vault, 'passkey', credential.id, envelope);
  } finally {
    local.fill(0);
  }
}
