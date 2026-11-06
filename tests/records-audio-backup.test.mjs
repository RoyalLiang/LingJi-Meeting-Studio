import {gunzipSync} from 'node:zlib';
import {mkdir,rename as renameDirectory} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import test from 'node:test';import assert from 'node:assert/strict';import{mkdtemp,rm,readFile,writeFile,readdir,utimes,realpath}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import{randomUUID}from'node:crypto';
import{createRepository}from'../services/records/src/repository.mjs';import{createRecord,audioPurgeReady,publicRecord}from'../packages/records/src/record.mjs';import{audioBackupSettings,saveAudioBackupSettings,prepareAudioBackup,backupAudioRecord,cleanupAudioBackups}from'../services/records/src/audio-backup.mjs';import{runCycle}from'../services/records/src/worker.mjs';
async function fixture(t,days=0){const root=await mkdtemp(join(tmpdir(),'lingji-audio-backup-')),destination=await mkdtemp(join(tmpdir(),'lingji-audio-copy-')),repo=await createRepository({root,databaseUrl:''});t.after(async()=>{await repo.close();await rm(root,{recursive:true,force:true});await rm(destination,{recursive:true,force:true});});await saveAudioBackupSettings(repo,'owner',{enabled:true,directory:destination,retentionDays:days});return{repo,destination,async record(pcm=Buffer.from([1,0,2,0,3,0])){const r=createRecord('owner',{title:'接口/联调',retainAudio:false});await prepareAudioBackup(repo,r);const sourceId=randomUUID(),object=await repo.putAudio(r.id,pcm);r.capture='completed';r.transcription='ready';r.sources=[{id:sourceId,kind:'microphone',watermark:0,lastSequence:0,asr:{state:'ready'}}];r.chunks=[{key:'sample',sourceId,sequence:0,sampleOffset:0,sampleCount:pcm.length/2,sampleRate:16000,state:'done',attempts:0,acceptedAt:Date.now(),...object}];await repo.insert(r);return{r,pcm,object:object.object};},async files(){const parent=join(destination,'聆记音频备份');const [owner]=await readdir(parent);const base=join(parent,owner),folders=(await readdir(base)).filter(name=>!name.startsWith('.'));const folder=join(base,folders[0]);return{folder,files:(await readdir(folder)).filter(name=>/\.wav(?:\.gz)?$/.test(name))};}};}
test('a streaming WAV backup preserves samples and completes before normal raw-audio purge',async t=>{const f=await fixture(t),{r,pcm,object}=await f.record();assert.equal(audioPurgeReady(await f.repo.get(r.id)),false);await runCycle(f.repo,{});const saved=await f.repo.get(r.id);assert.equal(saved.audioBackup.status,'saved');assert.doesNotMatch(JSON.stringify(publicRecord(saved).audioBackup),/directory|marker|folder|attempt/);assert.equal(saved.audioPurged,true);const{folder,files}=await f.files(),wave=await readFile(join(folder,files[0]));assert.equal(wave.subarray(0,4).toString(),'RIFF');assert.equal(wave.readUInt32LE(24),16000);assert.deepEqual(wave.subarray(44),pcm);await assert.rejects(f.repo.readAudio(object));});
test('never-clean retains backups and settings remain owner scoped',async t=>{const f=await fixture(t),{r}=await f.record(),now=Date.now();await backupAudioRecord(f.repo,r,now);const{folder,files}=await f.files();await cleanupAudioBackups(f.repo,now+400*86400000);assert.ok((await readFile(join(folder,files[0]))).length>44);assert.deepEqual(await audioBackupSettings(f.repo,'other'),{enabled:false,directory:'',retentionDays:0});await assert.rejects(saveAudioBackupSettings(f.repo,'owner',{enabled:true,directory:'../relative',retentionDays:0}),{code:'invalid_audio_backup_directory'});});
test('retention removes only registered unmodified WAV files and preserves user additions',async t=>{const f=await fixture(t,7),{r}=await f.record(),now=Date.now();await backupAudioRecord(f.repo,r,now);const{folder,files}=await f.files();await writeFile(join(folder,'notes.txt'),'用户的文件');await cleanupAudioBackups(f.repo,now+8*86400000);await assert.rejects(readFile(join(folder,files[0])));assert.equal(await readFile(join(folder,'notes.txt'),'utf8'),'用户的文件');});
test('modified backup files are preserved and failed copies cannot trigger early source purge',async t=>{const f=await fixture(t,7),{r,object}=await f.record(),now=Date.now();await backupAudioRecord(f.repo,r,now);const{folder,files}=await f.files();await writeFile(join(folder,files[0]),'手动修改');await utimes(join(folder,files[0]),new Date(now+10000),new Date(now+10000));await cleanupAudioBackups(f.repo,now+8*86400000);assert.equal(await readFile(join(folder,files[0]),'utf8'),'手动修改');const next=await f.record();await f.repo.change(next.r.id,value=>{value.audioBackup.directory=join(f.destination,'missing');});await backupAudioRecord(f.repo,await f.repo.get(next.r.id),now);const failed=await f.repo.get(next.r.id);assert.equal(failed.audioBackup.status,'failed');assert.equal(audioPurgeReady(failed),false);assert.deepEqual(await f.repo.readAudio(next.object),next.pcm);assert.equal((await audioBackupSettings(f.repo,'owner')).error,'audio_backup_failed');assert.ok(await f.repo.readAudio(object));});

