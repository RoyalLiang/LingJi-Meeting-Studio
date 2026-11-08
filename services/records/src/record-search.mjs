import { requireThat } from '../../../packages/records/src/record.mjs';

const textFields = new Set(['title','heading','text','summary','speaker','owner','due','label','name','definition','description','columns','cells','quote','valueText','unit']);
const privateFields = new Set(['evidence','evidenceSnapshot','snapshot','segments','versions','history','usage','modelFacts','provenance']);
// Keep one Unicode scalar per scalar so SQL character positions also address the original text.
export function foldSearchText(text) {
  return text.replace(/\p{Lu}|\p{Lt}/gu, char => {
    const lower = char.toLowerCase(), first = String.fromCodePoint(lower.codePointAt(0));
    return lower.length === first.length ? char : first;
  }).toLowerCase();
}
export function recordSearchBody(record) {
  const parts = [record.title, record.notes, ...record.segments.flatMap(segment => [segment.speaker, segment.text])];
  function visit(value, field = '', depth = 0) {
    if (depth > 16 || privateFields.has(field)) return;
    if (typeof value === 'string') { if (textFields.has(field)) parts.push(value); return; }
    if (Array.isArray(value)) { for (const item of value) visit(item, field, depth + 1); }
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) visit(item, key, depth + 1);
  }
  visit(record.minutes); return parts.filter(Boolean).join('\n');
}
export function searchHighlights(text, query) {
  const starts = [], ends = []; let original = 0;
  for (const char of text) { for (let i = 0; i < foldSearchText(char).length; i++) { starts.push(original); ends.push(original + char.length); } original += char.length; }
  query = foldSearchText(query);
  const lower = foldSearchText(text), result = []; let at = 0;
  while (query && result.length < 20 && (at = lower.indexOf(query, at)) >= 0) {
    const range = { start: starts[at], end: ends[at + query.length - 1] }, previous = result.at(-1);
    if (previous && previous.end >= range.start) previous.end = Math.max(previous.end, range.end); else result.push(range);
    at += query.length;
  }
  return result;
}
export const searchGrams = query => [...new Set(Array.from(query).flatMap((_, index, chars) => index + 2 < chars.length ? [chars.slice(index, index + 3).join('')] : []))];
export async function createRecordSearch({ db, pool }) {
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('lingji-record-search-v3-schema'))");
    await client.query('ALTER TABLE record_list_projection ADD COLUMN IF NOT EXISTS grams TEXT[], ADD COLUMN IF NOT EXISTS search_digest TEXT');
    await client.query(`CREATE OR REPLACE FUNCTION lingji_record_search_grams_v1(body TEXT) RETURNS TEXT[] LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT COALESCE(array_agg(DISTINCT substring(body FROM pos FOR 3)),ARRAY[]::TEXT[]) FROM generate_series(1,length(body)-2) pos $$`);
    await client.query('CREATE INDEX IF NOT EXISTS record_list_search_grams ON record_list_projection USING GIN(grams)');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    for (;;) {
      const result = await pool.query("UPDATE record_list_projection SET grams=lingji_record_search_grams_v1(COALESCE(data->>'search','')),search_digest=md5(COALESCE(data->>'search','')) WHERE id IN (SELECT id FROM record_list_projection WHERE grams IS NULL LIMIT 100) RETURNING id");
      if (result.rowCount < 100) break;
    }
  } else db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS record_search USING fts5(search, tokenize='trigram'); INSERT INTO record_search(rowid,search) SELECT rowid,json_extract(data,'$.search') FROM record_list_projection WHERE json_extract(data,'$.deleted')=0 AND rowid NOT IN (SELECT rowid FROM record_search)");
  return {
    async updatePg(client, id, text) {
      await client.query('UPDATE record_list_projection SET grams=lingji_record_search_grams_v1($2),search_digest=md5($2) WHERE id=$1 AND search_digest IS DISTINCT FROM md5($2)', [id, text]);
    },
    async list(owner, scope = 'all', query = '') {
      requireThat(typeof query === 'string' && query.length <= 200 && !query.includes('\0'), 'invalid_search_query', 400);
      query = foldSearchText(query).trim(); const now = new Date().toISOString(), indexed = Array.from(query).length >= 3;
      let rows;
      if (pool) {
        const filter = indexed ? ' AND p.grams @> $5::TEXT[]' : '';
        const rank = query ? "CASE WHEN strpos(lower(p.data->'summary'->>'title'),$4)>0 THEN 0 ELSE 1 END,(length(p.data->>'search')-length(replace(p.data->>'search',$4,'')))::float8/GREATEST(length(p.data->>'search'),1) DESC," : '';
        rows = (await pool.query(`SELECT (p.data->'summary')||jsonb_build_object('seconds',COALESCE(a.duration_ms/1000.0,(p.data->'summary'->>'seconds')::float8),'updatedAt',COALESCE(NULLIF(a.updated_at,''),p.data->'summary'->>'updatedAt'),'transcription',COALESCE(a.transcription,p.data->'summary'->>'transcription')) AS data,substring(COALESCE(p.data->>'searchBody',p.data->>'search') FROM GREATEST(1,strpos(p.data->>'search',$4)-60) FOR GREATEST(220,length($4)+120)) AS snippet FROM record_list_projection p LEFT JOIN record_audio_stats a ON a.record_id=p.id WHERE p.data->>'owner'=$1 AND p.data->>'deleted'='false' AND p.data->>'deleteAt'>$2 AND ($3='all' OR ($3='inbox' AND p.data->'summary'->>'workspaceId' IS NULL) OR p.data->'summary'->>'workspaceId'=$3) AND strpos(p.data->>'search',$4)>0${filter} ORDER BY ${rank}p.data->'summary'->>'createdAt' DESC,p.id DESC LIMIT 200`, [owner,now,scope,query,...(indexed ? [searchGrams(query)] : [])])).rows;
      } else {
        const from = indexed ? 'record_search JOIN record_list_projection p ON p.rowid=record_search.rowid' : 'record_list_projection p';
        const filter = indexed ? ' AND record_search MATCH $match' : '';
        const rank = indexed ? 'bm25(record_search),' : '';
        rows = db.prepare(`SELECT json_set(json_extract(p.data,'$.summary'),'$.seconds',COALESCE(round(a.duration_ms/1000.0),json_extract(p.data,'$.summary.seconds')),'$.updatedAt',COALESCE(NULLIF(a.updated_at,''),json_extract(p.data,'$.summary.updatedAt')),'$.transcription',COALESCE(a.transcription,json_extract(p.data,'$.summary.transcription'))) AS data,substr(COALESCE(json_extract(p.data,'$.searchBody'),json_extract(p.data,'$.search')),max(1,instr(json_extract(p.data,'$.search'),$q)-60),max(220,length($q)+120)) AS snippet FROM ${from} LEFT JOIN record_audio_stats a ON a.record_id=p.id WHERE json_extract(p.data,'$.owner')=$owner AND json_extract(p.data,'$.deleted')=0 AND json_extract(p.data,'$.deleteAt')>$now AND ($scope='all' OR ($scope='inbox' AND json_extract(p.data,'$.summary.workspaceId') IS NULL) OR json_extract(p.data,'$.summary.workspaceId')=$scope) AND instr(json_extract(p.data,'$.search'),$q)>0${filter} ORDER BY ${rank}json_extract(p.data,'$.summary.createdAt') DESC,p.id DESC LIMIT 200`).all({$owner:owner,$now:now,$scope:scope,$q:query,...(indexed ? {$match:'"'+query.replaceAll('"','""')+'"'} : {})});
      }
      return rows.map(row => {
        const summary = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        summary.seconds = Math.round(Number(summary.seconds));
        return { ...summary, ...(query ? { search: { snippet: row.snippet, highlights: searchHighlights(row.snippet, query), titleHighlights: searchHighlights(summary.title, query) } } : {}) };
      });
    },
  };
}
