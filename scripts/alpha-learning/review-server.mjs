import { createServer } from "node:http";
import {
  readFile,
  readdir,
  writeFile,
  rename,
  appendFile,
  mkdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readSnapshot, segmentPcm, wav, sha } from "./intake.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const idPattern = /^r\d{3,6}$/;
const readJson = (path) => readFile(path, "utf8").then(JSON.parse);
const readLines = (path) =>
  readFile(path, "utf8").then((text) =>
    text.split("\n").filter(Boolean).map(JSON.parse),
  );
const exists = (path) =>
  readFile(path).then(
    () => true,
    () => false,
  );

export async function createLearningReviewServer({
  workspace,
  port = 0,
  launchNext,
} = {}) {
  workspace = resolve(workspace || ".data/alpha-learning");
  const token = randomBytes(32).toString("hex");
  let origin,
    queue = Promise.resolve(),
    active = false;
  const roundDir = (name) => {
    if (!idPattern.test(name || "")) throw Error("invalid_round");
    return join(workspace, "rounds", name);
  };
  async function rounds() {
    const names = await readdir(join(workspace, "rounds")).catch(() => []);
    return Promise.all(
      names
        .filter((name) => idPattern.test(name))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map(async (name) => {
          const dir = roundDir(name);
          const report = await readJson(join(dir, "round-report.json")).catch(
            () => null,
          );
          const meta = await readJson(join(dir, "round.json")).catch(
            () => ({}),
          );
          return { name, status: report ? "已完成" : meta.status || "准备中" };
        }),
    );
  }
  async function data(name) {
    const dir = roundDir(name);
    let cases;
    if (await exists(join(dir, "annotation-results.jsonl")))
      cases = await readLines(join(dir, "annotation-results.jsonl"));
    else if (await exists(join(dir, "dataset/cases.jsonl")))
      cases = await readLines(join(dir, "dataset/cases.jsonl"));
    else cases = await readLines(join(dir, "prelabel/cases.jsonl"));
    const reviews = await readLines(join(dir, "reviews.jsonl")).catch(() => []),
      byId = new Map(reviews.map((row) => [row.sample_id, row]));
    return {
      cases: cases.map((row) => ({
        ...row,
        target: row.target ?? null,
        ...(byId.get(row.sample_id) || {}),
      })),
      report: await readJson(join(dir, "round-report.json")).catch(() => null),
    };
  }
  const send = (res, status, value) => {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  };
  async function body(req) {
    const parts = [];
    let size = 0;
    for await (const bytes of req) {
      size += bytes.length;
      if (size > 1024 * 1024) throw Error("body_too_large");
      parts.push(bytes);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  }
  const server = createServer(async (req, res) => {
    try {
      const host = new URL(origin).host;
      if (req.headers.host !== host)
        return send(res, 403, { error: "host_rejected" });
      const url = new URL(req.url, origin);
      if (
        req.method === "POST" &&
        (req.headers.origin !== origin ||
          req.headers["x-learning-token"] !== token)
      )
        return send(res, 403, { error: "origin_or_token_rejected" });
      if (url.pathname === "/api/bootstrap")
        return send(res, 200, { token, rounds: await rounds() });
      if (url.pathname === "/api/round" && req.method === "GET")
        return send(res, 200, await data(url.searchParams.get("name")));
      if (url.pathname === "/api/reviews" && req.method === "POST") {
        const input = await body(req),
          round = roundDir(input.round),
          review = input.review;
        const found = (await data(input.round)).cases.find(
          (row) => row.sample_id === review?.sample_id,
        );
        if (!found || found.input_hash !== review.input_hash)
          throw Error("stale_review");
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
        const cleaned = {
          sample_id: found.sample_id,
          input_hash: found.input_hash,
          target: review.target,
          reviewer: review.reviewer.trim(),
          note: review.note,
          correctedText: review.correctedText,
          audioVerified: review.audioVerified === true,
          blindReview: review.blindReview === true,
          updatedAt: new Date().toISOString(),
        };
        const save = async () => {
          const path = join(round, "reviews.jsonl");
          const previous = await readLines(path).catch(() => []);
          const map = new Map(previous.map((row) => [row.sample_id, row]));
          map.set(cleaned.sample_id, cleaned);
          await appendFile(
            join(round, "review-history.jsonl"),
            JSON.stringify({ ...cleaned, eventId: randomUUID() }) + "\n",
            { mode: 0o600 },
          );
          const temp = path + "." + randomUUID() + ".tmp";
          await writeFile(
            temp,
            [...map.values()].map((row) => JSON.stringify(row) + "\n").join(""),
            { mode: 0o600, flag: "wx" },
          );
          await rename(temp, path);
        };
        const pending = queue.then(save);
        queue = pending.catch(() => {});
        await pending;
        return send(res, 200, { saved: true });
      }
      if (url.pathname === "/api/audio" && req.method === "GET") {
        const name = url.searchParams.get("round"),
          dir = roundDir(name),
          row = (await data(name)).cases.find(
            (value) => value.sample_id === url.searchParams.get("sample"),
          );
        if (!row) throw Error("case_not_found");
        const meta = await readJson(join(dir, "round.json"));
        if (
          !/^[a-zA-Z0-9_-]+$/.test(meta.intake) ||
          !/^[a-zA-Z0-9_-]+$/.test(meta.asr)
        )
          throw Error("invalid_source_registry");
        const intake = join(workspace, meta.intake),
          registry = await readJson(join(intake, "registry.json"));
        const entry = registry[row.source.recordId];
        if (!entry) throw Error("source_missing");
        const current = readSnapshot(entry.root).find(
          (record) => record.id === row.source.recordId,
        );
        if (!current) throw Error("source_deleted_or_expired");
        const snapshot = (
          await readJson(join(intake, "records.json"))
        ).records.find((record) => record.id === row.source.recordId);
        if (!snapshot || snapshot.generation !== current.generation)
          throw Error("source_generation_changed");
        const audio = row.display.audio;
        let bytes;
        if (audio && /^[a-f0-9]{64}\.wav$/.test(audio.file)) {
          bytes = await readFile(join(workspace, meta.asr, audio.file));
          if (
            bytes.length < 44 ||
            bytes.toString("ascii", 0, 4) !== "RIFF" ||
            bytes.toString("ascii", 8, 12) !== "WAVE" ||
            sha(bytes.subarray(44)) !== audio.sha256
          )
            throw Error("audio_corrupt");
        } else {
          const segment = snapshot.segments.find(
            (value) => value.id === row.source.focus.segmentId,
          );
          bytes = wav(await segmentPcm(entry.root, snapshot, segment));
        }
        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": bytes.length,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        return res.end(bytes);
      }
      if (url.pathname === "/api/next" && req.method === "POST") {
        const input = await body(req);
        await readJson(join(roundDir(input.parent), "round.json"));
        if (active) return send(res, 409, { error: "已有学习轮次正在运行" });
        const all = await rounds();
        const number =
          Math.max(0, ...all.map((value) => Number(value.name.slice(1)))) + 1;
        const name = "r" + String(number).padStart(3, "0");
        active = true;
        const launch =
          launchNext ||
          ((parent, round) => {
            const child = spawn(
              process.execPath,
              [
                join(here, "run.mjs"),
                "--workspace",
                workspace,
                "--parent",
                parent,
                "--round",
                round,
                "--accept-silver",
              ],
              {
                cwd: resolve(here, "../.."),
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            child.stdout.on("data", (bytes) =>
              appendFile(join(workspace, "bridge.log"), bytes, {
                mode: 0o600,
              }).catch(() => {}),
            );
            child.stderr.on("data", (bytes) =>
              appendFile(join(workspace, "bridge.log"), bytes, {
                mode: 0o600,
              }).catch(() => {}),
            );
            return new Promise((resolve, reject) => {
              child.once("error", reject);
              child.once("exit", (code) =>
                code === 0 ? resolve() : reject(Error("learning_round_failed")),
              );
            });
          });
        Promise.resolve()
          .then(() => launch(input.parent, name))
          .catch(() => {})
          .finally(() => {
            active = false;
          });
        return send(res, 202, { round: name });
      }
      const assets = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/style.css": ["style.css", "text/css; charset=utf-8"],
        "/app.mjs": ["app.mjs", "text/javascript; charset=utf-8"],
      };
      if (req.method === "GET" && assets[url.pathname]) {
        const [name, type] = assets[url.pathname],
          bytes = await readFile(join(here, "review-assets", name));
        res.writeHead(200, {
          "Content-Type": type,
          "Content-Length": bytes.length,
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          "X-Content-Type-Options": "nosniff",
        });
        return res.end(bytes);
      }
      return send(res, 404, { error: "not_found" });
    } catch (error) {
      return send(res, 400, {
        error: /^[a-z_]+$/.test(error.message)
          ? error.message
          : "请求未完成，请核对样本版本或原音可用状态",
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    url: origin,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workspace = resolve(process.argv[2] || ".data/alpha-learning");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const port = Number(process.argv[3] || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw Error("invalid_port");
  const app = await createLearningReviewServer({ workspace, port });
  await writeFile(
    join(workspace, "review-server-state.json"),
    JSON.stringify({
      pid: process.pid,
      url: app.url,
      startedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ reviewUrl: app.url, loopbackOnly: true }));
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => app.close().then(() => process.exit(0)));
}