test('sealed raw audio is backed up while transcription is blocked, with restart-safe retry',async t=>{
  const f=await fixture(t),{r,pcm}=await f.record();
  await f.repo.change(r.id,value=>{value.capture='sealed';value.transcription='blocked';value.sources[0].watermark=-1;value.chunks[0].state='blocked';value.audioBackup.leaseUntil=Date.now()-1;});
  await runCycle(f.repo,{}, {lane:'audio'});
  const saved=await f.repo.get(r.id);assert.equal(saved.audioBackup.status,'saved');
  const {folder,files}=await f.files();assert.deepEqual((await readFile(join(folder,files[0]))).subarray(44),pcm);
  await f.repo.change(r.id,value=>{value.audioBackup.status='pending';});
  await backupAudioRecord(f.repo,await f.repo.get(r.id));assert.equal((await f.repo.get(r.id)).audioBackup.status,'saved');
  assert.deepEqual((await readdir(folder)).filter(name=>name.endsWith('.wav')),files);
});

test('backup HTTP settings enforce authentication, CSRF, account isolation and new-record scope',async t=>{
  const {createRecordServer}=await import('../services/records/src/server.mjs');
  const root=await mkdtemp(join(tmpdir(),'lingji-backup-api-')),destination=await mkdtemp(join(tmpdir(),'lingji-backup-api-files-'));
  const app=await createRecordServer({root,port:0});await app.start();
  t.after(async()=>{await app.stop();await rm(root,{recursive:true,force:true});await rm(destination,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}/api`;
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'dev@local.test',password:'LocalMeeting2026!'})});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
  const request=(path,method='GET',body,token=csrf)=>fetch(base+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json',...(token?{'X-CSRF-Token':token}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await fetch(base+'/settings/audio-backup')).status,401);
  const before=await(await request('/records','POST',{title:'启用前',autoMinutes:false})).json();
  const settings={enabled:true,directory:await realpath(destination),retentionDays:30};
  assert.equal((await request('/settings/audio-backup','PUT',settings,null)).status,403);
  const saved=await request('/settings/audio-backup','PUT',settings);assert.equal(saved.status,200);assert.deepEqual(await saved.json(),settings);
  assert.deepEqual(await(await request('/settings/audio-backup')).json(),settings);
  const other=await fetch(base+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'backup-other@example.test',password:'LocalMeeting2026!'})});assert.equal(other.status,200);
  const isolated=await fetch(base+'/settings/audio-backup',{headers:{Cookie:other.headers.get('set-cookie').split(';')[0]}});assert.equal(isolated.status,200);assert.deepEqual(await isolated.json(),{enabled:false,directory:'',retentionDays:0});
  const created=await request('/records','POST',{title:'启用后',autoMinutes:false});assert.equal(created.status,201);const publicValue=await created.json();
  assert.equal(publicValue.audioBackup.status,'pending');assert.doesNotMatch(JSON.stringify(publicValue),/lingji-backup-api-files|\.lingji-owner|"marker"/);
  assert.ok((await app.repo.get(publicValue.id)).audioBackup.directory);assert.equal((await app.repo.get(before.id)).audioBackup,undefined);
  const invalid=await request('/settings/audio-backup','PUT',{...settings,directory:'relative'});assert.equal(invalid.status,400);
  assert.deepEqual(await(await request('/settings/audio-backup')).json(),settings);
});

test('retention preserves same-size modified audio even if its timestamp was restored',async t=>{
  const f=await fixture(t,7),{r}=await f.record(),now=Date.now();await backupAudioRecord(f.repo,r,now);const{folder,files}=await f.files();
  const manifest=JSON.parse(await readFile(join(folder,'.lingji-backup.json'),'utf8')),path=join(folder,files[0]),bytes=await readFile(path);bytes[44]^=1;await writeFile(path,bytes);
  const modified=manifest.files[0];await utimes(path,new Date(modified.mtimeMs),new Date(modified.mtimeMs));
  await cleanupAudioBackups(f.repo,now+8*86400000);assert.deepEqual(await readFile(path),bytes);
});

test('renaming an ended meeting reconciles its saved backup after original audio was purged',async t=>{
  const f=await fixture(t),{r}=await f.record();await runCycle(f.repo,{}, {lane:'audio'});
  const old=await f.files();assert.equal((await f.repo.get(r.id)).audioPurged,true);
  await f.repo.change(r.id,value=>{value.title='自动结束后的正式会议名';value.titleEdited=true;});
  await runCycle(f.repo,{}, {lane:'audio'});
  const renamed=await f.files();assert.notEqual(renamed.folder,old.folder);assert.match(renamed.folder,/自动结束后的正式会议名/);
  assert.equal((await f.repo.get(r.id)).audioBackup.status,'saved');
  assert.deepEqual(renamed.files,old.files);
});

test('large new backups are lossless compressed WAVs and survive retention checks',async t=>{
  const f=await fixture(t,7),pcm=Buffer.alloc(32000);for(let i=0;i<16000;i++)pcm.writeInt16LE(Math.round(12000*Math.sin(i/12)),i*2);
  const {r}=await f.record(pcm),now=Date.now();await backupAudioRecord(f.repo,r,now);
  const {folder,files}=await f.files();assert.equal(files.length,1);assert.match(files[0],/\.wav\.gz$/);
  const packed=await readFile(join(folder,files[0])),wave=gunzipSync(packed);assert.deepEqual(wave.subarray(44),pcm);assert.ok(packed.length<wave.length);
  const manifest=JSON.parse(await readFile(join(folder,'.lingji-backup.json'),'utf8'));assert.equal(manifest.format,'lingji-audio-backup/v2');assert.equal(manifest.files[0].decodedSha256,createHash('sha256').update(wave).digest('hex'));
  await f.repo.change(r.id,value=>{value.audioBackup.status='pending';});await backupAudioRecord(f.repo,await f.repo.get(r.id),now);assert.equal((await f.repo.get(r.id)).audioBackup.status,'saved');
  await cleanupAudioBackups(f.repo,now+8*86400000);await assert.rejects(readFile(join(folder,files[0])));
});

test('legacy pending backups keep their ordinary WAV format',async t=>{
  const f=await fixture(t),{r}=await f.record(Buffer.alloc(32000));await f.repo.change(r.id,value=>{delete value.audioBackup.compression;});
  await backupAudioRecord(f.repo,await f.repo.get(r.id));const {folder,files}=await f.files();assert.match(files[0],/\.wav$/);assert.equal((await readFile(join(folder,files[0]))).length,32044);
});

test('backup rename recovers after the directory moved before database acknowledgement',async t=>{
  const f=await fixture(t),{r}=await f.record();await backupAudioRecord(f.repo,r);const {folder}=await f.files(),target=folder.replace('接口_联调','恢复后的标题');
  await f.repo.change(r.id,value=>{value.title='恢复后的标题';value.audioBackup.renameTo=target.split('/').at(-1);});await renameDirectory(folder,target);
  await backupAudioRecord(f.repo,await f.repo.get(r.id));const next=await f.repo.get(r.id);assert.equal(next.audioBackup.folder,target.split('/').at(-1));assert.equal(next.audioBackup.renameTo,undefined);assert.equal(next.audioBackup.status,'saved');
});

test('backup rename never replaces an existing foreign directory',async t=>{
  const f=await fixture(t),{r}=await f.record();await backupAudioRecord(f.repo,r);const {folder,files}=await f.files(),target=folder.replace('接口_联调','名称冲突');await mkdir(target);await writeFile(join(target,'private.txt'),'保留用户文件');
  await f.repo.change(r.id,value=>{value.title='名称冲突';});await backupAudioRecord(f.repo,await f.repo.get(r.id));const next=await f.repo.get(r.id);assert.equal(next.audioBackup.status,'saved');assert.equal(next.audioBackup.error,'audio_backup_rename_failed');assert.equal(await readFile(join(target,'private.txt'),'utf8'),'保留用户文件');assert.ok((await readFile(join(folder,files[0]))).length);
});

test('background reconciliation updates legacy saved folder names even with retention disabled',async t=>{
 const f=await fixture(t),{r}=await f.record();await backupAudioRecord(f.repo,r);const before=await f.repo.get(r.id);await f.repo.change(r.id,row=>{row.title='升级前已改名';});
 await cleanupAudioBackups(f.repo);const after=await f.repo.get(r.id);assert.notEqual(after.audioBackup.folder,before.audioBackup.folder);assert.match(after.audioBackup.folder,/升级前已改名/);assert.equal(after.audioBackup.status,'saved');
});
