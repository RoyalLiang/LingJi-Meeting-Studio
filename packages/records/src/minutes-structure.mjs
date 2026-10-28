import { validateMinutesQuality } from './minutes-quality.mjs';

// Validate optional rich content against the same frozen evidence as the prose.
export function validateMinutesStructure(result, snapshot, requireThat, {aggregate=false,aggregateParts=1}={}) {
  const sources = new Set(snapshot.map(segment => `${segment.id}:${segment.revision}`));
 const count=aggregate?Math.max(aggregateParts,sources.size):1, evidenceLimit=aggregate?Math.max(500,sources.size):500;
  const evidence = refs => Array.isArray(refs) && refs.length > 0 && refs.length <= evidenceLimit && refs.every(ref => ref && typeof ref.segmentId === 'string' && Number.isInteger(ref.revision) && sources.has(`${ref.segmentId}:${ref.revision}`));
  const topicIds = new Set();
  if (result.topics !== undefined) {
    requireThat(Array.isArray(result.topics) && result.topics.length <= 30*count && result.topics.every(topic => topic && typeof topic === 'object'), 'invalid_minutes_topics', 422);
    for (const topic of result.topics) if (topic.id !== undefined) {
      requireThat(typeof topic.id === 'string' && topic.id.trim() && topic.id === topic.id.trim() && topic.id.length <= 80 && !topicIds.has(topic.id), 'invalid_minutes_topics', 422);
      topicIds.add(topic.id);
    }
  }
  if (result.currentDiscussion !== undefined) requireThat(Array.isArray(result.currentDiscussion) && result.currentDiscussion.length <= 8 && result.currentDiscussion.every(item => item && typeof item.text === 'string' && item.text.trim() && item.text.length <= 2000 && evidence(item.evidence)), 'invalid_current_discussion', 422);
  validateMinutesQuality(result, snapshot, requireThat, topicIds, evidence, {aggregate});
  if (result.tables === undefined) return;
  requireThat(Array.isArray(result.tables) && result.tables.length <= 6, 'invalid_minutes_tables', 422);
  for (const table of result.tables) {
    requireThat(table && typeof table.title === 'string' && table.title.trim() && table.title.length <= 200 && Array.isArray(table.columns) && table.columns.length >= 2 && table.columns.length <= 8 && table.columns.every(column => typeof column === 'string' && column.trim() && column.length <= 100), 'invalid_minutes_tables', 422);
    if (table.topicId !== undefined) requireThat(typeof table.topicId === 'string' && topicIds.has(table.topicId), 'invalid_minutes_tables', 422);
    requireThat(Array.isArray(table.rows) && table.rows.length > 0 && table.rows.length <= 30 && table.rows.every(row => row && Array.isArray(row.cells) && row.cells.length === table.columns.length && row.cells.every(cell => typeof cell === 'string' && cell.length <= 1000) && evidence(row.evidence)), 'invalid_minutes_tables', 422);
  }
}
