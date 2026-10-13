import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { decodeStorage } from "../../services/records/src/storage-codec.mjs";

export const sha = (value) => createHash("sha256").update(value).digest("hex");
const pick = (value, keys) =>
  Object.fromEntries(
    keys
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
const segmentKeys = [
  "id",
  "revision",
  "sourceId",
  "chunkKey",
  "startMs",
  "endMs",
  "text",
  "speaker",
  "speakerId",
  "edited",
];

export function readSnapshot(root, now = Date.now()) {
  const db = new DatabaseSync(join(resolve(root), "records.sqlite"), {
    readOnly: true,
  });
  db.exec("BEGIN");
  try {
    const records = [];
    const rows = db
      .prepare(
        "SELECT id,data FROM aggregates WHERE json_extract(data,'$.kind')='record'",
      )
      .all();
    for (const row of rows) {
      const meta = JSON.parse(row.data);
      if (meta.deleted || !(Date.parse(meta.deleteAt) > now)) continue;
      const record =
        meta.$payload === "deflate-v1"
          ? JSON.parse(
              decodeStorage(
                db
                  .prepare("SELECT payload FROM aggregate_payloads WHERE id=?")
                  .get(row.id).payload,
              ),
            )
          : meta;
      records.push({
        ...pick(record, [
          "id",
          "transcriptRevision",
          "generation",
          "capture",
          "language",
          "deleteAt",
          "retainAudio",
          "audioPurged",
          "synthetic",
        ]),
        segments: (record.segments || []).map((segment) => ({
          ...pick(segment, segmentKeys),
          versions: (segment.versions || []).map((version) =>
            pick(version, segmentKeys),
          ),
        })),
        sources: (record.sources || []).map((source) =>
          pick(source, [
            "id",
            "sessionId",
            "epoch",
            "kind",
            "timelineOffsetMs",
          ]),
        ),
        chunks: (record.chunks || []).map((chunk) =>
          pick(chunk, [
            "key",
            "sourceId",
            "sessionId",
            "epoch",
            "sequence",
            "sampleOffset",
            "sampleCount",
            "sampleRate",
            "digest",
            "object",
            "state",
            "expired",
          ]),
        ),
        insights: record.insights
          ? pick(record.insights, ["transcriptRevision", "method", "items"])
          : null,
      });
    }
    return records;
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
}

export async function exportSnapshots(roots, output) {
  const records = [],
    registry = {},
    conflicts = [];
  for (const root of roots.map((value) => resolve(value))) {
    const sourceId = sha(root).slice(0, 16);
    for (const record of readSnapshot(root)) {
      if (registry[record.id]) {
        conflicts.push({ recordId: record.id, reason: "duplicate_record_id" });
        continue;
      }
      record.learningSource = sourceId;
      registry[record.id] = { root, sourceId };
      records.push(record);
    }
  }
  const encoded = JSON.stringify({ records });
  await mkdir(output, { recursive: false, mode: 0o700 });
  const manifest = {
    schema: "alpha-learning-snapshot-v1",
    createdAt: new Date().toISOString(),
    alphaTrainingAuthorized: true,
    sourceAccess: "read-only SQLite transaction",
    records: records.length,
    segments: records.reduce((n, r) => n + r.segments.length, 0),
    recordingRecords: records.filter((r) => r.capture === "recording").length,
    snapshotSha256: sha(encoded + "\n"),
    conflicts,
    sources: roots.map((root) => sha(resolve(root)).slice(0, 16)),
  };
  for (const [name, value] of Object.entries({
    "records.json": encoded,
    "registry.json": JSON.stringify(registry),
    "manifest.json": JSON.stringify(manifest, null, 2),
  })) {
    await writeFile(join(output, name), value + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  }
  return manifest;
}

export async function segmentPcm(
  root,
  record,
  segment,
  { maxSeconds = 120 } = {},
) {
  const source = record.sources.find((value) => value.id === segment.sourceId);
  if (
    !source ||
    !Number.isFinite(segment.startMs) ||
    !Number.isFinite(segment.endMs)
  )
    throw new Error("audio_source_missing");
  const start = Math.floor(
    (segment.startMs - (source.timelineOffsetMs || 0)) * 16,
  );
  const end = Math.ceil((segment.endMs - (source.timelineOffsetMs || 0)) * 16);
  if (start < 0 || end <= start || end - start > maxSeconds * 16000)
    throw new Error("audio_span_invalid_or_too_large");
  const chunks = record.chunks
    .filter(
      (chunk) =>
        chunk.sourceId === source.id &&
        chunk.sampleOffset < end &&
        chunk.sampleOffset + chunk.sampleCount > start,
    )
    .sort((a, b) => a.sampleOffset - b.sampleOffset);
  const parts = [];
  let cursor = start;
  for (const chunk of chunks) {
    if (
      chunk.expired ||
      chunk.sampleRate !== 16000 ||
      chunk.sampleOffset > cursor ||
      !/^[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(chunk.object || "") ||
      !chunk.object.startsWith(record.id + "/")
    )
      throw new Error("audio_gap_or_invalid_object");
    const bytes = decodeStorage(
      await readFile(join(root, "audio", chunk.object)),
      chunk.digest,
    );
    if (bytes.length !== chunk.sampleCount * 2)
      throw new Error("audio_size_mismatch");
    const until = Math.min(end, chunk.sampleOffset + chunk.sampleCount);
    if (until > cursor) {
      parts.push(
        bytes.subarray(
          (cursor - chunk.sampleOffset) * 2,
          (until - chunk.sampleOffset) * 2,
        ),
      );
      cursor = until;
    }
    if (cursor === end) break;
  }
  if (cursor !== end) throw new Error("audio_unavailable");
  return Buffer.concat(parts);
}

export function wav(pcm) {
  const head = Buffer.alloc(44);
  head.write("RIFF");
  head.writeUInt32LE(pcm.length + 36, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24);
  head.writeUInt32LE(32000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

export async function objectInventory(root, record) {
  let count = 0;
  for (const chunk of record.chunks) {
    if (!/^[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(chunk.object || "")) continue;
    if (
      await stat(join(root, "audio", chunk.object)).then(
        (value) => value.isFile(),
        () => false,
      )
    )
      count++;
  }
  return count;
}
