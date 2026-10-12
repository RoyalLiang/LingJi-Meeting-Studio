// Validate optional rich content against the same frozen evidence as the prose.
export function validateMinutesStructure(result, snapshot, requireThat) {
  const evidence = refs => Array.isArray(refs) && refs.length > 0 && refs.length <= 500 && refs.every(ref => ref && snapshot.some(s => s.id === ref.segmentId && s.revision === ref.revision));
  if (result.currentDiscussion !== undefined) requireThat(Array.isArray(result.currentDiscussion) && result.currentDiscussion.length <= 8 && result.currentDiscussion.every(item => item && typeof item.text === 'string' && item.text.trim() && item.text.length <= 2000 && evidence(item.evidence)), 'invalid_current_discussion', 422);
  if (result.tables === undefined) return;
  requireThat(Array.isArray(result.tables) && result.tables.length <= 6, 'invalid_minutes_tables', 422);
  for (const table of result.tables) {
    requireThat(table && typeof table.title === 'string' && table.title.trim() && table.title.length <= 200 && Array.isArray(table.columns) && table.columns.length >= 2 && table.columns.length <= 8 && table.columns.every(column => typeof column === 'string' && column.trim() && column.length <= 100), 'invalid_minutes_tables', 422);
    requireThat(Array.isArray(table.rows) && table.rows.length > 0 && table.rows.length <= 30 && table.rows.every(row => row && Array.isArray(row.cells) && row.cells.length === table.columns.length && row.cells.every(cell => typeof cell === 'string' && cell.length <= 1000) && evidence(row.evidence)), 'invalid_minutes_tables', 422);
  }
}
