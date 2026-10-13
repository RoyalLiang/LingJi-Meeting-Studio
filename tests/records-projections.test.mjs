import {encodeStorage,decodeStorage} from '../services/records/src/storage-codec.mjs';
import {recoverTemporaryAudio,recoverLocalWork} from '../services/records/src/desktop-backend.mjs';
import {createAuth} from '../services/records/src/auth.mjs';
import { webcrypto } from 'node:crypto';
import { createRecordServer } from '../services/records/src/server.mjs';
import { digest } from '../packages/records/src/record.mjs';
import { runCycle } from '../services/records/src/worker.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,mkdir,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord,emit,publicRecord} from '../packages/records/src/record.mjs';
import {DatabaseSync} from 'node:sqlite';
const js=stripTypeScriptTypes(await readFile(new URL('../apps/web/src/record-subscription.ts',import.meta.url),'utf8')).replaceAll('export function','function')+'\nexports.apply=applyRecordDelta;';
const exported={};vm.runInNewContext(js,{exports:exported});
test('owned client restart recovers stream and workspace leases; local session lasts only its backend generation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'client-recover-'));const repo=await createRepository({root});
  try {
    const record=createRecord('owner',{});record.sources.push({id:'source',asr:{state:'running',lease:Date.now()+90000,fence:'old',attempts:2}});
    record.capture='recording';record.jobs.push({id:'job',status:'running',lease:Date.now()+150000,fence:'old'});
    await repo.insert(record);await repo.insert({id:'analysis-test',kind:'workspace-analysis',status:'running',lease:Date.now()+150000,fence:'old'});
    const audio=join(root,'audio',record.id);await mkdir(audio,{recursive:true});
    const temporary=join(audio,'.tmp-00000000-0000-0000-0000-000000000000');await writeFile(temporary,'uncommitted');
    const protectedFile=join(audio,'unrelated');await writeFile(protectedFile,'keep');
    const pending=join(root,'audio','.pending','.tmp-00000000-0000-0000-0000-000000000000');await writeFile(pending,'uncommitted');
    await recoverTemporaryAudio(root);await assert.rejects(stat(pending),{code:'ENOENT'});await assert.rejects(stat(temporary),{code:'ENOENT'});assert.equal(await readFile(protectedFile,'utf8'),'keep');
    await recoverLocalWork(repo);const restored=await repo.get(record.id);
    assert.equal(restored.capture,'recording','do not seal before the durable WebView queue recovers');
    assert.equal(restored.sources[0].asr.lease,undefined);assert.equal(restored.sources[0].asr.fence,undefined);assert.equal(restored.sources[0].asr.attempts,2);
    assert.equal(restored.jobs[0].status,'queued');assert.equal((await repo.get('analysis-test')).status,'queued');
    const auth=await createAuth(repo,{localAccount:true});const cookie=(await auth.localSession()).split(';')[0];
    assert.ok(!(await auth.localSession()).includes('Max-Age='));
    const token=JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0],'base64url').toString());assert.equal(token.expires,null);
    assert.equal((await auth.user({headers:{cookie}})).email,'local@device.invalid');
    const restartedAuth=await createAuth(repo,{localAccount:true});await assert.rejects(restartedAuth.user({headers:{cookie}}),{code:'login_required'});
  } finally {await repo.close();await rm(root,{recursive:true,force:true});}
});
test('transactional projection deltas, rollback, lightweight listing and derived feed rebuild',async()=>{
  const root=await mkdtemp(join(tmpdir(),'record-projection-'));let repo=await createRepository({root});
  try{
    const record=createRecord('owner',{title:'Projection',language:'zh'});await repo.insert(record);
    const original=publicRecord(await repo.get(record.id));
    await repo.change(record.id,r=>{r.segments.push({id:'segment-1',text:'SECRET_TRANSCRIPT',revision:1,startMs:0,endMs:10});r.transcriptRevision++;emit(r,'transcript.updated',{});});
    const feed=await repo.eventsAfter(record.id,original.cursor);assert.equal(feed.events.length,1);
    const delta=feed.events[0].delta;assert.equal(delta.segments.upsert.length,1);assert.ok(!delta.set.sources);
    const applied=exported.apply(original,delta);assert.deepEqual(JSON.parse(JSON.stringify(applied)),publicRecord(await repo.get(record.id)));
    assert.equal(exported.apply(applied,delta),applied);assert.equal(exported.apply({...original,cursor:'999'},delta).cursor,'999');
    assert.equal(exported.apply({...original,cursor:'0'},delta),null);
    await assert.rejects(repo.change(record.id,r=>{r.title='WRONG';emit(r,'changed',{});throw new Error('rollback');}));
    const summary=await repo.listSummaries('owner','all','secret_transcript');assert.equal(summary[0].title,'Projection');assert.ok(!JSON.stringify(summary).includes('SECRET_TRANSCRIPT'));assert.equal((await repo.listSummaries('other')).length,0);
    assert.equal((await repo.eventsAfter(record.id,original.cursor)).cursor,feed.cursor);
    await repo.close();const db=new DatabaseSync(join(root,'records.sqlite'));db.exec('DELETE FROM record_feed_meta; DELETE FROM record_feed_events; DELETE FROM record_list_projection');db.close();
    repo=await createRepository({root});assert.equal((await repo.eventsAfter(record.id,'0')).events.length,2);assert.equal((await repo.listSummaries('owner')).length,1);
    await repo.change(record.id,r=>{r.deleted=true;emit(r,'record.deleted',{});});const deletedFeed=await repo.eventsAfter(record.id,'0');assert.equal(deletedFeed.deleted,true);assert.equal(deletedFeed.events.length,0);assert.ok(!JSON.stringify(deletedFeed).includes('SECRET_TRANSCRIPT'));assert.equal((await repo.listSummaries('owner')).length,0);
  }finally{await repo.close();await rm(root,{recursive:true,force:true});}
});

