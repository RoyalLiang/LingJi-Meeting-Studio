import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRecord, addSource, acknowledge, digest, stopSource, pause, seal, commitTranscriptBatch } from '../packages/records/src/record.mjs';
import { decodeNativeAudioPacket } from '../services/records/src/native-audio.mjs';
function packet(sequence, offset = sequence * 16000, samples = 16000) {
  const bytes = Buffer.alloc(12 + samples * 2, 42); bytes.writeUInt32LE(sequence, 0); bytes.writeUInt32LE(offset, 4); bytes.writeUInt32LE(samples, 8);
  return Buffer.concat([bytes, createHash('sha256').update(bytes).digest()]);
}
const manifest = (source, lastSequence) => ({ sourceId: source.id, sessionId: source.sessionId, epoch: source.epoch, lastSequence });
function accept(record, source, sequence) {
  const { pcm, metadata } = decodeNativeAudioPacket(packet(sequence), sequence);
  return acknowledge(record, { ...metadata, sourceId: source.id, sessionId: source.sessionId, epoch: source.epoch, object: 'test', digest: digest(pcm) });
}

test('shared native wire packets preserve exact PCM and reject size, identity and checksum corruption', () => {
  const raw = packet(3), decoded = decodeNativeAudioPacket(raw, 3); assert.equal(decoded.pcm.length, 32000); assert.equal(decoded.metadata.sampleOffset, 48000); assert.equal(decoded.metadata.sampleCount, 16000); assert.equal(decoded.metadata.digest, digest(raw.subarray(12, raw.length - 32)));
  assert.throws(() => decodeNativeAudioPacket(raw, 4), { code: 'invalid_native_packet' });
  const corrupt = Buffer.from(raw); corrupt[20] ^= 1; assert.throws(() => decodeNativeAudioPacket(corrupt, 3), { code: 'native_packet_corrupt' });
  assert.throws(() => decodeNativeAudioPacket(raw.subarray(1), 3), { code: 'invalid_native_packet' });
  assert.equal(decodeNativeAudioPacket(packet(0, 0, 1), 0).pcm.length, 2);
});

test('per-source stop preserves the other live source, enforces all identities, and remains idempotent', () => {
  const record = createRecord('owner'), mic = addSource(record, { kind: 'microphone' }), display = addSource(record, { kind: 'display' }); accept(record, mic, 0);
  const before = JSON.stringify(record); assert.throws(() => stopSource(record, { ...manifest(mic, 0), sessionId: randomUUID() }), { code: 'audio_session_mismatch' }); assert.equal(JSON.stringify(record), before);
  assert.equal(stopSource(record, manifest(mic, 0)), true); assert.equal(record.capture, 'recording'); assert.equal(display.stopped, false);
  const cursor = record.cursor; assert.equal(stopSource(record, manifest(mic, 0)), false); assert.equal(record.cursor, cursor);
  assert.throws(() => stopSource(record, manifest(mic, 1)), { code: 'manifest_immutable' });
  assert.equal(stopSource(record, manifest(display, -1)), true); assert.equal(record.capture, 'paused');
  pause(record, [manifest(mic, 0), manifest(display, -1)]); seal(record, [manifest(mic, 0), manifest(display, -1)]);
});

test('native produced stop fence permits missing tail repair and cannot precede durable received packets', () => {
  const record = createRecord('owner'), source = addSource(record, { kind: 'microphone' }); accept(record, source, 2);
  assert.throws(() => stopSource(record, manifest(source, 1)), { code: 'manifest_precedes_received_audio' });
  stopSource(record, manifest(source, 2)); assert.equal(source.watermark, -1); accept(record, source, 0); assert.equal(source.watermark, 0); accept(record, source, 1); assert.equal(source.watermark, 2);
  assert.throws(() => accept(record, source, 3), { code: 'outside_sealed_manifest' });
});

async function nativeFixture(work) {
  const { mkdtemp, rm, writeFile, rename } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const { createRepository } = await import('../services/records/src/repository.mjs'), { createNativeAudio } = await import('../services/records/src/native-audio.mjs');
  const root = await mkdtemp(join(tmpdir(), 'lingji-native-node-')), repo = await createRepository({ root, databaseUrl: '', s3: { bucket: '' } }), user = { id: randomUUID(), kind: 'user', authVersion: 0 }; let service;
  try {
    await repo.insert(user); const record = createRecord(user.id, { autoMinutes: false }); await repo.insert(record);
    service = await createNativeAudio(repo, { instanceId: '1'.repeat(32), recoveryIntervalMs: 60000 });
    const bind = async kind => service.bind(user, { recordId: record.id, requestId: randomUUID(), kind, label: kind });
    const publish = async (binding, name, bytes) => { const path = join(service.root, binding.leaseId), temporary = join(path, '.test-' + randomUUID()); await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, join(path, name)); service.wake(binding.leaseId); };
    await work({ repo, user, record, bind, publish, get service() { return service; }, restart: async () => { await service.close(); service = await createNativeAudio(repo, { instanceId: '2'.repeat(32), recoveryIntervalMs: 60000 }); return service; }, root });
  } finally { await service?.close(); await repo.close(); await rm(root, { recursive: true, force: true }); }
}

