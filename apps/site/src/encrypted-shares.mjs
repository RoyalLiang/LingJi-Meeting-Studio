import { ShareContentError, MAX_PUBLISHED_BYTES } from '../../../packages/records/src/published-content.mjs';
import { normalizeEncryptedEnvelope, SHARE_TOKEN } from '../../../packages/records/src/encrypted-share.mjs';

const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' };
const json = (value, status = 200) => Response.json(value, { status, headers });
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
const requests = new Map();
function limit(request) {
  const now = Date.now(), key = request.headers.get('cf-connecting-ip') || 'unknown';
  if (requests.size >= 10000) for (const [id, value] of requests) if (value.until <= now) requests.delete(id);
  let value = requests.get(key);
  if (!value || value.until <= now) value = { until: now + 60000, count: 0 };
  if (value.count >= 120 || (!requests.has(key) && requests.size >= 10000)) throw new ShareContentError('share_upload_limit', 429);
  value.count++; requests.set(key, value);
}
async function input(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ShareContentError('invalid_encrypted_share', 400);
  const reader = request.body?.getReader();
  if (!reader) throw new ShareContentError('invalid_encrypted_share', 400);
  const chunks = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_PUBLISHED_BYTES) throw new ShareContentError('share_too_large', 413); chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new ShareContentError('invalid_encrypted_share', 400); }
  } finally { await reader.cancel().catch(() => {}); }
}
const requireThat = (condition, code = 'invalid_encrypted_share', status = 400) => { if (!condition) throw new ShareContentError(code, status); };
function insertShare(db, { id, requestId, tokenHash, revokeHash, creatorHash, payload, payloadHash, now, revoked = null }) {
  // A tombstone consumes the same durable upload quota as a new encrypted object.
  return db.prepare('INSERT INTO encrypted_shares (id,request_id,token_hash,revoke_hash,creator_hash,payload,payload_hash,created_at,expires_at,revoked_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM encrypted_shares WHERE creator_hash=? AND created_at>?)<20 AND (SELECT COUNT(*) FROM encrypted_shares WHERE created_at>?)<2000').bind(id, requestId, tokenHash, revokeHash, creatorHash, payload, payloadHash, now, now + 86400000, revoked, creatorHash, now - 3600000, now - 86400000).run();
}

export async function encryptedShareRoute(request, env) {
  const path = new URL(request.url).pathname;
  if (/^\/s\/[A-Za-z0-9_-]{43}$/.test(path) && request.method === 'GET') {
    const asset = await env.ASSETS.fetch(new Request(new URL('/encrypted.html', request.url)));
    return new Response(asset.body, { status: asset.status, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'Permissions-Policy': 'microphone=(), camera=()' } });
  }
  if (!path.startsWith('/api/encrypted-shares')) return null;
  limit(request);
  requireThat(env.DB, 'sharing_not_configured', 503);
  const db = env.DB.withSession('first-primary'), now = Date.now();
  if (path === '/api/encrypted-shares' && request.method === 'POST') {
    const value = await input(request);
    requireThat(value && SHARE_TOKEN.test(value.token) && SHARE_TOKEN.test(value.revokeToken) && value.token !== value.revokeToken && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.requestId));
    requireThat(Object.keys(value).sort().join(',') === 'envelope,requestId,revokeToken,token');
    const envelope = normalizeEncryptedEnvelope(value.envelope), payload = JSON.stringify(envelope);
    const [tokenHash, revokeHash, payloadHash, creatorHash] = await Promise.all([hash(value.token), hash(value.revokeToken), hash(payload), hash(request.headers.get('cf-connecting-ip') || 'unknown')]);
    const find = () => db.prepare('SELECT * FROM encrypted_shares WHERE token_hash=?').bind(tokenHash).first();
    const reply = row => {
      requireThat(row.request_id === value.requestId && row.revoke_hash === revokeHash, 'publish_request_conflict', 409);
      requireThat(!row.revoked_at && row.expires_at > now, 'share_expired_or_revoked', 410);
      requireThat(row.payload_hash === payloadHash, 'publish_request_conflict', 409);
      return json({ id: row.id, path: `/s/${value.token}`, expires: row.expires_at });
    };
    const existing = await find(); if (existing) return reply(existing);
    const id = crypto.randomUUID(), expires = now + 86400000;
    // Quotas and insertion share one SQLite statement, including across Worker instances.
    try {
      const result = await insertShare(db, { id, requestId: value.requestId, tokenHash, revokeHash, creatorHash, payload, payloadHash, now });
      requireThat(result.meta.changes, 'share_upload_limit', 429);
    } catch (error) {
      let committed; try { committed = await find(); } catch { throw new ShareContentError('publish_retry_required', 503); }
      if (committed) return reply(committed);
      if (error instanceof ShareContentError) throw error;
      throw new ShareContentError('publish_retry_required', 503);
    }
    await db.prepare('UPDATE encrypted_shares SET payload=NULL WHERE expires_at<=? AND payload IS NOT NULL').bind(now).run().catch(() => {});
    return json({ id, path: `/s/${value.token}`, expires }, 201);
  }
  const match = path.match(/^\/api\/encrypted-shares\/([A-Za-z0-9_-]{43})(\/status)?$/);
  requireThat(match, 'not_found', 404);
  const tokenHash = await hash(match[1]);
  const find = () => db.prepare('SELECT * FROM encrypted_shares WHERE token_hash=?').bind(tokenHash).first();
  let row = await find();
  if (request.method === 'DELETE' && !match[2]) {
    const value = await input(request);
    requireThat(value && SHARE_TOKEN.test(value.revokeToken) && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.requestId), 'not_found', 404);
    const revokeHash = await hash(value.revokeToken);
    if (!row) {
      let limited = false;
      try { const result = await insertShare(db, { id: crypto.randomUUID(), requestId: value.requestId, tokenHash, revokeHash, creatorHash: await hash(request.headers.get('cf-connecting-ip') || 'unknown'), payload: null, payloadHash: '', now, revoked: now }); limited = !result.meta.changes; } catch { /* Reconcile a racing create or a committed tombstone before reporting success. */ }
      row = await find();
      requireThat(row, limited ? 'share_upload_limit' : 'publish_retry_required', limited ? 429 : 503);
    }
    requireThat(revokeHash === row.revoke_hash && value.requestId === row.request_id, 'not_found', 404);
    await db.prepare('UPDATE encrypted_shares SET revoked_at=COALESCE(revoked_at,?),payload=NULL WHERE id=?').bind(now, row.id).run();
    return json({ revoked: true });
  }
  requireThat(request.method === 'GET', 'method_not_allowed', 405);
  requireThat(row && !row.revoked_at && row.expires_at > now && row.payload, 'share_expired_or_revoked', 404);
  if (match[2]) return json({ valid: true, expires: row.expires_at });
  requireThat(await hash(row.payload) === row.payload_hash, 'shared_content_unavailable', 503);
  return json({ envelope: JSON.parse(row.payload), expires: row.expires_at });
}
