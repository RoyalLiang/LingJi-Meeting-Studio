import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { requireThat } from '../../../packages/records/src/record.mjs';

export const SYNC_PAGE_BYTES = 512 * 1024;
const PAGE_OPERATIONS = 64;
const VAULT_QUOTA = 64 * 1024 * 1024;
const schema = [
  'CREATE TABLE IF NOT EXISTS sync_vaults (owner TEXT PRIMARY KEY, data TEXT NOT NULL, head BIGINT NOT NULL, bytes BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS sync_delta (owner TEXT NOT NULL, seq BIGINT NOT NULL, op TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,seq), UNIQUE(owner,op))',
  'CREATE TABLE IF NOT EXISTS sync_credentials (owner TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,id))',
  'CREATE TABLE IF NOT EXISTS sync_pairs (owner TEXT NOT NULL, id TEXT NOT NULL, expires BIGINT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,id))',
  'CREATE INDEX IF NOT EXISTS sync_pair_expiry ON sync_pairs(owner,expires)',
  'CREATE TABLE IF NOT EXISTS sync_challenges (owner TEXT NOT NULL, purpose TEXT NOT NULL, challenge TEXT NOT NULL, expires BIGINT NOT NULL, PRIMARY KEY(owner,purpose))',
];

export async function createPrivateSyncStore({ root, pool }) {
  const db = pool ? null : new DatabaseSync(join(root, 'private-sync.sqlite'));
  if (db) db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  let sqliteTail = Promise.resolve();
  const run = (connection, sql, params = []) => {
    if (pool) return connection.query(sql, params).then(result => result.rows);
    const values = [];
    const statement = db.prepare(sql.replace(/\$(\d+)/g, (_match, index) => {
      values.push(params[Number(index) - 1]);
      return '?';
    }));
    return statement.all(...values);
  };
  function serialized(task) {
    const pending = sqliteTail.then(task);
    sqliteTail = pending.catch(() => {});
    return pending;
  }
  const read = pool ? task => task(pool) : task => serialized(() => task(db));
  const write = pool ? async task => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await task(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } : task => serialized(async () => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = await task(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
  try {
    await write(async conn => {
      for (const sql of schema) await run(conn, sql);
    });
  } catch (error) {
    db?.close();
    throw error;
  }
  const decode = row => row && JSON.parse(row.data);


  const reserved = row => Number(row.head) < -Date.now();
  async function canReplaceEmpty(conn, owner, row) {
    if (!row || Number(row.head) > 0 || reserved(row)) return false;
    const associated = await run(conn, `SELECT 1 FROM sync_vaults WHERE owner IN ($2,$3,$4) AND head>0
      UNION ALL SELECT 1 FROM sync_credentials WHERE owner=$1
      UNION ALL SELECT 1 FROM sync_pairs WHERE owner=$1 AND expires>$5 LIMIT 1`, [owner, owner + ':audio', owner + ':live-audio', owner + ':live-receipts', Date.now()]);
    return associated.length === 0;
  }

  return {
    vault(owner) {
      return read(async conn => decode((await run(conn, 'SELECT data FROM sync_vaults WHERE owner=$1', [owner]))[0]) ?? null);
    },
    initialize(owner, data) {
      return write(async conn => {
        const rows = await run(conn, 'INSERT INTO sync_vaults(owner,data,head,bytes) VALUES($1,$2,0,0) ON CONFLICT(owner) DO NOTHING RETURNING owner', [owner, JSON.stringify(data)]);
        requireThat(rows.length === 1, 'sync_vault_exists', 409);
        return data;
      });
    },
    emptyUpgradeAvailable(owner) {
      return read(async conn => canReplaceEmpty(conn, owner,
        (await run(conn, 'SELECT head FROM sync_vaults WHERE owner=$1', [owner]))[0]));
    },
    reserveEmptyUpgrade(owner, vaultId) {
      return write(async conn => {
        const [row] = await run(conn, 'SELECT data,head FROM sync_vaults WHERE owner=$1' + (pool ? ' FOR UPDATE' : ''), [owner]);
        requireThat(decode(row)?.id === vaultId && await canReplaceEmpty(conn, owner, row), 'sync_legacy_history', 409);
        // A reserved empty vault stays readable and cannot accept new ciphertext.
        const fence = -Date.now() - 180_000;
        await run(conn, 'UPDATE sync_vaults SET head=$2 WHERE owner=$1', [owner, fence]);
        return fence;
      });
    },
    releaseEmptyUpgrade(owner, fence) {
      return write(conn => run(conn, 'UPDATE sync_vaults SET head=0 WHERE owner=$1 AND head=$2', [owner, fence]));
    },
    usage(owner) {
    return read(async conn => {
      const audio = [owner + ':audio', owner + ':live-audio', owner + ':live-receipts'];
      const rows = await run(conn, 'SELECT owner,bytes FROM sync_vaults WHERE owner IN ($1,$2,$3,$4)', [owner, ...audio]);
      return {
        meetings: Number(rows.find(row => row.owner === owner)?.bytes || 0),
        audio: rows.filter(row => row.owner !== owner).reduce((bytes, row) => bytes + Number(row.bytes), 0),
        quota: VAULT_QUOTA,
      };
    });
  },
  push(owner, vaultId, operations, parentOwner) {
      return write(async conn => {
        if (parentOwner) {
          const [parent] = await run(conn, 'SELECT head FROM sync_vaults WHERE owner=$1' + (pool ? ' FOR UPDATE' : ''), [parentOwner]);
          requireThat(parent && !reserved(parent), 'sync_legacy_history', 409);
        }
        const [row] = await run(conn, 'SELECT data,head,bytes FROM sync_vaults WHERE owner=$1' + (pool ? ' FOR UPDATE' : ''), [owner]);
        requireThat(decode(row)?.id === vaultId, 'sync_vault_unavailable', 404);
        requireThat(!reserved(row), 'sync_legacy_history', 409);
        const acknowledgements = [];
        let head = Math.max(0, Number(row.head)), bytes = Number(row.bytes);
        // Keep the existing audio quota across both journals, serialized by the parent row lock.
        const siblings = parentOwner ? ['audio', 'live-audio', 'live-receipts']
          .map(stream => parentOwner + ':' + stream).filter(stream => stream !== owner) : [];
        const others = siblings.length ? await run(conn, 'SELECT bytes FROM sync_vaults WHERE owner IN ($1,$2)', siblings) : [];
        const quota = VAULT_QUOTA - others.reduce((total, entry) => total + Number(entry.bytes), 0);
        for (const operation of operations) {
          const data = JSON.stringify(operation);
          const [prior] = await run(conn, 'SELECT seq,data FROM sync_delta WHERE owner=$1 AND op=$2', [owner, operation.id]);
          if (prior) {
            requireThat(prior.data === data, 'sync_operation_conflict', 409);
            acknowledgements.push({ id: operation.id, seq: Number(prior.seq) });
            continue;
          }
          bytes += Buffer.byteLength(data);
          requireThat(bytes <= quota, 'sync_quota_exceeded', 413);
          head++;
          await run(conn, 'INSERT INTO sync_delta(owner,seq,op,data) VALUES($1,$2,$3,$4)', [owner, head, operation.id, data]);
          acknowledgements.push({ id: operation.id, seq: head });
        }
        await run(conn, 'UPDATE sync_vaults SET head=$2,bytes=$3 WHERE owner=$1', [owner, head, bytes]);
        return { acknowledgements };
      });
    },
    pull(owner, vaultId, after) {
      return read(async conn => {
        const [row] = await run(conn, 'SELECT data,head FROM sync_vaults WHERE owner=$1', [owner]);
        requireThat(decode(row)?.id === vaultId, 'sync_vault_unavailable', 404);
        const head = Math.max(0, Number(row.head));
        requireThat(after <= head, 'sync_invalid_cursor', 409);
        const rows = await run(conn,
          'SELECT seq,data FROM sync_delta WHERE owner=$1 AND seq>$2 AND seq<=$3 ORDER BY seq LIMIT $4',
          [owner, after, head, PAGE_OPERATIONS]);
        const operations = [];
        let bytes = 0;
        for (const next of rows) {
          bytes += Buffer.byteLength(next.data) + 32;
          if (bytes > SYNC_PAGE_BYTES) break;
          operations.push({ ...decode(next), seq: Number(next.seq) });
        }
        const cursor = operations.at(-1)?.seq ?? after;
        return { operations, cursor, more: cursor < head };
      });
    },
    challenge(owner, purpose, challenge, now) {
      return write(async conn => {
        await run(conn, 'INSERT INTO sync_challenges(owner,purpose,challenge,expires) VALUES($1,$2,$3,$4) ON CONFLICT(owner,purpose) DO UPDATE SET challenge=excluded.challenge,expires=excluded.expires',
          [owner, purpose, challenge, now + 5 * 60_000]);
      });
    },
    takeChallenge(owner, purpose, now) {
      return write(async conn => {
        const [row] = await run(conn, 'DELETE FROM sync_challenges WHERE owner=$1 AND purpose=$2 RETURNING challenge,expires', [owner, purpose]);
        return row && Number(row.expires) > now ? row.challenge : null;
      });
    },
    credentials(owner) {
      return read(async conn => (await run(conn, 'SELECT data FROM sync_credentials WHERE owner=$1 ORDER BY id LIMIT 32', [owner])).map(decode));
    },
    addCredential(owner, credential) {
      return write(async conn => {
        const [row] = await run(conn, 'SELECT data,head FROM sync_vaults WHERE owner=$1' + (pool ? ' FOR UPDATE' : ''), [owner]);
        requireThat(decode(row), 'sync_vault_unavailable', 404);
        requireThat(!reserved(row), 'sync_legacy_history', 409);
        const existing = await run(conn, 'SELECT id FROM sync_credentials WHERE owner=$1 LIMIT 32', [owner]);
        requireThat(existing.length < 32, 'sync_credential_limit', 409);
        const rows = await run(conn, 'INSERT INTO sync_credentials(owner,id,data) VALUES($1,$2,$3) ON CONFLICT(owner,id) DO NOTHING RETURNING id',
          [owner, credential.id, JSON.stringify(credential)]);
        requireThat(rows.length === 1, 'sync_credential_exists', 409);
      });
    },
    finishAssertion(owner, credential, counter) {
      return write(async conn => {
        const updated = await run(conn,
          'UPDATE sync_credentials SET data=$3 WHERE owner=$1 AND id=$2 AND data=$4 RETURNING id',
          [owner, credential.id, JSON.stringify({ ...credential, counter }), JSON.stringify(credential)]);
        requireThat(updated.length === 1, 'sync_credential_changed', 409);
      });
    },
    startPair(owner, id, hostProof, now) {
      return write(async conn => {
        const [vault] = await run(conn, 'SELECT head FROM sync_vaults WHERE owner=$1' + (pool ? ' FOR UPDATE' : ''), [owner]);
        requireThat(vault, 'sync_vault_unavailable', 404);
        requireThat(!reserved(vault), 'sync_legacy_history', 409);
        await run(conn, 'DELETE FROM sync_pairs WHERE owner=$1 AND expires<=$2', [owner, now]);
        const active = await run(conn, 'SELECT id FROM sync_pairs WHERE owner=$1 LIMIT 8', [owner]);
        requireThat(active.length < 8, 'sync_pair_limit', 429);
        const rows = await run(conn, 'INSERT INTO sync_pairs(owner,id,expires,data) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',
          [owner, id, now + 5 * 60_000, JSON.stringify({ hostProof, frames: [] })]);
        requireThat(rows.length === 1, 'sync_pair_exists', 409);
      });
    },
    pair(owner, id, proof, frame, now) {
      return write(async conn => {
        const [row] = await run(conn, 'SELECT data,expires FROM sync_pairs WHERE owner=$1 AND id=$2' + (pool ? ' FOR UPDATE' : ''), [owner, id]);
        requireThat(row && Number(row.expires) > now, 'sync_pair_unavailable', 404);
        const { hostProof, guestProof, frames } = decode(row);
        const host = proof === hostProof;
        // A guest claims an invitation with the first OPAQUE request. The host must verify the handshake.
        const claim = !host && !guestProof && frame?.step === 1;
        requireThat(host || proof === guestProof || claim, 'sync_pair_unavailable', 404);
        if (frame) {
          requireThat((frame.step % 2 === 0) === host, 'sync_pair_role', 403);
          const previous = frames[frame.step - 1];
          if (previous) requireThat(previous === frame.data, 'sync_pair_replay', 409);
          else {
            requireThat(frame.step === frames.length + 1, 'sync_pair_order', 409);
            frames.push(frame.data);
            await run(conn, 'UPDATE sync_pairs SET data=$3 WHERE owner=$1 AND id=$2',
              [owner, id, JSON.stringify({ hostProof, guestProof: claim ? proof : guestProof, frames })]);
          }
        }
        return { frames, expires: Number(row.expires) };
      });
    },
    close: () => serialized(() => db?.close()),
  };
}
