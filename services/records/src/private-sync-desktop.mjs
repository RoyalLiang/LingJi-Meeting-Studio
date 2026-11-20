import { DomainError, requireThat } from '../../../packages/records/src/record.mjs';
import { SYNC_PAGE_BYTES } from './private-sync-store.mjs';

export const PRIVATE_SYNC_COMPANION = 'https://lingji.rookiehouse.com';
const routes = new Map([
  ['profile', new Set(['GET', 'PATCH'])],
  ['audio', new Set(['GET', 'POST'])],
  ['live-audio', new Set(['GET', 'POST'])],
  ['live-receipts', new Set(['GET', 'POST'])],
  ['vault', new Set(['GET', 'PUT'])],
  ['delta', new Set(['GET', 'POST'])],
  ['pair/start', new Set(['POST'])],
  ['pair/exchange', new Set(['POST'])],
]);

async function jsonResponse(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    requireThat(size <= SYNC_PAGE_BYTES + 4096, 'sync_response_too_large', 502);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DomainError('sync_server_unavailable', 502); }
}

export function createDesktopPrivateSync({ origin = PRIVATE_SYNC_COMPANION, fetcher = fetch } = {}) {
  let session, generation = 0;
  function startSession(upstream, data, current) {
    const cookie = upstream.headers.getSetCookie().map(value => value.split(';')[0]).find(value => value.startsWith('record_session='));
    requireThat(cookie && typeof data.csrf === 'string' && typeof data.email === 'string', 'sync_sign_in_failed', 502);
    requireThat(generation === current, 'sync_account_changed', 409);
    session = { cookie, csrf: data.csrf, email: data.email };
    return { email: data.email, companion: origin };
  }
  async function remote(path, method, body, auth) {
    try {
      return await fetcher(new URL(path, origin), {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: {
          Origin: origin,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(auth ? { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new DomainError('sync_server_unavailable', 502);
    }
  }
  return async ({ req, res, path, url, readBody, send, limit }) => {
    const route = path.slice('/api/private-sync/'.length);
    requireThat(req.method === 'GET' || req.headers.origin, 'origin_rejected', 403);
    if (route === 'session' && req.method === 'GET') {
      send(res, 200, { email: session?.email ?? null, companion: origin });
    } else if (route === 'session' && req.method === 'POST') {
      limit('private-sync-login', 10);
      const body = await readBody(req, 8192);
      const current = body.step && body.step !== 'finish' ? generation : ++generation;
      const upstream = body.step
        ? await remote('/api/auth/account', 'POST', body)
        : await remote(body.register === true ? '/api/auth/register' : '/api/auth/login', 'POST', { email: body.email, password: body.password });
      const data = await jsonResponse(upstream);
      if (!upstream.ok) return send(res, upstream.status, { error: data.error || 'sync_sign_in_failed' });
      requireThat(generation === current, 'sync_account_changed', 409);
      send(res, 200, body.step && body.step !== 'finish' ? data : startSession(upstream, data, current));
    } else if (route === 'session' && req.method === 'DELETE') {
      generation++;
      session = undefined;
      send(res, 200, { ok: true });
    } else {
      const upgrade = route === 'account-upgrade' && req.method === 'POST';
      requireThat(upgrade || routes.get(route)?.has(req.method), 'not_found', 404);
      const auth = session;
      requireThat(auth, 'sync_sign_in_required', 401);
      const body = req.method === 'GET' ? null : await readBody(req, upgrade ? 8192 : SYNC_PAGE_BYTES);
      const current = generation;
      const upstream = await remote(path + url.search, req.method, body, auth);
      if (session !== auth) throw new DomainError('sync_account_changed', 409);
      if (upstream.status === 401 && !upgrade) session = undefined;
      const data = await jsonResponse(upstream);
      if (upstream.ok && upgrade && body.step === 'finish') {
        send(res, 200, startSession(upstream, data, current));
        return;
      }
      send(res, upstream.status, upstream.ok ? data : { error: data.error || 'sync_request_failed' });
    }
  };
}