for(const deltaEnabled of [true,false])test(`SSE ${deltaEnabled?'delta':'rollback'} resets cursors and revokes logged-out access`,async()=>{
  const {createRecordServer}=await import('../services/records/src/server.mjs');
  const root=await mkdtemp(join(tmpdir(),'record-feed-http-'));const repo=await createRepository({root});const app=await createRecordServer({repo,port:0,deltaEnabled});const address=await app.start(),base=`http://127.0.0.1:${address.port}`;
  const abort=new AbortController();let reader;
  try{
    const response=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'feed@example.com',password:'long-password'})});const user=await response.json(),headers={Cookie:response.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':user.csrf};
    const created=await fetch(base+'/api/records',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'});const record=await created.json();let reads=0;const original=repo.get;repo.get=async id=>{if(id===record.id)reads++;return original(id);};
    const stream=await fetch(`${base}/api/records/${record.id}/events?after=999`,{headers,signal:abort.signal});reader=stream.body.getReader();let text='';
    async function until(pattern){const deadline=Date.now()+3000;while(!pattern.test(text)){assert.ok(Date.now()<deadline,'stream timeout');const part=await reader.read();assert.equal(part.done,false);text+=new TextDecoder().decode(part.value);}text='';}
    await until(/event: reset/);const initialReads=reads;
    await repo.change(record.id,r=>{r.title='Delta title';emit(r,'record.updated',{});});await until(deltaEnabled ? /"delta"/ : /"type":"record.updated"/);if(deltaEnabled)assert.equal(reads,initialReads,'SSE polling must not decode aggregate');else assert.ok(reads>initialReads);
    await fetch(base+'/api/auth/logout',{method:'POST',headers});await until(/event: revoked/);
  }finally{abort.abort();await reader?.cancel().catch(()=>{});await app.stop();await rm(root,{recursive:true,force:true});}
});

