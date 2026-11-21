import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { requireThat } from '../../../packages/records/src/record.mjs';

export const SYNC_PAGE_BYTES = 512 * 1024;
const PAGE_OPERATIONS = 64;
const VAULT_QUOTA = 64 * 1024 * 1024;
const LIVE_RECEIPT_QUOTA = 1024 * 1024;
const schema = [
  'CREATE TABLE IF NOT EXISTS sync_vaults (owner TEXT PRIMARY KEY, data TEXT NOT NULL, head BIGINT NOT NULL, bytes BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS sync_delta (owner TEXT NOT NULL, seq BIGINT NOT NULL, op TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,seq), UNIQUE(owner,op))',
  'CREATE TABLE IF NOT EXISTS sync_credentials (owner TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,id))',
  'CREATE TABLE IF NOT EXISTS sync_pairs (owner TEXT NOT NULL, id TEXT NOT NULL, expires BIGINT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,id))',
  'CREATE INDEX IF NOT EXISTS sync_pair_expiry ON sync_pairs(owner,expires)',
  'CREATE TABLE IF NOT EXISTS sync_challenges (owner TEXT NOT NULL, purpose TEXT NOT NULL, challenge TEXT NOT NULL, expires BIGINT NOT NULL, PRIMARY KEY(owner,purpose))',
];

