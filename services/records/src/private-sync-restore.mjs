import { createHash } from 'node:crypto';
import { addSource, createRecord, DomainError, emit, requireThat } from '../../../packages/records/src/record.mjs';
import { normalizePublishedContent, ShareContentError } from '../../../packages/records/src/published-content.mjs';

const recordingId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function localId(...identity) {
  const hash = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return [hash.slice(0, 8), hash.slice(8, 12), '4' + hash.slice(13, 16), '8' + hash.slice(17, 20), hash.slice(20, 32)].join('-');
}

export async function restorePrivateMeeting(repo, owner, input) {
  requireThat(typeof input?.id === 'string' && /^[a-f0-9-]{36}$/.test(input.id), 'sync_invalid_operation', 400);
  requireThat(typeof input.notes === 'string' && input.notes.length <= 100_000, 'sync_invalid_notes', 400);
  let content;
  try { content = normalizePublishedContent(input.content); }
  catch (error) {
    if (error instanceof ShareContentError) throw new DomainError('sync_invalid_record', 400);
    throw error;
  }
  requireThat(content.scope === 'full' && !content.draft, 'sync_record_not_final', 400);
  const id = localId('private-sync/restore/v1', owner, input.id);
  const existing = async () => {
    const stored = await repo.get(id);
    if (!stored) return null;
    requireThat(stored.owner === owner && stored.syncParent === input.id && !stored.deleted && Date.parse(stored.deleteAt) > Date.now(), 'sync_restore_conflict', 409);
    return { id, duplicate: true };
  };
  const previous = await existing();
  if (previous) return previous;
  const record = createRecord(owner, { title: content.title, retainAudio: false });
  record.id = id;
  record.syncSourceId = content.sourceRecordId;
  record.syncParent = input.id;
  record.capture = 'completed';
  record.transcription = 'ready';
  record.segments = content.segments.map(segment => ({ ...segment, sourceId: 'sync', edited: false }));
  record.notes = input.notes;
  record.notesRevision = input.notes ? 1 : 0;
  record.minutes = content.minutes;
  record.minutesRevision = content.minutes?.revision ?? (content.minutes ? 1 : 0);
  record.transcriptRevision = content.minutes?.transcriptRevision ?? (record.segments.length ? 1 : 0);
  if (record.minutes) {
    record.minutes.revision = record.minutesRevision;
    record.minutes.transcriptRevision = record.transcriptRevision;
  }
  emit(record, 'record.sync.restored');
  try { await repo.insert(record); }
  catch (error) {
    const duplicate = await existing();
    if (duplicate) return duplicate;
    throw error;
  }
  return { id, duplicate: false };
}

export async function preparePrivateRecording(repo, owner, input) {
  const { id: recording, vault, title, live = false, existingOnly = false } = input || {};
  requireThat(typeof live === 'boolean' && typeof existingOnly === 'boolean' && (!existingOnly || live), 'sync_invalid_recording', 400);
  requireThat(typeof recording === 'string' && recordingId.test(recording) && typeof vault === 'string' && recordingId.test(vault), 'sync_invalid_recording', 400);
  const id = localId('private-sync/recording/v1', owner, vault, recording);
  requireThat(typeof title === 'string' && title.trim().length > 0 && title.length <= 160, 'sync_invalid_recording', 400);
  async function existing() {
    const record = await repo.get(id);
    if (!record) return null;
    requireThat(record.owner === owner && record.syncRecording === true, 'sync_recording_unavailable', 409);
    return record;
  }
  const stored = await existing();
  if (stored) return stored;
  requireThat(!existingOnly, 'sync_recording_prefix_unavailable', 404);
  const record = createRecord(owner, { title });
  record.id = id;
  record.syncRecording = true;
  record.syncSourceId = recording;
  if (live) addSource(record, { kind: 'import', label: '手机麦克风' });
  try { return await repo.insert(record); }
  catch (error) {
    const duplicate = await existing();
    if (duplicate) return duplicate;
    throw error;
  }
}