test('Node consumes native packets through durable indexed ingest before deleting files, with no full-record read on the hot path', async () => nativeFixture(async ({ repo, record, bind, publish, service }) => {
  const { readFile, stat } = await import('node:fs/promises'), { join } = await import('node:path');
  const binding = await bind('microphone'); await service.idle();
  await assert.rejects(stat(join(service.root, binding.leaseId, 'receipt.json')), { code: 'ENOENT' });
  const get = repo.get; repo.get = id => { assert.notEqual(id, record.id, 'normal ingestion must not hydrate history'); return get(id); };
  await publish(binding, '000000.pcm', packet(0)); await service.idle(); repo.get = get;
  const result = await repo.get(record.id); assert.equal(result.chunks.length, 1); assert.equal(result.sources[0].watermark, 0); assert.equal((await repo.readAudio(result.chunks[0].object)).length, 32000);
  await assert.rejects(stat(join(service.root, binding.leaseId, '000000.pcm')), { code: 'ENOENT' });
  const receipt = JSON.parse(await readFile(join(service.root, binding.leaseId, 'receipt.json'))); assert.equal(receipt.watermark, 0); assert.equal(receipt.sampleEnd, 16000); assert.equal(receipt.finished, false);
  await publish(binding, 'stop.json', JSON.stringify({ schema: 1, lastSequence: 0, sampleEnd: 16000, action: 'pause' })); await service.idle();
  assert.equal((await repo.get(record.id)).capture, 'paused'); assert.equal(JSON.parse(await readFile(join(service.root, binding.leaseId, 'receipt.json'))).finished, true);
}));

test('one stopped native source cannot seal an unclosed second source at its watermark', async () => nativeFixture(async ({ repo, record, bind, publish, service }) => {
  const first = await bind('microphone'), second = await bind('display'); await service.idle();
  await publish(first, '000000.pcm', packet(0)); await service.idle();
  await publish(first, 'stop.json', JSON.stringify({ schema: 1, lastSequence: 0, sampleEnd: 16000, action: 'seal' })); await service.idle();
  let current = await repo.get(record.id); assert.equal(current.capture, 'recording'); assert.equal(current.sources.find(source => source.id === second.source.id).lastSequence, null);
  await publish(second, '000000.pcm', packet(0)); await service.idle();
  await publish(second, 'stop.json', JSON.stringify({ schema: 1, lastSequence: 0, sampleEnd: 16000, action: 'seal' })); await service.idle();
  current = await repo.get(record.id); assert.equal(current.capture, 'sealed'); assert.ok(current.sources.every(source => source.lastSequence === 0));
}));

test('native process restart drains retained packets and pauses without restarting physical capture', async () => nativeFixture(async ({ repo, record, bind, publish, service, restart }) => {
  const binding = await bind('microphone'); await service.idle();
  await publish(binding, '000000.pcm', packet(0)); await service.idle(); await service.close();
  await publish(binding, '000001.pcm', packet(1)); const next = await restart(); await next.idle();
  const current = await repo.get(record.id); assert.equal(current.sources[0].lastSequence, 1); assert.equal(current.sources[0].watermark, 1); assert.equal(current.chunks.length, 2); assert.equal(current.capture, 'paused');
}));

test('native corruption and revoked capture grant preserve unacknowledged bytes', async () => nativeFixture(async ({ repo, user, record, bind, publish, service }) => {
  const { stat, readFile } = await import('node:fs/promises'), { join } = await import('node:path');
  const first = await bind('microphone'); await service.idle(); const corrupt = packet(0); corrupt[14] ^= 1;
  await publish(first, '000000.pcm', corrupt); await service.idle();
  assert.equal((await repo.get(record.id)).chunks.length, 0); assert.ok((await stat(join(service.root, first.leaseId, '000000.pcm'))).isFile()); assert.equal(JSON.parse(await readFile(join(service.root, first.leaseId, 'receipt.json'))).error, 'native_packet_corrupt');
  const second = await bind('display'); await service.idle(); await repo.change(user.id, value => { value.authVersion++; });
  await publish(second, '000000.pcm', packet(0)); await service.idle();
  assert.equal((await repo.get(record.id)).chunks.length, 0); assert.ok((await stat(join(service.root, second.leaseId, '000000.pcm'))).isFile()); assert.equal(JSON.parse(await readFile(join(service.root, second.leaseId, 'receipt.json'))).error, 'native_capture_revoked');
}));


