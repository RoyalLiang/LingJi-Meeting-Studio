import { spawn } from "node:child_process";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import {
  queueLearningReview,
  learningFingerprint,
} from "../../../packages/records/src/learning.mjs";
import { emit, requireThat } from "../../../packages/records/src/record.mjs";
import {
  loadReviewRound,
  trainingPlan,
  readJson,
  readLines,
  roundDirectory,
} from "../../../scripts/alpha-learning/review-store.mjs";
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const learningWorkspace = (repo, id) => {
  requireThat(/^[a-f0-9-]{36}$/.test(id), "invalid_record_id", 400);
  return join(repo.root, "learning", id);
};
const ownerKey = (owner) => createHash("sha256").update(owner).digest("hex");
export const trainingStateId = (owner) =>
  "learning-training:" + ownerKey(owner);
export const trainingWorkspace = (repo, owner) =>
  join(repo.root, "learning-training", ownerKey(owner));
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const meetingFold = (id) => {
  const n = parseInt(hash(id).slice(0, 8), 16) % 10;
  return n < 8 ? "train" : n === 8 ? "dev" : "test";
};
const current = (record, fingerprint) =>
  record &&
  !record.deleted &&
  Date.parse(record.deleteAt) > Date.now() &&
  record.capture === "completed" &&
  record.chunks.every((chunk) => chunk.state === "done") &&
  record.sources.every((source) => source.watermark === source.lastSequence) &&
  learningFingerprint(record) === fingerprint;
