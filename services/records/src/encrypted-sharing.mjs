import { createPublishedContent, ShareContentError } from '../../../packages/records/src/published-content.mjs';
import { encryptShare, shareFingerprint } from '../../../packages/records/src/encrypted-share.mjs';
import { DomainError, requireThat } from '../../../packages/records/src/record.mjs';

const publicLink = value => ({ id: value.id, requestId: value.requestId, fingerprint: value.fingerprint, scope: value.scope, expires: value.expires, revoked: value.revoked, pending: !value.expires, url: value.expires && !value.revoked ? `${value.origin}/s/${value.token}#${value.key}` : undefined });
export function createEncryptedSharing(repo, { fetcher = fetch, origin = 'https://rookiecode.com' } = {}) {
  const working = new Map();
  async function request(path, body, method = 'POST') {
    let response;
    try { response = await fetcher(origin + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000), redirect: 'error' }); }
    catch { throw new DomainError('encrypted_share_unavailable', 503); }
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new DomainError(response.status === 429 ? 'encrypted_share_limit' : response.status === 409 ? 'encrypted_share_conflict' : response.status === 404 ? 'encrypted_share_missing' : 'encrypted_share_unavailable', response.status === 429 ? 429 : 503);
    return value;
  }
  async function owned(owner, recordId, id) {
    const value = await repo.get(id);
    requireThat(value?.kind === 'encrypted-share' && value.owner === owner && value.recordId === recordId, 'not_found', 404);
    return value;
  }
  return {
    async list(owner, recordId) { return (await repo.list('encrypted-share')).filter(value => value.owner === owner && value.recordId === recordId).map(publicLink); },
    async create(owner, record, input) {
      requireThat(input.confirmed === true, 'share_confirmation_required', 400);
      requireThat(['minutes', 'full'].includes(input.scope) && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestId), 'invalid_share_scope', 400);
      const id = `encrypted-share:${input.requestId}`;
      requireThat(typeof input.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(input.fingerprint), 'share_content_changed', 409);
      if (working.has(id)) { await working.get(id); const value = await owned(owner, record.id, id); requireThat(value.scope === input.scope && value.fingerprint === input.fingerprint, 'share_content_changed', 409); return publicLink(value); }
      const upload = (async () => {
        let value = await repo.get(id);
        if (value) { value = await owned(owner, record.id, id); requireThat(value.scope === input.scope && value.fingerprint === input.fingerprint, 'share_content_changed', 409); }
        else {
          const active = (await repo.list('encrypted-share')).filter(item => item.owner === owner && !item.revoked && (!item.expires || item.expires > Date.now()));
          requireThat(active.length < 20, 'share_limit', 429);
          let encrypted;
          try { const content = createPublishedContent(record, input.scope); requireThat(await shareFingerprint(content) === input.fingerprint, 'share_content_changed', 409); encrypted = await encryptShare(content); }
          catch (error) { if (error instanceof ShareContentError) throw new DomainError(error.code, error.status); throw error; }
          value = await repo.insert({ id, kind: 'encrypted-share', owner, recordId: record.id, scope: input.scope, fingerprint: input.fingerprint, origin, ...encrypted, requestId: input.requestId, createdAt: Date.now(), expires: 0, revoked: false });
        }
        requireThat(!value.revoked && (!value.expires || value.expires > Date.now()), 'share_expired_or_revoked', 410);
        if (value.expires) return publicLink(value);
        const result = await request('/api/encrypted-shares', { requestId: value.requestId, token: value.token, revokeToken: value.revokeToken, envelope: value.envelope });
        requireThat(result.path === `/s/${value.token}` && typeof result.id === 'string' && Number.isFinite(result.expires) && result.expires > Date.now() && result.expires <= Date.now() + 86460000, 'encrypted_share_unavailable', 503);
        return publicLink(await repo.change(id, current => { current.expires = result.expires; current.remoteId = result.id; delete current.envelope; }));
      })();
      working.set(id, upload);
      try { return await upload; } finally { if (working.get(id) === upload) working.delete(id); }
    },
    async revoke(owner, recordId, id) {
      if (working.has(id)) await working.get(id);
      const value = await owned(owner, recordId, id);
      if (value.revoked) return { revoked: true };
      const result = await request(`/api/encrypted-shares/${value.token}`, { requestId: value.requestId, revokeToken: value.revokeToken }, 'DELETE');
      requireThat(result.revoked === true, 'encrypted_share_unavailable', 503);
      await repo.change(id, current => { current.revoked = true; delete current.envelope; delete current.key; delete current.revokeToken; });
      return { revoked: true };
    }
  };
}