test('binary audio negotiates explicitly, preserves CSRF and identity, and falls back for older APIs', async () => {
  const source = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/api.ts', import.meta.url), 'utf8'), { mode: 'transform' }).replace(/^import .*$/gm, '').replace(/export /g, '');
  const requests = [], exports = {};
  vm.runInNewContext(source + '\nObject.assign(exports,{uploadAudio,setAudioTransport,setCsrf});', {
    exports, crypto: webcrypto, performance, Uint8Array, atob, trace() {},
    fetch: async (url, options) => { requests.push({ url, ...options }); return { ok: true, json: async () => ({ watermark: 0 }) }; },
  });
  const bytes = Buffer.alloc(32000, 21), chunk = { sourceId: 'source', epoch: 'epoch', sessionId: 'session', sequence: 0, sampleOffset: 0, sampleCount: 16000, sampleRate: 16000, digest: digest(bytes), pcm: bytes.toString('base64') };
  exports.setCsrf('isolated-csrf');
  await exports.uploadAudio('/records/test/audio', chunk);
  assert.deepEqual(JSON.parse(requests[0].body), chunk);
  exports.setAudioTransport('pcm-v1');
  await exports.uploadAudio('/records/test/audio', chunk);
  const binary = requests[1];
  assert.deepEqual(Buffer.from(binary.body), bytes);
  assert.equal(binary.headers['X-CSRF-Token'], 'isolated-csrf');
  assert.equal(binary.credentials, 'same-origin');
  assert.equal(binary.headers['Content-Type'], 'application/octet-stream');
  const { pcm: _pcm, ...metadata } = chunk;
  assert.deepEqual(JSON.parse(binary.headers['X-Record-Audio']), metadata);
  assert.ok(binary.body.length + Buffer.byteLength(binary.headers['X-Record-Audio']) < Buffer.byteLength(requests[0].body) * 0.76);
  exports.setAudioTransport();
  await exports.uploadAudio('/records/test/audio', chunk);
  assert.equal(requests[2].body, requests[0].body);
});

test('PCM and JSON share durable receipts, duplicate detection, pause and final draining', async () => {
  const root = await mkdtemp(join(tmpdir(), 'record-pcm-'));
  const repo = await createRepository({ root, databaseUrl: '' });
  const app = await createRecordServer({ repo, port: 0 });
  try {
    const address = await app.start(), base = `http://127.0.0.1:${address.port}`;
    const registered = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'pcm@example.test', password: 'isolated-pcm-password' }) });
    const user = await registered.json();
    const headers = { Cookie: registered.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': user.csrf };
    const json = async (path, body) => {
      const response = await fetch(base + path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.ok(response.ok, await response.clone().text()); return response.json();
    };
    const bootstrap = await fetch(`${base}/api/bootstrap`, { headers });
    assert.equal((await bootstrap.json()).audioTransport, 'pcm-v1');
    const record = await json('/api/records', {});
    const source = await json(`/api/records/${record.id}/sources`, { kind: 'microphone' });
    const bytes = Buffer.alloc(32000, 21);
    const chunk = { sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, sequence: 0, sampleOffset: 0, sampleCount: 16000, sampleRate: 16000, digest: digest(bytes) };
    const raw = metadata => fetch(`${base}/api/records/${record.id}/audio`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Record-Audio': typeof metadata === 'string' ? metadata : JSON.stringify(metadata) }, body: bytes });
    const first = await json(`/api/records/${record.id}/audio`, { ...chunk, pcm: bytes.toString('base64') });
    const duplicate = await raw(chunk); assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), first);
    const next = await raw({ ...chunk, sequence: 1, sampleOffset: 16000 }); assert.equal(next.status, 200);
    assert.equal((await next.json()).watermark, 1);
    assert.equal((await raw({ ...chunk, digest: 'a'.repeat(64) })).status, 400);
    assert.equal((await raw({ ...chunk, sampleCount: 100 })).status, 400);
    assert.equal((await raw({ ...chunk, sessionId: 'wrong-session' })).status, 400);
    for (const metadata of ['null', '[]', 'broken-json']) assert.equal((await raw(metadata)).status, 400);
    assert.equal((await repo.get(record.id)).chunks.length, 2);
    const manifest = [{ sourceId: source.id, epoch: source.epoch, lastSequence: 1 }];
    await json(`/api/records/${record.id}/pause`, { sources: manifest });
    assert.equal((await repo.get(record.id)).capture, 'paused');
    await json(`/api/records/${record.id}/seal`, { sources: manifest });
    for (let i = 0; i < 3; i++) await runCycle(repo, { transcribe: async () => 'Synthetic recognized speech' });
    const completed = await repo.get(record.id);
    assert.equal(completed.capture, 'completed');
    assert.equal(completed.chunks.filter(chunk => chunk.state === 'done').length, 2);
  } finally { await app.stop(); await rm(root, { recursive: true, force: true }); }
});


