import {randomUUID} from 'node:crypto';
import {collectionFields,encodedCollections,encodedDocuments,hydrateCollections,storageHeader} from './record-storage-shape.mjs';
import {requireThat} from '../../../packages/records/src/record.mjs';

export async function createPostgresRecordStore(pool) {
  await pool.query('CREATE TABLE IF NOT EXISTS record_collections(record_id TEXT NOT NULL,field TEXT NOT NULL,position INTEGER NOT NULL,data JSONB NOT NULL,PRIMARY KEY(record_id,field,position))');
  await pool.query('CREATE TABLE IF NOT EXISTS record_documents(record_id TEXT NOT NULL,field TEXT NOT NULL,data JSONB NOT NULL,PRIMARY KEY(record_id,field))');
  await pool.query('CREATE TABLE IF NOT EXISTS record_collection_backups(record_id TEXT PRIMARY KEY,data JSONB NOT NULL)');
  const baselines=new WeakMap();
  async function decode(value,client=pool) {
    if(value?.$collections!==2)return value;
    const rows=Object.fromEntries(collectionFields.map(field=>[field,[]]));
    for(const row of (await client.query('SELECT field,position,data FROM record_collections WHERE record_id=$1 ORDER BY field,position',[value.id])).rows){
      requireThat(collectionFields.includes(row.field)&&row.position===rows[row.field].length+(value.$offsets?.[row.field]||0),'storage_corrupt',500);rows[row.field].push(JSON.stringify(row.data));
    }
    const documents=Object.fromEntries((await client.query('SELECT field,data FROM record_documents WHERE record_id=$1 ORDER BY field',[value.id])).rows.map(row=>[row.field,JSON.stringify(row.data)]));
    const result=hydrateCollections(value,rows,documents);baselines.set(result,{rows,documents,offsets:value.$offsets||{}});return result;
  }
  async function snapshotRead(read) {
    const client=await pool.connect();
    try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await read(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  return {
    decode,
    read(id){return snapshotRead(async client=>decode((await client.query('SELECT data FROM record_aggregates WHERE id=$1',[id])).rows[0]?.data || null,client));},
    list(kind){return snapshotRead(async client=>{const rows=(await client.query("SELECT data FROM record_aggregates WHERE data->>'kind'=$1 ORDER BY id",[kind])).rows;const values=[];for(const row of rows)values.push(await decode(row.data,client));return values;});},
    async write(client,value,insert=false){
      if(value.kind!=='record'){
        await client.query(insert?'INSERT INTO record_aggregates(id,data) VALUES($1,$2)':'UPDATE record_aggregates SET data=$2 WHERE id=$1',[value.id,JSON.stringify(value)]);return;
      }
      const before=baselines.get(value),rows=encodedCollections(value),documents=encodedDocuments(value);
      if(value.deleted||Date.parse(value.deleteAt)<=Date.now())await client.query('DELETE FROM record_collection_backups WHERE record_id=$1',[value.id]);
      if(!insert&&!before&&!value.deleted&&Date.parse(value.deleteAt)>Date.now())await client.query('INSERT INTO record_collection_backups(record_id,data) SELECT id,data FROM record_aggregates WHERE id=$1 AND data->>\'$collections\' IS DISTINCT FROM \'2\' ON CONFLICT DO NOTHING',[value.id]);
      for(const field of collectionFields){
        if(before?.offsets[field])await client.query('DELETE FROM record_collections WHERE record_id=$1 AND field=$2',[value.id,field]);
        let pending=[];
        const flush=async()=>{if(!pending.length)return;await client.query('INSERT INTO record_collections(record_id,field,position,data) SELECT $1,$2,item.position,item.data FROM jsonb_to_recordset($3::jsonb) AS item(position INTEGER,data JSONB) ON CONFLICT(record_id,field,position) DO UPDATE SET data=excluded.data',[value.id,field,JSON.stringify(pending)]);pending=[];};
        for(let position=0;position<rows[field].length;position++)if(before?.offsets[field]||before?.rows[field][position]!==rows[field][position]){pending.push({position,data:JSON.parse(rows[field][position])});if(pending.length===100)await flush();}
        await flush();
        if(!before||before.rows[field].length>rows[field].length)await client.query('DELETE FROM record_collections WHERE record_id=$1 AND field=$2 AND position>=$3',[value.id,field,rows[field].length]);
      }
      for(const [field,data] of Object.entries(documents))if(before?.documents[field]!==data)await client.query('INSERT INTO record_documents(record_id,field,data) VALUES($1,$2,$3) ON CONFLICT(record_id,field) DO UPDATE SET data=excluded.data',[value.id,field,data]);
      for(const field of before?Object.keys(before.documents):(await client.query('SELECT field FROM record_documents WHERE record_id=$1',[value.id])).rows.map(row=>row.field))if(!Object.hasOwn(documents,field))await client.query('DELETE FROM record_documents WHERE record_id=$1 AND field=$2',[value.id,field]);
      const header=storageHeader(value,rows,documents,randomUUID());
      await client.query(insert?'INSERT INTO record_aggregates(id,data) VALUES($1,$2)':'UPDATE record_aggregates SET data=$2 WHERE id=$1',[value.id,JSON.stringify(header)]);
    },
  };
}