test('silence completion advances durable status without invalidating unchanged transcript evidence', () => {
  const record = createRecord('owner'), source = addSource(record, { kind: 'display' });
  accept(record, source, 0); const before = record.transcriptRevision, key = record.chunks[0].key;
  commitTranscriptBatch(record, [key], '', record.generation, 'sensevoice', {provider:'sensevoice-local'});
  assert.equal(record.transcriptRevision, before); assert.equal(record.segments.length, 0); assert.equal(record.chunks[0].state, 'done');
  accept(record, source, 1); commitTranscriptBatch(record, [record.chunks[1].key], '真正的新发言', record.generation, 'sensevoice', {provider:'sensevoice-local'});
  assert.ok(record.transcriptRevision > before);
});


test('paused native sources can seal from a durable control file after renderer loss',async()=>nativeFixture(async({repo,record,bind,publish,service})=>{
  const binding=await bind('display');await publish(binding,'000000.pcm',packet(0));await service.idle();
  await publish(binding,'stop.json',JSON.stringify({schema:1,lastSequence:0,sampleEnd:16000,action:'pause'}));await service.idle();
  assert.equal((await repo.get(record.id)).capture,'paused');
  await publish(binding,'control.json',JSON.stringify({schema:1,action:'seal'}));await service.idle();
  assert.equal((await repo.get(record.id)).capture,'sealed');
  await publish(binding,'control.json',JSON.stringify({schema:1,action:'pause'}));await service.idle();
  assert.equal((await repo.get(record.id)).capture,'sealed');
}));
test('record deletion purges pending native PCM and late producer files without ingesting them',async()=>nativeFixture(async({repo,record,bind,publish,service})=>{
  const {stat}=await import('node:fs/promises'),{join}=await import('node:path');const binding=await bind('display');
  await repo.change(record.id,current=>{current.deleted=true;});await service.idle();
  await publish(binding,'000000.pcm',packet(0));await service.idle();
  await assert.rejects(stat(join(service.root,binding.leaseId,'000000.pcm')),{code:'ENOENT'});
  assert.equal((await repo.get(record.id)).chunks.length,0);
  assert.equal((await repo.get('native-capture:'+binding.leaseId)).state,'purged');
}));
test('failed native device binding can compensate its empty allocated source',async()=>nativeFixture(async({repo,user,record,bind,service})=>{
  const binding=await bind('microphone');await service.cancel(user,{leaseId:binding.leaseId});
  const current=await repo.get(record.id);assert.equal(current.sources[0].lastSequence,-1);assert.equal(current.sources[0].stopped,true);assert.equal(current.capture,'paused');
}));


test('blocked raw PCM is purged by deletion notifications without manual native wake',async()=>nativeFixture(async({repo,record,bind,publish,service})=>{
  const {stat}=await import('node:fs/promises'),{join}=await import('node:path');const binding=await bind('display');const corrupt=packet(0);corrupt[20]^=1;
  await publish(binding,'000000.pcm',corrupt);await service.idle();assert.equal((await repo.get('native-capture:'+binding.leaseId)).state,'blocked');
  await repo.change(record.id,current=>{current.deleted=true;return{deleted:true};});await new Promise(resolve=>setImmediate(resolve));await service.idle();
  await assert.rejects(stat(join(service.root,binding.leaseId,'000000.pcm')),{code:'ENOENT'});
}));
test('SQLite changes from a separate repository invalidate blocked native leases and purge deleted audio',async()=>nativeFixture(async({repo,root,record,bind,publish,service})=>{
  const {createRepository}=await import('../services/records/src/repository.mjs');const other=await createRepository({root,databaseUrl:'',s3:{bucket:''}});
  try{const binding=await bind('display');const corrupt=packet(0);corrupt[20]^=1;await publish(binding,'000000.pcm',corrupt);await service.idle();
    await other.change(record.id,current=>{current.deleted=true;return{deleted:true};});
    const started=Date.now();while((await repo.get('native-capture:'+binding.leaseId)).state!=='purged'){assert.ok(Date.now()-started<4000);await new Promise(resolve=>setTimeout(resolve,50));}
    assert.equal((await repo.get(record.id)).chunks.length,0);
  }finally{await other.close();}
}));
test('cancellation by request fences both future bind and already allocated empty sources',async()=>nativeFixture(async({user,record,service})=>{
  const first={recordId:record.id,requestId:randomUUID(),kind:'display',label:'synthetic'};
  await service.cancel(user,first);await assert.rejects(service.bind(user,first),{code:'native_capture_conflict'});
  const second={...first,requestId:randomUUID()};await service.bind(user,second);await service.cancel(user,second);await service.cancel(user,second);
}));


