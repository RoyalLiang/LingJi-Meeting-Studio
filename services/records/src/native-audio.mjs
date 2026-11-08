import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { requireThat } from '../../../packages/records/src/record.mjs';

export function decodeNativeAudioPacket(bytes, expectedSequence) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length >= 46 && bytes.length <= 32044, 'invalid_native_packet', 400);
  const sequence = bytes.readUInt32LE(0), sampleOffset = bytes.readUInt32LE(4), sampleCount = bytes.readUInt32LE(8);
  requireThat(sequence < 1000000 && sequence === expectedSequence && sampleCount >= 1 && sampleCount <= 16000 && bytes.length === 12 + sampleCount * 2 + 32, 'invalid_native_packet', 400);
  const packet = bytes.subarray(0, bytes.length - 32), checksum = createHash('sha256').update(packet).digest();
  requireThat(timingSafeEqual(checksum, bytes.subarray(bytes.length - 32)), 'native_packet_corrupt', 409);
  const pcm = packet.subarray(12);
  return { pcm, metadata: { sequence, sampleOffset, sampleCount, sampleRate: 16000, digest: createHash('sha256').update(pcm).digest('hex') } };
}

import { mkdir, lstat, open, readdir, rename, unlink, rm } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { addSource, stopSource, pause, seal, publicSources, digest } from '../../../packages/records/src/record.mjs';
import { flushAudioObject } from './audio-storage-sync.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const packetName = /^([0-9]{6})\.pcm$/;
async function boundedFile(path, maximum) {
  const stat = await lstat(path); requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum, 'invalid_native_packet', 400);
  const handle = await open(path, 'r');
  try { const bytes = Buffer.alloc(maximum + 1); let count = 0; while (count < bytes.length) { const { bytesRead } = await handle.read(bytes, count, bytes.length - count); if (!bytesRead) break; count += bytesRead; } requireThat(count <= maximum, 'invalid_native_packet', 400); return bytes.subarray(0, count); }
  finally { await handle.close(); }
}
async function atomicNativeJson(directory, name, value) {
  const temporary = join(directory, '.json-' + randomUUID()), destination = join(directory, name);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, destination); await flushAudioObject(destination, directory);
  } finally { await handle?.close(); await rm(temporary, { force: true }); }
}