test('lossless storage validates hashes, bounded expansion, noise fallback and legacy PCM',()=>{
  const bytes=Buffer.from('无损存储与版本校验'.repeat(2000)),packed=encodeStorage(bytes);
  assert.equal(packed.compressed,true);assert.ok(packed.bytes.length<bytes.length/5);assert.deepEqual(decodeStorage(packed.bytes),bytes);
  const corrupt=Buffer.from(packed.bytes);corrupt[9]^=1;assert.throws(()=>decodeStorage(corrupt),e=>e.code==='storage_corrupt');
  const bomb=Buffer.from(packed.bytes);bomb.writeUInt32BE(100*1024*1024,5);assert.throws(()=>decodeStorage(bomb),e=>e.code==='storage_corrupt');
  const legacy=Buffer.from('LJZ1 legacy PCM');assert.deepEqual(decodeStorage(legacy,digest(legacy)),legacy);
  let seed=1;const noise=Buffer.alloc(32000);for(let i=0;i<noise.length;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;noise[i]=seed&255;}
  const random=encodeStorage(noise);assert.equal(random.compressed,false);assert.deepEqual(decodeStorage(random.bytes,digest(noise)),noise);
});

test('compressed SQLite payloads and PCM preserve atomic rollback, projections and restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'client-compressed-'));let repo=await createRepository({root,compressAggregates:true,compressAudio:true});
  try{
    const record=createRecord('owner',{title:'Local storage',retainAudio:true});record.notes='Synthetic local notes '.repeat(4000);record.gcAt=Date.now();
    await repo.insert(record);const initial=await repo.get(record.id),audio=Buffer.alloc(32000,0);
    const object=await repo.putAudio(record.id,audio);assert.deepEqual(await repo.readAudio(object.object),audio);
    assert.deepEqual(await repo.putAudio(record.id,audio),object);
    const plainPath=join(root,'audio',object.object);assert.ok((await readFile(plainPath)).length<audio.length/5);
    await assert.rejects(repo.change(record.id,r=>{r.notes='should roll back';emit(r,'notes.changed');throw new Error('abort');}));
    assert.deepEqual(await repo.get(record.id),initial);
    await repo.change(record.id,r=>{r.notes+=' confirmed';emit(r,'notes.changed');});const latest=await repo.get(record.id);
    assert.equal((await repo.eventsAfter(record.id,initial.cursor)).events.length,1);
    assert.equal((await repo.listSummaries('owner')).length,1);
    await repo.close();const db=new DatabaseSync(join(root,'records.sqlite'));
    const metadata=JSON.parse(db.prepare('SELECT data FROM aggregates WHERE id=?').get(record.id).data);
    assert.equal(metadata.$payload,'deflate-v1');assert.ok(db.prepare('SELECT length(payload) size FROM aggregate_payloads WHERE id=?').get(record.id).size<Buffer.byteLength(JSON.stringify(latest))/5);db.close();
    repo=await createRepository({root});assert.deepEqual(await repo.get(record.id),latest);assert.deepEqual(await repo.readAudio(object.object),audio);
    await repo.change(record.id,r=>{r.title='Plain-compatible write';emit(r,'record.changed');});assert.equal((await repo.get(record.id)).title,'Plain-compatible write');
    await repo.close();repo=await createRepository({root,compressAggregates:true});assert.equal((await repo.get(record.id)).title,'Plain-compatible write');
  }finally{await repo.close();await rm(root,{recursive:true,force:true});}
});