export async function createPrivateSyncStore({ root, pool }) {
  const dbPath = pool ? null : join(root, 'private-sync.sqlite');
  const db = pool ? null : new DatabaseSync(dbPath);
  if (db) db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  let readDb = null;
  let sqliteTail = Promise.resolve();
  const run = (connection, sql, params = []) => {
    if (pool) return connection.query(sql, params).then(result => result.rows);
    const values = [];
    const statement = connection.prepare(sql.replace(/\$(\d+)/g, (_match, index) => {
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
  // Dedicated read-only WAL connection reads committed snapshots without queueing behind writes.
  const read = pool ? task => task(pool) : task => Promise.resolve().then(() => task(readDb || db));
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
    if (dbPath) {
      readDb = new DatabaseSync(dbPath, { readOnly: true });
      readDb.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON');
    }
  } catch (error) {
    readDb?.close();
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
      const audio = [owner + ':audio', owner + ':live-audio'];
      const rows = await run(conn, 'SELECT owner,bytes FROM sync_vaults WHERE owner IN ($1,$2,$3)', [owner, ...audio]);
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
          const [parent] = await run(conn, 'SELECT head FROM sync_vaults WHERE owner=$1' + (pool ? ' FOR SHARE' : ''), [parentOwner]);
          requireThat(parent && !reserved(parent), 'sync_legacy_history', 409);
        }
        const [row] = await run(conn, 'SELECT data,head,bytes FROM sync_vaults WHERE owner=$1' + (pool ? ' FOR UPDATE' : ''), [owner]);
        requireThat(decode(row)?.id === vaultId, 'sync_vault_unavailable', 404);
        requireThat(!reserved(row), 'sync_legacy_history', 409);
        const acknowledgements = [];
        let head = Math.max(0, Number(row.head)), bytes = Number(row.bytes);
      // A full audio journal must still accept receipts for durable desktop audio.
      const receipts = parentOwner && owner === parentOwner + ':live-receipts';
      const sibling = !parentOwner || receipts ? null
        : parentOwner + (owner === parentOwner + ':audio' ? ':live-audio' : ':audio');
      const [other] = sibling ? await run(conn, 'SELECT bytes FROM sync_vaults WHERE owner=$1', [sibling]) : [];
      const quota = receipts ? LIVE_RECEIPT_QUOTA : VAULT_QUOTA - Number(other?.bytes || 0);
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
        const trimmed = rows.length ? Number(rows[0].seq) > after + 1 : after < head;
        const cursor = operations.at(-1)?.seq ?? (trimmed ? head : after);
        return { operations, cursor, more: cursor < head, ...(trimmed ? { trimmed: true } : {}) };
      });
    },
    pullSubstream(parentOwner, owner, vaultId, after) {
      return read(async conn => {
        const rows = await run(conn, 'SELECT owner,data,head FROM sync_vaults WHERE owner IN ($1,$2)', [parentOwner, owner]);
        const parent = rows.find(item => item.owner === parentOwner);
        requireThat(decode(parent)?.id === vaultId, 'sync_vault_unavailable', 404);
        const stream = rows.find(item => item.owner === owner);
        if (!stream) {
          requireThat(after === 0, 'sync_cursor_ahead', 409);
          return { operations: [], cursor: 0, more: false };
        }
        requireThat(decode(stream)?.id === vaultId, 'sync_vault_unavailable', 404);
        const head = Math.max(0, Number(stream.head));
        requireThat(after <= head, 'sync_invalid_cursor', 409);
        const deltaRows = await run(conn,
          'SELECT seq,data FROM sync_delta WHERE owner=$1 AND seq>$2 AND seq<=$3 ORDER BY seq LIMIT $4',
          [owner, after, head, PAGE_OPERATIONS]);
        const operations = [];
        let bytes = 0;
        for (const next of deltaRows) {
          bytes += Buffer.byteLength(next.data) + 32;
          if (bytes > SYNC_PAGE_BYTES) break;
          operations.push({ ...decode(next), seq: Number(next.seq) });
        }
        const trimmed = deltaRows.length ? Number(deltaRows[0].seq) > after + 1 : after < head;
        const cursor = operations.at(-1)?.seq ?? (trimmed ? head : after);
        return { operations, cursor, more: cursor < head, ...(trimmed ? { trimmed: true } : {}) };
      });
    },
    prune(owner, vaultId, beforeSeq, parentOwner) {
      return write(async conn => {
        if (parentOwner) {
          const [parent] = await run(conn, 'SELECT data,head FROM sync_vaults WHERE owner=$1' + (pool ? ' FOR SHARE' : ''), [parentOwner]);
          requireThat(decode(parent)?.id === vaultId && !reserved(parent), 'sync_vault_unavailable', 404);
        }
        const [row] = await run(conn, 'SELECT data,head,bytes FROM sync_vaults WHERE owner=$1' + (pool ? ' FOR UPDATE' : ''), [owner]);
        if (!row) return { pruned: 0, bytes: 0 };
        requireThat(decode(row)?.id === vaultId, 'sync_vault_unavailable', 404);
        const head = Math.max(0, Number(row.head));
        const upto = Math.min(Math.max(0, beforeSeq), head);
        if (upto <= 0) return { pruned: 0, bytes: Number(row.bytes) };
        const deleted = await run(conn, 'DELETE FROM sync_delta WHERE owner=$1 AND seq<=$2 RETURNING seq', [owner, upto]);
        if (!deleted.length) return { pruned: 0, bytes: Number(row.bytes) };
        const sizeExpr = pool ? 'COALESCE(SUM(octet_length(data)),0)' : 'COALESCE(SUM(length(CAST(data AS BLOB))),0)';
        const [total] = await run(conn, `SELECT ${sizeExpr} AS bytes FROM sync_delta WHERE owner=$1`, [owner]);
        const bytes = Number(total?.bytes || 0);
        await run(conn, 'UPDATE sync_vaults SET bytes=$2 WHERE owner=$1', [owner, bytes]);
        return { pruned: deleted.length, bytes };
      });
    },
    saveAuthChallenge(id, payload, now, ttlMs, limit) {
      return write(async conn => {
        await run(conn, "DELETE FROM sync_challenges WHERE purpose='opaque-auth' AND expires<=$1", [now]);
        const [count] = await run(conn, "SELECT COUNT(*) AS n FROM sync_challenges WHERE purpose='opaque-auth'", []);
        requireThat(Number(count?.n || 0) < limit, 'authentication_busy', 429);
        await run(conn, "INSERT INTO sync_challenges(owner,purpose,challenge,expires) VALUES($1,'opaque-auth',$2,$3)",
          ['auth:' + id, payload, now + ttlMs]);
      });
    },
    takeAuthChallenge(id, now) {
      return write(async conn => {
        const [row] = await run(conn, "DELETE FROM sync_challenges WHERE owner=$1 AND purpose='opaque-auth' RETURNING challenge,expires", ['auth:' + id]);
        return row && Number(row.expires) > now ? row.challenge : null;
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
    close: () => serialized(() => { readDb?.close(); readDb = null; db?.close(); }),
  };
}
