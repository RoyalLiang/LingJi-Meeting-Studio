import { createHash } from 'node:crypto';
import { requireThat, digest } from '../../../packages/records/src/record.mjs';
import { createSecretStore } from './integrations/secret-store.mjs';
import { readConfig } from './config.mjs';
import { LOCAL_SPEAKER_MODEL, localSpeakersConfigured, transcribeLocalAsr } from './local-asr.mjs';
import { normalizedVoice, voiceSimilarity } from './local-speakers.mjs';

const registries = new WeakMap(), uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const publicEntry = ({ id, name, createdAt, source }) => ({ id, name, createdAt, source });
const vaultId = (owner, scope) => 'voiceprints:' + createHash('sha256').update(JSON.stringify([owner, scope])).digest('hex');
async function ownedSegment(repo, owner, scope, input) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input) && uuid.test(input.recordId) && uuid.test(input.segmentId) && Number.isSafeInteger(input.revision), 'invalid_voiceprint_source', 400);
  const record = await repo.get(input.recordId), segment = record?.segments?.find(segment => segment.id === input.segmentId);
  requireThat(record?.kind === 'record' && record.owner === owner && !record.deleted && Date.parse(record.deleteAt) > Date.now() && (scope === 'all' || (record.workspaceId || 'inbox') === scope), 'record_not_found', 404);
  requireThat(segment?.revision === input.revision && segment.sourceId !== 'text-import', 'voiceprint_source_changed', 409);
  return { record, segment };
}
async function clipFor(repo, owner, scope, input) {
  const { record, segment } = await ownedSegment(repo, owner, scope, input), source = record.sources.find(source => source.id === segment.sourceId);
  requireThat(source && !segment.overlappingSpeech, 'voiceprint_audio_unavailable', 409);
  const start = Math.round((segment.startMs - (source.timelineOffsetMs || 0)) * 16), end = Math.round((segment.endMs - (source.timelineOffsetMs || 0)) * 16);
  requireThat(Number.isSafeInteger(start) && start >= 0 && end - start >= 32000 && end - start <= 480000, 'voiceprint_clip_duration', 400);
  const chunks = record.chunks.filter(chunk => chunk.sourceId === source.id && chunk.epoch === source.epoch && chunk.sampleOffset < end && chunk.sampleOffset + chunk.sampleCount > start).sort((a, b) => a.sampleOffset - b.sampleOffset);
  requireThat(chunks.length > 0 && chunks.length <= 128, 'voiceprint_audio_unavailable', 409);
  const pcm = Buffer.alloc((end - start) * 2); let offset = start;
  for (const chunk of chunks) {
    requireThat(chunk.state === 'done' && !chunk.expired && chunk.sampleOffset <= offset, 'voiceprint_audio_unavailable', 409);
    let bytes; try { bytes = await repo.readAudio(chunk.object); } catch { requireThat(false, 'voiceprint_audio_unavailable', 409); }
    requireThat(bytes.length === chunk.sampleCount * 2 && digest(bytes) === chunk.digest, 'voiceprint_audio_unavailable', 409);
    const from = Math.max(start, chunk.sampleOffset), to = Math.min(end, chunk.sampleOffset + chunk.sampleCount);
    bytes.copy(pcm, (from - start) * 2, (from - chunk.sampleOffset) * 2, (to - chunk.sampleOffset) * 2); offset = to;
  }
  requireThat(offset === end, 'voiceprint_audio_unavailable', 409); return pcm;
}
export function voiceprints(repo, { infer = transcribeLocalAsr } = {}) {
  if (registries.has(repo)) return registries.get(repo);
  let secrets;
  async function secretStore() {
    try { return await (secrets ||= createSecretStore(repo.root)); } catch (error) { secrets = undefined; throw error; }
  }
  async function vault(owner, scope, create = false) {
    const id = vaultId(owner, scope); let value = await repo.get(id);
    if (!value && create) {
      try { await repo.insert({ id, kind: 'voiceprints', owner, scope, entries: [], revision: 0 }); }
      catch (error) { if (error.code !== 'already_exists') throw error; }
      value = await repo.get(id);
    }
    requireThat(!value || value.kind === 'voiceprints' && value.owner === owner && value.scope === scope, 'voiceprint_not_found', 404);
    return value;
  }
  async function embedding(owner, scope, input) {
    const config = await readConfig(repo.root); requireThat(localSpeakersConfigured(config), 'voiceprint_unavailable', 503);
    const pcm = await clipFor(repo, owner, scope, input);
    const result = await infer(pcm, config, { metadata: true, embedding: true }), vector = normalizedVoice(result.embedding);
    requireThat(vector, 'voiceprint_unavailable', 503);
    await ownedSegment(repo, owner, scope, input); return vector;
  }
    const banks=async owner=>(await repo.list('voiceprints')).filter(bank=>bank.owner===owner);
  const globalId=(bank,entry)=>{const value=createHash('sha256').update(`${bank.id}:${entry.id}`).digest('hex');return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20,32)}`;};
  const globalEntry=(bank,entry)=>({...publicEntry(entry),id:globalId(bank,entry),global:bank.scope==='all'||entry.consentVersion===2});
  const findGlobal=async(owner,id)=>{for(const bank of await banks(owner)){const entry=bank.entries.find(entry=>globalId(bank,entry)===id);if(entry)return {bank,entry};}return null;};
  async function listGlobal(owner){const global=await vault(owner,'all',true),values=await banks(owner),config=await readConfig(repo.root);return {available:localSpeakersConfigured(config),revision:global.revision||0,entries:values.flatMap(bank=>bank.entries.map(entry=>globalEntry(bank,entry)))};}
  async function confirmGlobal(owner,id,input){
    requireThat(uuid.test(id)&&input?.consent===true&&Number.isSafeInteger(input.libraryRevision),'voiceprint_consent_required',400);
    const global=await vault(owner,'all',true),found=await findGlobal(owner,id);requireThat(found,'voiceprint_not_found',404);
    await repo.changeMany([...new Set([global.id,found.bank.id])],records=>{const bank=records.find(bank=>bank.id===found.bank.id),entry=bank.entries.find(entry=>entry.id===found.entry.id),current=records.find(bank=>bank.id===global.id);requireThat(entry,'voiceprint_not_found',404);if(entry.consentVersion===2)return;requireThat(current.revision===input.libraryRevision,'voiceprint_library_changed',409);entry.consentVersion=2;entry.globalConfirmedAt=new Date().toISOString();current.revision=(current.revision||0)+1;});
    return listGlobal(owner);
  }
  async function matchGlobal(owner,input){
    const {record}=await ownedSegment(repo,owner,'all',input);let scope=record.workspaceId||'inbox';
    const allowed=(bank,entry)=>bank.scope==='all'||entry.consentVersion===2||bank.scope===scope;
    const values=(await banks(owner)).flatMap(bank=>bank.entries.filter(entry=>allowed(bank,entry)).map(entry=>({bank,entry})));if(!values.length)return {matches:[]};
    const vector=await embedding(owner,'all',input),store=await secretStore(),matches=values.map(({bank,entry})=>{let value;try{value=store.open(`${bank.id}:${entry.id}`,entry.sealed);}catch{requireThat(false,'voiceprint_storage_invalid',503);}const saved=normalizedVoice(value.vector);requireThat(saved&&value.model===LOCAL_SPEAKER_MODEL,'voiceprint_storage_invalid',503);return {id:globalId(bank,entry),name:entry.name,identity:JSON.stringify([entry.sealed,entry.fingerprint,entry.name]),similarity:Math.round(voiceSimilarity(vector,saved)*1000)/1000};}).filter(entry=>entry.similarity>=0.6).sort((a,b)=>b.similarity-a.similarity);
    const {record:latest}=await ownedSegment(repo,owner,'all',input);scope=latest.workspaceId||'inbox';const active=new Map((await banks(owner)).flatMap(bank=>bank.entries.filter(entry=>allowed(bank,entry)).map(entry=>[globalId(bank,entry),JSON.stringify([entry.sealed,entry.fingerprint,entry.name])])));return {matches:matches.filter(entry=>active.get(entry.id)===entry.identity).slice(0,3).map(({identity:_identity,...entry})=>entry)};
  }
  async function clip(owner,input){
    requireThat(input&&typeof input==='object'&&!Array.isArray(input)&&(!input.id||uuid.test(input.id)),'invalid_voiceprint',400);
    const found=input.id?await findGlobal(owner,input.id):null;if(input.id)requireThat(found,'voiceprint_not_found',404);
    const reference=found?.entry.source||input;
    const check=async()=>{const {record}=await ownedSegment(repo,owner,'all',reference);requireThat(record.retainAudio&&!record.audioPurged&&!record.audioCleanup,'voiceprint_audio_unavailable',409);};
    await check();const pcm=await clipFor(repo,owner,'all',reference);await check();
    if(found){const latest=await findGlobal(owner,input.id);requireThat(latest?.bank.id===found.bank.id&&latest.entry.sealed===found.entry.sealed,'voiceprint_not_found',404);}
    return pcm;
  }

 const registry = {
    confirmGlobal,clip,
    async list(owner, scope) {
      if(scope==='all')return listGlobal(owner);
      const value = await vault(owner, scope), config = await readConfig(repo.root);
      return { available: localSpeakersConfigured(config), revision: value?.revision || 0, entries: (value?.entries || []).map(publicEntry) };
    },
    async enroll(owner, scope, input) {
      requireThat(input && typeof input === 'object' && !Array.isArray(input) && input.consent === true, 'voiceprint_consent_required', 400);
      requireThat(uuid.test(input.requestId) && typeof input.name === 'string' && input.name.trim().length > 0 && input.name.trim().length <= 80 && !/[\u0000-\u001f\u007f]/u.test(input.name), 'invalid_voiceprint_name', 400);
      requireThat(Number.isSafeInteger(input.libraryRevision) && input.libraryRevision >= 0, 'voiceprint_library_changed', 409);
      const name = input.name.trim(), fingerprint = digest(JSON.stringify([input.recordId, input.segmentId, input.revision, name]));
      const priorGlobal=await vault(owner,'all'),globalRevision=scope==='all'?input.libraryRevision:(priorGlobal?.revision||0);
      const global=await vault(owner,'all',true),value=scope==='all'?global:await vault(owner,scope,true);
      const existing = value.entries.find(entry => entry.id === input.requestId);
      if (existing) { requireThat(existing.fingerprint === fingerprint, 'voiceprint_request_conflict', 409); return scope==='all'?globalEntry(value,existing):publicEntry(existing); }
      requireThat((value.revision || 0) === input.libraryRevision, 'voiceprint_library_changed', 409);
      requireThat(value.entries.length < 100, 'voiceprint_limit', 429);
      const vector = await embedding(owner, scope, input), store = await secretStore();
      const entry = { id: input.requestId, name, fingerprint, model: LOCAL_SPEAKER_MODEL, createdAt: new Date().toISOString(), consentVersion: scope==='all'?2:1, source: { recordId: input.recordId, segmentId: input.segmentId, revision: input.revision }, sealed: store.seal(`${value.id}:${input.requestId}`, { model: LOCAL_SPEAKER_MODEL, vector }) };
      await repo.changeMany([...new Set([value.id, input.recordId,global.id])], records => {
        const current = records.find(record => record.id === value.id), source = records.find(record => record.id === input.recordId);
        requireThat(source?.owner === owner && source.kind === 'record' && !source.deleted && Date.parse(source.deleteAt) > Date.now() && (scope === 'all' || (source.workspaceId || 'inbox') === scope) && source.segments.some(segment => segment.id === input.segmentId && segment.revision === input.revision), 'voiceprint_source_changed', 409);
        const duplicate = current.entries.find(entry => entry.id === input.requestId);
        if (duplicate) { requireThat(duplicate.fingerprint === fingerprint, 'voiceprint_request_conflict', 409); return; }
        requireThat((current.revision || 0) === input.libraryRevision, 'voiceprint_library_changed', 409);
        requireThat(current.entries.length < 100, 'voiceprint_limit', 429); const globalBank=records.find(bank=>bank.id===global.id);requireThat(globalBank.revision===globalRevision,'voiceprint_library_changed',409);current.entries.push(entry);globalBank.revision=(globalBank.revision||0)+1;
      }); return scope==='all'?globalEntry(value,entry):publicEntry(entry);
    },
    async match(owner, scope, input) {
      if(scope==='all')return matchGlobal(owner,input);
      const value = await vault(owner, scope);
      if (!value?.entries.length) return { matches: [] };
      const vector = await embedding(owner, scope, input), store = await secretStore();
      const matches = value.entries.map(entry => {
        let payload; try { payload = store.open(`${value.id}:${entry.id}`, entry.sealed); } catch { requireThat(false, 'voiceprint_storage_invalid', 503); }
        const known = normalizedVoice(payload.vector); requireThat(payload.model === LOCAL_SPEAKER_MODEL && known, 'voiceprint_storage_invalid', 503);
        return { id: entry.id, name: entry.name, similarity: Math.round(voiceSimilarity(vector, known) * 1000) / 1000 };
      }).filter(entry => entry.similarity >= 0.6).sort((a, b) => b.similarity - a.similarity).slice(0, 3);
      const current = await vault(owner, scope), active = new Set(current?.entries.map(entry => entry.id));
      return { matches: matches.filter(entry => active.has(entry.id)) };
    },
    async revoke(owner, scope, id, revision = 0) {
      requireThat(uuid.test(id), 'voiceprint_not_found', 404);
      requireThat(Number.isSafeInteger(revision) && revision >= 0, 'voiceprint_library_changed', 409);
      const global=await vault(owner,'all',true),found=scope==='all'?await findGlobal(owner,id):null;
      const value=scope==='all'?(found?.bank||global):await vault(owner,scope,true),entryId=found?.entry.id||id;
      const changed=await repo.changeMany([...new Set([value.id,global.id])],records=>{
        const current=records.find(bank=>bank.id===value.id),globalBank=records.find(bank=>bank.id===global.id),fence=scope==='all'?globalBank:current;
        if(!current.entries.some(entry=>entry.id===entryId)&&revision<(fence.revision||0))return;
        current.entries=current.entries.filter(entry=>entry.id!==entryId);current.revision=(current.revision||0)+1;
        if(current.id!==globalBank.id)globalBank.revision=(globalBank.revision||0)+1;
      });
      return {deleted:true,revision:changed.find(bank=>bank.id===(scope==='all'?global.id:value.id)).revision};

    },
  };
  registries.set(repo, registry); return registry;
}
