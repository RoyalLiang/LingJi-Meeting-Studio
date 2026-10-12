import { meetingSeconds } from '../../../packages/records/src/workspaces.mjs';
import { publicRecord } from '../../../packages/records/src/record.mjs';

export const cursorKey = cursor => String(cursor).padStart(20, '0');
export function projectionDelta(before, after) {
  const set = {}, remove = [];
  for (const key of Object.keys(before)) if (!(key in after)) remove.push(key);
  for (const [key, value] of Object.entries(after)) {
    if (key !== 'segments' && JSON.stringify(value) !== JSON.stringify(before[key])) set[key] = value;
  }
  const previous = new Map(before.segments.map(segment => [segment.id, segment]));
  const next = new Set(after.segments.map(segment => segment.id));
  return { baseCursor: before.cursor, cursor: after.cursor, set, remove,
    segments: { upsert: after.segments.filter(segment => JSON.stringify(previous.get(segment.id)) !== JSON.stringify(segment)),
      remove: before.segments.filter(segment => !next.has(segment.id)).map(segment => segment.id),
      ...(JSON.stringify(before.segments.map(s=>s.id)) !== JSON.stringify(after.segments.map(s=>s.id)) ? {order:after.segments.map(s=>s.id)} : {}) } };
}
export function deriveProjection(record, before) {
  if (record.kind !== 'record') return null;
  const events = record.events || [], last = events.at(-1);
  const delta = before && before.cursor !== record.cursor ? projectionDelta(before, publicRecord(record)) : null;
  return { list: {owner:record.owner,deleted:!!record.deleted,deleteAt:record.deleteAt,search:`${record.title} ${record.segments.map(s=>s.text).join(' ')} ${JSON.stringify(record.minutes||'')}`.toLowerCase(),summary:{id:record.id,title:record.title,workspaceId:record.workspaceId||null,createdAt:record.createdAt,updatedAt:record.updatedAt,capture:record.capture,transcription:record.transcription,segments:record.segments.length,hasMinutes:!!record.minutes,seconds:meetingSeconds(record)}}, meta: { id: record.id, owner: record.owner, deleted: !!record.deleted, deleteAt: record.deleteAt,
    cursor: record.cursor, first: events[0]?.cursor || record.cursor },
    events: events.filter(event => !before || BigInt(event.cursor) > BigInt(before.cursor)).map(event =>
      ({ ...event, projection: !!delta, ...(delta && event === last ? { delta } : {}) })) };
}
export function visibleSnapshot(value) { return value.kind === 'record' ? structuredClone(publicRecord(value)) : null; }
