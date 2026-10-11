import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError, digest, requireThat } from '../../../packages/records/src/record.mjs';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function createAuth(repo, options = {}) {
  let secret = options.secret || process.env.RECORD_SESSION_SECRET;
  requireThat(process.env.NODE_ENV !== 'production' || (secret && secret.length >= 32), 'production_secret_required', 500);
  if (!secret) {
    const file = join(repo.root, 'session.key');
    try { secret = await readFile(file, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; secret = randomBytes(48).toString('hex');
      try { await writeFile(file, secret, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; secret = await readFile(file, 'utf8'); }
    }
  }
  const sign = value => createHmac('sha256', secret).update(value).digest('hex');
  const cookies = request => Object.fromEntries((request.headers.cookie || '').split(';').map(c => c.trim().split('=')));
  const cookie = token => `record_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
  return {
    csrf: user => sign(`csrf:${user.id}:${user.authVersion}`),
    async register(body) {
      const email = String(body.email || '').trim().toLowerCase();
      requireThat(/^[^@\s]{1,80}@[^@\s]{1,100}\.[^@\s]{2,20}$/.test(email), 'invalid_email', 400);
      requireThat(typeof body.password === 'string' && body.password.length >= 10 && body.password.length <= 128, 'password_length_10_128', 400);
      requireThat(!process.env.RECORD_INVITE_CODE || body.inviteCode === process.env.RECORD_INVITE_CODE, 'invite_required', 403);
      const salt = randomBytes(16).toString('hex');
      const user = { id: `user:${digest(email)}`, kind: 'user', email, salt, password: scryptSync(body.password, salt, 64).toString('hex'), authVersion: 1 };
      await repo.insert(user); return user;
    },
    async login(body) {
      const user = await repo.get(`user:${digest(String(body.email || '').trim().toLowerCase())}`);
      const password = String(body.password || '').slice(0, 128);
      const computed = scryptSync(password, user?.salt || 'unknown-user-salt', 64).toString('hex');
      requireThat(user && same(computed, user.password), 'invalid_credentials', 401); return user;
    },
    issue(user) {
      const data = Buffer.from(JSON.stringify({ id: user.id, version: user.authVersion, expires: Date.now() + 604800000 })).toString('base64url');
      return cookie(`${data}.${sign(data)}`);
    },
    clear() { return cookie('') + '; Max-Age=0'; },
    async user(request) {
      const [data, signature] = (cookies(request).record_session || '').split('.');
      requireThat(data && same(sign(data), signature), 'login_required', 401);
      let token; try { token = JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { throw new DomainError('invalid_session', 401); }
      requireThat(token.expires > Date.now(), 'session_expired', 401);
      const user = await repo.get(token.id); requireThat(user && user.authVersion === token.version, 'session_expired', 401); return user;
    },
    checkCsrf(request, user) { requireThat(same(request.headers['x-csrf-token'], sign(`csrf:${user.id}:${user.authVersion}`)), 'csrf_required', 403); }
  };
}
