import { readFile, writeFile, rename, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
export const reviewRoundPattern = /^r\d{3,6}$/;
export const readJson = (path) => readFile(path, "utf8").then(JSON.parse);
export const readLines = (path) =>
  readFile(path, "utf8").then((text) =>
    text.split("\n").filter(Boolean).map(JSON.parse),
  );
const optional = async (path, reader, fallback) => {
  try {
    return await reader(path);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
};
export function roundDirectory(workspace, name) {
  if (!reviewRoundPattern.test(name || "")) throw Error("invalid_round");
  return join(workspace, "rounds", name);
}
export async function loadReviewRound(workspace, name) {
  const dir = roundDirectory(workspace, name);
  let cases;
  for (const file of [
    "annotation-results.jsonl",
    "dataset/cases.jsonl",
    "prelabel/cases.jsonl",
  ]) {
    cases = await optional(join(dir, file), readLines, null);
    if (cases) break;
  }
  if (!cases) cases = [];
  const reviews = await optional(join(dir, "reviews.jsonl"), readLines, []);
  const byId = new Map(reviews.map((row) => [row.sample_id, row]));
  const records = await optional(join(dir, "records.json"), readJson, {
    records: [],
  });
  const byRecord = new Map(
    records.records.map((record) => [record.id, record]),
  );
  cases = cases.map((row) => {
    const record = byRecord.get(row.source.recordId),
      focus = record?.segments.find(
        (segment) => segment.id === row.source.focus.segmentId,
      ),
      review = byId.get(row.sample_id);
    return {
      ...row,
      display: {
        ...row.display,
        ...(record?.title ? { meetingTitle: record.title } : {}),
        ...(focus ? { startMs: focus.startMs, endMs: focus.endMs } : {}),
      },
      target: row.target ?? null,
      ...(review?.input_hash === row.input_hash ? review : {}),
    };
  });
  return {
    cases,
    report: await optional(join(dir, "round-report.json"), readJson, null),
    meta: await optional(join(dir, "round.json"), readJson, {}),
  };
}
const queues = new Map();
export async function saveReviews(workspace, name, input) {
  const dir = roundDirectory(workspace, name),
    data = await loadReviewRound(workspace, name),
    lookup = new Map(data.cases.map((row) => [row.sample_id, row]));
  if (!Array.isArray(input) || !input.length || input.length > 12)
    throw Error("invalid_review_batch");
  const seen = new Set(),
    cleaned = [];
  for (const review of input) {
    const found = lookup.get(review?.sample_id);
    if (
      !found ||
      found.input_hash !== review.input_hash ||
      seen.has(review.sample_id)
    )
      throw Error("stale_review");
    seen.add(review.sample_id);
    const targets = Object.keys(
      Object.values(found.request.questions)[0].criteria,
    );
    if (
      ![...targets, "skip", "abstain"].includes(review.target) ||
      typeof review.reviewer !== "string" ||
      !review.reviewer.trim() ||
      review.reviewer.length > 80
    )
      throw Error("invalid_review");
    if (
      typeof review.correctedText !== "string" ||
      review.correctedText.length > 2000 ||
      typeof review.note !== "string" ||
      review.note.length > 2000
    )
      throw Error("invalid_review_text");
    if (found.family !== "asr" && review.correctedText)
      throw Error("correction_requires_asr_case");
    if (
      found.family === "asr" &&
      review.audioVerified === true &&
      !found.source.audioSha256
    )
      throw Error("audio_not_verified");
    cleaned.push({
      sample_id: found.sample_id,
      input_hash: found.input_hash,
      target: review.target,
      reviewer: review.reviewer.trim(),
      note: review.note,
      correctedText: review.correctedText,
      audioVerified: review.audioVerified === true,
      blindReview: review.blindReview === true,
      reviewedAt: new Date().toISOString(),
    });
  }
  const previous = queues.get(dir) || Promise.resolve();
  const pending = previous
    .catch(() => {})
    .then(async () => {
      const rows = await optional(join(dir, "reviews.jsonl"), readLines, []),
        map = new Map(rows.map((row) => [row.sample_id, row]));
      for (const review of cleaned) map.set(review.sample_id, review);
      await appendFile(
        join(dir, "review-history.jsonl"),
        JSON.stringify({ eventId: randomUUID(), reviews: cleaned }) + "\n",
        { mode: 0o600 },
      );
      const path = join(dir, "reviews.jsonl"),
        temporary = path + "." + randomUUID() + ".tmp";
      await writeFile(
        temporary,
        [...map.values()].map((row) => JSON.stringify(row) + "\n").join(""),
        { mode: 0o600 },
      );
      await rename(temporary, path);
    });
  queues.set(dir, pending);
  try {
    await pending;
  } finally {
    if (queues.get(dir) === pending) queues.delete(dir);
  }
  return { saved: cleaned.length };
}
export function trainingPlan(cases) {
  const meetings = new Set();
  const counts = { intent: 0, asr: 0 },
    labels = [],
    evaluation = { intent: 0, asr: 0 };
  for (const row of cases) {
    if (
      !row.reviewer?.trim() ||
      !row.target ||
      ["skip", "abstain"].includes(row.target) ||
      row.rejected
    )
      continue;
    if (row.family === "asr" && (!row.audioVerified || !row.source.audioSha256))
      continue;
    meetings.add(row.source.recordId);
    labels.push(
      Object.fromEntries(
        [
          "sample_id",
          "input_hash",
          "target",
          "reviewer",
          "correctedText",
          "audioVerified",
          "blindReview",
        ].map((key) => [key, row[key] ?? null]),
      ),
    );
    if (row.split === "train") counts[row.family]++;
    else if (row.blindReview === true) evaluation[row.family]++;
  }
  labels.sort((a, b) => a.sample_id.localeCompare(b.sample_id));
  const planHash = createHash("sha256")
      .update(JSON.stringify(labels))
      .digest("hex"),
    ready = counts.intent > 0 && counts.asr > 0;
  return {
    planHash,
    ready,
    counts,
    evaluation: evaluation.intent + evaluation.asr,
    meetings: meetings.size,
    labels,
    message: `仅使用 ${meetings.size} 场会议的人工确认标签：训练意图 ${counts.intent} 条、转录候选 ${counts.asr} 条；独立盲标评测 ${evaluation.intent + evaluation.asr} 条。${ready ? "" : " 两类任务均需至少一条可训练的人工标签。"}`,
  };
}
