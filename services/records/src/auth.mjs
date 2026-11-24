import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createAccountTotp } from './account-totp.mjs';
import { DomainError, digest, requireThat } from '../../../packages/records/src/record.mjs';

const derivePassword = promisify(scrypt);
export const normalizeAccountEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
export const validAccountEmail = email => /^[^@\s]{1,80}@[^@\s]{1,100}\.[^@\s]{2,20}$/.test(email);
export const accountId = email => 'user:' + digest(email);
export const validAccountEnvelope = value => typeof value?.nonce === 'string' && /^[\w-]{16}$/.test(value.nonce)
  && typeof value?.body === 'string' && /^[\w-]{64}$/.test(value.body);
const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export async function createAuth(repo, options = {}) {
  let secret = options.localAccount ? randomBytes(48).toString('hex') : options.secret || process.env.RECORD_SESSION_SECRET;
  if (options.localAccount) await writeFile(join(repo.root, 'session.key'), secret, { mode: 0o600 });
  requireThat(process.env.NODE_ENV !== 'production' || (secret && secret.length >= 32), 'production_secret_required', 500);
  if (!secret) {
    const file = join(repo.root, 'session.key');
    try { secret = await readFile(file, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; secret = randomBytes(48).toString('hex');
      try { await writeFile(file, secret, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; secret = await readFile(file, 'utf8'); }
    }
  }
  let pendingPasswords = 0;
  const passwordHash = async (password, salt) => {
    requireThat(pendingPasswords < 8, 'authentication_busy', 429);
    pendingPasswords++;
    try { return (await derivePassword(password, salt, 64)).toString('hex'); }
    finally { pendingPasswords--; }
  };
  const sign = value => createHmac('sha256', secret).update(value).digest('hex');
  const cookies = request => Object.fromEntries((request.headers.cookie || '').split(';').map(c => c.trim().split('=')));
  const cookie = token => `record_session=${token}; HttpOnly; SameSite=Strict; Path=/${options.localAccount ? '' : '; Max-Age=604800'}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
  const ttl = 7 * 24 * 60 * 60 * 1000;
  const freshFor = 10 * 60 * 1000;
  const factorKey = options.trackDevices && (options.accountFactorKey || process.env.RECORD_ACCOUNT_FACTOR_KEY);
  requireThat(!factorKey || /^[0-9a-f]{64}$/i.test(factorKey), 'account_factor_key_invalid', 500);
  const totp = factorKey && createAccountTotp(Buffer.from(factorKey, 'hex'));
  const session = request => {
    const [data, signature] = (cookies(request).record_session || '').split('.');
    requireThat(data && same(sign(data), signature), 'login_required', 401);
    let token;
    try { token = JSON.parse(Buffer.from(data, 'base64url').toString()); }
    catch { throw new DomainError('invalid_session', 401); }
    requireThat((options.localAccount && token.expires === null) || token.expires > Date.now(), 'session_expired', 401);
    return token;
  };
  const active = (account, now = Date.now()) =>
    (account.devices || []).filter(device => device.expires > now && device.version === account.authVersion);
  const androidApp = request => request?.headers['x-lingji-client'] === 'android'
    || /\bLingJi-Android\b/.test(request?.headers['user-agent'] || '');
  const appLabel = request => {
    if (androidApp(request)) return '聆记 Android';
    if (/\bLingJi-iOS\//.test(request?.headers['user-agent'] || '')) return '聆记 iOS';
    const desktop = /^LingJi-Desktop-(macOS|Windows|Linux)$/.exec(request?.headers['user-agent'] || '');
    return desktop ? '聆记 ' + desktop[1] : '';
  };
  const label = request => {
    const agent = request?.headers['user-agent'] || '';
    if (/Android/i.test(agent)) return 'Android';
    if (/iPhone|iPad/i.test(agent)) return 'iPhone / iPad';
    if (/Windows/i.test(agent)) return 'Windows';
    if (/Macintosh/i.test(agent)) return 'macOS';
    if (/Linux/i.test(agent)) return 'Linux';
    return '浏览器';
  };
  const desktopIdentity = request => {
    if (!/^LingJi-Desktop-(macOS|Windows|Linux)$/.test(request?.headers['user-agent'] || '')) return;
    const installationId = request.headers['x-lingji-device-id'];
    if (typeof installationId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(installationId)) return;
    const encoded = request.headers['x-lingji-device-name'];
    if (typeof encoded === 'string' && encoded.length <= 960) {
      try {
        const name = [...decodeURIComponent(encoded).replace(/[\p{Cc}\p{Cf}]/gu, '').trim()].slice(0, 80).join('');
        if (name) return { installationId, name };
      } catch { /* Use the platform label for malformed input. */ }
    }
    return { installationId, name: appLabel(request) };
  };
  function requireFresh(current, token) {
    requireThat(totp && token.sid && token.issuedAt > Date.now() - freshFor &&
      active(current).some(device => device.id === token.sid), 'account_recent_login_required', 403);
  }
  const auth = {
    csrf: user => sign(`csrf:${user.id}:${user.authVersion}`),
    async register(body) {
      const email = normalizeAccountEmail(body?.email);
      requireThat(validAccountEmail(email), 'invalid_email', 400);
      requireThat(typeof body.password === 'string' && body.password.length >= 10 && body.password.length <= 128, 'password_length_10_128', 400);
      const salt = randomBytes(16).toString('hex');
      const user = { id: `user:${digest(email)}`, kind: 'user', email, salt, password: await passwordHash(body.password, salt), authVersion: 1 };
      await repo.insert(user); return user;
    },
    async login(body) {
      const user = await repo.get(accountId(normalizeAccountEmail(body?.email)));
      const password = String(body.password || '').slice(0, 128);
      const computed = await passwordHash(password, user?.salt || 'unknown-user-salt');
      requireThat(user && !user.opaqueRecord && same(computed, user.password), 'invalid_credentials', 401); return user;
    },
    async issue(user, request, factor) {
      const now = Date.now();
      const token = { id: user.id, version: user.authVersion, expires: options.localAccount ? null : now + ttl };
      if (options.trackDevices) {
        let previousId;
        if (request?.headers.cookie) {
          try {
            const previous = session(request);
            if (previous.id === user.id && previous.version === user.authVersion) previousId = previous.sid;
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
          }
        }
        token.sid = randomUUID();
        token.issuedAt = now;
        const desktop = desktopIdentity(request);
        await repo.change(user.id, current => {
          requireThat(current.authVersion === user.authVersion, 'session_expired', 401);
          if (current.totp) {
            requireThat(totp, 'account_factor_unavailable', 503);
            totp.consume(current, factor);
          }
          const entries = active(current, now).filter(device =>
            device.id !== previousId && (!desktop || device.installationId !== desktop.installationId));
          const identity = desktop || { name: appLabel(request) || label(request) };
          current.devices = [{ id: token.sid, ...identity, issuedAt: now, expires: token.expires, version: token.version }, ...entries].slice(0, 32);
        });
      }
      const data = Buffer.from(JSON.stringify(token)).toString('base64url');
      return cookie(`${data}.${sign(data)}`);
    },
    clear() { return cookie('') + '; Max-Age=0'; },
    sessionExpiry(request) {
      const token = session(request);
      return token.sid ? token.expires : null;
    },
    async identifyDevice(user, request) {
      if (!options.trackDevices) return;
      const app = appLabel(request);
      const name = app || label(request);
      if (name === '浏览器') return;
      const token = session(request);
      const device = active(user).find(entry => entry.id === token.sid);
      if (!device || device.installationId || device.name === name || (!app && device.name !== '浏览器')) return;
      await repo.change(user.id, current => {
        const currentDevice = active(current).find(entry => entry.id === token.sid);
        if (currentDevice && !currentDevice.installationId && (app || currentDevice.name === '浏览器')) currentDevice.name = name;
      });
    },
    async refreshSession(user, request) {
      const token = session(request);
      requireThat(options.trackDevices && token.sid, 'login_required', 401);
      const now = Date.now();
      let expires;
      await repo.change(user.id, current => {
        requireThat(current.authVersion === token.version, 'session_expired', 401);
        const device = active(current, now).find(entry => entry.id === token.sid);
        requireThat(device && token.expires > now, 'session_expired', 401);
        expires = Math.max(device.expires, now + ttl);
        device.expires = expires;
        if (androidApp(request)) device.name = '聆记 Android';
      });
      const data = Buffer.from(JSON.stringify({ ...token, expires })).toString('base64url');
      return { cookie: cookie(`${data}.${sign(data)}`), expires };
    },
    async user(request) {
      const token = session(request);
      const user = await repo.get(token.id);
      requireThat(user && user.authVersion === token.version, 'session_expired', 401);
      if (options.trackDevices && (token.sid || user.trackedOnly)) {
        requireThat(active(user).some(device => device.id === token.sid), 'session_expired', 401);
      }
      return user;
    },
    devices(user, request) {
      const token = session(request);
      return { current: Boolean(token.sid), items: active(user).map(({ id, name, issuedAt, installationId }) => ({
        id, name: id === token.sid && !installationId ? appLabel(request) || (name === '浏览器' ? label(request) : name) : name,
          issuedAt, current: id === token.sid,
      })) };
    },
    async revoke(user, request, id) {
      const token = session(request);
      requireThat(token.sid && id !== token.sid, 'account_device_unavailable', 400);
      await repo.change(user.id, current => {
        const devices = active(current);
        requireThat(devices.some(device => device.id === token.sid), 'session_expired', 401);
        current.devices = devices.filter(device => device.id !== id);
      });
    },
    async logout(user, request) {
      const token = session(request);
      await repo.change(user.id, current => {
        if (options.trackDevices && token.sid) current.devices = active(current).filter(device => device.id !== token.sid);
        else current.authVersion++;
      });
    },
    factorStatus(user, request) {
      const token = session(request);
      return { available: Boolean(totp), enabled: Boolean(user.totp), recent: Boolean(token.sid && token.issuedAt > Date.now() - freshFor) };
    },
    async beginTotp(user, request) {
      const token = session(request);
      requireThat(totp, 'account_factor_unavailable', 503);
      const { uri, pending } = totp.enroll(user.id, user.email);
      await repo.change(user.id, current => {
        requireFresh(current, token);
        requireThat(current.opaqueRecord && !current.totp, 'account_factor_setup_unavailable', 409);
        current.totpPending = pending;
      });
      return { uri };
    },
    async confirmTotp(user, request, code) {
      const token = session(request);
      let recovery;
      await repo.change(user.id, current => {
        requireFresh(current, token);
        recovery = totp.confirm(current, code);
        current.trackedOnly = true;
        current.devices = active(current).filter(device => device.id === token.sid);
      });
      return { recovery };
    },
    async disableTotp(user, request, code) {
      const token = session(request);
      await repo.change(user.id, current => {
        requireFresh(current, token);
        requireThat(current.totp, 'account_factor_setup_unavailable', 409);
        totp.consume(current, code);
        delete current.totp;
        current.devices = active(current).filter(device => device.id === token.sid);
      });
    },
    checkCsrf(request, user) { requireThat(same(request.headers['x-csrf-token'], sign(`csrf:${user.id}:${user.authVersion}`)), 'csrf_required', 403); }
  };
  if (options.seedDevelopment && process.env.NODE_ENV !== 'production' && process.env.RECORD_DEV_ACCOUNT !== 'off') {
    const email = process.env.RECORD_DEV_EMAIL || 'dev@local.test';
    if (!await repo.get(`user:${digest(email.trim().toLowerCase())}`)) {
      const salt = randomBytes(16).toString('hex');
      await repo.insert({ id: `user:${digest(email.trim().toLowerCase())}`, kind: 'user', email: email.trim().toLowerCase(), salt, password: await passwordHash(process.env.RECORD_DEV_PASSWORD || 'LocalMeeting2026!', salt), authVersion: 1 });
    }
  }
  if (options.localAccount) {
    const email = 'local@device.invalid', id = `user:${digest(email)}`;
    let user = await repo.get(id);
    if (!user) user = await auth.register({ email, password: randomBytes(48).toString('hex') });
    auth.localSession = async () => auth.issue(await repo.get(id));
  }
  return auth;
}
