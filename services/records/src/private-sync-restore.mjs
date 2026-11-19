import { createHash } from 'node:crypto';
import { createRecord, DomainError, emit, requireThat } from '../../../packages/records/src/record.mjs';
import { normalizePublishedContent, ShareContentError } from '../../../packages/records/src/published-content.mjs';

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
  const hash = createHash('sha256').update(JSON.stringify(['private-sync/restore/v1', owner, input.id])).digest('hex');
  const id = [hash.slice(0, 8), hash.slice(8, 12), '4' + hash.slice(13, 16), '8' + hash.slice(17, 20), hash.slice(20, 32)].join('-');
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
