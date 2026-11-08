import {randomUUID} from 'node:crypto';
import {backup} from 'node:sqlite';
import {stat,chmod,open,link,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {flushAudioObject} from './audio-storage-sync.mjs';
import {encodeStorage,decodeStorage} from './storage-codec.mjs';
import {requireThat} from '../../../packages/records/src/record.mjs';

const fields=['chunks','segments','events'];
export async function backupLegacyRecordStore(db,root){
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='record_collections'").get()||!db.prepare("SELECT 1 FROM sqlite_master WHERE name='aggregates'").get()||!db.prepare("SELECT 1 FROM aggregates WHERE json_extract(data,'$.kind')='record' LIMIT 1").get())return;
  const destination=join(root,'records.pre-collections-v1.sqlite');
  try{requireThat((await stat(destination)).size>0,'storage_backup_incomplete',500);return;}catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary=join(root,`.tmp-record-backup-${randomUUID()}.sqlite`);
  try{
    await backup(db,temporary);await chmod(temporary,0o600);
    const handle=await open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}
    try{await link(temporary,destination);}catch(error){if(error.code!=='EEXIST')throw error;}
    await flushAudioObject(destination,root);
  }finally{await rm(temporary,{force:true});}
}
function readRows(db,id){
  const rows=Object.fromEntries(fields.map(field=>[field,[]]));
  for(const row of db.prepare('SELECT field,position,data FROM record_collections WHERE record_id=? ORDER BY field,position').all(id)){
    requireThat(fields.includes(row.field)&&row.position===rows[row.field].length,'storage_corrupt',500);rows[row.field].push(row.data);
  }
  return rows;
}
function collections(value,rows){
  requireThat(fields.every(field=>value.$counts?.[field]===rows[field].length),'storage_corrupt',500);
  const result={...value,...Object.fromEntries(fields.map(field=>[field,rows[field].map(item=>JSON.parse(item))]))};
  delete result.$collections;delete result.$version;delete result.$counts;return result;
}
export function hydrateRecordCollections(db,value){return value?.$collections===1?collections(value,readRows(db,value.id)):value;}
const bodyOf=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!fields.includes(key)));
const encodeRows=value=>Object.fromEntries(fields.map(field=>[field,(value[field]||[]).map(item=>JSON.stringify(item))]));
export const sameRecordSnapshot=(before,after)=>before.body===after.body&&fields.every(field=>before.rows[field].length===after.rows[field].length&&before.rows[field].every((item,index)=>item===after.rows[field][index]));

// The transaction belongs to the repository: collection rows and the header commit together.
export function createSqliteRecordStore(db,{compressAggregates=false}={}){
  db.exec('CREATE TABLE IF NOT EXISTS record_collections(record_id TEXT NOT NULL, field TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(record_id,field,position))');
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
    if(value?.$collections!==1){if(value?.kind==='record')cache.delete(value.id);return value;}
    let entry=cache.get(value.id);
    if(entry?.version!==value.$version){
      const rows=readRows(db,value.id);
      entry={version:value.$version,rows,bytes:fields.reduce((sum,field)=>sum+rows[field].reduce((n,item)=>n+Buffer.byteLength(item),0),0)};
      remember(value.id,entry);
    }
    const result=collections(value,entry.rows);
    baselines.set(result,entry.rows);
    return result;
  }
  function snapshot(value){return {body:JSON.stringify(bodyOf(value)),rows:baselines.get(value)||encodeRows(value)};}
  function prepare(value){return {body:JSON.stringify(bodyOf(value)),rows:encodeRows(value)};}
  function write(value,insert=false,prepared){
    const separated=value.kind==='record',rows=separated?(prepared?.rows||encodeRows(value)):null,previous=insert?null:cache.get(value.id);
    const version=randomUUID();
    if(separated)for(const field of fields){
      rows[field].forEach((item,index)=>{if(previous?.rows[field][index]!==item)put.run(value.id,field,index,item);});
      if(!previous||previous.rows[field].length>rows[field].length)trim.run(value.id,field,rows[field].length);
    }
    const json=JSON.stringify(separated?{...bodyOf(value),$collections:1,$version:version,$counts:Object.fromEntries(fields.map(field=>[field,rows[field].length]))}:value);
    const packed=compressAggregates&&separated?encodeStorage(Buffer.from(json)):{compressed:false};
    const metadata=packed.compressed?JSON.stringify({id:value.id,kind:value.kind,owner:value.owner,deleted:value.deleted,deleteAt:value.deleteAt,nextWorkAt:value.nextWorkAt,workAt:value.workAt,$payload:'deflate-v1'}):json;
    if(insert)db.prepare('INSERT INTO aggregates(id,data) VALUES(?,?)').run(value.id,metadata);
    else db.prepare('UPDATE aggregates SET data=? WHERE id=?').run(metadata,value.id);
    if(packed.compressed)db.prepare('INSERT INTO aggregate_payloads(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(value.id,packed.bytes);
    else db.prepare('DELETE FROM aggregate_payloads WHERE id=?').run(value.id);
    if(separated)remember(value.id,{version,rows,bytes:fields.reduce((sum,field)=>sum+rows[field].reduce((n,item)=>n+Buffer.byteLength(item),0),0)});
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
  return {decode,snapshot,prepare,write};
}
