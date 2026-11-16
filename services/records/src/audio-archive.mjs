import {createHash,randomUUID} from 'node:crypto';
import {open,link,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {flushAudioObject} from './audio-storage-sync.mjs';
import {requireThat} from '../../../packages/records/src/record.mjs';

export async function createAudioArchive({root,db,pool,readAudio,header}) {
  const schema='CREATE TABLE IF NOT EXISTS record_audio_archive_offsets(object TEXT PRIMARY KEY,record_id TEXT NOT NULL,source_id TEXT NOT NULL,epoch TEXT NOT NULL,sequence INTEGER NOT NULL,archive TEXT NOT NULL,byte_offset BIGINT NOT NULL,byte_length INTEGER NOT NULL)';
  if(pool){const client=await pool.connect();try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('lingji-audio-archive-v1'))");await client.query(schema);await client.query('CREATE INDEX IF NOT EXISTS audio_archive_record ON record_audio_archive_offsets(record_id)');await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
  else db.exec(schema+'; CREATE INDEX IF NOT EXISTS audio_archive_record ON record_audio_archive_offsets(record_id)');
  async function rows(sql,params){
    if(pool)return (await pool.query(sql,params)).rows;
    const bound=[];sql=sql.replace(/\$(\d+)/g,(_,i)=>{bound.push(params[Number(i)-1]);return '?';});
    return db.prepare(sql).all(...bound);
  }
  const handles=new Map();
  async function closeFile(path){const entry=handles.get(path);handles.delete(path);if(entry){entry.retired=true;if(!entry.readers)await (await entry.file).close();}}
  async function prune(){for(const [path,entry] of handles){if(handles.size<=4)break;if(!entry.readers)await closeFile(path);}}
  return {
    async read(object) {
      const row=(await rows('SELECT archive,byte_offset,byte_length FROM record_audio_archive_offsets WHERE object=$1',[object]))[0];
      if(!row)return null;
      requireThat(/^[a-f0-9-]{36}\/archive-[a-f0-9-]{36}\.pcm$/.test(row.archive),'audio_object_corrupt',500);
      requireThat(Number.isSafeInteger(Number(row.byte_offset))&&Number(row.byte_offset)>=0&&Number.isSafeInteger(Number(row.byte_length))&&Number(row.byte_length)>0&&Number(row.byte_length)<=32*1024*1024,'audio_object_corrupt',500);
      let entry=handles.get(row.archive);
      if(!entry){entry={file:open(join(root,'audio',row.archive),'r'),readers:0,retired:false};handles.set(row.archive,entry);}
      entry.readers++;
      try {
        const file=await entry.file,bytes=Buffer.alloc(Number(row.byte_length));let offset=0;
        while(offset<bytes.length){const read=await file.read(bytes,offset,bytes.length-offset,Number(row.byte_offset)+offset);requireThat(read.bytesRead>0,'audio_object_corrupt',500);offset+=read.bytesRead;}
        requireThat(createHash('sha256').update(bytes).digest('hex')===object.split('/')[1],'audio_object_corrupt',500);
        return bytes;
      } finally {entry.readers--;if(entry.retired&&!entry.readers)await (await entry.file).close();await prune();}
    },
    async compact(record) {
      if(record.deleted || record.capture!=='completed' || !record.retainAudio || record.audioPurged || record.chunks.some(chunk=>chunk.state!=='done'))return false;
      const archived=new Set((await rows('SELECT object FROM record_audio_archive_offsets WHERE record_id=$1',[record.id])).map(row=>row.object));
      for(const object of archived)await rm(join(root,'audio',object),{force:true});
      const chunks=record.chunks.filter(chunk=>!chunk.expired&&!archived.has(chunk.object)).sort((a,b)=>a.sourceId.localeCompare(b.sourceId)||a.epoch.localeCompare(b.epoch)||a.sequence-b.sequence);
      const groups=[];let group=[];
      for(const chunk of chunks){const last=group.at(-1);if(last&&(last.sourceId!==chunk.sourceId||last.epoch!==chunk.epoch||last.sequence+1!==chunk.sequence||last.sampleOffset+last.sampleCount!==chunk.sampleOffset||chunk.sampleOffset+chunk.sampleCount-group[0].sampleOffset>16000*600)){groups.push(group);group=[];}group.push(chunk);}
      if(group.length)groups.push(group);
      let changed=false;
      for(const batch of groups.filter(items=>items.length>1)){
        const name=`archive-${randomUUID()}.pcm`,archive=`${record.id}/${name}`,directory=join(root,'audio',record.id),temporary=join(directory,`.tmp-${name}`),destination=join(directory,name);
        let installed=false;
        try{
          const file=await open(temporary,'wx',0o600),offsets=[];let offset=0;
          try{for(const chunk of batch){const bytes=await readAudio(chunk.object);requireThat(bytes.length===chunk.sampleCount*2,'audio_object_corrupt',500);await file.writeFile(bytes);offsets.push({...chunk,byteOffset:offset,byteLength:bytes.length});offset+=bytes.length;}await file.sync();}finally{await file.close();}
          await link(temporary,destination);await flushAudioObject(destination,directory);
          const client=pool?await pool.connect():null;
          try{
            if(client)await client.query('BEGIN');else db.exec('BEGIN IMMEDIATE');
            const raw=client?(await client.query('SELECT data FROM record_aggregates WHERE id=$1 FOR UPDATE',[record.id])).rows[0]?.data:header(JSON.parse(db.prepare('SELECT data FROM aggregates WHERE id=?').get(record.id)?.data||'null'));
            requireThat(raw&&!raw.deleted&&raw.retainAudio&&raw.capture==='completed'&&raw.generation===record.generation,'audio_archive_stale',409);
            for(const chunk of offsets){const args=[chunk.object,record.id,chunk.sourceId,chunk.epoch,chunk.sequence,archive,chunk.byteOffset,chunk.byteLength];if(client)await client.query('INSERT INTO record_audio_archive_offsets VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(object) DO NOTHING',args);else db.prepare('INSERT OR IGNORE INTO record_audio_archive_offsets VALUES(?,?,?,?,?,?,?,?)').run(...args);}
            if(client)await client.query('COMMIT');else db.exec('COMMIT');installed=true;
          }catch(error){try{if(client)await client.query('ROLLBACK');else db.exec('ROLLBACK');}catch{/* Commit may have reached the database before the connection failed. */}throw error;}finally{client?.release();}
          // Old hash references remain valid through the committed offset table.
          for(const object of new Set(batch.map(chunk=>chunk.object)))await rm(join(root,'audio',object),{force:true});
          changed=true;
        }finally{await rm(temporary,{force:true});if(!installed){const references=await rows('SELECT object FROM record_audio_archive_offsets WHERE archive=$1 LIMIT 1',[archive]).catch(()=>null);if(references&&!references.length)await rm(destination,{force:true});}}
      }
      return changed;
    },
    async liveFiles(recordId,liveObjects){
      const entries=await rows('SELECT object,archive FROM record_audio_archive_offsets WHERE record_id=$1',[recordId]);
      const keep=new Set(entries.filter(row=>liveObjects.has(row.object)).map(row=>row.archive));
      return {keep,async remove(archive){await closeFile(archive);if(pool)await pool.query('DELETE FROM record_audio_archive_offsets WHERE record_id=$1 AND archive=$2',[recordId,archive]);else db.prepare('DELETE FROM record_audio_archive_offsets WHERE record_id=? AND archive=?').run(recordId,archive);}};
    },
    async close(){await Promise.all([...handles.keys()].map(closeFile));},
  };
}
