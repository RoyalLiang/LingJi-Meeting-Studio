import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { exportSnapshots, readSnapshot } from "./intake.mjs";
import { collectCandidates, teacherLabels } from "./providers.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = resolve(here, "../..");
export const shellQuote = (value) =>
  "'" + String(value).replace(/'/g, "'\\''") + "'";
const json = (path) => readFile(path, "utf8").then(JSON.parse);
const lines = (path) =>
  readFile(path, "utf8").then((text) =>
    text.split("\n").filter(Boolean).map(JSON.parse),
  );
const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );
const store = async (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const writeLines = async (path, values) =>
  writeFile(
    path,
    values.map((value) => JSON.stringify(value) + "\n").join(""),
    { mode: 0o600 },
  );

async function execute(command, args, log) {
  const fd = openSync(log, "a", 0o600);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repo,
      stdio: ["ignore", fd, fd],
    });
    child.once("error", (error) => {
      closeSync(fd);
      reject(error);
    });
    child.once("exit", (code) => {
      closeSync(fd);
      code === 0 ? resolve() : reject(Error(command + "_failed_" + code));
    });
  });
}

export async function runLearningRound({
  workspace = ".data/alpha-learning",
  round,
  parent,
  refresh = false,
  steps = 100,
  acceptSilver = false,
  host = "wgs",
  remoteBase = "/home/westwell/ai-labs/neohorse-jev-4b",
} = {}) {
  workspace = resolve(workspace);
  if (
    !/^r\d{3,6}$/.test(round || "") ||
    (parent && !/^r\d{3,6}$/.test(parent)) ||
    !Number.isInteger(steps) ||
    steps < 2 ||
    steps > 2000 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host) ||
    !/^\/[a-zA-Z0-9/_.-]+$/.test(remoteBase)
  )
    throw Error("invalid_learning_parameters");
  await mkdir(join(workspace, "rounds"), { recursive: true, mode: 0o700 });
  const dir = join(workspace, "rounds", round);
  await mkdir(dir, { recursive: false, mode: 0o700 });
  const log = join(dir, "bridge.log");
  let meta;
  const remote = (script) =>
    execute(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, script],
      log,
    );
  const upload = (source, destination) =>
    execute("scp", [source, host + ":" + destination], log);
  const download = (source, destination) =>
    execute("scp", [host + ":" + source, destination], log);
  try {
    const previous = parent
      ? await json(join(workspace, "rounds", parent, "round.json"))
      : null;
    const group =
      previous?.remoteGroup ||
      "alpha-" + new Date().toISOString().slice(0, 10).replaceAll("-", "");
    if (!/^[a-zA-Z0-9_-]+$/.test(group)) throw Error("invalid_remote_group");
    const remoteRoot = remoteBase + "/learning/" + group + "-" + round;
    const intake = refresh || !previous ? "intake-" + round : previous.intake;
    const asr = refresh || !previous ? "asr-" + round : previous.asr;
    if (!/^[a-zA-Z0-9_-]+$/.test(intake) || !/^[a-zA-Z0-9_-]+$/.test(asr))
      throw Error("invalid_source_names");
    meta = {
      round,
      parent: parent || null,
      intake,
      asr,
      remoteGroup: group,
      remoteRoot,
      remoteBase,
      host,
      status: "运行中",
      steps,
      acceptSilver,
      startedAt: new Date().toISOString(),
    };
    await store(join(dir, "round.json"), meta);
    if (refresh || !previous) {
      await exportSnapshots(
        [
          join(
            homedir(),
            "Library/Application Support/com.tts.meeting/backend",
          ),
          join(repo, ".data/records"),
        ],
        join(workspace, intake),
      );
      await collectCandidates(join(workspace, intake), join(workspace, asr), {
        limit: 24,
        perRecord: 4,
      });
    }
    const original = (await json(join(workspace, intake, "records.json")))
      .records;
    const registry = await json(join(workspace, intake, "registry.json"));
    const live = new Map();
    for (const root of new Set(
      Object.values(registry).map((value) => value.root),
    ))
      for (const value of readSnapshot(root)) live.set(value.id, value);
    const records = original.filter(
      (value) => live.get(value.id)?.generation === value.generation,
    );
    const valid = new Set(records.map((value) => value.id));
    await store(join(dir, "records.json"), { records });
    const parentDir = parent ? join(workspace, "rounds", parent) : null;
    const asrSource =
      parentDir &&
      (await exists(join(parentDir, "dataset/asr-candidates.jsonl")))
        ? join(parentDir, "dataset/asr-candidates.jsonl")
        : join(workspace, asr, "candidates.jsonl");
    await writeLines(
      join(dir, "asr-candidates.jsonl"),
      (await lines(asrSource)).filter((value) => valid.has(value.recordId)),
    );
    await remote(
      "set -e\numask 077\nmkdir -p " +
        shellQuote(remoteBase + "/learning") +
        "\nmkdir " +
        shellQuote(remoteRoot),
    );
    await remote("mkdir " + shellQuote(remoteRoot + "/runtime"));
    const tools = [
      "learning_data.py",
      "build_learning_round.py",
      "predict_learning.py",
      "score_learning.py",
      "finalize_learning_round.py",
      "train_lora.py",
      "intent_inputs.py",
      "build_dataset.py",
      "intent_policy.json",
      "quantized_runtime.py",
      "train_head.py",
    ];
    const runtimeHashes = {};
    for (const tool of tools) {
      runtimeHashes[tool] = createHash("sha256")
        .update(await readFile(join(repo, "tools/neohorse", tool)))
        .digest("hex");
      await upload(
        join(repo, "tools/neohorse", tool),
        remoteRoot + "/runtime/" + tool,
      );
    }
    await store(join(dir, "runtime-manifest.json"), {
      version: 1,
      files: runtimeHashes,
    });
    await upload(
      join(dir, "runtime-manifest.json"),
      remoteRoot + "/runtime-manifest.json",
    );
    for (const name of ["records.json", "asr-candidates.jsonl"])
      await upload(join(dir, name), remoteRoot + "/" + name);
    let splits = "";
    if (parentDir) {
      const path = (await exists(join(parentDir, "dataset/split-map.json")))
        ? join(parentDir, "dataset/split-map.json")
        : join(parentDir, "prelabel/split-map.json");
      await upload(path, remoteRoot + "/splits.json");
      splits = " --splits " + shellQuote(remoteRoot + "/splits.json");
    }
    const common =
      " --tokenizer " +
      shellQuote(remoteBase + "/model/tokenizer") +
      " --records " +
      shellQuote(remoteRoot + "/records.json") +
      " --asr-candidates " +
      shellQuote(remoteRoot + "/asr-candidates.jsonl") +
      splits;
    await remote(
      "set -e\ncd " +
        shellQuote(remoteBase) +
        "\n.venv/bin/python -u " +
        shellQuote(remoteRoot + "/runtime/build_learning_round.py") +
        "" +
        common +
        " --output " +
        shellQuote(remoteRoot + "/prelabel"),
    );
    await mkdir(join(dir, "prelabel"), { mode: 0o700 });
    await download(remoteRoot + "/prelabel/*", join(dir, "prelabel"));
    const cases = await lines(join(dir, "prelabel/cases.jsonl")),
      lookup = new Map(cases.map((value) => [value.sample_id, value]));
    let teachers = [],
      reviews = [];
    if (parentDir && !refresh) {
      teachers = await lines(join(parentDir, "teacher.jsonl")).catch(() => []);
      const effective = await lines(
        join(parentDir, "dataset/effective-reviews.jsonl"),
      ).catch(() => []);
      const edited = await lines(join(parentDir, "reviews.jsonl")).catch(
        () => [],
      );
      reviews = [
        ...new Map(
          [...effective, ...edited].map((value) => [value.sample_id, value]),
        ).values(),
      ];
      teachers = teachers.filter(
        (value) => lookup.get(value.sample_id)?.input_hash === value.input_hash,
      );
      reviews = reviews.filter(
        (value) => lookup.get(value.sample_id)?.input_hash === value.input_hash,
      );
    } else {
      await teacherLabels(
        join(dir, "prelabel/cases.jsonl"),
        join(workspace, intake, "registry.json"),
        join(dir, "teacher.jsonl"),
        { limit: 96 },
      );
      teachers = await lines(join(dir, "teacher.jsonl"));
    }
    await writeLines(join(dir, "teacher.jsonl"), teachers);
    await writeLines(join(dir, "reviews-input.jsonl"), reviews);
    await upload(join(dir, "teacher.jsonl"), remoteRoot + "/teacher.jsonl");
    await upload(
      join(dir, "reviews-input.jsonl"),
      remoteRoot + "/reviews-input.jsonl",
    );
    const build =
      ".venv/bin/python -u " +
      shellQuote(remoteRoot + "/runtime/build_learning_round.py") +
      "" +
      common +
      " --teachers " +
      shellQuote(remoteRoot + "/teacher.jsonl") +
      " --reviews " +
      shellQuote(remoteRoot + "/reviews-input.jsonl") +
      (acceptSilver ? " --accept-silver" : "") +
      " --output " +
      shellQuote(remoteRoot + "/dataset");
    await remote("set -e\ncd " + shellQuote(remoteBase) + "\n" + build);
    await mkdir(join(dir, "dataset"), { mode: 0o700 });
    await download(remoteRoot + "/dataset/*", join(dir, "dataset"));
    const train = await lines(join(dir, "dataset/train.jsonl"));
    const both = new Set(train.map((row) => row.family)).size === 2;
    const parentCheckpoint =
      previous &&
      (await exists(join(parentDir, "checkpoint/lora-training-report.json")))
        ? previous.remoteRoot + "/checkpoint/adapter"
        : null;
    const baseline = parentCheckpoint
      ? " --adapter " + shellQuote(parentCheckpoint)
      : "";
    const commands = [
      "set -e",
      "cd " + shellQuote(remoteBase),
      ".venv/bin/python -u " +
        shellQuote(remoteRoot + "/runtime/predict_learning.py") +
        " --model-dir " +
        shellQuote(remoteBase + "/model") +
        " --cases " +
        shellQuote(remoteRoot + "/dataset/cases.jsonl") +
        " --output " +
        shellQuote(remoteRoot + "/base-predictions.jsonl") +
        baseline,
    ];
    if (both) {
      commands.push(
        ".venv/bin/python -u " +
          shellQuote(remoteRoot + "/runtime/train_lora.py") +
          " --model-dir " +
          shellQuote(remoteBase + "/model") +
          " --dataset " +
          shellQuote(remoteRoot + "/dataset/train.jsonl") +
          " --output-dir " +
          shellQuote(remoteRoot + "/checkpoint") +
          " --max-examples 2048 --balance-families --steps " +
          steps +
          (parentCheckpoint
            ? " --resume-adapter " + shellQuote(parentCheckpoint)
            : ""),
      );
      commands.push(
        ".venv/bin/python -u " +
          shellQuote(remoteRoot + "/runtime/train_lora.py") +
          " --model-dir " +
          shellQuote(remoteBase + "/model") +
          " --dataset " +
          shellQuote(remoteRoot + "/dataset/train.jsonl") +
          " --output-dir " +
          shellQuote(remoteRoot + "/checkpoint") +
          " --max-examples 2048 --verify-only",
      );
      commands.push(
        ".venv/bin/python -u " +
          shellQuote(remoteRoot + "/runtime/predict_learning.py") +
          " --model-dir " +
          shellQuote(remoteBase + "/model") +
          " --cases " +
          shellQuote(remoteRoot + "/dataset/cases.jsonl") +
          " --output " +
          shellQuote(remoteRoot + "/adapter-predictions.jsonl") +
          " --adapter " +
          shellQuote(remoteRoot + "/checkpoint/adapter"),
      );
    }
    commands.push(
      ".venv/bin/python " +
        shellQuote(remoteRoot + "/runtime/score_learning.py") +
        " --cases " +
        shellQuote(remoteRoot + "/dataset/cases.jsonl") +
        " --predictions " +
        shellQuote(remoteRoot + "/base-predictions.jsonl") +
        " --datasets " +
        shellQuote(remoteRoot + "/dataset") +
        " --output " +
        shellQuote(remoteRoot + "/base-scores.json"),
    );
    if (both)
      commands.push(
        ".venv/bin/python " +
          shellQuote(remoteRoot + "/runtime/score_learning.py") +
          " --cases " +
          shellQuote(remoteRoot + "/dataset/cases.jsonl") +
          " --predictions " +
          shellQuote(remoteRoot + "/adapter-predictions.jsonl") +
          " --datasets " +
          shellQuote(remoteRoot + "/dataset") +
          " --output " +
          shellQuote(remoteRoot + "/adapter-scores.json"),
      );
    commands.push(
      ".venv/bin/python " +
        shellQuote(remoteRoot + "/runtime/finalize_learning_round.py") +
        " --root " +
        shellQuote(remoteRoot) +
        " --round-id " +
        shellQuote(round),
    );
    await remote(
      "cd " +
        shellQuote(remoteBase) +
        "\nflock -n .learning-gpu.lock sh -c " +
        shellQuote(commands.join("\n")),
    );
    await download(remoteRoot + "/*.json*", dir);
    if (both) {
      await mkdir(join(dir, "checkpoint"), { mode: 0o700 });
      await download(
        remoteRoot + "/checkpoint/*.json",
        join(dir, "checkpoint"),
      );
    }
    const report = await json(join(dir, "round-report.json"));
    meta.status = "已完成";
    meta.completedAt = new Date().toISOString();
    meta.trainingSkipped = both ? null : "需要两个任务的有效训练标签";
    await store(join(dir, "round.json"), meta);
    console.log(
      JSON.stringify({
        round,
        cases: report.cases,
        trained: report.trained,
        updatesByFamily: report.updatesByFamily,
        goldTestReady: report.goldTestReady,
      }),
    );
    return report;
  } catch (error) {
    if (meta)
      await store(join(dir, "round.json"), {
        ...meta,
        status: "失败",
        error: error.message,
        failedAt: new Date().toISOString(),
      });
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--accept-silver") options.acceptSilver = true;
    else if (key === "--refresh") options.refresh = true;
    else if (key === "--remote-base") options.remoteBase = args[++i];
    else if (key === "--steps") options.steps = Number(args[++i]);
    else if (["--workspace", "--round", "--parent", "--host"].includes(key))
      options[key.slice(2)] = args[++i];
    else throw Error("Unknown learning option");
  }
  await runLearningRound(options);
}