test('native binding HTTP is local-instance and CSRF scoped and allocates one source idempotently',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os');
  const {createRecordServer}=await import('../services/records/src/server.mjs');const root=await mkdtemp(join(tmpdir(),'native-api-'));
  const instance='4'.repeat(32),app=await createRecordServer({root,databaseUrl:'',s3:{bucket:''},localAccount:true,nativeInstance:instance,port:0});
  try{const address=await app.start(),base=`http://127.0.0.1:${address.port}`,cookie=(await app.localSession()).split(';')[0];
    const boot=await(await fetch(base+'/api/bootstrap',{headers:{cookie}})).json();assert.equal(boot.nativeAudioTransport,'native-file-v1');
    const headers={cookie,'content-type':'application/json','x-csrf-token':boot.csrf};
    const record=await(await fetch(base+'/api/records',{method:'POST',headers,body:JSON.stringify({title:'synthetic native binding',autoMinutes:false})})).json();
    const input={recordId:record.id,requestId:randomUUID(),kind:'display',label:'synthetic'};
    assert.equal((await fetch(base+'/api/client/native-captures',{method:'POST',headers,body:JSON.stringify(input)})).status,404);
    const privileged={...headers,'x-native-instance':instance};
    const first=await(await fetch(base+'/api/client/native-captures',{method:'POST',headers:privileged,body:JSON.stringify(input)})).json();
    assert.equal(first.protocol,'native-file-v1');assert.equal(first.source.captureTransport,'native-file-v1');
    const second=await(await fetch(base+'/api/client/native-captures',{method:'POST',headers:privileged,body:JSON.stringify(input)})).json();assert.equal(second.source.id,first.source.id);
    assert.equal((await app.repo.get(record.id)).sources.length,1);
    const bad={...privileged,'x-csrf-token':'wrong'};assert.equal((await fetch(base+'/api/client/native-captures',{method:'POST',headers:bad,body:JSON.stringify(input)})).status,403);
    const invalid=await fetch(base+`/api/records/${record.id}/seal`,{method:'POST',headers,body:JSON.stringify({sources:[{sourceId:first.source.id,epoch:first.source.epoch,lastSequence:-1}]})});assert.equal(invalid.status,400);
    const cancelled=await fetch(base+'/api/client/native-captures',{method:'POST',headers:privileged,body:JSON.stringify({action:'cancel',leaseId:first.leaseId})});assert.equal(cancelled.status,200);
    assert.equal((await app.repo.get(record.id)).capture,'paused');
  }finally{await app.stop();await rm(root,{recursive:true,force:true});}
});


test('abandoned empty native bind is reclaimed after its producer never attaches',async()=>nativeFixture(async({repo,record,bind,service})=>{
  const binding=await bind('display');await repo.change('native-capture:'+binding.leaseId,current=>{current.createdAt=new Date(Date.now()-61000).toISOString();});
  service.wake(binding.leaseId);await service.idle();assert.equal((await repo.get(record.id)).capture,'paused');assert.equal((await repo.get(record.id)).sources[0].lastSequence,-1);
}));


test('deleted native audio becomes terminal only after producer stop and physical raw cleanup',async()=>nativeFixture(async({repo,record,bind,publish,service})=>{
  const {writeFile,readFile,stat}=await import('node:fs/promises'),{join}=await import('node:path');const binding=await bind('display'),directory=join(service.root,binding.leaseId);
  await writeFile(join(directory,'producer.lock'),'native-pcm-v1');
  await repo.change(record.id,current=>{current.deleted=true;return{deleted:true};});await new Promise(resolve=>setImmediate(resolve));await service.idle();
  let receipt=JSON.parse(await readFile(join(directory,'receipt.json')));assert.equal(receipt.purged,undefined);assert.equal((await repo.get('native-capture:'+binding.leaseId)).state,'purging');
  await publish(binding,'000000.pcm',packet(0));await service.idle();await assert.rejects(stat(join(directory,'000000.pcm')),{code:'ENOENT'});
  await publish(binding,'stop.json',JSON.stringify({schema:1,lastSequence:0,sampleEnd:16000,action:'source'}));await service.idle();
  receipt=JSON.parse(await readFile(join(directory,'receipt.json')));assert.equal(receipt.purged,true);assert.equal(receipt.finished,false);assert.equal(receipt.error,'record_expired');assert.equal((await repo.get('native-capture:'+binding.leaseId)).state,'purged');
}));
