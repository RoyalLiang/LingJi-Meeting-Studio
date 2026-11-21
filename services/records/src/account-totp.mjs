import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { requireThat } from '../../../packages/records/src/record.mjs';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const totpStep = (now = Date.now()) => Math.floor(now / 30_000);

function base32(bytes) {
  let bits = 0, buffer = 0, output = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

export function totpCode(secret, step, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hash = createHmac('sha1', secret).update(counter).digest();
  const offset = hash.at(-1) & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}

export function createAccountTotp(sessionSecret) {
  const key = createHmac('sha256', sessionSecret).update('lingji:account-totp-secret:v1').digest();
  const pepper = createHmac('sha256', sessionSecret).update('lingji:account-totp-backup:v1').digest();
  const hashRecovery = (id, code) => createHmac('sha256', pepper).update(id + ':' + code).digest('hex');

  function wrap(id, secret) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  function unwrap(id, value) {
    const bytes = Buffer.from(value, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(id));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
  }

  function match(id, factor, input) {
    if (!/^\d{6}$/.test(input)) return null;
    const secret = unwrap(id, factor.secret);
    try {
      const now = totpStep();
      return [now, now - 1, now + 1].find(step => step > (factor.step ?? -1) &&
        timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(input))) ?? null;
    } finally {
      secret.fill(0);
    }
  }

  return {
    enroll(id, email) {
      const seed = randomBytes(20);
      try {
        const issuer = '聆记';
        const uri = 'otpauth://totp/' + encodeURIComponent(issuer + ':' + email) + '?' +
          new URLSearchParams({ secret: base32(seed), issuer, algorithm: 'SHA1', digits: '6', period: '30' });
        return { uri, pending: { secret: wrap(id, seed), expires: Date.now() + 300_000 } };
      } finally {
        seed.fill(0);
      }
    },
    confirm(account, code) {
      const pending = account.totpPending;
      requireThat(!account.totp && pending?.expires > Date.now(), 'account_factor_setup_expired', 409);
      const step = match(account.id, pending, code);
      requireThat(step !== null, 'account_factor_invalid', 401);
      const recovery = Array.from({ length: 8 }, () => randomBytes(12).toString('hex'));
      account.totp = { secret: pending.secret, step, recovery: recovery.map(code => hashRecovery(account.id, code)) };
      delete account.totpPending;
      return recovery;
    },
    consume(account, value) {
      requireThat(typeof value === 'string' && value.length > 0, 'account_factor_required', 403);
      const input = value.trim().toLowerCase();
      const step = match(account.id, account.totp, input);
      if (step !== null) { account.totp.step = step; return; }
      const backup = /^[a-f0-9]{24}$/.test(input) && hashRecovery(account.id, input);
      requireThat(backup && account.totp.recovery.includes(backup), 'account_factor_invalid', 401);
      account.totp.recovery = account.totp.recovery.filter(code => code !== backup);
    },
  };
}