export async function createNativeAudio(repo, { instanceId, recoveryIntervalMs = 10000 } = {}) {
  requireThat(typeof instanceId === 'string' && /^[a-f0-9]{32}$/.test(instanceId), 'native_capture_unavailable', 503);
  const root = join(repo.root, 'audio', 'native'); await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root); requireThat(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'native_capture_unavailable', 503);
  const pending = new Set(), working = new Map(), again = new Set(), active = new Set(), prepared = new Set(), recordsToLeases = new Map(); let closing = false, timer;
  const idFor = token => 'native-capture:' + token;
  const directoryFor = lease => { requireThat(/^[a-f0-9]{64}$/.test(lease.token) && lease.id === idFor(lease.token), 'native_capture_unavailable', 503); return join(root, lease.token); };
  const leaseWatchers = new Map();
  function watchLease(lease) {
    if (leaseWatchers.has(lease.token)) return;
    try {
      const handle = watch(directoryFor(lease), (_event, name) => {
        if (!name || packetName.test(String(name)) || name === 'stop.json' || name === 'control.json') wake(lease.token);
      });
      handle.on('error', () => { handle.close(); leaseWatchers.delete(lease.token); });
      handle.unref(); leaseWatchers.set(lease.token, handle);
    } catch { /* Active leases also have a recovery poll. */ }
  }
  async function actor(lease) {
    const user = await repo.get(lease.owner);
    requireThat(user?.kind === 'user' && (user.authVersion || 0) === lease.authVersion, 'native_capture_revoked', 403);
  }
  async function sourceRecord(lease) {
    const record = await repo.get(lease.recordId);
    requireThat(record?.kind === 'record' && record.owner === lease.owner, 'native_capture_unavailable', 404);
    requireThat(!record.deleted && Date.parse(record.deleteAt) > Date.now(), 'record_expired', 410);
    const source = record.sources.find(source => source.id === lease.sourceId && source.epoch === lease.epoch && source.sessionId === lease.sessionId);
    requireThat(source, 'native_capture_unavailable', 409); return { record, source };
  }
  async function receipt(lease, finished = false, error = null, purged = false) {
    await atomicNativeJson(directoryFor(lease), 'receipt.json', { schema: 1, leaseId: lease.token, watermark: lease.watermark ?? -1, sampleEnd: lease.acceptedSampleEnd || 0, finished, error, ...(purged ? {purged:true} : {}) });
  }
  async function finishSource(lease, stop) {
    requireThat(stop && stop.schema === 1 && Number.isSafeInteger(stop.lastSequence) && stop.lastSequence >= -1 && stop.lastSequence < 1000000 && Number.isSafeInteger(stop.sampleEnd) && stop.sampleEnd >= 0 && ['source','pause','seal'].includes(stop.action), 'invalid_manifest', 400);
    requireThat(stop.lastSequence >= (lease.watermark ?? -1) && (stop.lastSequence === -1 ? stop.sampleEnd === 0 : stop.sampleEnd >= stop.lastSequence + 1 && stop.sampleEnd <= (stop.lastSequence + 1) * 16000), 'invalid_manifest', 400);
    let expectedEnd = lease.acceptedSampleEnd || 0;
    if (stop.lastSequence > (lease.watermark ?? -1)) {
      try {
        const last = decodeNativeAudioPacket(await boundedFile(join(directoryFor(lease), String(stop.lastSequence).padStart(6, '0') + '.pcm'), 32044), stop.lastSequence);
        expectedEnd = last.metadata.sampleOffset + last.metadata.sampleCount;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const { record } = await sourceRecord(lease), chunk = record.chunks.find(chunk => chunk.sourceId === lease.sourceId && chunk.epoch === lease.epoch && chunk.sequence === stop.lastSequence);
        requireThat(chunk, 'native_packet_missing', 409); expectedEnd = chunk.sampleOffset + chunk.sampleCount;
      }
    }
    requireThat(stop.sampleEnd === expectedEnd, 'native_stop_conflict', 409);
    await repo.change(lease.recordId, record => {
      requireThat(record.owner === lease.owner && !record.deleted && Date.parse(record.deleteAt) > Date.now(), 'record_expired', 410);
      stopSource(record, { sourceId: lease.sourceId, sessionId: lease.sessionId, epoch: lease.epoch, lastSequence: stop.lastSequence });
    }, { returnRecord: false });
    await repo.change(lease.id, current => { current.stop = stop; }, { returnRecord: false });
    lease.stop = stop;
    for (const token of recordsToLeases.get(lease.recordId) || []) if (token !== lease.token) wake(token);
  }
  async function completeAction(lease) {
    if (!lease.stop || lease.watermark !== lease.stop.lastSequence) return false;
    requireThat((lease.acceptedSampleEnd || 0) === lease.stop.sampleEnd, 'native_stop_conflict', 409);
    if (lease.stop.action !== 'source') { const applied = await repo.change(lease.recordId, record => {
      requireThat(record.owner === lease.owner && !record.deleted && Date.parse(record.deleteAt) > Date.now(), 'record_expired', 410);
      if (!record.sources.every(source => source.stopped)) return false;
      const manifests = record.sources.map(source => ({ sourceId: source.id, sessionId: source.sessionId, epoch: source.epoch, lastSequence: source.lastSequence ?? source.watermark }));
      if (lease.stop.action === 'seal') seal(record, manifests); else if (['recording','paused'].includes(record.capture)) pause(record, manifests);
      return true;
    }, { returnRecord: false }); if (!applied) return false; }
    await repo.change(lease.id, current => { current.state = 'done'; current.error = null; }, { returnRecord: false });
    await receipt(lease, true); if (lease.stop.action === 'seal') { active.delete(lease.token); leaseWatchers.get(lease.token)?.close(); leaseWatchers.delete(lease.token); } else active.add(lease.token); return true;
  }
  async function recover(lease, files) {
    if (lease.instanceId === instanceId || lease.stop) return;
    const { record, source } = await sourceRecord(lease);
    let last = source.lastSequence ?? -1, sampleEnd = lease.acceptedSampleEnd || 0;
    for (const chunk of record.chunks) if (chunk.sourceId === source.id && chunk.epoch === source.epoch && chunk.sequence >= last) { last = chunk.sequence; sampleEnd = chunk.sampleOffset + chunk.sampleCount; }
    const final = files.at(-1);
    if (final && final.sequence >= last) { const value = decodeNativeAudioPacket(await boundedFile(join(directoryFor(lease), final.name), 32044), final.sequence); last = final.sequence; sampleEnd = value.metadata.sampleOffset + value.metadata.sampleCount; }
    await finishSource(lease, { schema: 1, lastSequence: last, sampleEnd, action: 'pause' });
  }
  async function purgeRaw(lease) {
    await receipt(lease, false, 'record_expired');
    for (const name of await readdir(directoryFor(lease))) if (packetName.test(name) || name.startsWith('.pcm-')) await rm(join(directoryFor(lease), name), { force: true });
    await repo.change(lease.id, current => { current.state = 'purging'; current.error = 'record_expired'; }, { returnRecord: false });
  }
  async function applyControl(lease) {
    let control;
    try { control = JSON.parse((await boundedFile(join(directoryFor(lease), 'control.json'), 2048)).toString()); }
    catch (error) { if (error.code === 'ENOENT') return lease; requireThat(false, 'invalid_manifest', 400); }
    requireThat(control?.schema === 1 && ['pause','seal'].includes(control.action), 'invalid_manifest', 400);
    if (lease.stop && lease.stop.action !== 'seal' && lease.stop.action !== control.action) {
      await repo.change(lease.id, current => { current.stop.action = control.action; current.state = 'draining'; }, { returnRecord: false });
      return repo.get(lease.id);
    }
    return lease;
  }
  async function processLease(token) {
    let lease = await repo.get(idFor(token)); if (!lease || lease.kind !== 'native-capture' || !lease.sourceId) { active.delete(token); return; }
    try {
      lease = await applyControl(lease);
      const [access] = await repo.getRecordAccess([lease.recordId]);
      if (['purging','purged'].includes(lease.state) || !access || access.deleted || Date.parse(access.deleteAt) <= Date.now()) {
        watchLease(lease); await purgeRaw(lease);
        const stopped = await lstat(join(directoryFor(lease), 'stop.json')).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; });
        const attached = await lstat(join(directoryFor(lease), 'producer.lock')).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; });
        if (stopped || lease.instanceId !== instanceId || !attached) {
          await repo.change(lease.id, current => { current.state='purged'; }, {returnRecord:false}); await receipt(lease, false, 'record_expired', true);
          active.delete(token); leaseWatchers.get(token)?.close(); leaseWatchers.delete(token);
        } else active.add(token);
        return;
      }
      if (lease.state === 'done') {
        if (['sealed','completed'].includes(access.capture) || lease.instanceId !== instanceId) { active.delete(token); leaseWatchers.get(token)?.close(); leaseWatchers.delete(token); }
        else { watchLease(lease); active.add(token); }
        return;
      }
      await actor(lease); active.add(token);
      const directory = directoryFor(lease); watchLease(lease);
      if (!prepared.has(token)) {
        const entries = await readdir(directory), files = entries.flatMap(name => { const match = packetName.exec(name); return match ? [{ name, sequence: Number(match[1]) }] : []; }).sort((a, b) => a.sequence - b.sequence);
        for (const file of files) if (file.sequence <= (lease.watermark ?? -1)) await unlink(join(directory, file.name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (!lease.stop && entries.includes('stop.json')) {
          let stop; try { stop = JSON.parse((await boundedFile(join(directory, 'stop.json'), 2048)).toString()); } catch (error) { requireThat(error.code === 'ENOENT', 'invalid_manifest', 400); }
          if (stop) await finishSource(lease, stop);
        }
        await recover(lease, files.filter(file => file.sequence > (lease.watermark ?? -1))); prepared.add(token);
      }
      if (!lease.stop && (lease.watermark ?? -1) === -1 && Date.parse(lease.createdAt) + 60000 <= Date.now()) {
        const attached = await lstat(join(directory, 'producer.lock')).then(stat => stat.isFile() && !stat.isSymbolicLink(), error => { if (error.code !== 'ENOENT') throw error; return false; });
        if (!attached) await finishSource(lease, { schema:1,lastSequence:-1,sampleEnd:0,action:'source' });
      }
      if (!lease.stop) {
        let stop; try { stop = JSON.parse((await boundedFile(join(directory, 'stop.json'), 2048)).toString()); } catch (error) { requireThat(error.code === 'ENOENT', 'invalid_manifest', 400); }
        if (stop) await finishSource(lease, stop);
      }
      if ((lease.watermark ?? -1) >= 0) await unlink(join(directory, String(lease.watermark).padStart(6, '0') + '.pcm')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      let processed = 0;
      lease = await applyControl(lease);
      for (; processed < 16; processed++) {
        if (closing) return;
        const sequence = (lease.watermark ?? -1) + 1, path = join(directory, String(sequence).padStart(6, '0') + '.pcm'); let bytes;
        try { bytes = await boundedFile(path, 32044); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const current = await repo.get(lease.id);
          if ((current.watermark ?? -1) > (lease.watermark ?? -1)) { lease = current; continue; }
          if (!lease.stop || sequence > lease.stop.lastSequence) break;
          const { record } = await sourceRecord(lease), chunk = record.chunks.find(chunk => chunk.sourceId === lease.sourceId && chunk.epoch === lease.epoch && chunk.sequence === sequence);
          requireThat(chunk, 'native_packet_missing', 409);
          await repo.change(lease.id, current => { current.watermark = sequence; current.acceptedSampleEnd = chunk.sampleOffset + chunk.sampleCount; }, { returnRecord: false });
          lease = await repo.get(lease.id); await receipt(lease); continue;
        }
        await actor(lease);
        const value = decodeNativeAudioPacket(bytes, sequence);
        const ack = await repo.ingestAudio(lease.owner, lease.recordId, { ...value.metadata, sourceId: lease.sourceId, sessionId: lease.sessionId, epoch: lease.epoch }, value.pcm);
        requireThat(ack.durable === true && ack.sourceId === lease.sourceId && ack.epoch === lease.epoch && ack.watermark >= sequence, 'native_ack_invalid', 409);
        await repo.change(lease.id, current => { current.watermark = sequence; current.acceptedSampleEnd = value.metadata.sampleOffset + value.metadata.sampleCount; current.error = null; current.warning = null; current.state = current.stop ? 'draining' : 'recording'; }, { returnRecord: false });
        lease = await repo.get(lease.id); await unlink(path); await receipt(lease);
      }
      if (processed === 16) again.add(token);
      if (!await completeAction(lease) && ((lease.watermark ?? -1) >= 0 || lease.stop || lease.error)) await receipt(lease, false, lease.error || null);
    } catch (error) {
      const retryable = error.code === 'audio_cleanup_in_progress' || !(error.status >= 400 && error.status < 500);
      const code = typeof error.code === 'string' && /^[a-z][a-z_]{1,79}$/.test(error.code) ? error.code : retryable ? 'native_capture_retrying' : 'native_capture_rejected';
      const fatal = !retryable;
      if (fatal) active.delete(token); else active.add(token);
      await repo.change(lease.id, current => { current.error = fatal ? code : null; current.warning = fatal ? null : 'native_capture_retrying'; current.state = fatal ? 'blocked' : 'retrying'; }, { returnRecord: false }).catch(() => {});
      if (fatal || (lease.watermark ?? -1) >= 0 || lease.stop) await receipt(lease, false, fatal ? code : null).catch(() => {});
    }
  }
  function pump() {
    if (closing) return;
    while (working.size < 4 && pending.size) {
      const token = pending.values().next().value; pending.delete(token);
      if (working.has(token)) { again.add(token); continue; }
      const task = processLease(token).catch(error => { console.error('[native-audio]', error.code || 'native_capture_failed'); }).finally(() => { working.delete(token); if (again.delete(token)) pending.add(token); pump(); }); working.set(token, task);
    }
  }
  function wake(token) { if (closing || !/^[a-f0-9]{64}$/.test(token)) return; if (working.has(token)) again.add(token); else pending.add(token); pump(); }
  for (const lease of await repo.list('native-capture')) { const tokens = recordsToLeases.get(lease.recordId) || new Set(); tokens.add(lease.token); recordsToLeases.set(lease.recordId, tokens); active.add(lease.token); wake(lease.token); }
  let recoveryAt = Date.now() + recoveryIntervalMs;
  timer = setInterval(() => {
    const recovery = Date.now() >= recoveryAt;
    for (const token of active) if (recovery || !leaseWatchers.has(token)) wake(token);
    if (recovery) recoveryAt = Date.now() + recoveryIntervalMs;
  }, Math.min(500, recoveryIntervalMs)); timer.unref();
  const unsubscribe = repo.subscribeChanges(ids => {
    if (!ids.length) { for (const tokens of recordsToLeases.values()) for (const token of tokens) wake(token); }
    else for (const id of ids) for (const token of recordsToLeases.get(id) || []) wake(token);
  }, { all: true });
  return {
    root,
    async bind(user, input) {
      requireThat(input && uuid.test(input.recordId) && uuid.test(input.requestId) && ['microphone','display'].includes(input.kind) && typeof input.label === 'string' && input.label.length <= 80, 'invalid_native_capture', 400);
      if (input.timelineOffsetMs !== undefined) requireThat(Number.isSafeInteger(input.timelineOffsetMs) && input.timelineOffsetMs >= 0 && input.timelineOffsetMs <= 200000000, 'invalid_native_capture', 400);
      const [access] = await repo.getRecordAccess([input.recordId]); requireThat(access?.kind === 'record' && access.owner === user.id, 'not_found', 404); requireThat(!access.deleted && Date.parse(access.deleteAt) > Date.now(), 'record_expired', 410);
      const token = digest(JSON.stringify([user.id, input.requestId])), id = idFor(token), fingerprint = digest(JSON.stringify([input.recordId,input.kind,input.label,input.timelineOffsetMs || 0]));
      let lease = await repo.get(id);
      if (!lease) {
        try { await repo.insert({ id, token, kind: 'native-capture', owner: user.id, authVersion: user.authVersion || 0, instanceId, recordId: input.recordId, fingerprint, state: 'binding', createdAt: new Date().toISOString() }); }
        catch (error) { if (error.code !== 'already_exists') throw error; }
        lease = await repo.get(id);
      }
      requireThat(lease.owner === user.id && lease.fingerprint === fingerprint && lease.instanceId === instanceId && lease.state !== 'done', 'native_capture_conflict', 409); await actor(lease);
      const directory = directoryFor(lease); await mkdir(directory, { recursive: true, mode: 0o700 }); const stat = await lstat(directory); requireThat(stat.isDirectory() && !stat.isSymbolicLink(), 'native_capture_unavailable', 503);
      const source = await repo.changeMany([id, input.recordId], records => {
        const current = records.find(record => record.id === id), record = records.find(record => record.id === input.recordId);
        requireThat(!current.cancelled, 'native_capture_conflict', 409);
        requireThat(record.kind === 'record' && record.owner === user.id && !record.deleted && Date.parse(record.deleteAt) > Date.now(), 'record_expired', 410);
        if (current.sourceId) { const source = record.sources.find(source => source.id === current.sourceId && source.epoch === current.epoch); requireThat(source && !source.stopped, 'native_capture_conflict', 409); return publicSources([source])[0]; }
        const source = addSource(record, { kind: input.kind, label: input.label }); source.timelineOffsetMs = Math.max(source.timelineOffsetMs, input.timelineOffsetMs || 0);
        Object.assign(current, { sourceId: source.id, sessionId: source.sessionId, epoch: source.epoch, state: 'recording', watermark: -1, acceptedSampleEnd: 0 }); source.captureTransport = 'native-file-v1';
        return publicSources([source])[0];
      });
      const tokens = recordsToLeases.get(input.recordId) || new Set(); tokens.add(token); recordsToLeases.set(input.recordId, tokens); active.add(token); watchLease(lease); wake(token); return { protocol: 'native-file-v1', leaseId: token, source, actorId: user.id, authVersion: user.authVersion || 0 };
    },
    wake,
    async cancel(user, input) {
      const byRequest = uuid.test(input.requestId) && uuid.test(input.recordId);
      requireThat(byRequest || /^[a-f0-9]{64}$/.test(input.leaseId), 'invalid_native_capture', 400);
      const token = byRequest ? digest(JSON.stringify([user.id,input.requestId])) : input.leaseId;
      if (byRequest) {
        const [access] = await repo.getRecordAccess([input.recordId]); requireThat(access?.owner === user.id, 'not_found', 404);
      }
      let lease = await repo.get(idFor(token));
      if (!lease && byRequest) {
        try { await repo.insert({ id:idFor(token), token,kind:'native-capture',owner:user.id,authVersion:user.authVersion || 0,instanceId,recordId:input.recordId,state:'cancelled',cancelled:true }); }
        catch (error) { if (error.code !== 'already_exists') throw error; }
        lease = await repo.get(idFor(token));
      }
      requireThat(lease?.owner === user.id && lease.instanceId === instanceId && (!byRequest || lease.recordId === input.recordId), 'not_found', 404);
      await actor(lease);
      if (lease.state === 'done' || lease.state === 'cancelled') return {cancelled:true};
      await repo.change(lease.id, current => { current.cancelled=true; if (!current.sourceId) current.state='cancelled'; }, {returnRecord:false});
      lease = await repo.get(lease.id); if (!lease.sourceId) return {cancelled:true};
      requireThat((lease.watermark ?? -1) === -1 && !(await readdir(directoryFor(lease))).some(name => packetName.test(name)), 'native_capture_conflict', 409);
      await finishSource(lease, { schema: 1, lastSequence: -1, sampleEnd: 0, action: 'source' });
      await completeAction(lease); return { cancelled: true };
    },
    async idle() { while (working.size || pending.size) { await Promise.allSettled([...working.values()]); } },
    async close() { unsubscribe(); closing = true; for (const handle of leaseWatchers.values()) handle.close(); leaseWatchers.clear(); clearInterval(timer); pending.clear(); await Promise.allSettled([...working.values()]); },
  };
}
