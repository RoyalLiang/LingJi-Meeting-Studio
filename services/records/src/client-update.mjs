// Read-only protocol v1. Never returns audio, transcript, titles, identities or provider settings.
export async function clientUpdateBarrier(repo, owner, now = Date.now()) {
  const records = (await repo.list()).filter(record => record.kind === 'record' && record.owner === owner && !record.deleted && Date.parse(record.deleteAt) > now);
  return { protocol: 1, records: records.map(record => ({ capture: record.capture,
    sources: record.sources.map(source => ({ stopped: source.stopped, lastSequence: source.lastSequence, watermark: source.watermark })) })) };
}
