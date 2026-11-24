import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { requireThat } from '../../../packages/records/src/record.mjs';

export const SYNC_PAGE_BYTES = 512 * 1024;
const PAGE_OPERATIONS = 64;
const VAULT_QUOTA = 1024 * 1024 * 1024;
const LIVE_RECEIPT_QUOTA = 1024 * 1024;
const PAIR_WINDOW = 5 * 60_000;
const TRANSFER_WINDOW = 2 * 60 * 60_000;
const audioOwners = owner => [owner + ':audio', owner + ':live-audio', owner + ':live-audio-v2'];
const schema = [
  'CREATE TABLE IF NOT EXISTS sync_vaults (owner TEXT PRIMARY KEY, data TEXT NOT NULL, head BIGINT NOT NULL, bytes BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS sync_delta (owner TEXT NOT NULL, seq BIGINT NOT NULL, op TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,seq), UNIQUE(owner,op))',
  'CREATE TABLE IF NOT EXISTS sync_audio_retention (owner TEXT PRIMARY KEY, acknowledged BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS sync_audio_retired_ops (owner TEXT NOT NULL, op TEXT NOT NULL, seq BIGINT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(owner,op))',
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
  const fingerprint = data => createHash('sha256').update(data).digest('hex');
  const operationBytes = pool ? 'octet_length(data)' : 'length(CAST(data AS BLOB))';

  async function reclaimAudio(conn, owner, needed) {
    if (needed <= 0) return 0;
    const [checkpoint] = await run(conn, 'SELECT acknowledged FROM sync_audio_retention WHERE owner=$1', [owner]);
    if (!checkpoint) return 0;
    let reclaimed = 0;
    while (reclaimed < needed) {
      const rows = await run(conn, `WITH page AS (
        SELECT seq, ${operationBytes} AS bytes FROM sync_delta WHERE owner=$1 AND seq<=$2 ORDER BY seq LIMIT $3
      ), eligible AS (
        SELECT seq, COALESCE(SUM(bytes) OVER (ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS earlier_bytes FROM page
      )
        SELECT delta.seq,delta.op,delta.data FROM eligible JOIN sync_delta AS delta ON delta.owner=$1 AND delta.seq=eligible.seq
        WHERE eligible.earlier_bytes<$4 ORDER BY delta.seq`, [owner, checkpoint.acknowledged, PAGE_OPERATIONS, needed - reclaimed]);
      if (!rows.length) break;
      const params = [owner];
      const values = [];
      let retired = 0;
      for (const row of rows) {
        retired = Number(row.seq);
        reclaimed += Buffer.byteLength(row.data);
        params.push(row.op, row.seq, fingerprint(row.data));
        values.push(`($1,$${params.length - 2},$${params.length - 1},$${params.length})`);
      }
      // Retain only each operation's fingerprint so a lost response can be retried after reclamation.
      await run(conn, `INSERT INTO sync_audio_retired_ops(owner,op,seq,fingerprint) VALUES ${values.join(',')}`, params);
      await run(conn, 'DELETE FROM sync_delta WHERE owner=$1 AND seq<=$2', [owner, retired]);
    }
    if (reclaimed > 0) await run(conn, 'UPDATE sync_vaults SET bytes=bytes-$2 WHERE owner=$1', [owner, reclaimed]);
    return reclaimed;
  }

  const reserved = row => Number(row.head) < -Date.now();
  async function canReplaceEmpty(conn, owner, row) {
    if (!row || Number(row.head) > 0 || reserved(row)) return false;
    const associated = await run(conn, `SELECT 1 FROM sync_vaults WHERE owner IN ($2,$3,$4,$5) AND head>0
      UNION ALL SELECT 1 FROM sync_credentials WHERE owner=$1
      UNION ALL SELECT 1 FROM sync_pairs WHERE owner=$1 AND expires>$6 LIMIT 1`, [owner, ...audioOwners(owner), owner + ':live-receipts', Date.now()]);
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
      const rows = await run(conn, 'SELECT owner,bytes FROM sync_vaults WHERE owner IN ($1,$2,$3,$4)', [owner, ...audioOwners(owner)]);
      return {
        meetings: Number(rows.find(row => row.owner === owner)?.bytes || 0),
        audio: rows.filter(row => row.owner !== owner).reduce((bytes, row) => bytes + Number(row.bytes), 0),
        quota: VAULT_QUOTA,
      };
    });
  },
  push(owner, vaultId, operations, parentOwner) {
      return write(async conn => {
        // Meeting and audio writes share the parent lock and one quota.
        const receipts = parentOwner && owner === parentOwner + ':live-receipts';
        const audio = parentOwner && !receipts;
        const account = parentOwner ?? owner;
        const audioStreams = audioOwners(account);
        if (parentOwner) {
          const [parent] = await run(conn, 'SELECT data,head FROM sync_vaults WHERE owner=$1' + (pool ? (audio ? ' FOR UPDATE' : ' FOR SHARE') : ''), [parentOwner]);
          requireThat(parent && !reserved(parent), 'sync_legacy_history', 409);
          requireThat(decode(parent)?.id === vaultId, 'sync_vault_unavailable', 404);
        }
        const [row] = await run(conn, 'SELECT data,head,bytes FROM sync_vaults WHERE owner=$1' + (pool ? ' FOR UPDATE' : ''), [owner]);
        requireThat(decode(row)?.id === vaultId, 'sync_vault_unavailable', 404);
        requireThat(!reserved(row), 'sync_legacy_history', 409);
        const acknowledgements = [];
        let head = Math.max(0, Number(row.head)), bytes = Number(row.bytes);
        // A full audio journal must still accept receipts for durable desktop audio.
        const other = receipts ? [] : await run(conn, 'SELECT bytes FROM sync_vaults WHERE owner IN ($1,$2,$3,$4) AND owner<>$5', [account, ...audioStreams, owner]);
        let quota = receipts ? LIVE_RECEIPT_QUOTA : VAULT_QUOTA - other.reduce((total, entry) => total + Number(entry.bytes), 0);
        const pending = new Map();
        for (const operation of operations) {
          const data = JSON.stringify(operation);
          const prior = pending.get(operation.id) ?? (await run(conn,
            'SELECT seq,data,NULL AS fingerprint FROM sync_delta WHERE owner=$1 AND op=$2'
            + (audio ? ' UNION ALL SELECT seq,NULL,fingerprint FROM sync_audio_retired_ops WHERE owner=$1 AND op=$2' : ''),
            [owner, operation.id]))[0];
          if (prior) {
            requireThat(prior.data === data || (prior.fingerprint && prior.fingerprint === fingerprint(data)), 'sync_operation_conflict', 409);
            acknowledgements.push({ id: operation.id, seq: Number(prior.seq) });
            continue;
          }
          bytes += Buffer.byteLength(data);
          head++;
          pending.set(operation.id, { seq: head, data });
          acknowledgements.push({ id: operation.id, seq: head });
        }
        if (pending.size === 0) return { acknowledgements };
        if (!receipts && bytes > quota) {
          if (audio) bytes -= await reclaimAudio(conn, owner, bytes - quota);
          for (const stream of audioStreams) {
            if (bytes <= quota) break;
            if (stream !== owner) quota += await reclaimAudio(conn, stream, bytes - quota);
          }
        }
        requireThat(bytes <= quota, 'sync_quota_exceeded', 413);
        for (const [id, operation] of pending) {
          await run(conn, 'INSERT INTO sync_delta(owner,seq,op,data) VALUES($1,$2,$3,$4)', [owner, operation.seq, id, operation.data]);
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
        const audio = owner !== parentOwner + ':live-receipts';
        const rows = await run(conn, 'SELECT owner,data,head FROM sync_vaults WHERE owner IN ($1,$2)', [parentOwner, owner]);
        const parent = rows.find(item => item.owner === parentOwner);
        requireThat(decode(parent)?.id === vaultId, 'sync_vault_unavailable', 404);
        const stream = rows.find(item => item.owner === owner);
        if (!stream) {
          requireThat(after === 0, 'sync_cursor_ahead', 409);
          return { operations: [], cursor: 0, more: false, ...(audio ? { acknowledged: 0 } : {}) };
        }
        requireThat(decode(stream)?.id === vaultId, 'sync_vault_unavailable', 404);
        const head = Math.max(0, Number(stream.head));
        requireThat(after <= head, 'sync_invalid_cursor', 409);
        const [checkpoint] = audio ? await run(conn, 'SELECT acknowledged FROM sync_audio_retention WHERE owner=$1', [owner]) : [];
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
        return { operations, cursor, more: cursor < head, ...(trimmed ? { trimmed: true } : {}),
          ...(audio ? { acknowledged: Math.min(head, Number(checkpoint?.acknowledged || 0)) } : {}) };
      });
    },
    acknowledgeAudio(owner, vaultId, beforeSeq, parentOwner) {
      return write(async conn => {
        const [parent] = await run(conn, 'SELECT data,head FROM sync_vaults WHERE owner=$1' + (pool ? ' FOR UPDATE' : ''), [parentOwner]);
        requireThat(decode(parent)?.id === vaultId && !reserved(parent), 'sync_vault_unavailable', 404);
        const [row] = await run(conn, 'SELECT data,head,bytes FROM sync_vaults WHERE owner=$1', [owner]);
        requireThat(row && decode(row)?.id === vaultId, 'sync_vault_unavailable', 404);
        requireThat(beforeSeq <= Number(row.head), 'sync_cursor_ahead', 409);
        const [updated] = await run(conn, `INSERT INTO sync_audio_retention(owner,acknowledged) VALUES($1,$2)
          ON CONFLICT(owner) DO UPDATE SET acknowledged=excluded.acknowledged
          WHERE sync_audio_retention.acknowledged<excluded.acknowledged RETURNING acknowledged`, [owner, beforeSeq]);
        const [existing] = updated ? [] : await run(conn, 'SELECT acknowledged FROM sync_audio_retention WHERE owner=$1', [owner]);
        return { acknowledged: Number((updated || existing).acknowledged), bytes: Number(row.bytes) };
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
    startPair(owner, id, hostProof, now, direct = false) {
      return write(async conn => {
        const [vault] = await run(conn, 'SELECT head FROM sync_vaults WHERE owner=$1' + (pool ? ' FOR UPDATE' : ''), [owner]);
        requireThat(vault, 'sync_vault_unavailable', 404);
        requireThat(!reserved(vault), 'sync_legacy_history', 409);
        await run(conn, 'DELETE FROM sync_pairs WHERE owner=$1 AND expires<=$2', [owner, now]);
        const active = await run(conn, 'SELECT id FROM sync_pairs WHERE owner=$1 LIMIT 8', [owner]);
        requireThat(active.length < 8, 'sync_pair_limit', 429);
        const rows = await run(conn, 'INSERT INTO sync_pairs(owner,id,expires,data) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',
        [owner, id, now + PAIR_WINDOW, JSON.stringify({ hostProof, frames: [], direct })]);
        requireThat(rows.length === 1, 'sync_pair_exists', 409);
      });
    },
    pair(owner, id, proof, frame, now, ice = false) {
      return write(async conn => {
        const [row] = await run(conn, 'SELECT data,expires FROM sync_pairs WHERE owner=$1 AND id=$2' + (pool ? ' FOR UPDATE' : ''), [owner, id]);
        requireThat(row && Number(row.expires) > now, 'sync_pair_unavailable', 404);
        const data = decode(row);
        const { hostProof, guestProof, frames, direct } = data;
        if (ice && !direct) return null;
        const host = proof === hostProof;
        // A guest claims an invitation with the first OPAQUE request. The host must verify the handshake.
        const claim = !host && !guestProof && (ice || frame?.step === 1);
        requireThat(host || proof === guestProof || claim, 'sync_pair_unavailable', 404);
        let changed = false;
        if (frame) {
          requireThat(direct || frame.data.length <= 6000, 'sync_invalid_pair_frame', 400);
          requireThat((frame.step % 2 === 0) === host, 'sync_pair_role', 403);
          const previous = frames[frame.step - 1];
          if (previous) requireThat(previous === frame.data, 'sync_pair_replay', 409);
          else {
            requireThat(frame.step === frames.length + 1, 'sync_pair_order', 409);
            frames.push(frame.data);
          if (direct && frame.step === 2) data.transferUntil = now + TRANSFER_WINDOW;
            changed = true;
          }
        }
        if (claim) {
          data.guestProof = proof;
          changed = true;
        }
        let expires = Number(row.expires);
        if (data.transferUntil && expires - now < 45_000) {
          expires = Math.max(expires, Math.min(data.transferUntil, now + 90_000));
        }
        if (changed || expires !== Number(row.expires)) {
          await run(conn, 'UPDATE sync_pairs SET data=$3,expires=$4 WHERE owner=$1 AND id=$2',
            [owner, id, JSON.stringify(data), expires]);
        }
      if (ice) return { expires: data.transferUntil ?? expires + TRANSFER_WINDOW, role: host ? 'receiver' : 'sender' };
        return { frames, expires };
      });
    },
    close: () => serialized(() => { readDb?.close(); readDb = null; db?.close(); }),
  };
}
