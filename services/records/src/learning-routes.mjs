import { recordingWaveform } from './waveform.mjs';
import { join } from "node:path";
import { emit, requireThat } from "../../../packages/records/src/record.mjs";
import {
  queueLearningReview,
  publicLearning,
} from "../../../packages/records/src/learning.mjs";
import {
  loadReviewRound,
  saveReviews,
  roundDirectory,
  readJson,
} from "../../../scripts/alpha-learning/review-store.mjs";
import {
  segmentPcm,
  wav,
  sha,
} from "../../../scripts/alpha-learning/intake.mjs";
import {
  reviewLocation,
  learningRounds,
  trainingCorpus,
  queueHumanTraining,
  trainingStateId,
} from "./learning-worker.mjs";
export async function learningRoutes({
  req,
  res,
  url,
  action,
  repo,
  user,
  record,
  readBody,
  send,
  csrf,
  requireLearning,
  learningService,
}) {
  if (!action.startsWith("learning/")) return false;
  const route = action.slice("learning/".length);
  if (req.method === "POST") await requireLearning();
  if (route === "bootstrap" && req.method === "GET") {
    const status = record.learning?.status || "waiting";
    const training = await repo.get(trainingStateId(user.id));
    send(res, 200, {
      integrated: true,
      service: learningService.read(),
      training: training
        ? {
            status: training.status,
            round: "t-" + training.round,
            error: training.error || null,
          }
        : null,
      title: record.title,
      csrf,
      rounds: await learningRounds(repo, record),
      status: status === "queued" ? "running" : status,
      message:
        status === "failed"
          ? "待标注生成失败，请检查学习服务连接后重试。"
          : status === "waiting"
            ? "会议结束并排空转录后，自动生成待标注结果。"
            : undefined,
    });
    return true;
  }
  if (route === "prepare" && req.method === "POST") {
    requireThat(repo.backend === "sqlite", "learning_requires_local_store");
    requireThat(record.capture === "completed", "learning_wait_for_transcript");
    await repo.change(record.id, (value) => {
      requireThat(
        !value.deleted && value.owner === user.id,
        "record_deleted",
        410,
      );
      if (
        value.learning?.status === "running" &&
        value.learning.lease > Date.now()
      )
        return;
      value.learning = { ...value.learning, enabled: true, fingerprint: null };
      if (queueLearningReview(value, true)) emit(value, "learning.queued");
    });
    send(res, 202, { queued: true });
    return true;
  }
  if (route === "plan" && req.method === "GET") {
    const corpus = await trainingCorpus(repo, user.id);
    send(res, 200, corpus.plan);
    return true;
  }
  if (route === "next" && req.method === "POST") {
    requireThat(repo.backend === "sqlite", "learning_requires_local_store");
    send(
      res,
      202,
      await queueHumanTraining(repo, user.id, await readBody(req, 4000)),
    );
    return true;
  }
  if (["round", "reviews", "audio"].includes(route)) {
    const input = req.method === "POST" ? await readBody(req, 100000) : null,
      name =
        input?.round ||
        url.searchParams.get("name") ||
        url.searchParams.get("round");
    const location = await reviewLocation(repo, record, name),
      data = await loadReviewRound(location.workspace, location.round),
      cases = data.cases.filter((row) => row.source.recordId === record.id);
    if (route === "round" && req.method === "GET") {
      send(res, 200, {
        cases,
        report: data.report,
        status: record.learning.status,
      });
      return true;
    }
    if (route === "reviews" && req.method === "POST") {
      const reviews = input.reviews || [input.review];
      requireThat(
        Array.isArray(reviews) &&
          reviews.every((review) =>
            cases.some(
              (row) =>
                row.sample_id === review?.sample_id &&
                row.input_hash === review.input_hash,
            ),
          ),
        "stale_review",
      );
      send(
        res,
        200,
        await saveReviews(location.workspace, location.round, reviews),
      );
      return true;
    }
    if (route === "audio" && req.method === "GET") {
      requireThat(
        record.retainAudio && !record.audioPurged,
        "audio_unavailable",
        404,
      );
      const row = cases.find(
        (value) => value.sample_id === url.searchParams.get("sample"),
      );
      requireThat(row?.source.audioSha256, "audio_unavailable", 404);
      const dir = roundDirectory(location.workspace, location.round),
        snapshot = (await readJson(join(dir, "records.json"))).records.find(
          (value) => value.id === record.id,
        );
      requireThat(
        snapshot?.generation === record.generation,
        "learning_snapshot_changed",
      );
      const focus = snapshot.segments.find(
        (segment) =>
          segment.id === row.source.focus.segmentId &&
          segment.revision === row.source.focus.revision,
      );
      requireThat(focus, "learning_snapshot_changed");
      const pcm = await segmentPcm(repo.root, snapshot, focus);
      requireThat(sha(pcm) === row.source.audioSha256, "audio_corrupt");
      if(url.searchParams.get('waveform')==='1'){
        send(res,200,await recordingWaveform([{object:'clip',sampleOffset:0,sampleCount:pcm.length/2}],async()=>pcm));return true;
      }
      const bytes = wav(pcm);
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": bytes.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(bytes);
      return true;
    }
  }
  requireThat(false, "not_found", 404);
}
export { publicLearning };
