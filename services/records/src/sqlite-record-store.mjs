import {collectionFields as fields,recordBody as bodyOf,encodedCollections as encodeRows,encodedDocuments,hydrateCollections as collections,sameStorageSnapshot,storageHeader,collectionOffsets} from './record-storage-shape.mjs';
import {randomUUID} from 'node:crypto';
import {backup} from 'node:sqlite';
import {stat,chmod,open,link,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {flushAudioObject} from './audio-storage-sync.mjs';
import {encodeStorage,decodeStorage} from './storage-codec.mjs';
import {requireThat} from '../../../packages/records/src/record.mjs';


export async function backupLegacyRecordStore(db,root){
  const hasCollections=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='record_collections'").get();
  const ready=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='record_storage_schema'").get() && !!db.prepare('SELECT 1 FROM record_storage_schema WHERE version=2').get();
  if(ready || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='aggregates'").get() || !db.prepare("SELECT 1 FROM aggregates WHERE json_extract(data,'$.kind')='record' LIMIT 1").get())return;
  const destination=join(root,hasCollections?'records.pre-collections-v2.sqlite':'records.pre-collections-v1.sqlite');
  try{requireThat((await stat(destination)).size>0,'storage_backup_incomplete',500);return;}catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary=join(root,`.tmp-record-backup-${randomUUID()}.sqlite`);
  try{
    await backup(db,temporary);await chmod(temporary,0o600);
    const handle=await open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}
    try{await link(temporary,destination);}catch(error){if(error.code!=='EEXIST')throw error;}
    await flushAudioObject(destination,root);
  }finally{await rm(temporary,{force:true});}
}
function readRows(db,id,offsets={}){
  const rows=Object.fromEntries(fields.map(field=>[field,[]]));
  for(const row of db.prepare('SELECT field,position,data FROM record_collections WHERE record_id=? ORDER BY field,position').all(id)){
    requireThat(fields.includes(row.field)&&row.position===rows[row.field].length+(offsets[row.field]||0),'storage_corrupt',500);rows[row.field].push(row.data);
  }
  return rows;
}
function readDocuments(db,id){return Object.fromEntries(db.prepare('SELECT field,data FROM record_documents WHERE record_id=? ORDER BY field').all(id).map(row=>[row.field,row.data]));}
export function hydrateRecordCollections(db,value){
  return [1,2].includes(value?.$collections)?collections(value,readRows(db,value.id,value.$offsets),value.$collections===2?readDocuments(db,value.id):{}):value;
}
export const sameRecordSnapshot=sameStorageSnapshot;

// The transaction belongs to the repository: collection rows and the header commit together.
export function createSqliteRecordStore(db,{compressAggregates=false}={}){
  db.exec('CREATE TABLE IF NOT EXISTS record_collections(record_id TEXT NOT NULL, field TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(record_id,field,position))');
  db.exec('CREATE TABLE IF NOT EXISTS record_storage_schema(version INTEGER PRIMARY KEY)');
  db.exec('CREATE TABLE IF NOT EXISTS record_documents(record_id TEXT NOT NULL,field TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(record_id,field))');
  const cache=new Map(),baselines=new WeakMap();
  const put=db.prepare('INSERT INTO record_collections(record_id,field,position,data) VALUES(?,?,?,?) ON CONFLICT(record_id,field,position) DO UPDATE SET data=excluded.data');
  const trim=db.prepare('DELETE FROM record_collections WHERE record_id=? AND field=? AND position>=?');
  function remember(id,entry){
    cache.delete(id);
    if(entry.bytes<=16*1024*1024)cache.set(id,entry);
    while(cache.size>3)cache.delete(cache.keys().next().value);
  }
  function hydrate(value){
    if(value?.$payload==='deflate-v1'){
      const stored=db.prepare('SELECT payload FROM aggregate_payloads WHERE id=?').get(value.id);
      requireThat(stored,'storage_corrupt',500);
      value=JSON.parse(decodeStorage(stored.payload).toString());
    }
    if(value?.$collections!==2){if(value?.kind==='record')cache.delete(value.id);return value?.$collections===1?collections(value,readRows(db,value.id,value.$offsets)):value;}
    let entry=cache.get(value.id);
    if(entry?.version!==value.$version){
      const rows=readRows(db,value.id,value.$offsets);
      entry={version:value.$version,rows,offsets:value.$offsets||{},documents:readDocuments(db,value.id),bytes:fields.reduce((sum,field)=>sum+rows[field].reduce((n,item)=>n+Buffer.byteLength(item),0),0)};
      entry.bytes+=Object.values(entry.documents).reduce((sum,item)=>sum+Buffer.byteLength(item),0);
      remember(value.id,entry);
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
    const result=collections(value,entry.rows,entry.documents);
    baselines.set(result,entry);
    return result;
  }
  function snapshot(value){const baseline=baselines.get(value);return {body:JSON.stringify(bodyOf(value)),rows:baseline?.rows||encodeRows(value),documents:baseline?.documents||encodedDocuments(value)};}
  function prepare(value){return {body:JSON.stringify(bodyOf(value)),rows:encodeRows(value),documents:encodedDocuments(value)};}
  function write(value,insert=false,prepared){
    const separated=value.kind==='record',rows=separated?(prepared?.rows||encodeRows(value)):null,previous=insert?null:baselines.get(value)||cache.get(value.id);
    const version=randomUUID(),documents=separated?(prepared?.documents||encodedDocuments(value)):{},offsets=separated?collectionOffsets(rows,previous):{};
    if(separated)for(const field of fields){
      const start=offsets[field]||0,oldStart=previous?.offsets?.[field]||0,end=start+rows[field].length;
      if(start>oldStart)db.prepare('DELETE FROM record_collections WHERE record_id=? AND field=? AND position<?').run(value.id,field,start);
      rows[field].forEach((item,index)=>{const position=start+index;if(previous?.rows[field][position-oldStart]!==item)put.run(value.id,field,position,item);});
      if(!previous||oldStart+previous.rows[field].length>end)trim.run(value.id,field,end);
    }
    if(separated){
      for(const [field,data] of Object.entries(documents))if(previous?.documents?.[field]!==data)db.prepare('INSERT INTO record_documents(record_id,field,data) VALUES(?,?,?) ON CONFLICT(record_id,field) DO UPDATE SET data=excluded.data').run(value.id,field,data);
      for(const field of previous?Object.keys(previous.documents):db.prepare('SELECT field FROM record_documents WHERE record_id=?').all(value.id).map(row=>row.field))if(!Object.hasOwn(documents,field))db.prepare('DELETE FROM record_documents WHERE record_id=? AND field=?').run(value.id,field);
    }
    writeHeader(separated?storageHeader(value,rows,documents,version,offsets):value,insert);
    if(separated)remember(value.id,{version,rows,documents,offsets,bytes:Object.values(documents).reduce((sum,item)=>sum+Buffer.byteLength(item),0)+fields.reduce((sum,field)=>sum+rows[field].reduce((n,item)=>n+Buffer.byteLength(item),0),0)});
  }
  function updateCache(value,patch){
    const previous=cache.get(value.id);
    if(!previous||previous.version!==patch?.baseVersion||value.$collections!==2)return cache.delete(value.id);
    const rows={...previous.rows},documents={...previous.documents},offsets={...value.$offsets},patches=new Map(previous.patches);let bytes=previous.bytes;
    const changes=patch.rows||[],touched=new Set(changes.map(change=>change.field));
    for(const field of fields)if((offsets[field]||0)!==(previous.offsets?.[field]||0)||value.$counts[field]!==rows[field].length)touched.add(field);
    for(const field of touched){
      if(!fields.includes(field))return cache.delete(value.id);
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
    if(fields.some(field=>rows[field].length!==value.$counts[field])||value.$documents.some(field=>!Object.hasOwn(documents,field)))return cache.delete(value.id);
    remember(value.id,{version:value.$version,rows,documents,offsets,bytes,patches});
  }
  function writeHeader(value,insert=false,patch){
    const json=JSON.stringify(value);
    const packed=compressAggregates&&value.kind==='record'?encodeStorage(Buffer.from(json)):{compressed:false};
    const metadata=packed.compressed?JSON.stringify({id:value.id,kind:value.kind,owner:value.owner,deleted:value.deleted,deleteAt:value.deleteAt,nextWorkAt:value.nextWorkAt,workAt:value.workAt,$collections:2,$audioVersion:2,$payload:'deflate-v1'}):json;
    if(insert)db.prepare('INSERT INTO aggregates(id,data) VALUES(?,?)').run(value.id,metadata);
    else db.prepare('UPDATE aggregates SET data=? WHERE id=?').run(metadata,value.id);
    if(packed.compressed)db.prepare('INSERT INTO aggregate_payloads(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(value.id,packed.bytes);
    else db.prepare('DELETE FROM aggregate_payloads WHERE id=?').run(value.id);
    updateCache(value,patch);
  }
  function decode(value){
    if(value?.kind!=='record'||db.isTransaction)return hydrate(value);
    db.exec('BEGIN');
    try{
      const row=db.prepare('SELECT data FROM aggregates WHERE id=?').get(value.id);
      const result=hydrate(row?JSON.parse(row.data):null);
      db.exec('COMMIT');return result;
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function header(value){
    if(value?.$payload==='deflate-v1'){
      const stored=db.prepare('SELECT payload FROM aggregate_payloads WHERE id=?').get(value.id);
      requireThat(stored,'storage_corrupt',500);return JSON.parse(decodeStorage(stored.payload).toString());
    }
    return value;
  }
  return {decode,snapshot,prepare,write,header,writeHeader,invalidate:id=>cache.delete(id)};
}