async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value) + "\n", { mode: 0o600 });
}
async function writeLines(path, rows) {
  await writeFile(
    path,
    rows.map((row) => JSON.stringify(row) + "\n").join(""),
    { mode: 0o600 },
  );
}
export async function learningBridge(options) {
  const {
    workspace,
    round,
    parent,
    inputBundle,
    recordId,
    sourceRoot,
    splitsFile,
    prepareOnly,
    perRecord = 1000,
  } = options;
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const args = [
    join(repoRoot, "scripts/alpha-learning/run.mjs"),
    "--workspace",
    workspace,
    "--round",
    round,
    "--per-record",
    String(perRecord),
  ];
  if(options.steps!==undefined)args.push("--steps",String(options.steps));
  if (parent) args.push("--parent", parent);
  if (inputBundle) args.push("--input-bundle", inputBundle);
  if (recordId) args.push("--record-id", recordId);
  if (sourceRoot) args.push("--source-root", sourceRoot);
  if (splitsFile) args.push("--splits-file", splitsFile);
  if (prepareOnly) args.push("--prepare-only");
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = join(workspace, "worker-bridge.log");
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) =>
      appendFile(log, bytes, { mode: 0o600 }).catch(() => {}),
    );
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            Object.assign(Error("learning_bridge_failed"), {
              code: "learning_bridge_failed",
            }),
          ),
    );
  });
  return loadReviewRound(workspace, round);
}
export async function processLearningRecord(repo, id, providers = {}) {
  let claim;
  await repo.change(id, (record) => {
    if (record.learning?.enabled === false) return;
    if (queueLearningReview(record, true)) emit(record, "learning.queued");
    const value = record.learning;
    if (
      !current(record, value?.fingerprint) ||
      !["queued", "running", "failed"].includes(value.status) ||
      (value.attempts || 0) >= 3 ||
      (value.retryAt || 0) > Date.now() ||
      (value.status === "running" && (value.lease || 0) > Date.now())
    )
      return;
    value.status = "running";
    value.attempts = (value.attempts || 0) + 1;
    value.sequence = (value.sequence || 0) + 1;
    value.round = "r" + String(value.sequence).padStart(3, "0");
    value.fence = randomUUID();
    value.lease = Date.now() + 6 * 3600000;
    delete value.error;
    claim = {
      id,
      fingerprint: value.fingerprint,
      fence: value.fence,
      round: value.round,
      owner: record.owner,
    };
    emit(record, "learning.running");
  });
  if (!claim) return false;
  try {
    const workspace = learningWorkspace(repo, id);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const splitsFile = join(workspace, "split-" + claim.round + ".json");
    await writeJson(splitsFile, { [id]: meetingFold(id) });
    const result = await (providers.learningPreparation || learningBridge)({
      workspace,
      round: claim.round,
      recordId: id,
      sourceRoot: repo.root,
      splitsFile,
      prepareOnly: true,
      perRecord: 1000,
    });
    requireThat(
      result.report?.trained !== true,
      "learning_preparation_must_not_train",
    );
    await repo.change(id, (record) => {
      if (
        !current(record, claim.fingerprint) ||
        record.learning?.fence !== claim.fence
      )
        return;
      const value = record.learning;
      value.status = "ready";
      value.groups = new Set(
        result.cases.map((row) => row.source.focus.segmentId),
      ).size;
      value.cases = result.cases.length;
      value.preparedAt = Date.now();
      value.history = [
        ...(value.history || []),
        { round: claim.round, fingerprint: claim.fingerprint },
      ].slice(-10);
      delete value.lease;
      delete value.fence;
      emit(record, "learning.ready");
    });
    return true;
  } catch (error) {
    await repo.change(id, (record) => {
      if (
        !current(record, claim.fingerprint) ||
        record.learning?.fence !== claim.fence
      )
        return;
      const value = record.learning;
      value.status = "failed";
      value.error = error.code || "learning_preparation_failed";
      value.retryAt = Date.now() + Math.min(300000, 60000 * value.attempts);
      delete value.lease;
      delete value.fence;
      emit(record, "learning.failed");
    });
    return false;
  }
}
export async function reviewLocation(repo, record, name) {
  requireThat(
    current(record, record.learning?.fingerprint),
    "learning_snapshot_changed",
  );
  if (/^t-r\d{3,6}$/.test(name || "")) {
    const round = name.slice(2),
      state = await repo.get(trainingStateId(record.owner));
    const entry = state?.history?.find(
      (item) =>
        item.round === round &&
        item.records.some(
          (source) =>
            source.id === record.id &&
            source.fingerprint === record.learning.fingerprint,
        ),
    );
    requireThat(entry, "learning_round_not_found", 404);
    return { workspace: trainingWorkspace(repo, record.owner), round };
  }
  requireThat(
    record.learning?.history?.some(
      (entry) =>
        entry.round === name &&
        entry.fingerprint === record.learning.fingerprint,
    ),
    "learning_round_not_found",
    404,
  );
  return { workspace: learningWorkspace(repo, record.id), round: name };
}
export async function learningRounds(repo, record) {
  const rounds = (record.learning?.history || [])
    .filter((entry) => entry.fingerprint === record.learning.fingerprint)
    .map((entry) => ({ name: entry.round, status: "已完成" }));
  const state = await repo.get(trainingStateId(record.owner));
  for (const entry of state?.history || [])
    if (
      entry.records.some(
        (source) =>
          source.id === record.id &&
          source.fingerprint === record.learning?.fingerprint,
      )
    )
      rounds.push({ name: "t-" + entry.round, status: "已完成" });
  return rounds;
}
export async function trainingCorpus(repo, owner) {
  const state = await repo.get(trainingStateId(owner)),
    sources = [],
    cases = [],
    records = [],
    asr = [],
    registry = {},
    reviews = [];
  const cache = new Map();
  const loaded = async (workspace, round) => {
    const key = workspace + "/" + round;
    if (!cache.has(key))
      cache.set(key, await loadReviewRound(workspace, round));
    return cache.get(key);
  };
  for (const record of await repo.list()) {
    if (
      record.owner !== owner ||
      record.learning?.status !== "ready" ||
      !current(record, record.learning.fingerprint)
    )
      continue;
    const latest = [...(state?.history || [])]
      .reverse()
      .find((entry) =>
        entry.records.some(
          (source) =>
            source.id === record.id &&
            source.fingerprint === record.learning.fingerprint,
        ),
      );
    const location = latest
      ? { workspace: trainingWorkspace(repo, owner), round: latest.round }
      : {
          workspace: learningWorkspace(repo, record.id),
          round: record.learning.history.at(-1)?.round,
        };
    if (!location.round) continue;
    const data = await loaded(location.workspace, location.round),
      dir = roundDirectory(location.workspace, location.round);
    const snapshot = await readJson(join(dir, "records.json"));
    const original = snapshot.records.find((value) => value.id === record.id);
    if (!original) continue;
    const candidates = await readLines(
      join(dir, "dataset/asr-candidates.jsonl"),
    );
    const feedback = new Map();
    const locations = [
      ...(record.learning.history || [])
        .filter((entry) => entry.fingerprint === record.learning.fingerprint)
        .map((entry) => ({
          workspace: learningWorkspace(repo, record.id),
          round: entry.round,
        })),
      ...(state?.history || [])
        .filter((entry) =>
          entry.records.some(
            (source) =>
              source.id === record.id &&
              source.fingerprint === record.learning.fingerprint,
          ),
        )
        .map((entry) => ({
          workspace: trainingWorkspace(repo, owner),
          round: entry.round,
        })),
    ];
    for (const source of locations)
      for (const row of (await loaded(source.workspace, source.round)).cases) {
        if (row.source.recordId !== record.id || !row.reviewer || !row.target)
          continue;
        const key = row.sample_id + ":" + row.input_hash;
        const previous = feedback.get(key);
        if (
          !previous ||
          (Date.parse(row.reviewedAt) || 0) >=
            (Date.parse(previous.reviewedAt) || 0)
        )
          feedback.set(key, row);
      }
    const selected = data.cases
      .filter((row) => row.source.recordId === record.id)
      .map((row) => {
        const review = feedback.get(row.sample_id + ":" + row.input_hash);
        return review
          ? {
              ...row,
              ...Object.fromEntries(
                [
                  "target",
                  "reviewer",
                  "audioVerified",
                  "blindReview",
                  "correctedText",
                  "note",
                  "reviewedAt",
                ].map((key) => [key, review[key]]),
              ),
            }
          : row;
      });
    cases.push(...selected);
    records.push(original);
    asr.push(...candidates.filter((row) => row.recordId === record.id));
    registry[record.id] = {
      root: repo.root,
      sourceId: original.learningSource,
    };
    for (const row of selected)
      if (row.reviewer && row.target)
        reviews.push(
          Object.fromEntries(
            [
              "sample_id",
              "input_hash",
              "target",
              "reviewer",
              "audioVerified",
              "blindReview",
              "correctedText",
              "note",
            ].map((key) => [
              key,
              row[key] ??
                (key === "correctedText" || key === "note" ? "" : false),
            ]),
          ),
        );
    sources.push({
      id: record.id,
      fingerprint: record.learning.fingerprint,
      round: location.round,
    });
  }
  const plan = trainingPlan(cases);
  plan.planHash = hash({
    labels: plan.labels,
    sources,
    policy: "alpha-human-only-v1",
  });
  return {
    plan,
    sources,
    records,
    asr,
    registry,
    reviews,
    parent: state?.lastTrainedRound || null,
  };
}
export async function queueHumanTraining(repo, owner, input) {
  const corpus = await trainingCorpus(repo, owner);
  requireThat(
    input.confirmed === true &&
      corpus.plan.ready &&
      input.planHash === corpus.plan.planHash,
    "human_review_required",
  );
  const id = trainingStateId(owner);
  if (!(await repo.get(id))) {
    try {
      await repo.insert({
        id,
        kind: "learning-training",
        owner,
        status: "idle",
        sequence: 0,
        history: [],
      });
    } catch (error) {
      if (error.code !== "already_exists") throw error;
    }
  }
  return repo.change(id, (state) => {
    requireThat(
      !["queued", "running"].includes(state.status),
      "learning_training_busy",
    );
    state.sequence++;
    state.round = "r" + String(state.sequence).padStart(3, "0");
    state.status = "queued";
    state.planHash = corpus.plan.planHash;
    state.records = corpus.sources;
    state.approvedAt = Date.now();
    state.attempts = 0;
    state.parent = corpus.parent;
    delete state.error;
    return { round: "t-" + state.round, queued: true };
  });
}
export async function processLearningTraining(repo, owner, providers = {}) {
  const id = trainingStateId(owner);
  let claim;
  await repo.change(id, (state) => {
    if (
      !["queued", "running"].includes(state.status) ||
      (state.status === "running" && (state.lease || 0) > Date.now())
    )
      return;
    if ((state.attempts || 0) >= 3) return;
    if (state.status === "running") {
      state.sequence++;
      state.round = "r" + String(state.sequence).padStart(3, "0");
    }
    state.attempts = (state.attempts || 0) + 1;
    state.status = "running";
    state.fence = randomUUID();
    state.lease = Date.now() + 6 * 3600000;
    claim = structuredClone(state);
  });
  if (!claim) return;
  try {
    const corpus = await trainingCorpus(repo, owner);
    requireThat(
      corpus.plan.planHash === claim.planHash,
      "learning_approval_changed",
    );
    const workspace = trainingWorkspace(repo, owner),
      inputBundle = join(workspace, "inputs", claim.round + "-" + claim.fence);
    await mkdir(inputBundle, { recursive: true, mode: 0o700 });
    await writeJson(join(inputBundle, "records.json"), {
      records: corpus.records,
    });
    await writeJson(join(inputBundle, "registry.json"), corpus.registry);
    await writeJson(join(inputBundle, "manifest.json"), {
      schema: "alpha-human-approved-v1",
      planHash: claim.planHash,
    });
    await writeJson(
      join(inputBundle, "split-map.json"),
      Object.fromEntries(
        corpus.records.map((record) => [record.id, meetingFold(record.id)]),
      ),
    );
    await writeLines(join(inputBundle, "asr-candidates.jsonl"), corpus.asr);
    await writeLines(join(inputBundle, "reviews.jsonl"), corpus.reviews);
    const result = await (providers.learningTraining || learningBridge)({
      workspace,
      round: claim.round,
      parent: claim.parent,
      inputBundle,
      prepareOnly: false,
      perRecord: 1000,
    });
    const stillCurrent =
      (await trainingCorpus(repo, owner)).plan.planHash === claim.planHash;
    await repo.change(id, (state) => {
      if (state.fence !== claim.fence) return;
      state.status = stillCurrent ? "completed" : "stale";
      if (stillCurrent) {
        state.history = [
          ...(state.history || []),
          {
            round: claim.round,
            records: claim.records,
            planHash: claim.planHash,
            trained: result.report?.trained === true,
            completedAt: Date.now(),
            completedAt: Date.now(),
          },
        ].slice(-20);
        if (result.report?.trained) state.lastTrainedRound = claim.round;
      }
      delete state.fence;
      delete state.lease;
    });
  } catch (error) {
    await repo.change(id, (state) => {
      if (state.fence !== claim.fence) return;
      state.status = "failed";
      state.error = error.code || "learning_training_failed";
      delete state.fence;
      delete state.lease;
    });
  }
}
export async function runLearningCycle(repo, providers = {}) {
  for (const record of await repo.listWork({ lane: 'learning' }))
    if (!record.deleted && record.capture === "completed")
      await processLearningRecord(repo, record.id, providers);
  for (const state of await repo.list("learning-training"))
    if (["queued", "running"].includes(state.status))
      await processLearningTraining(repo, state.owner, providers);
}
