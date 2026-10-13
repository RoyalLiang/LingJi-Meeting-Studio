/* global document, window, fetch, URL, Blob, Option */
import { groupReviewCases } from "./presentation.mjs";
const $ = (id) => document.getElementById(id);
const names = {
  decision: "决定",
  action: "行动候选",
  proposal: "提议",
  question: "问题",
  withdrawal: "否定／撤回",
  asr_selection: "转录候选",
};
const base = document.body.dataset.apiBase || "";
const endpoint = (path) => (base ? base + path.replace(/^\/api/, "") : path);
let rows = [],
  groups = [],
  current = null,
  page = 0,
  token = "",
  integrated = false,
  plan = null;
const pending = (row) =>
  row.target === null || row.target === undefined || row.target === "";
async function api(path, body) {
  const response = await fetch(
    endpoint(path),
    body
      ? {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Learning-Token": token,
            "X-CSRF-Token": token,
          },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = await response.json();
  if (!response.ok) throw Error(data.message || data.error || "请求失败");
  return data;
}
function notice(text) {
  $("notice").textContent = text;
  $("notice").classList.add("visible");
  window.setTimeout(() => $("notice").classList.remove("visible"), 4500);
}
const visibleRows = (group) =>
  group.rows.filter(
    (row) => $("family").value === "all" || row.family === $("family").value,
  );
function filtered() {
  const query = $("search").value.trim();
  return groups.filter(
    (group) =>
      ($("meeting").value === "all" || group.recordId === $("meeting").value) &&
      visibleRows(group).length &&
      (!$("pending").checked || visibleRows(group).some(pending)) &&
      (!query ||
        (group.text + " " + group.original + " " + group.title).includes(
          query,
        )),
  );
}
const time = (value) =>
  Number.isFinite(value)
    ? `${Math.floor(value / 60000)}:${String(Math.floor(value / 1000) % 60).padStart(2, "0")}`
    : "";
function list() {
  const all = filtered();
  page = Math.max(
    0,
    Math.min(page, Math.floor(Math.max(0, all.length - 1) / 30)),
  );
  $("list").replaceChildren();
  for (const group of all.slice(page * 30, (page + 1) * 30)) {
    const button = document.createElement("button");
    button.className =
      "case-item" + (current?.id === group.id ? " active" : "");
    const small = document.createElement("small");
    small.textContent =
      group.title +
      " · " +
      time(group.startMs) +
      " · " +
      (visibleRows(group).some(pending) ? "待标注" : "已标注");
    const text = document.createElement("p");
    text.textContent = group.text;
    button.append(small, text);
    button.onclick = () => select(group);
    $("list").append(button);
  }
  $("page").textContent =
    `${page + 1} / ${Math.max(1, Math.ceil(all.length / 30))}`;
  $("prev-page").disabled = page === 0;
  $("next-page").disabled = (page + 1) * 30 >= all.length;
  const scopeGroups = groups.filter(
    (group) =>
      $("meeting").value === "all" || group.recordId === $("meeting").value,
  );
  $("total").textContent = scopeGroups.length;
  $("reviewed").textContent = scopeGroups.filter(
    (group) => !group.rows.some(pending),
  ).length;
}
function describe(row, prediction) {
  if (!prediction?.choice) return "尚无结果";
  const choice = prediction.choice;
  return row.family === "asr"
    ? choice === "none"
      ? "无法确定原话"
      : row.display.candidates[Number(choice.slice(1))] || choice
    : { present: "存在", absent: "不存在" }[choice] || choice;
}
function select(group) {
  current = group;
  const selected = visibleRows(group),
    focus = selected[0],
    asr = selected.find((row) => row.family === "asr");
  $("detail").hidden = false;
  $("empty").hidden = true;
  $("task").textContent = group.title;
  $("question").textContent = "核对这段发言";
  $("split").textContent =
    { train: "训练分组", dev: "验证分组 · 先盲标", test: "测试分组 · 先盲标" }[
      focus.split
    ] || focus.split;
  $("source").textContent =
    `${time(group.startMs)}${time(group.endMs) ? "–" + time(group.endMs) : ""} · 片段 ${focus.source.focus.segmentId.slice(-8)} @${focus.source.focus.revision} · 转录版本 ${focus.source.transcriptRevision}`;
  $("original").textContent = group.text;
  $("raw").textContent = group.original;
  $("raw-details").hidden = group.original === group.text;
  $("context").textContent = selected
    .map((row) => names[row.task] + ":\n" + row.request.state)
    .join("\n\n");
  const audioRow = asr || focus;
  $("audio").src = endpoint(
    "/api/audio?round=" +
      encodeURIComponent($("round").value) +
      "&sample=" +
      encodeURIComponent(audioRow.sample_id),
  );
  $("audio-note").textContent =
    "播放时读取这段原音；缺失原音的候选只能暂存，不能作为已核听训练标签。";
  $("verified").disabled = false;
  $("verified").checked = asr?.audioVerified === true;
  $("audio").onerror = () => {
    $("audio-note").textContent =
      "这段原音不可用。候选可暂存或跳过，不能作为已核听训练标签。";
    $("verified").disabled = true;
    $("verified").checked = false;
  };
  $("predictions").replaceChildren();
  $("choices").replaceChildren();
  for (const row of selected) {
    const summary = document.createElement("p");
    const blind = row.split !== "train" && pending(row);
    summary.textContent =
      names[row.task] +
      "：" +
      (blind
        ? "独立评测样本，先标注再展示预测。"
        : `训练前 ${describe(row, row.basePrediction)} ｜ 本轮 ${describe(row, row.adapterPrediction)} ｜ 教师弱标 ${describe(row, row.teacherTarget ? { choice: row.teacherTarget } : null)}`);
    $("predictions").append(summary);
    const section = document.createElement("fieldset");
    section.className = "task-choices";
    const legend = document.createElement("legend");
    legend.textContent = names[row.task];
    section.append(legend);
    const options =
      row.family === "asr"
        ? row.display.candidates.map((text, index) => ["c" + index, text])
        : [
            ["present", "存在"],
            ["absent", "不存在"],
          ];
    if (row.family === "asr") options.push(["none", "候选均不正确／无法判断"]);
    options.push(["skip", "跳过"]);
    const choices = document.createElement("div");
    choices.className = row.family === "intent" ? "intent-options" : "";
    for (const [value, text] of options) {
      const label = document.createElement("label");
      label.className = "choice";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = row.sample_id;
      input.value = value;
      input.checked = row.target === value;
      const span = document.createElement("span");
      span.textContent = text;
      label.append(input, span);
      choices.append(label);
    }
    section.append(choices);
    $("choices").append(section);
  }
  $("corrected-label").hidden = !asr;
  $("corrected").value = asr?.correctedText || "";
  $("note").value = asr?.note || focus.note || "";
  if (asr?.reviewer || focus.reviewer)
    $("reviewer").value = asr?.reviewer || focus.reviewer;
  $("save-state").textContent = selected.some((row) => row.rejected)
    ? "部分输入超过模型预算，标注将保留，暂不训练该项。"
    : "";
  list();
}
async function load() {
  const data = await api(
    "/api/round?name=" + encodeURIComponent($("round").value),
  );
  rows = data.cases;
  groups = groupReviewCases(rows);
  page = 0;
  current = null;
  const selectedMeeting = $("meeting").value;
  $("meeting").replaceChildren(new Option("全部会议", "all"));
  const meetings = new Map(
    groups.map((group) => [group.recordId, group.title]),
  );
  for (const [id, title] of meetings)
    $("meeting").append(new Option(title, id));
  $("meeting").value = meetings.has(selectedMeeting) ? selectedMeeting : "all";
  $("meeting-label").hidden = integrated;
  const report = data.report;
  $("gold").textContent = report?.goldTestReady ? "已有人工集" : "待建立";
  $("round-note").textContent = report?.trained
    ? "本轮已训练：" +
      Object.entries(report.updatesByFamily || {})
        .map(
          ([key, value]) =>
            (key === "asr" ? "转录候选" : "意图") + " " + value + " 步",
        )
        .join(" / ") +
      "。请核对新结果。"
    : data.status === "running"
      ? "正在生成会后待标注结果…"
      : "同一片段集中标注；人工确认后才训练。教师弱标不是原话真值。";
  list();
  if (filtered()[0]) select(filtered()[0]);
  else {
    $("detail").hidden = true;
    $("empty").hidden = false;
    $("empty").textContent =
      data.status === "running"
        ? "正在生成会后待标注结果，稍后自动刷新。"
        : "当前没有待标注片段。";
  }
}
$("form").onsubmit = async (event) => {
  event.preventDefault();
  if (!current) return;
  const selected = visibleRows(current),
    reviews = [];
  const correctedText = $("corrected").value.trim();
  for (const row of selected) {
    const target = [
      ...document.querySelectorAll("input[type=radio]:checked"),
    ].find((input) => input.name === row.sample_id)?.value;
    if (!target) return notice("请为各项选择标注；无法确定时选择跳过。");
    const corrected = row.family === "asr" ? correctedText : "";
    if (
      corrected &&
      !["none", "skip"].includes(target) &&
      row.display.candidates[Number(target.slice(1))] !== corrected
    )
      return notice("补充正确文字时请选择候选均不正确，或清空正确文字。");
    reviews.push({
      sample_id: row.sample_id,
      input_hash: row.input_hash,
      target,
      correctedText: corrected,
      reviewer: $("reviewer").value.trim(),
      audioVerified: $("verified").checked,
      blindReview:
        row.split !== "train" &&
        (pending(row) ||
          (row.blindReview === true &&
            row.target === target &&
            (row.correctedText || "") === corrected)),
      note: $("note").value.trim(),
    });
  }
  try {
    $("save-state").textContent = "保存中…";
    const before = filtered(),
      index = before.indexOf(current);
    await api("/api/reviews", { round: $("round").value, reviews });
    for (const review of reviews)
      Object.assign(
        rows.find((row) => row.sample_id === review.sample_id),
        review,
      );
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
        "当前筛选下的片段已标注。可以继续其他会议，或确认训练与回测。";
    }
    notice("本段标注已保存。");
  } catch (error) {
    $("save-state").textContent = error.message;
  }
};
$("export").onclick = () => {
  const reviews = rows
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
    new Blob([reviews.map((row) => JSON.stringify(row) + "\n").join("")], {
      type: "application/x-ndjson",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = $("round").value + "-reviews.jsonl";
  link.click();
  URL.revokeObjectURL(url);
};
$("next-round").onclick = async () => {
  try {
    plan = await api("/api/plan?round=" + encodeURIComponent($("round").value));
    $("train-plan").hidden = false;
    $("plan-note").textContent =
      plan.message ||
      `仅使用人工确认标签：训练意图 ${plan.counts.intent} 条、转录候选 ${plan.counts.asr} 条；评测 ${plan.evaluation || 0} 条。`;
    $("confirm-training").checked = false;
    $("start-training").disabled = true;
  } catch (error) {
    notice(error.message);
  }
};
$("confirm-training").onchange = () => {
  $("start-training").disabled = !$("confirm-training").checked || !plan?.ready;
};
$("cancel-training").onclick = () => {
  $("train-plan").hidden = true;
  plan = null;
};
$("start-training").onclick = async () => {
  try {
    $("start-training").disabled = true;
    const result = await api("/api/next", {
      parent: $("round").value,
      planHash: plan.planHash,
      confirmed: true,
    });
    $("train-plan").hidden = true;
    notice(
      "训练与回测已排队：" + result.round + "。完成后会保留新的可标注结果。",
    );
  } catch (error) {
    notice(error.message);
    $("start-training").disabled = false;
  }
};
function refilter() {
  page = 0;
  list();
  if (filtered()[0]) select(filtered()[0]);
  else {
    $("detail").hidden = true;
    $("empty").hidden = false;
    $("empty").textContent = "当前筛选没有片段。";
  }
}
for (const id of ["family", "meeting", "pending"]) $(id).onchange = refilter;
$("search").oninput = refilter;
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
  token = data.csrf || data.token;
  integrated = data.integrated === true;
  $("prepare").hidden = !integrated;
  if (data.title) document.title = data.title + " · 学习评审";
  $("round").replaceChildren();
  for (const round of data.rounds) {
    const option = document.createElement("option");
    option.value = round.name;
    option.textContent = round.name + " · " + round.status;
    $("round").append(option);
  }
  if (data.rounds.length) {
    $("round").value =
      !initial && data.rounds.some((round) => round.name === selected)
        ? selected
        : [...data.rounds].reverse().find((round) => round.status === "已完成")
            ?.name || data.rounds.at(-1).name;
    await load();
  } else {
    $("round-note").textContent =
      data.status === "running"
        ? "正在生成会后待标注结果…"
        : data.message || "会议结束并完成转录后，待标注结果会出现在这里。";
    $("total").textContent = "0";
    $("reviewed").textContent = "0";
  }
}
$("refresh").onclick = () =>
  bootstrap().catch((error) => notice(error.message));
window.setInterval(() => {
  if (integrated && rows.length === 0) bootstrap().catch(() => {});
}, 10000);
bootstrap(true).catch((error) => notice(error.message));

$("prepare").onclick = async () => {
  try {
    await api("/api/prepare", {});
    notice("会后待标注已排队。");
    await bootstrap();
  } catch (error) {
    notice(error.message);
  }
};
