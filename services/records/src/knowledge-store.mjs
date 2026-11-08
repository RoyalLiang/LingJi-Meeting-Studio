import { createKnowledgeQuestions } from './knowledge-questions.mjs';
import { knowledgeCandidates, knowledgeStamp, normalizedKnowledgeText, knowledgeHighlight, reviewKnowledge } from '../../../packages/records/src/knowledge.mjs';
import { requireThat } from '../../../packages/records/src/record.mjs';

const grams = text => [...new Set(Array.from(text.toLowerCase()).flatMap((_, i, letters) => i + 2 < letters.length ? [letters.slice(i, i + 3).join('')] : []))];
const decode = row => typeof row.data === 'string' ? JSON.parse(row.data) : row.data;

export async function createKnowledgeStore({ db, pool }) {
  const schema = `CREATE TABLE IF NOT EXISTS record_knowledge_state(record_id TEXT PRIMARY KEY, stamp TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS record_knowledge(id TEXT PRIMARY KEY,record_id TEXT NOT NULL,owner TEXT NOT NULL,workspace TEXT NOT NULL,expires TEXT NOT NULL,data ${pool ? 'JSONB' : 'TEXT'} NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_scope ON record_knowledge(owner,workspace,expires);
    CREATE INDEX IF NOT EXISTS knowledge_record ON record_knowledge(record_id);`;
  if (pool) {
    for (const statement of schema.split(';').filter(statement => statement.trim())) await pool.query(statement);
    await pool.query('ALTER TABLE record_knowledge ADD COLUMN IF NOT EXISTS grams TEXT[]');
    await pool.query('CREATE INDEX IF NOT EXISTS knowledge_grams ON record_knowledge USING GIN(grams)');
  } else {
    db.exec(schema);
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_search USING fts5(text,tokenize='trigram')");
  }
  // Upgrade only derived search keys; preserve concurrent review fields in the stored JSON.
  let after = '';
  for (;;) {
    const batch = pool ? (await pool.query("SELECT id,data FROM record_knowledge WHERE id>$1 AND data->>'topicKey' IS NULL ORDER BY id LIMIT 100",[after])).rows : db.prepare("SELECT id,data FROM record_knowledge WHERE id>? AND json_extract(data,'$.topicKey') IS NULL ORDER BY id LIMIT 100").all(after);
    for (const row of batch) {
      const entry=decode(row),topicKey=normalizedKnowledgeText(entry.topic || ''),textKey=normalizedKnowledgeText(entry.text);
      if (pool) await pool.query("UPDATE record_knowledge SET data=jsonb_set(jsonb_set(data,'{topicKey}',$2::jsonb),'{textKey}',$3::jsonb) WHERE id=$1",[row.id,JSON.stringify(topicKey),JSON.stringify(textKey)]);
      else db.prepare("UPDATE record_knowledge SET data=json_set(data,'$.topicKey',?,'$.textKey',?) WHERE id=?").run(topicKey,textKey,row.id);
      after=row.id;
    }
    if(batch.length<100)break;
  }
  const publicEntry = ({topicKey:_topicKey,textKey:_textKey,...entry}) => entry;
  const scopeWhere = (scope, pg) => scope === 'all' ? '' : ` AND workspace=${pg ? '$3' : '?'}`;
  function writeSqlite(record) {
    if (record.kind !== 'record') return;
    const stamp = knowledgeStamp(record);
    if (db.prepare('SELECT stamp FROM record_knowledge_state WHERE record_id=?').get(record.id)?.stamp === stamp) return;
    const previous = db.prepare('SELECT rowid,data FROM record_knowledge WHERE record_id=?').all(record.id);
    if (record.deleted || Date.parse(record.deleteAt) <= Date.now()) {
      for (const row of previous) db.prepare('DELETE FROM knowledge_search WHERE rowid=?').run(row.rowid);
      db.prepare('DELETE FROM record_knowledge WHERE record_id=?').run(record.id);
    } else {
      const next = knowledgeCandidates(record), ids = new Set(next.map(entry => entry.id));
      for (const row of previous) {
        const entry = decode(row);
        if (!ids.has(entry.id) && entry.status !== 'retracted') { entry.status = 'retracted'; entry.reviewRevision++; }
        db.prepare('UPDATE record_knowledge SET workspace=?,expires=?,data=? WHERE id=?').run(record.workspaceId || 'inbox', record.deleteAt, JSON.stringify({ ...entry, workspaceId: record.workspaceId || null, title: record.title }), entry.id);
      }
      for (const entry of next) {
        if (previous.some(row => decode(row).id === entry.id)) continue;
        const result = db.prepare('INSERT INTO record_knowledge(id,record_id,owner,workspace,expires,data) VALUES(?,?,?,?,?,?)').run(entry.id, record.id, record.owner, record.workspaceId || 'inbox', record.deleteAt, JSON.stringify(entry));
        db.prepare('INSERT INTO knowledge_search(rowid,text) VALUES(?,?)').run(result.lastInsertRowid, entry.text);
      }
    }
    db.prepare('INSERT INTO record_knowledge_state(record_id,stamp) VALUES(?,?) ON CONFLICT(record_id) DO UPDATE SET stamp=excluded.stamp').run(record.id, stamp);
  }
  async function writePg(client, record) {
    if (record.kind !== 'record') return;
    const stamp = knowledgeStamp(record);
    if ((await client.query('SELECT stamp FROM record_knowledge_state WHERE record_id=$1', [record.id])).rows[0]?.stamp === stamp) return;
    if (record.deleted || Date.parse(record.deleteAt) <= Date.now()) await client.query('DELETE FROM record_knowledge WHERE record_id=$1', [record.id]);
    else {
      const next = knowledgeCandidates(record), ids = new Set(next.map(entry => entry.id));
      for (const row of (await client.query('SELECT data FROM record_knowledge WHERE record_id=$1', [record.id])).rows) {
        const entry = decode(row);
        if (!ids.has(entry.id) && entry.status !== 'retracted') { entry.status = 'retracted'; entry.reviewRevision++; }
        await client.query('UPDATE record_knowledge SET workspace=$2,expires=$3,data=$4 WHERE id=$1', [entry.id, record.workspaceId || 'inbox', record.deleteAt, JSON.stringify({ ...entry, workspaceId: record.workspaceId || null, title: record.title })]);
      }
      for (const entry of next) await client.query('INSERT INTO record_knowledge(id,record_id,owner,workspace,expires,data,grams) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING', [entry.id, record.id, record.owner, record.workspaceId || 'inbox', record.deleteAt, JSON.stringify(entry), grams(entry.text)]);
    }
    await client.query('INSERT INTO record_knowledge_state(record_id,stamp) VALUES($1,$2) ON CONFLICT(record_id) DO UPDATE SET stamp=excluded.stamp', [record.id, stamp]);
  }
  return {
    writeSqlite, writePg,
 ...createKnowledgeQuestions({db,pool}),
    async list(owner, scope, { query = '', kind = '', status = '', offset = 0 } = {}) {
      requireThat(typeof query === 'string' && query.length <= 200 && ['', 'decision', 'action', 'risk', 'term'].includes(kind) && ['', 'candidate', 'confirmed', 'dismissed', 'retracted'].includes(status), 'invalid_knowledge_query', 400);
      requireThat(Number.isSafeInteger(offset) && offset >= 0 && offset <= 100000, 'invalid_knowledge_query', 400);
      const now = new Date().toISOString(), params = [owner, now, ...(scope === 'all' ? [] : [scope])];
      let rows, total;
      if (pool) {
        let where = 'owner=$1 AND expires>$2' + scopeWhere(scope, true);
        if (query) { params.push(query); where += ` AND strpos(lower(data->>'text'),lower($${params.length}))>0`; if (Array.from(query).length >= 3) { params.push(grams(query)); where += ` AND grams @> $${params.length}::text[]`; } }
        if (kind) { params.push(kind); where += ` AND data->>'kind'=$${params.length}`; }
        if (status) { params.push(status); where += ` AND data->>'status'=$${params.length}`; } else where += " AND data->>'status' IN ('candidate','confirmed')";
        total = Number((await pool.query(`SELECT count(*) AS count FROM record_knowledge WHERE ${where}`, params)).rows[0].count);
        rows = (await pool.query(`SELECT data FROM record_knowledge WHERE ${where} ORDER BY data->>'createdAt' DESC,id LIMIT 40 OFFSET $${params.length + 1}`, [...params,offset])).rows;
      } else {
        let where = 'k.owner=? AND k.expires>?' + scopeWhere(scope, false), join = '';
        if (query) {
          if (Array.from(query).length >= 3) { join = ' JOIN knowledge_search ON knowledge_search.rowid=k.rowid'; where += ' AND knowledge_search MATCH ?'; params.push('"' + query.replaceAll('"', '""') + '"'); }
          where += " AND instr(lower(json_extract(k.data,'$.text')),lower(?))>0"; params.push(query);
        }
        if (kind) { where += " AND json_extract(k.data,'$.kind')=?"; params.push(kind); }
        if (status) { where += " AND json_extract(k.data,'$.status')=?"; params.push(status); } else where += " AND json_extract(k.data,'$.status') IN ('candidate','confirmed')";
        total = db.prepare(`SELECT count(*) AS count FROM record_knowledge k${join} WHERE ${where}`).get(...params).count;
        rows = db.prepare(`SELECT k.data FROM record_knowledge k${join} WHERE ${where} ORDER BY ${join ? 'bm25(knowledge_search),' : ''} json_extract(k.data,'$.createdAt') DESC,k.id LIMIT 40 OFFSET ?`).all(...params,offset);
      }
      const base = [owner,now,...(scope === 'all' ? [] : [scope])];
      const topic = pool ? "data->>'topic'" : "json_extract(data,'$.topic')", topicKey = pool ? "data->>'topicKey'" : "json_extract(data,'$.topicKey')", textKey = pool ? "data->>'textKey'" : "json_extract(data,'$.textKey')";
      const active = pool ? "data->>'kind'='decision' AND data->>'status' IN ('candidate','confirmed')" : "json_extract(data,'$.kind')='decision' AND json_extract(data,'$.status') IN ('candidate','confirmed')";
      const visible = `owner=${pool ? '$1' : '?'} AND expires>${pool ? '$2' : '?'}` + scopeWhere(scope,pool) + ` AND ${active} AND ${topic}<>''`;
      const groupsSql = `SELECT min(${topic}) AS topic,${topicKey} AS key,count(*) AS count FROM record_knowledge WHERE ${visible} GROUP BY ${topicKey} HAVING count(DISTINCT record_id)>1 AND count(DISTINCT ${textKey})>1 ORDER BY key LIMIT 20`;
      const groups = pool ? (await pool.query(groupsSql,base)).rows : db.prepare(groupsSql).all(...base);
      const conflicts = [];
      for (const group of groups) {
        const idsSql = `SELECT id FROM record_knowledge WHERE ${visible} AND ${topicKey}=${pool ? '$' + (base.length+1) : '?'} ORDER BY id LIMIT 40`;
        const ids = pool ? (await pool.query(idsSql,[...base,group.key])).rows : db.prepare(idsSql).all(...base,group.key);
        conflicts.push({topic:group.topic,entries:ids.map(row=>row.id),total:Number(group.count),status:'needs-review'});
      }
      return { entries: rows.map(decode).map(entry => ({ ...publicEntry(entry), highlights: knowledgeHighlight(entry.text, query) })), total, offset, hasMore: total > offset + 40, conflicts };

    },
    async review(owner, scope, id, input) {
      requireThat(/^[a-f0-9]{64}$/.test(id), 'knowledge_not_found', 404);
      const client = pool ? await pool.connect() : null;
      try {
        if (client) await client.query('BEGIN'); else db.exec('BEGIN IMMEDIATE');
        const row = client ? (await client.query('SELECT owner,workspace,expires,data FROM record_knowledge WHERE id=$1 FOR UPDATE', [id])).rows[0] : db.prepare('SELECT owner,workspace,expires,data FROM record_knowledge WHERE id=?').get(id);
        requireThat(row?.owner === owner && (scope === 'all' || row.workspace === scope) && row.expires > new Date().toISOString(), 'knowledge_not_found', 404);
        const entry = reviewKnowledge(decode(row), input);
        if (client) await client.query('UPDATE record_knowledge SET data=$2 WHERE id=$1', [id, JSON.stringify(entry)]); else db.prepare('UPDATE record_knowledge SET data=? WHERE id=?').run(JSON.stringify(entry), id);
        if (client) await client.query('COMMIT'); else db.exec('COMMIT');
        return publicEntry(entry);
      } catch (error) { if (client) await client.query('ROLLBACK'); else db.exec('ROLLBACK'); throw error; }
      finally { client?.release(); }
    },
  };
}
