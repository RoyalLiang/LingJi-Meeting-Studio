import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { encodeStorage } from "../services/records/src/storage-codec.mjs";
import {
  readSnapshot,
  exportSnapshots,
  segmentPcm,
  wav,
  sha,
} from "../scripts/alpha-learning/intake.mjs";
import { createLearningReviewServer } from "../scripts/alpha-learning/review-server.mjs";
import { shellQuote } from "../scripts/alpha-learning/run.mjs";

test("Alpha intake reads compressed/plain records without changing the source and excludes account/provider data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alpha-intake-"));
  try {
    const root = join(dir, "source");
    await mkdir(root);
    const path = join(root, "records.sqlite");
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE aggregates(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE aggregate_payloads(id TEXT PRIMARY KEY,payload BLOB)",
    );
    const value = {
      id: randomUUID(),
      kind: "record",
      owner: "never-export-account",
      deleteAt: "2099-01-01T00:00:00Z",
      generation: 1,
      capture: "completed",
      transcriptRevision: 1,
      segments: [
        {
          id: "s1",
          revision: 1,
          text: "Synthetic text. ".repeat(200),
          startMs: 0,
          endMs: 1000,
        },
      ],
      notes: "never-export-notes",
      shares: [{ token: "never-export-token" }],
      sources: [],
      chunks: [],
    };
    const packed = encodeStorage(Buffer.from(JSON.stringify(value)));
    assert.ok(packed.compressed);
    db.prepare("INSERT INTO aggregates VALUES(?,?)").run(
      value.id,
      JSON.stringify({
        id: value.id,
        kind: "record",
        deleteAt: value.deleteAt,
        $payload: "deflate-v1",
      }),
    );
    db.prepare("INSERT INTO aggregate_payloads VALUES(?,?)").run(
      value.id,
      packed.bytes,
    );
    db.prepare("INSERT INTO aggregates VALUES(?,?)").run(
      "user",
      JSON.stringify({ kind: "user", apiKey: "never-export-key" }),
    );
    db.prepare("INSERT INTO aggregates VALUES(?,?)").run(
      "deleted",
      JSON.stringify({ ...value, id: "deleted", deleted: true }),
    );
    db.close();
    const before = sha(await readFile(path));
    const values = readSnapshot(root);
    assert.equal(values.length, 1);
    assert.equal(values[0].segments[0].text, value.segments[0].text);
    const output = join(dir, "snapshot");
    const manifest = await exportSnapshots([root], output);
    const raw = await readFile(join(output, "records.json"));
    assert.equal(manifest.snapshotSha256, sha(raw));
    assert.ok(!raw.toString().includes("never-export"));
    assert.equal(sha(await readFile(path)), before);
    assert.equal(
      (await stat(join(output, "records.json"))).mode & 0o777,
      0o600,
    );
    await assert.rejects(exportSnapshots([root], output), { code: "EEXIST" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("audio spans reconstruct exact original PCM and fail on gaps/corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-audio-"));
  try {
    const id = randomUUID();
    await mkdir(join(root, "audio", id), { recursive: true });
    const chunks = [];
    for (let i = 0; i < 2; i++) {
      const bytes = Buffer.alloc(32000);
      for (let n = 0; n < 16000; n++) bytes.writeInt16LE(i + 1, n * 2);
      const digest = sha(bytes);
      await writeFile(
        join(root, "audio", id, digest),
        encodeStorage(bytes).bytes,
      );
      chunks.push({
        sourceId: "source",
        sampleRate: 16000,
        sampleOffset: i * 16000,
        sampleCount: 16000,
        digest,
        object: id + "/" + digest,
      });
    }
    const record = {
      id,
      sources: [{ id: "source", timelineOffsetMs: 1000 }],
      chunks,
    };
    const segment = { sourceId: "source", startMs: 1500, endMs: 2500 };
    const bytes = await segmentPcm(root, record, segment);
    assert.equal(bytes.length, 32000);
    assert.equal(bytes.readInt16LE(0), 1);
    assert.equal(bytes.readInt16LE(15998), 1);
    assert.equal(bytes.readInt16LE(16000), 2);
    assert.equal(wav(bytes).readUInt32LE(24), 16000);
    await assert.rejects(
      segmentPcm(root, { ...record, chunks: [chunks[0]] }, segment),
      /audio_unavailable/,
    );
    await writeFile(
      join(root, "audio", chunks[1].object),
      Buffer.from("corrupt"),
    );
    await assert.rejects(
      segmentPcm(root, record, segment),
      (error) => error.code === "storage_corrupt",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local review enforces origin/token, source identity and persists independent concurrent annotations", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "alpha-review-"));
  let app;
  try {
    const round = join(workspace, "rounds/r001");
    await mkdir(round, { recursive: true });
    const one = {
      sample_id: "a",
      input_hash: "hash-a",
      family: "intent",
      task: "decision",
      split: "train",
      source: {
        recordId: "record",
        focus: { segmentId: "s", revision: 1 },
        transcriptRevision: 1,
      },
      request: {
        state: "Synthetic",
        questions: { decision: { criteria: { present: "yes", absent: "no" } } },
      },
      display: { original: "<img src=x onerror=alert(1)> synthetic" },
      target: null,
    };
    await writeFile(
      join(round, "annotation-results.jsonl"),
      [one, { ...one, sample_id: "b", input_hash: "hash-b" }]
        .map((value) => JSON.stringify(value) + "\n")
        .join(""),
    );
    await writeFile(join(round, "round.json"), "{}");
    app = await createLearningReviewServer({
      workspace,
      launchNext: async () => {},
    });
    const boot = await (await fetch(app.url + "/api/bootstrap")).json();
    const headers = {
      Origin: app.url,
      "X-Learning-Token": boot.token,
      "Content-Type": "application/json",
    };
    const review = (sample_id, input_hash) => ({
      round: "r001",
      review: {
        sample_id,
        input_hash,
        target: "present",
        reviewer: "synthetic-test",
        audioVerified: false,
        blindReview: false,
        note: "",
        correctedText: "",
      },
    });
    const post = (value, extra = {}) =>
      fetch(app.url + "/api/reviews", {
        method: "POST",
        headers: { ...headers, ...extra },
        body: JSON.stringify(value),
      });
    assert.equal(
      (await post(review("a", "hash-a"), { Origin: "http://evil.invalid" }))
        .status,
      403,
    );
    assert.equal((await post(review("a", "stale"))).status, 400);
    const responses = await Promise.all([
      post(review("a", "hash-a")),
      post(review("b", "hash-b")),
    ]);
    assert.ok(responses.every((value) => value.status === 200));
    const saved = (await readFile(join(round, "reviews.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(saved.length, 2);
    const html = await (await fetch(app.url + "/")).text();
    assert.ok(!html.includes("<img src=x"));
    assert.match(
      (await fetch(app.url + "/")).headers.get("content-security-policy"),
      /default-src 'self'/,
    );
    assert.equal(
      (await stat(join(round, "reviews.jsonl"))).mode & 0o777,
      0o600,
    );
  } finally {
    if (app) await app.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("remote shell arguments quote literal command metacharacters", () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(shellQuote("$(touch /tmp/never)"), "'$(touch /tmp/never)'");
});

test("cached review audio validates source generation and PCM hash", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "alpha-review-audio-"));
  let app, db;
  try {
    const root = join(workspace, "source");
    await mkdir(root);
    db = new DatabaseSync(join(root, "records.sqlite"));
    db.exec("CREATE TABLE aggregates(id TEXT PRIMARY KEY,data TEXT)");
    const record = {
      id: randomUUID(),
      kind: "record",
      generation: 1,
      deleteAt: "2099-01-01T00:00:00Z",
      capture: "completed",
      segments: [],
      sources: [],
      chunks: [],
    };
    const save = () =>
      db
        .prepare("INSERT OR REPLACE INTO aggregates VALUES(?,?)")
        .run(record.id, JSON.stringify(record));
    save();
    const dir = join(workspace, "rounds/r001"),
      intake = join(workspace, "intake"),
      asr = join(workspace, "asr");
    for (const path of [dir, intake, asr])
      await mkdir(path, { recursive: true });
    const pcm = Buffer.alloc(320),
      file = "a".repeat(64) + ".wav";
    const row = {
      sample_id: "clip",
      input_hash: "clip-hash",
      family: "asr",
      source: { recordId: record.id },
      display: { audio: { file, sha256: sha(pcm) } },
    };
    await writeFile(
      join(dir, "annotation-results.jsonl"),
      JSON.stringify(row) + "\n",
    );
    await writeFile(
      join(dir, "round.json"),
      JSON.stringify({ intake: "intake", asr: "asr" }),
    );
    await writeFile(
      join(intake, "registry.json"),
      JSON.stringify({ [record.id]: { root } }),
    );
    await writeFile(
      join(intake, "records.json"),
      JSON.stringify({ records: [record] }),
    );
    await writeFile(join(asr, file), wav(pcm));
    app = await createLearningReviewServer({ workspace });
    const url = app.url + "/api/audio?round=r001&sample=clip";
    assert.equal((await fetch(url)).status, 200);
    await writeFile(join(asr, file), wav(Buffer.alloc(320, 1)));
    assert.equal((await (await fetch(url)).json()).error, "audio_corrupt");
    await writeFile(join(asr, file), wav(pcm));
    record.generation = 2;
    save();
    assert.equal(
      (await (await fetch(url)).json()).error,
      "source_generation_changed",
    );
    record.deleted = true;
    save();
    assert.equal(
      (await (await fetch(url)).json()).error,
      "source_deleted_or_expired",
    );
  } finally {
    if (app) await app.close();
    if (db) db.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
