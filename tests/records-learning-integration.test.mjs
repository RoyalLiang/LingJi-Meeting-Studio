import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createRepository } from "../services/records/src/repository.mjs";
import {
  createRecord,
  addSource,
  acknowledge,
  seal,
  commitTranscript,
  publicRecord,
  digest,
} from "../packages/records/src/record.mjs";
import {
  processLearningRecord,
  processLearningTraining,
  trainingCorpus,
  queueHumanTraining,
  trainingStateId,
  learningWorkspace,
  meetingFold,
} from "../services/records/src/learning-worker.mjs";
import {
  saveReviews,
  loadReviewRound,
} from "../scripts/alpha-learning/review-store.mjs";
import { recoverLocalWork } from "../services/records/src/desktop-backend.mjs";
import { createRecordServer } from "../services/records/src/server.mjs";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alpha-integrated-"));
  const repo = await createRepository({ root });
  return {
    root,
    repo,
    close: async () => {
      await repo.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function meeting(repo, owner = "synthetic-owner", completed = true) {
  const record = createRecord(owner, {
    learningEnabled: true,
    retainAudio: true,
    title: "合成测试会议",
  });
  while (meetingFold(record.id) !== "train") record.id = randomUUID();
  const source = addSource(record, { kind: "microphone", label: "合成音轨" });
  const pcm = Buffer.alloc(32000),
    object = await repo.putAudio(record.id, pcm);
  acknowledge(record, {
    sourceId: source.id,
    sessionId: source.sessionId,
    epoch: source.epoch,
    sequence: 0,
    sampleOffset: 0,
    sampleCount: 16000,
    sampleRate: 16000,
    ...object,
  });
  seal(record, [{ sourceId: source.id, epoch: source.epoch, lastSequence: 0 }]);
  if (completed)
    commitTranscript(
      record,
      record.chunks[0].key,
      "为啥为啥他他他这些 IP 全全不通呢？",
      record.generation,
    );
  await repo.insert(record);
  return record;
}
function cases(record) {
  const focus = record.segments[0],
    source = {
      recordId: record.id,
      transcriptRevision: record.transcriptRevision,
      focus: { segmentId: focus.id, revision: focus.revision },
      audioSha256: digest(Buffer.alloc(32000)),
    };
  return ["decision", "asr_selection"].map((task) => ({
    sample_id: record.id + task,
    input_hash: record.id + task,
    family: task === "decision" ? "intent" : "asr",
    task,
    split: meetingFold(record.id),
    source,
    request: {
      state: focus.text,
      questions: {
        [task]: {
          type: "choice",
          instructions: "合成测试",
          criteria:
            task === "decision"
              ? { present: "存在", absent: "不存在" }
              : { c0: focus.text, none: "无法判断" },
        },
      },
    },
    display: {
      original: focus.text,
      meetingTitle: record.title,
      candidates: [focus.text],
    },
    target: null,
    teacherTarget: task === "decision" ? "present" : "c0",
  }));
}
async function prepared(repo, options) {
  const record = await repo.get(options.recordId),
    dir = join(options.workspace, "rounds", options.round);
  await mkdir(join(dir, "dataset"), { recursive: true });
  const rows = cases(record);
  await writeFile(
    join(dir, "annotation-results.jsonl"),
    rows.map(JSON.stringify).join("\n") + "\n",
  );
  await writeFile(
    join(dir, "records.json"),
    JSON.stringify({ records: [record] }),
  );
  await writeFile(
    join(dir, "round.json"),
    JSON.stringify({ round: options.round, status: "已完成" }),
  );
  await writeFile(
    join(dir, "round-report.json"),
    JSON.stringify({ trained: false, goldTestReady: false }),
  );
  await writeFile(
    join(dir, "dataset/asr-candidates.jsonl"),
    JSON.stringify({
      recordId: record.id,
      segmentId: record.segments[0].id,
      revision: record.segments[0].revision,
      candidates: [{ text: record.segments[0].text, source: "stored_asr" }],
    }) + "\n",
  );
  return { cases: rows, report: { trained: false } };
}
const reviewed = (rows) =>
  rows.map((row) => ({
    sample_id: row.sample_id,
    input_hash: row.input_hash,
    target: row.family === "intent" ? "present" : "c0",
    reviewer: "合成核对测试",
    audioVerified: true,
    blindReview: false,
    correctedText: "",
    note: "",
  }));
test("meeting-end preparation waits for drain, is idempotent and never trains weak labels", async () => {
  const f = await fixture();
  try {
    const record = await meeting(f.repo, "synthetic-owner", false);
    let calls = 0;
    const providers = {
      learningPreparation: async (opts) => {
        calls++;
        return prepared(f.repo, opts);
      },
    };
    assert.equal(
      await processLearningRecord(f.repo, record.id, providers),
      false,
    );
    assert.equal(calls, 0);
    await f.repo.change(record.id, (r) =>
      commitTranscript(r, r.chunks[0].key, "合成发言", r.generation),
    );
    await Promise.all([
      processLearningRecord(f.repo, record.id, providers),
      processLearningRecord(f.repo, record.id, providers),
    ]);
    assert.equal(calls, 1);
    assert.equal((await f.repo.get(record.id)).learning.status, "ready");
    assert.equal(
      (await trainingCorpus(f.repo, record.owner)).plan.ready,
      false,
    );
    assert.equal(await f.repo.get(trainingStateId(record.owner)), null);
    const visible = JSON.stringify(publicRecord(await f.repo.get(record.id)));
    assert.ok(!visible.includes("fingerprint"));
    assert.ok(!visible.includes("fence"));
  } finally {
    await f.close();
  }
});
test("source edit during preparation fences old results; retry allocates a fresh round", async () => {
  const f = await fixture();
  try {
    const record = await meeting(f.repo);
    let release, started;
    const start = new Promise((resolve) => {
      started = resolve;
    });
    const work = processLearningRecord(f.repo, record.id, {
      learningPreparation: async (opts) => {
        const result = await prepared(f.repo, opts);
        started();
        await new Promise((resolve) => {
          release = resolve;
        });
        return result;
      },
    });
    await start;
    await f.repo.change(record.id, (r) => {
      r.segments[0].text = "人工修订";
      r.segments[0].revision++;
      r.transcriptRevision++;
    });
    release();
    await work;
    assert.notEqual((await f.repo.get(record.id)).learning.status, "ready");
    await processLearningRecord(f.repo, record.id, {
      learningPreparation: (opts) => prepared(f.repo, opts),
    });
    const latest = await f.repo.get(record.id);
    assert.equal(latest.learning.status, "ready");
    assert.equal(latest.learning.round, "r002");
    assert.equal(latest.segments[0].text, "人工修订");
  } finally {
    await f.close();
  }
});
test("human-only corpus isolates owners and invalidates approval after feedback changes", async () => {
  const f = await fixture();
  try {
    const record = await meeting(f.repo),
      other = await meeting(f.repo, "another-owner");
    for (const r of [record, other])
      await processLearningRecord(f.repo, r.id, {
        learningPreparation: (opts) => prepared(f.repo, opts),
      });
    const data = await loadReviewRound(
      learningWorkspace(f.repo, record.id),
      "r001",
    );
    await saveReviews(
      learningWorkspace(f.repo, record.id),
      "r001",
      reviewed(data.cases),
    );
    const corpus = await trainingCorpus(f.repo, record.owner);
    assert.deepEqual(corpus.plan.counts, { intent: 1, asr: 1 });
    assert.equal(corpus.records.length, 1);
    await assert.rejects(
      queueHumanTraining(f.repo, record.owner, {
        confirmed: false,
        planHash: corpus.plan.planHash,
      }),
      (error) => error.code === "human_review_required",
    );
    await queueHumanTraining(f.repo, record.owner, {
      confirmed: true,
      planHash: corpus.plan.planHash,
    });
    const changed = reviewed(data.cases);
    changed[0].target = "absent";
    await saveReviews(learningWorkspace(f.repo, record.id), "r001", changed);
    let trained = false;
    await processLearningTraining(f.repo, record.owner, {
      learningTraining: async () => {
        trained = true;
      },
    });
    assert.equal(trained, false);
    assert.equal(
      (await f.repo.get(trainingStateId(record.owner))).status,
      "failed",
    );
  } finally {
    await f.close();
  }
});
test("integrated learning routes enforce account and CSRF and serve grouped UI assets", async () => {
  const f = await fixture();
  let app;
  try {
    app = await createRecordServer({
      repo: f.repo,
      port: 0,
      localAccount: true,
      learningProbe: async () => true,
    });
    const address = await app.start(),
      base = "http://127.0.0.1:" + address.port,
      cookie = await app.localSession();
    const boot = await (
      await fetch(base + "/api/bootstrap", { headers: { cookie } })
    ).json();
    const user = (await f.repo.list("user"))[0];
    assert.ok(user);
    const record = await meeting(f.repo, user.id),
      other = await meeting(f.repo, "different-owner");
    await processLearningRecord(f.repo, record.id, {
      learningPreparation: (opts) => prepared(f.repo, opts),
    });
    const path = base + "/api/records/" + record.id + "/learning";
    assert.equal(
      (
        await fetch(base + "/api/records/" + other.id + "/learning/bootstrap", {
          headers: { cookie },
        })
      ).status,
      404,
    );
    assert.equal(
      (await fetch(path + "/view", { headers: { cookie } })).status,
      404,
    );
    const data = await (
      await fetch(path + "/round?name=r001", { headers: { cookie } })
    ).json();
    const audioCase=data.cases.find(row=>row.family==='asr');
    const waveform=await (await fetch(path+`/audio?round=r001&sample=${encodeURIComponent(audioCase.sample_id)}&waveform=1`,{headers:{cookie}})).json();
    assert.equal(waveform.peaks.length,192);assert.equal(waveform.sampleRate,16000);
    const body = { round: "r001", reviews: reviewed(data.cases) };
    assert.equal(
      (
        await fetch(path + "/reviews", {
          method: "POST",
          headers: { cookie, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
      403,
    );
    const headers = {
      cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": boot.csrf,
    };
    assert.equal(
      (
        await fetch(path + "/reviews", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
      ).status,
      200,
    );
    const plan = await (
      await fetch(path + "/plan", { headers: { cookie } })
    ).json();
    assert.equal(plan.ready, true);
    assert.equal(
      (
        await fetch(path + "/next", {
          method: "POST",
          headers,
          body: JSON.stringify({ planHash: plan.planHash }),
        })
      ).status,
      409,
    );
  } finally {
    if (app) await app.stop();
    else await f.repo.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("approved human training publishes a new round and later feedback is inherited", async () => {
  const f = await fixture();
  try {
    const record = await meeting(f.repo);
    await processLearningRecord(f.repo, record.id, {
      learningPreparation: (opts) => prepared(f.repo, opts),
    });
    const original = await loadReviewRound(
      learningWorkspace(f.repo, record.id),
      "r001",
    );
    await saveReviews(
      learningWorkspace(f.repo, record.id),
      "r001",
      reviewed(original.cases),
    );
    const corpus = await trainingCorpus(f.repo, record.owner);
    await queueHumanTraining(f.repo, record.owner, {
      confirmed: true,
      planHash: corpus.plan.planHash,
    });
    let called = 0;
    await processLearningTraining(f.repo, record.owner, {
      learningTraining: async (opts) => {
        called++;
        const reviews = (
          await readFile(join(opts.inputBundle, "reviews.jsonl"), "utf8")
        )
          .trim()
          .split("\n")
          .map(JSON.parse);
        assert.equal(reviews.length, 2);
        assert.ok(reviews.every((row) => row.reviewer === "合成核对测试"));
        assert.equal(opts.prepareOnly, false);
        const dir = join(opts.workspace, "rounds", opts.round);
        await mkdir(join(dir, "dataset"), { recursive: true });
        await writeFile(
          join(dir, "records.json"),
          await readFile(join(opts.inputBundle, "records.json")),
        );
        await writeFile(
          join(dir, "dataset/asr-candidates.jsonl"),
          await readFile(join(opts.inputBundle, "asr-candidates.jsonl")),
        );
        await writeFile(
          join(dir, "round.json"),
          JSON.stringify({ round: opts.round }),
        );
        await writeFile(
          join(dir, "round-report.json"),
          JSON.stringify({ trained: true }),
        );
        const lookup = new Map(reviews.map((row) => [row.sample_id, row]));
        await writeFile(
          join(dir, "annotation-results.jsonl"),
          original.cases
            .map((row) =>
              JSON.stringify({ ...row, ...lookup.get(row.sample_id) }),
            )
            .join("\n") + "\n",
        );
        return { cases: original.cases, report: { trained: true } };
      },
    });
    assert.equal(called, 1);
    const state = await f.repo.get(trainingStateId(record.owner));
    assert.equal(state.status, "completed");
    assert.equal(state.lastTrainedRound, "r001");
    const next = await trainingCorpus(f.repo, record.owner);
    assert.equal(next.parent, "r001");
    assert.equal(next.reviews.length, 2);
  } finally {
    await f.close();
  }
});

test("restart recovery revokes old leases and allocates a fresh approved training round", async () => {
  const f = await fixture();
  try {
    const record = await meeting(f.repo);
    await f.repo.change(record.id, (r) => {
      r.learning.status = "running";
      r.learning.lease = Date.now() + 60000;
      r.learning.fence = "old";
    });
    await f.repo.insert({
      id: trainingStateId(record.owner),
      kind: "learning-training",
      owner: record.owner,
      status: "running",
      sequence: 1,
      round: "r001",
      approvedAt: Date.now(),
      planHash: "approved",
      fence: "old",
      lease: Date.now() + 60000,
    });
    await recoverLocalWork(f.repo);
    const r = await f.repo.get(record.id),
      state = await f.repo.get(trainingStateId(record.owner));
    assert.equal(r.learning.status, "queued");
    assert.equal(r.learning.fence, undefined);
    assert.equal(state.status, "queued");
    assert.equal(state.round, "r002");
    assert.equal(state.planHash, "approved");
  } finally {
    await f.close();
  }
});

test("a focus review batch is atomic when one target is invalid", async () => {
  const f = await fixture();
  try {
    const record = await meeting(f.repo);
    await processLearningRecord(f.repo, record.id, {
      learningPreparation: (opts) => prepared(f.repo, opts),
    });
    const workspace = learningWorkspace(f.repo, record.id),
      data = await loadReviewRound(workspace, "r001"),
      reviews = reviewed(data.cases);
    reviews[1].target = "invalid";
    await assert.rejects(
      saveReviews(workspace, "r001", reviews),
      /invalid_review/,
    );
    await assert.rejects(
      readFile(join(workspace, "rounds/r001/reviews.jsonl")),
      { code: "ENOENT" },
    );
    assert.ok(
      (await loadReviewRound(workspace, "r001")).cases.every(
        (row) => row.target === null,
      ),
    );
  } finally {
    await f.close();
  }
});
test("expired source records cannot be included in an approved training corpus", async () => {
  const f = await fixture();
  try {
    const record = await meeting(f.repo);
    await processLearningRecord(f.repo, record.id, {
      learningPreparation: (opts) => prepared(f.repo, opts),
    });
    const workspace = learningWorkspace(f.repo, record.id),
      data = await loadReviewRound(workspace, "r001");
    await saveReviews(workspace, "r001", reviewed(data.cases));
    const old = await trainingCorpus(f.repo, record.owner);
    assert.equal(old.plan.ready, true);
    await f.repo.change(record.id, (r) => {
      r.deleteAt = new Date(Date.now() - 1000).toISOString();
    });
    const current = await trainingCorpus(f.repo, record.owner);
    assert.equal(current.records.length, 0);
    await assert.rejects(
      queueHumanTraining(f.repo, record.owner, {
        confirmed: true,
        planHash: old.plan.planHash,
      }),
      (error) => error.code === "human_review_required",
    );
  } finally {
    await f.close();
  }
});


test('unavailable learning service blocks preparation without changing the queued record', async () => {
  const f=await fixture();let app;
  try {
    let calls=0;
    app=await createRecordServer({repo:f.repo,port:0,localAccount:true,learningProbe:async()=>{calls++;return false;}});
    const address=await app.start(),base=`http://127.0.0.1:${address.port}`,cookie=await app.localSession();
    const boot=await (await fetch(base+'/api/bootstrap',{headers:{cookie}})).json();
    const owner=(await f.repo.list('user'))[0].id,record=await meeting(f.repo,owner);
    const before=JSON.stringify((await f.repo.get(record.id)).learning);
    const result=await fetch(`${base}/api/records/${record.id}/learning/prepare`,{method:'POST',headers:{cookie,'X-CSRF-Token':boot.csrf,'Content-Type':'application/json'},body:'{}'});
    assert.equal(result.status,503);assert.equal((await result.json()).error,'learning_service_unavailable');
    assert.equal(JSON.stringify((await f.repo.get(record.id)).learning),before);
    const status=await (await fetch(base+'/api/learning/status',{headers:{cookie}})).json();
    assert.equal(status.available,false);assert.equal(calls,1);
  } finally {if(app)await app.stop();else await f.repo.close();await rm(f.root,{recursive:true,force:true});}
});


test('absent learning service defers queued work without retries or repeated writes',async()=>{
 const f=await fixture();try{
  const {learningServiceFor}=await import('../services/records/src/learning-service.mjs');
  const {runLearningCycle}=await import('../services/records/src/learning-worker.mjs');
  const record=await meeting(f.repo);let probes=0,writes=0;
  learningServiceFor(f.repo,async()=>{probes++;return false;});
  const change=f.repo.change;f.repo.change=(...args)=>{writes++;return change(...args);};
  await runLearningCycle(f.repo);await runLearningCycle(f.repo);
  const saved=await f.repo.get(record.id);
  assert.ok(saved.learning.retryAt>Date.now());assert.equal(saved.learning.attempts,0);
  assert.equal(saved.learning.status,'queued');assert.equal(probes,1);assert.equal(writes,1);
 }finally{await f.close();}
});
