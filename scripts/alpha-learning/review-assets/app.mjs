/* global document, window, fetch, URL, Blob */
const $ = (id) => document.getElementById(id);
const names = {
  decision: "决定",
  action: "行动候选",
  proposal: "提议",
  question: "问题",
  withdrawal: "否定／撤回",
  asr_selection: "转录候选选择",
};
let rounds = [],
  rows = [],
  current = null,
  page = 0,
  token = "";
const api = async (path, body) => {
  const response = await fetch(
    path,
    body
      ? {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Learning-Token": token,
          },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "请求失败");
  return data;
};
function notice(text) {
  $("notice").textContent = text;
  $("notice").classList.add("visible");
  window.setTimeout(() => $("notice").classList.remove("visible"), 4500);
}
const pending = (row) =>
  row.target === null || row.target === undefined || row.target === "";
function filtered() {
  const query = $("search").value.trim();
  return rows.filter(
    (row) =>
      ($("family").value === "all" || row.family === $("family").value) &&
      (!$("pending").checked || pending(row)) &&
      (!query || row.display.original.includes(query)),
  );
}
function list() {
  const all = filtered();
  page = Math.max(
    0,
    Math.min(page, Math.floor(Math.max(0, all.length - 1) / 30)),
  );
  $("list").replaceChildren();
  for (const row of all.slice(page * 30, (page + 1) * 30)) {
    const button = document.createElement("button");
    button.className =
      "case-item" + (current?.sample_id === row.sample_id ? " active" : "");
    const small = document.createElement("small");
    small.textContent =
      names[row.task] + " · " + (pending(row) ? "待标注" : "已标注");
    const text = document.createElement("p");
    text.textContent = row.display.original;
    button.append(small, text);
    button.onclick = () => select(row);
    $("list").append(button);
  }
  $("page").textContent =
    page + 1 + " / " + Math.max(1, Math.ceil(all.length / 30));
  $("prev-page").disabled = page === 0;
  $("next-page").disabled = (page + 1) * 30 >= all.length;
  $("total").textContent = rows.length;
  $("reviewed").textContent = rows.filter((row) => !pending(row)).length;
}
function describe(row, prediction) {
  if (!prediction?.choice) return "尚无预测";
  const key = prediction.choice;
  const text =
    row.family === "asr"
      ? key === "none"
        ? "无法据文字确认"
        : row.display.candidates[Number(key.slice(1))]
      : key === "present"
        ? "存在"
        : "不存在";
  const probability = prediction.probabilities?.[key];
  return (
    text +
    (typeof probability === "number"
      ? " · 原始概率 " + (probability * 100).toFixed(1) + "%"
      : "")
  );
}
function select(row) {
  current = row;
  $("empty").hidden = true;
  $("detail").hidden = false;
  $("task").textContent = names[row.task];
  $("question").textContent =
    row.family === "asr"
      ? "哪一个候选更符合原音？"
      : row.request.questions[row.task].instructions;
  $("split").textContent =
    { train: "训练分组", dev: "验证分组 · 盲标", test: "测试分组 · 盲标" }[
      row.split
    ] || row.split;
  $("source").textContent =
    "会议 " +
    row.source.recordId.slice(-8) +
    " · 片段 " +
    row.source.focus.segmentId.slice(-8) +
    " @" +
    row.source.focus.revision +
    " · 转录版本 " +
    row.source.transcriptRevision;
  $("original").textContent = row.display.original;
  $("context").textContent = row.request.state;
  $("audio").src =
    "/api/audio?round=" +
    encodeURIComponent($("round").value) +
    "&sample=" +
    row.sample_id;
  $("audio-note").textContent = "播放时尝试读取这段原音；部分历史原音已清理。";
  $("verified").disabled = false;
  $("verified").checked = row.audioVerified === true;
  $("audio").onerror = () => {
    $("audio-note").textContent =
      "这段原音不可用。转录正确性暂不计入人工音频评测。";
    $("verified").disabled = true;
    $("verified").checked = false;
  };
  const blind = row.split !== "train" && pending(row);
  $("predictions").textContent = blind
    ? "独立验证样本：先完成标注，再查看模型和教师结果。"
    : "训练前：" +
      describe(row, row.basePrediction) +
      " ｜ 本轮模型：" +
      describe(row, row.adapterPrediction) +
      " ｜ 教师弱标：" +
      describe(row, row.teacherTarget ? { choice: row.teacherTarget } : null) +
      "。概率未校准，预测不代表真实原话。";
  $("choices").replaceChildren();
  const options =
    row.family === "asr"
      ? row.display.candidates.map((text, i) => ["c" + i, text])
      : [
          ["present", "存在这类意图"],
          ["absent", "不存在这类意图"],
        ];
  if (row.family === "asr") options.push(["none", "这些候选均不正确"]);
  options.push(["skip", "暂不能确定，跳过训练"]);
  for (const [value, text] of options) {
    const label = document.createElement("label");
    label.className = "choice";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "target";
    input.value = value;
    input.checked = row.target === value;
    const span = document.createElement("span");
    span.textContent = text;
    label.append(input, span);
    $("choices").append(label);
  }
  $("corrected-label").hidden = row.family !== "asr";
  $("corrected").value = row.correctedText || "";
  $("note").value = row.note || "";
  if (row.reviewer) $("reviewer").value = row.reviewer;
  $("save-state").textContent = row.rejected
    ? "超出本轮模型预算，标注仍可保存。"
    : "";
  list();
}
async function load() {
  const name = $("round").value;
  const data = await api("/api/round?name=" + encodeURIComponent(name));
  rows = data.cases;
  current = null;
  page = 0;
  const report = data.report;
  $("gold").textContent = report?.goldTestReady ? "已有人工测试" : "待建立";
  $("round-note").textContent = report?.trained
    ? "本轮已训练 · " +
      Object.entries(report.updatesByFamily || {})
        .map(([k, v]) => (k === "asr" ? "转录候选" : "意图") + " " + v + " 步")
        .join(" / ") +
      "。教师标签仍是弱监督。"
    : "本轮结果可标注，训练与回测状态以轮次报告为准。";
  list();
  const first = filtered()[0];
  if (first) select(first);
  else {
    $("detail").hidden = true;
    $("empty").hidden = false;
  }
}
$("form").onsubmit = async (event) => {
  event.preventDefault();
  const target = document.querySelector("input[name=target]:checked")?.value;
  const correctedText = $("corrected").value.trim();
  if (
    correctedText &&
    target &&
    !["none", "skip"].includes(target) &&
    current.display.candidates?.[Number(target.slice(1))] !== correctedText
  )
    return notice("补充正确文字时请选择候选均不正确，或先清空正确文字。");
  if (!target && !correctedText) return notice("请选择标注结果。");
  const row = {
    sample_id: current.sample_id,
    input_hash: current.input_hash,
    target: target || "none",
    correctedText,
    reviewer: $("reviewer").value.trim(),
    audioVerified: $("verified").checked,
    blindReview:
      current.split !== "train" &&
      (pending(current) ||
        (current.blindReview === true &&
          current.target === (target || "none") &&
          (current.correctedText || "") === correctedText)),
    note: $("note").value.trim(),
  };
  try {
    $("save-state").textContent = "保存中…";
    await api("/api/reviews", { round: $("round").value, review: row });
    const before = filtered();
    const index = before.indexOf(current);
    Object.assign(current, row);
    const all = filtered();
    list();
    const next = all.includes(current)
      ? all[index + 1] || all[0]
      : all[index] || all[0];
    if (next) select(next);
    else {
      $("detail").hidden = true;
      $("empty").hidden = false;
      $("empty").textContent =
        "当前筛选下的样本已标注。可以导出标注或生成下一轮。";
    }
    notice("标注已保存，原会议内容未修改。");
  } catch (error) {
    $("save-state").textContent = error.message;
  }
};
$("export").onclick = () => {
  const reviewed = rows
    .filter((row) => !pending(row))
    .map((row) =>
      Object.fromEntries(
        [
          "sample_id",
          "input_hash",
          "target",
          "reviewer",
          "audioVerified",
          "blindReview",
          "note",
          "correctedText",
        ].map((key) => [key, row[key]]),
      ),
    );
  const url = URL.createObjectURL(
    new Blob([reviewed.map((row) => JSON.stringify(row) + "\n").join("")], {
      type: "application/x-ndjson",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = $("round").value + "-reviews.jsonl";
  a.click();
  URL.revokeObjectURL(url);
};
$("next-round").onclick = async () => {
  try {
    $("next-round").disabled = true;
    const result = await api("/api/next", { parent: $("round").value });
    notice("下一轮已开始：" + result.round + "。完成后会保留新的可标注结果。");
  } catch (error) {
    notice(error.message);
  } finally {
    $("next-round").disabled = false;
  }
};
for (const id of ["family", "pending"])
  $(id).onchange = () => {
    page = 0;
    list();
  };
$("search").oninput = () => {
  page = 0;
  list();
};
$("prev-page").onclick = () => {
  page--;
  list();
};
$("next-page").onclick = () => {
  page++;
  list();
};
$("round").onchange = () => load().catch((error) => notice(error.message));
async function bootstrap(initial = false) {
  const selected = $("round").value;
  const data = await api("/api/bootstrap");
  token = data.token;
  rounds = data.rounds;
  $("round").replaceChildren();
  for (const round of rounds) {
    const option = document.createElement("option");
    option.value = round.name;
    option.textContent = round.name + " · " + round.status;
    $("round").append(option);
  }
  if (rounds.length) {
    $("round").value =
      !initial && rounds.some((round) => round.name === selected)
        ? selected
        : [...rounds].reverse().find((round) => round.status === "已完成")
            ?.name || rounds.at(-1).name;
    await load();
  } else
    $("round-note").textContent =
      "尚无学习轮次。先运行数据接入与旁路评测命令。";
}
$("refresh").onclick = () =>
  bootstrap().catch((error) => notice(error.message));
bootstrap(true).catch((error) => notice(error.message));
