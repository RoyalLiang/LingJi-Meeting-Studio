import {randomUUID} from 'node:crypto';
import {collectionFields,encodedCollections,encodedDocuments,hydrateCollections,storageHeader,collectionOffsets} from './record-storage-shape.mjs';
import {requireThat} from '../../../packages/records/src/record.mjs';

export async function createPostgresRecordStore(pool) {
  await pool.query('CREATE TABLE IF NOT EXISTS record_collections(record_id TEXT NOT NULL,field TEXT NOT NULL,position INTEGER NOT NULL,data JSONB NOT NULL,PRIMARY KEY(record_id,field,position))');
  await pool.query('CREATE TABLE IF NOT EXISTS record_documents(record_id TEXT NOT NULL,field TEXT NOT NULL,data JSONB NOT NULL,PRIMARY KEY(record_id,field))');
  await pool.query('CREATE TABLE IF NOT EXISTS record_collection_backups(record_id TEXT PRIMARY KEY,data JSONB NOT NULL)');
  const baselines=new WeakMap(),cache=new Map();
  function remember(id,entry){
    cache.delete(id);
    if(entry.bytes<=16*1024*1024)cache.set(id,entry);
    while(cache.size>3)cache.delete(cache.keys().next().value);
  }
  function patchHeader(value,patch){
    const previous=cache.get(value.id);
    if(!previous||previous.version!==patch?.baseVersion||value.$collections!==2)return cache.delete(value.id);
    const rows={...previous.rows},documents={...previous.documents},offsets={...value.$offsets},patches=new Map(previous.patches);let bytes=previous.bytes;
    const changes=patch.rows||[],touched=new Set(changes.map(change=>change.field));
    for(const field of collectionFields)if((offsets[field]||0)!==(previous.offsets?.[field]||0)||value.$counts[field]!==rows[field].length)touched.add(field);
    for(const field of touched){
      if(!collectionFields.includes(field))return cache.delete(value.id);
      const drop=(offsets[field]||0)-(previous.offsets?.[field]||0);
      if(drop<0||drop>rows[field].length)return cache.delete(value.id);
      const kept=rows[field].slice(drop,drop+value.$counts[field]);
      for(const item of rows[field].slice(0,drop))bytes-=Buffer.byteLength(item);
      for(const item of rows[field].slice(drop+kept.length))bytes-=Buffer.byteLength(item);
      rows[field]=kept;
    }
    for(const change of changes){
      const index=change.position-(offsets[change.field]||0),items=rows[change.field];
      if(index<0)continue;
      if(index>items.length)return cache.delete(value.id);
      const old=items[index],key=`${change.field}:${change.position}`,pending=patches.get(key),data=change.data;
      if(pending){bytes-=pending.bytes;patches.delete(key);}
      if(data===undefined){
        if(old===undefined)return cache.delete(value.id);
        // Defer decoding frozen job inputs until a reader actually requests them.
        const set={...pending?.set,...JSON.parse(JSON.stringify(change.set||{}))},remove=new Set(pending?.remove);
        for(const name of change.remove||[]){delete set[name];remove.add(name);}
        for(const name of Object.keys(change.set||{}))remove.delete(name);
        const patch={field:change.field,position:change.position,set,remove:[...remove]};
        patch.bytes=Buffer.byteLength(JSON.stringify(patch));bytes+=patch.bytes;patches.set(key,patch);continue;
      }
      bytes+=Buffer.byteLength(data)-(old===undefined?0:Buffer.byteLength(old));items[index]=data;
    }
    for(const [key,patch] of patches)if(patch.position<(offsets[patch.field]||0)||patch.position>=(offsets[patch.field]||0)+value.$counts[patch.field]){bytes-=patch.bytes;patches.delete(key);}
    if(collectionFields.some(field=>rows[field].length!==value.$counts[field])||value.$documents.some(field=>!Object.hasOwn(documents,field)))return cache.delete(value.id);
    remember(value.id,{version:value.$version,rows,documents,offsets,bytes,patches});
  }
  async function decode(value,client=pool,loaded) {
    if(value?.$collections!==2)return value;
    let entry=loaded?.entry ?? cache.get(value.id);
    if(!entry || entry.version!==value.$version){
    const rows=Object.fromEntries(collectionFields.map(field=>[field,[]]));
    for(const row of loaded?.collections ?? (await client.query('SELECT field,position,data FROM record_collections WHERE record_id=$1 ORDER BY field,position',[value.id])).rows){
      requireThat(collectionFields.includes(row.field)&&row.position===rows[row.field].length+(value.$offsets?.[row.field]||0),'storage_corrupt',500);rows[row.field].push(JSON.stringify(row.data));
    }
    const documents=Object.fromEntries((loaded?.documents ?? (await client.query('SELECT field,data FROM record_documents WHERE record_id=$1 ORDER BY field',[value.id])).rows).map(row=>[row.field,JSON.stringify(row.data)]));
      entry={rows,documents,offsets:value.$offsets||{},version:value.$version,bytes:Object.values(rows).flat().reduce((sum,row)=>sum+Buffer.byteLength(row),0)+Object.values(documents).reduce((sum,row)=>sum+Buffer.byteLength(row),0)};remember(value.id,entry);
    }
    if (entry.patches?.size) {
      const rows={...entry.rows},copied=new Set();let bytes=entry.bytes;
      for (const patch of entry.patches.values()) {
        if (!copied.has(patch.field)) {rows[patch.field]=[...rows[patch.field]];copied.add(patch.field);}
        const index=patch.position-(entry.offsets[patch.field]||0),old=rows[patch.field][index];
        const item=JSON.parse(old);Object.assign(item,patch.set);
        for (const key of patch.remove) delete item[key];
        rows[patch.field][index]=JSON.stringify(item);
        bytes+=Buffer.byteLength(rows[patch.field][index])-Buffer.byteLength(old)-patch.bytes;
      }
      entry={...entry,rows,bytes,patches:new Map()};remember(value.id,entry);
    }
    const {rows,documents}=entry;
    const result=hydrateCollections(value,rows,documents);baselines.set(result,{rows,documents,offsets:value.$offsets||{}});return result;
  }
  async function snapshotRead(read) {
    const client=await pool.connect();
    try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await read(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  return {
    patchHeader,
    decode,
    read(id){return snapshotRead(async client=>decode((await client.query('SELECT data FROM record_aggregates WHERE id=$1',[id])).rows[0]?.data || null,client));},
    list(kind){return snapshotRead(async client=>{
      const values=[];
      let after='';
      for(;;){
        const {rows}=await client.query("SELECT id,data FROM record_aggregates WHERE data->>'kind'=$1 AND id>$2 ORDER BY id LIMIT 32",[kind,after]);
        const pages=new Map();
        const missing=[];
        for(const {data} of rows){
          if(data?.$collections!==2)continue;
          const entry=cache.get(data.id);
          if(entry?.version===data.$version)pages.set(data.id,{entry});
          else {
            missing.push(data.id);
            pages.set(data.id,{collections:[],documents:[]});
          }
        }
        if(missing.length){
          const ids=missing;
          const {rows:collections}=await client.query('SELECT record_id,field,position,data FROM record_collections WHERE record_id=ANY($1::text[]) ORDER BY record_id,field,position',[ids]);
          for(const row of collections)pages.get(row.record_id).collections.push(row);
          const {rows:documents}=await client.query('SELECT record_id,field,data FROM record_documents WHERE record_id=ANY($1::text[]) ORDER BY record_id,field',[ids]);
          for(const row of documents)pages.get(row.record_id).documents.push(row);
        }
        for(const row of rows)values.push(await decode(row.data,client,pages.get(row.id)));
        if(rows.length<32)break;
        after=rows.at(-1).id;
      }
      return values;
    });},
    async write(client,value,insert=false){
      if(value.kind!=='record'){
        await client.query(insert?'INSERT INTO record_aggregates(id,data) VALUES($1,$2)':'UPDATE record_aggregates SET data=$2 WHERE id=$1',[value.id,JSON.stringify(value)]);return;
      }
      const before=baselines.get(value),rows=encodedCollections(value),documents=encodedDocuments(value),offsets=collectionOffsets(rows,before);
      if(value.deleted||Date.parse(value.deleteAt)<=Date.now())await client.query('DELETE FROM record_collection_backups WHERE record_id=$1',[value.id]);
      if(!insert&&!before&&!value.deleted&&Date.parse(value.deleteAt)>Date.now())await client.query('INSERT INTO record_collection_backups(record_id,data) SELECT id,data FROM record_aggregates WHERE id=$1 AND data->>\'$collections\' IS DISTINCT FROM \'2\' ON CONFLICT DO NOTHING',[value.id]);
      for(const field of collectionFields){
        const start=offsets[field]||0,oldStart=before?.offsets[field]||0,end=start+rows[field].length;
        if(start>oldStart)await client.query('DELETE FROM record_collections WHERE record_id=$1 AND field=$2 AND position<$3',[value.id,field,start]);
        let pending=[];
        const flush=async()=>{if(!pending.length)return;await client.query('INSERT INTO record_collections(record_id,field,position,data) SELECT $1,$2,item.position,item.data FROM jsonb_to_recordset($3::jsonb) AS item(position INTEGER,data JSONB) ON CONFLICT(record_id,field,position) DO UPDATE SET data=excluded.data',[value.id,field,JSON.stringify(pending)]);pending=[];};
        for(let index=0;index<rows[field].length;index++){const position=start+index;if(before?.rows[field][position-oldStart]!==rows[field][index]){pending.push({position,data:JSON.parse(rows[field][index])});if(pending.length===100)await flush();}}
        await flush();
        if(!before||oldStart+before.rows[field].length>end)await client.query('DELETE FROM record_collections WHERE record_id=$1 AND field=$2 AND position>=$3',[value.id,field,end]);
      }
      for(const [field,data] of Object.entries(documents))if(before?.documents[field]!==data)await client.query('INSERT INTO record_documents(record_id,field,data) VALUES($1,$2,$3) ON CONFLICT(record_id,field) DO UPDATE SET data=excluded.data',[value.id,field,data]);
      for(const field of before?Object.keys(before.documents):(await client.query('SELECT field FROM record_documents WHERE record_id=$1',[value.id])).rows.map(row=>row.field))if(!Object.hasOwn(documents,field))await client.query('DELETE FROM record_documents WHERE record_id=$1 AND field=$2',[value.id,field]);
      const header=storageHeader(value,rows,documents,randomUUID(),offsets);
      remember(value.id,{rows,documents,offsets,version:header.$version,bytes:Object.values(rows).flat().reduce((sum,row)=>sum+Buffer.byteLength(row),0)+Object.values(documents).reduce((sum,row)=>sum+Buffer.byteLength(row),0)});
      await client.query(insert?'INSERT INTO record_aggregates(id,data) VALUES($1,$2)':'UPDATE record_aggregates SET data=$2 WHERE id=$1',[value.id,JSON.stringify(header)]);
    },
  };
}
