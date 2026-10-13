import { createHash } from "node:crypto";
export const learningFingerprint = (record) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        id: record.id,
        generation: record.generation,
        transcriptRevision: record.transcriptRevision,
        segments: record.segments.map(
          ({ id, revision, text, sourceId, startMs, endMs, speaker }) => ({
            id,
            revision,
            text,
            sourceId,
            startMs,
            endMs,
            speaker,
          }),
        ),
      }),
    )
    .digest("hex");
export function queueLearningReview(
  record,
  enabled = record.learning?.enabled === true,
) {
  if (
    !enabled ||
    record.deleted ||
    !(Date.parse(record.deleteAt) > Date.now()) ||
    record.capture !== "completed" ||
    record.chunks.some((chunk) => chunk.state !== "done") ||
    record.sources.some((source) => source.watermark !== source.lastSequence)
  )
    return false;
  const fingerprint = learningFingerprint(record);
  if (record.learning?.fingerprint === fingerprint) return false;
  record.learning = {
    enabled: true,
    status: record.segments.length ? "queued" : "empty",
    fingerprint,
    revision: record.transcriptRevision,
    generation: record.generation,
    sequence: record.learning?.sequence || 0,
    attempts: 0,
    history: record.learning?.history || [],
    queuedAt: Date.now(),
  };
  return true;
}
export function publicLearning(record) {
  const value = record.learning;
  if (!value) return null;
  return {
    enabled: value.enabled,
    status: value.status,
    revision: value.revision,
    groups: value.groups || 0,
    cases: value.cases || 0,
    error: value.error || null,
    preparedAt: value.preparedAt || null,
  };
}
export function learningWorkAt(record, now = Date.now()) {
  const value = record.learning;
  if (
    !value ||
    !["queued", "running", "failed"].includes(value.status) ||
    (value.attempts || 0) >= 3
  )
    return Infinity;
  return Math.max(
    now,
    value.retryAt || 0,
    value.status === "running" ? value.lease || 0 : 0,
  );
}
