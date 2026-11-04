import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,open,readFile,writeFile,rename,unlink,readdir,lstat,realpath,rmdir} from 'node:fs/promises';
import {isAbsolute,join,basename,resolve,sep} from 'node:path';
import {digest,requireThat,emit} from '../../../packages/records/src/record.mjs';
import {waveHeader} from './audio-wav.mjs';

const settingsId=owner=>`audio-backup:${digest(owner)}`;
const baseDirectory=(directory,owner)=>join(directory,'聆记音频备份',digest(owner).slice(0,12));
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const missing=error=>error.code==='ENOENT';
const remove=async path=>{try{await unlink(path);}catch(error){if(!missing(error))throw error;}};
const fileHash=async path=>{const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex');};
const regularDirectory=async path=>{const info=await lstat(path);requireThat(info.isDirectory()&&!info.isSymbolicLink(),'invalid_audio_backup_directory',400);};
async function ownedBase(directory,owner,marker){
  const base=baseDirectory(directory,owner);await regularDirectory(directory);await regularDirectory(join(directory,'聆记音频备份'));await regularDirectory(base);
  requireThat((await json(join(base,'.lingji-owner.json'))).marker===marker,'audio_backup_path_conflict',409);return base;
}
export async function audioBackupSettings(repo,owner){
  const value=await repo.get(settingsId(owner));return {enabled:Boolean(value?.enabled),directory:value?.directory||'',retentionDays:value?.retentionDays||0,...(value?.lastError?{error:value.lastError}:{})};
}
export async function saveAudioBackupSettings(repo,owner,input){
  requireThat(typeof input?.enabled==='boolean'&&[0,7,30,90,180].includes(input.retentionDays),'invalid_audio_backup_settings',400);
  const id=settingsId(owner),previous=await repo.get(id),marker=previous?.marker||randomUUID();let directory=previous?.directory||'';
  if(input.enabled){
    requireThat(typeof input.directory==='string'&&input.directory.length<=4096&&isAbsolute(input.directory),'invalid_audio_backup_directory',400);
    directory=await realpath(input.directory);await regularDirectory(directory);
    requireThat(directory!==resolve(repo.root)&&!directory.startsWith(resolve(repo.root)+sep),'invalid_audio_backup_directory',400);
    const base=baseDirectory(directory,owner);await mkdir(base,{recursive:true,mode:0o700});await regularDirectory(join(directory,'聆记音频备份'));await regularDirectory(base);
    const ownerFile=join(base,'.lingji-owner.json');
    try{await writeFile(ownerFile,JSON.stringify({marker}),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
    await ownedBase(directory,owner,marker);
    const probe=join(base,`.write-check-${randomUUID()}`),handle=await open(probe,'wx',0o600);await handle.close();await unlink(probe);
  }
  const value={id,kind:'audio-backup-settings',owner,marker,directory,enabled:input.enabled,retentionDays:input.retentionDays};
  if(previous)await repo.change(id,current=>Object.assign(current,value,{lastError:null}));else await repo.insert(value);
  return audioBackupSettings(repo,owner);
}
export async function prepareAudioBackup(repo,record){
  const setting=await repo.get(settingsId(record.owner));if(!setting?.enabled)return;
  const title=String(record.title).normalize('NFKC').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,60).replace(/[. ]+$/g,'');
  record.audioBackup={status:'pending',directory:setting.directory,marker:setting.marker,folder:`${record.createdAt.slice(0,10)}_${title}_${record.id.slice(0,8)}`};
}
export const audioBackupReady=record=>['sealed','completed'].includes(record.capture)&&record.sources.every(source=>Number.isInteger(source.lastSequence)&&source.lastSequence>=-1&&record.chunks.filter(chunk=>chunk.sourceId===source.id).length===source.lastSequence+1);
export const audioBackupPending=record=>record?.audioBackup&&!['saved','skipped'].includes(record.audioBackup.status);
export async function backupAudioRecord(repo,record,now=Date.now()){
  if(!audioBackupPending(record)||!audioBackupReady(record))return;
  const backup=record.audioBackup;if(backup.retryAt>now||backup.leaseUntil>now)return;
  const attempt=randomUUID();let claimed=false;
  await repo.change(record.id,current=>{if(!current.deleted&&audioBackupPending(current)&&!(current.audioBackup.retryAt>now||current.audioBackup.leaseUntil>now)){Object.assign(current.audioBackup,{status:'writing',attempt,leaseUntil:now+600000});claimed=true;}},{returnRecord:false});
  if(!claimed)return;
  const active=async()=>{const access=(await repo.getRecordAccess([record.id]))[0];requireThat(access&&!access.deleted&&access.owner===record.owner&&Date.parse(access.deleteAt)>Date.now(),'record_not_found',404);};
  const temporary=[];
  try{
    const base=await ownedBase(backup.directory,record.owner,backup.marker),folder=join(base,backup.folder);await mkdir(folder,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});await regularDirectory(folder);
    const ownerFile=join(folder,'.lingji-owner.json');try{await writeFile(ownerFile,JSON.stringify({marker:backup.marker,recordId:record.id}),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
    const owner=await json(ownerFile);requireThat(owner.marker===backup.marker&&owner.recordId===record.id,'audio_backup_path_conflict',409);
    const files=[];
    for(const source of record.sources){
      const chunks=record.chunks.filter(chunk=>chunk.sourceId===source.id).sort((a,b)=>a.sequence-b.sequence);if(!chunks.length)continue;requireThat(chunks.every((chunk,index)=>!chunk.expired&&chunk.sequence===index),'audio_object_corrupt',500);
      await active();const bytes=chunks.reduce((sum,chunk)=>sum+chunk.sampleCount*2,0);requireThat(bytes<=0xffffffff-36,'audio_backup_too_large',413);
      const name=`${source.kind}-${source.id}.wav`,target=join(folder,name),temp=join(folder,`.lingji-part-${attempt}-${source.id}`),hash=createHash('sha256');temporary.push(temp);
      const handle=await open(temp,'wx',0o600);try{const header=waveHeader(bytes);await handle.writeFile(header);hash.update(header);for(const chunk of chunks){const pcm=await repo.readAudio(chunk.object);requireThat(pcm.length===chunk.sampleCount*2,'audio_object_corrupt',500);await handle.writeFile(pcm);hash.update(pcm);}await handle.sync();}finally{await handle.close();}
      await active();const sha256=hash.digest('hex');
      let exists=false;try{const info=await lstat(target);exists=true;requireThat(info.isFile()&&!info.isSymbolicLink()&&await fileHash(target)===sha256,'audio_backup_file_changed',409);}catch(error){if(!missing(error))throw error;}if(!exists)await rename(temp,target);
      await remove(temp);const info=await lstat(target);files.push({name,size:info.size,mtimeMs:info.mtimeMs,sha256,sourceId:source.id,sampleRate:16000,timelineOffsetMs:source.timelineOffsetMs||0});
    }
    await active();const manifest=join(folder,'.lingji-backup.json'),temp=join(folder,`.lingji-part-${attempt}-manifest`);temporary.push(temp);
    await writeFile(temp,JSON.stringify({format:'lingji-audio-backup/v1',marker:backup.marker,recordId:record.id,savedAt:now,files}),{flag:'wx',mode:0o600});await rename(temp,manifest);
    await repo.change(record.id,current=>{if(current.audioBackup?.attempt===attempt){Object.assign(current.audioBackup,{status:files.length?'saved':'skipped',savedAt:now,error:null,leaseUntil:0,retryAt:0});emit(current,'audio.backup.saved');}},{returnRecord:false});
    const setting=await repo.get(settingsId(record.owner));if(setting?.lastErrorRecord===record.id)await repo.change(setting.id,current=>{delete current.lastError;delete current.lastErrorRecord;});
  }catch{
    await repo.change(record.id,current=>{if(!current.deleted&&current.audioBackup?.attempt===attempt&&current.audioBackup.status!=='saved'){Object.assign(current.audioBackup,{status:'failed',error:'audio_backup_failed',retryAt:now+60000,leaseUntil:0});emit(current,'audio.backup.failed');}},{returnRecord:false});
    const setting=await repo.get(settingsId(record.owner));if(setting)await repo.change(setting.id,current=>Object.assign(current,{lastError:'audio_backup_failed',lastErrorRecord:record.id}));
  }finally{await Promise.allSettled(temporary.map(remove));}
  return true;
}

const cleanedAt=new WeakMap();
export async function cleanupAudioBackups(repo,now=Date.now()){
  if(now-(cleanedAt.get(repo)||0)<3600000)return;cleanedAt.set(repo,now);
  for(const setting of await repo.list('audio-backup-settings')){
    if(!setting.enabled||!setting.retentionDays)continue;
    try{
      const base=await ownedBase(setting.directory,setting.owner,setting.marker);
      for(const entry of await readdir(base,{withFileTypes:true})){
        if(!entry.isDirectory()||entry.isSymbolicLink())continue;
        const folder=join(base,entry.name);let manifest;try{manifest=await json(join(folder,'.lingji-backup.json'));}catch{continue;}
        if(manifest.format!=='lingji-audio-backup/v1'||manifest.marker!==setting.marker||!Number.isFinite(manifest.savedAt)||!Array.isArray(manifest.files)||manifest.savedAt>now-setting.retentionDays*86400000)continue;
        let complete=true;
        for(const file of manifest.files){
          if(typeof file.name!=='string'||basename(file.name)!==file.name||!file.name.endsWith('.wav')){complete=false;continue;}
          const path=join(folder,file.name);let info;try{info=await lstat(path);}catch(error){if(missing(error))continue;throw error;}
          if(!info.isFile()||info.isSymbolicLink()||info.size!==file.size||info.mtimeMs!==file.mtimeMs||typeof file.sha256!=='string'||await fileHash(path)!==file.sha256){complete=false;continue;}
          await unlink(path);
        }
        if(complete&&(await readdir(folder)).every(name=>['.lingji-backup.json','.lingji-owner.json'].includes(name))){await remove(join(folder,'.lingji-backup.json'));await remove(join(folder,'.lingji-owner.json'));await rmdir(folder);}
      }
    }catch{/* An unavailable backup drive must not interrupt recording or ASR. */}
  }
}
