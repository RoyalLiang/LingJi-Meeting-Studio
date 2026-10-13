import { useEffect, useMemo, useState } from "react";
import { Modal, Button } from "./ui";
import { Select } from "./Select";
import { api, messageOf } from "../api";
import { timecode } from "../model";
import type { RecordDetail } from "../model";
import { groupReviewCases } from "../../../../packages/records/src/learning-display.mjs";
import "./LearningReview.css";
type Prediction = { choice?: string | null };
type ReviewCase = {
  sample_id: string;
  input_hash: string;
  family: "intent" | "asr";
  task: string;
  split: string;
  source: {
    recordId: string;
    transcriptRevision: number;
    focus: { segmentId: string; revision: number };
    audioSha256?: string | null;
  };
  display: {
    original: string;
    meetingTitle?: string;
    startMs?: number;
    endMs?: number;
    candidates?: string[];
  };
  request: { state: string };
  target?: string | null;
  reviewer?: string;
  correctedText?: string;
  note?: string;
  audioVerified?: boolean;
  blindReview?: boolean;
  reviewedAt?: string;
  basePrediction?: Prediction;
  adapterPrediction?: Prediction;
  teacherTarget?: string | null;
  rejected?: string;
};
type Boot = {
  rounds: { name: string; status: string }[];
  status: string;
  message?: string;
  training?: { status: string; round?: string; error?: string };
};
type Round = {
  cases: ReviewCase[];
  report?: {
    trained?: boolean;
    goldTestReady?: boolean;
    updatesByFamily?: Record<string, number>;
  } | null;
};
type Plan = {
  planHash: string;
  ready: boolean;
  message: string;
  counts: { intent: number; asr: number };
  evaluation: number;
};
const names: Record<string, string> = {
  decision: "决定",
  action: "行动候选",
  proposal: "提议",
  question: "问题",
  withdrawal: "否定／撤回",
  asr_selection: "转录候选",
};
const pending = (row: ReviewCase) => !row.target;
function describe(row: ReviewCase, prediction?: Prediction | null) {
  const choice = prediction?.choice;
  if (!choice) return "尚无结果";
  return row.family === "asr"
    ? choice === "none"
      ? "无法判断"
      : row.display.candidates?.[Number(choice.slice(1))] || choice
    : { present: "存在", absent: "不存在" }[choice] || choice;
}
function learningMessage(error: unknown) {
  const fallback = messageOf(error),
    code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : fallback;
  const labels: Record<string, string> = {
    learning_snapshot_changed: "转录或候选已变化，请刷新结果后重新核对。",
    learning_round_not_found: "当前评审版本已变化，请刷新结果。",
    stale_review: "标注引用的版本已变化，请刷新结果。",
    human_review_required: "请先保存有效人工标注，再确认当前训练计划。",
    learning_training_busy: "已有训练任务正在进行，请等待完成。",
    learning_wait_for_transcript: "转录尚未排空，请稍候。",
    learning_requires_local_store: "会后学习目前支持 Alpha 本机存储。",
    audio_not_verified: "缺少可核听的原音，不能确认这条转录训练标签。",
  };
  return labels[code] || fallback;
}
export function LearningReview({
  record,
  close,
}: {
  record: RecordDetail;
  close: () => void;
}) {
  const prefix = `/records/${record.id}/learning`;
  const [boot, setBoot] = useState<Boot>(),
    [round, setRound] = useState(""),
    [data, setData] = useState<Round>({ cases: [] });
  const [selected, setSelected] = useState(""),
    [family, setFamily] = useState("all"),
    [query, setQuery] = useState(""),
    [onlyPending, setOnlyPending] = useState(true);
  const [drafts, setDrafts] = useState<
      Record<string, { target?: string; correctedText?: string }>
    >({}),
    [verified, setVerified] = useState<Record<string, boolean>>({}),
    [audioErrors, setAudioErrors] = useState<Record<string, boolean>>({});
  const [reviewer, setReviewer] = useState("本机审核者"),
    [notes, setNotes] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [plan, setPlan] = useState<Plan>(),
    [confirmed, setConfirmed] = useState(false);
  async function load(name: string) {
    const next = await api<Round>(
      `${prefix}/round?name=${encodeURIComponent(name)}`,
    );
    setData(next);
    setRound(name);
    setSelected(groupReviewCases(next.cases)[0]?.id || "");
    setDrafts({});
    setVerified({});
    setAudioErrors({});
    setNotes({});
  }
  async function refresh(initial = false) {
    const next = await api<Boot>(`${prefix}/bootstrap`);
    setBoot(next);
    if (next.rounds.length && (initial || !round)) {
      await load(next.rounds.at(-1)!.name);
    }
  }
  useEffect(() => {
    let disposed = false;
    api<Boot>(`${prefix}/bootstrap`)
      .then(async (next) => {
        if (disposed) return;
        setBoot(next);
        if (next.rounds.length) {
          const name = next.rounds.at(-1)!.name;
          const result = await api<Round>(
            `${prefix}/round?name=${encodeURIComponent(name)}`,
          );
          if (!disposed) {
            setRound(name);
            setData(result);
            setSelected(groupReviewCases(result.cases)[0]?.id || "");
          }
        }
      })
      .catch((error) => {
        if (!disposed) setError(learningMessage(error));
      });
    return () => {
      disposed = true;
    };
  }, [prefix]);
  useEffect(() => {
    const timer = setInterval(() => {
      void refresh(data.cases.length === 0).catch(() => {});
    }, 10000);
    return () => clearInterval(timer);
  }, [prefix, round, data.cases.length]);
  const groups = useMemo(() => groupReviewCases(data.cases), [data.cases]);
  const visible = (group: (typeof groups)[number]) =>
    group.rows.filter((row) => family === "all" || row.family === family);
  const filtered = groups.filter(
    (group) =>
      visible(group).length &&
      (!onlyPending || visible(group).some(pending)) &&
      (!query || (group.original + " " + group.text).includes(query)),
  );
  const group = filtered.find((group) => group.id === selected) || filtered[0],
    current = group ? visible(group) : [],
    asr = current.find((row) => row.family === "asr");
  const hasDrafts =
    data.cases.some((row) => {
      const draft = drafts[row.sample_id];
      return (
        draft &&
        ((draft.target ?? row.target ?? "") !== (row.target ?? "") ||
          (draft.correctedText ?? row.correctedText ?? "") !==
            (row.correctedText ?? ""))
      );
    }) ||
    groups.some((group) => {
      const asr = group.rows.find((row) => row.family === "asr");
      return (
        (verified[group.id] !== undefined &&
          verified[group.id] !== Boolean(asr?.audioVerified)) ||
        (notes[group.id] !== undefined &&
          notes[group.id] !== String(group.rows[0].note || ""))
      );
    });
  const audioRow = asr || current[0],
    wasVerified = asr?.audioVerified === true,
    hasAudioError = group ? audioErrors[group.id] === true : false;
  const audioVerified = group ? (verified[group.id] ?? wasVerified) : false;
  const target = (row: ReviewCase) =>
    drafts[row.sample_id]?.target ?? row.target ?? "";
  const correction = asr
    ? (drafts[asr.sample_id]?.correctedText ?? asr.correctedText ?? "")
    : "";
  const change = (
    row: ReviewCase,
    value: { target?: string; correctedText?: string },
  ) =>
    setDrafts((previous) => ({
      ...previous,
      [row.sample_id]: { ...previous[row.sample_id], ...value },
    }));
  async function save() {
    if (!group) return;
    setError("");
    setNotice("");
    const reviews = [];
    for (const row of current) {
      const choice = target(row),
        correctedText = row.family === "asr" ? correction.trim() : "";
      if (!choice) {
        setError("请标注各项；无法确定时选择跳过。");
        return;
      }
      if (
        correctedText &&
        !["none", "skip"].includes(choice) &&
        row.display.candidates?.[Number(choice.slice(1))] !== correctedText
      ) {
        setError("补充正确文字时请选择候选均不正确，或清空正确文字。");
        return;
      }
      if (!reviewer.trim()) {
        setError("请填写标注者。");
        return;
      }
      const unchanged =
        row.target === choice && (row.correctedText || "") === correctedText;
      reviews.push({
        sample_id: row.sample_id,
        input_hash: row.input_hash,
        target: choice,
        correctedText,
        reviewer: reviewer.trim(),
        note: notes[group.id] ?? row.note ?? "",
        audioVerified:
          row.family === "asr"
            ? audioVerified && (!hasAudioError || unchanged)
            : audioVerified,
        blindReview:
          row.split !== "train" &&
          (pending(row) || (row.blindReview === true && unchanged)),
        reviewedAt: new Date().toISOString(),
      });
    }
    setBusy(true);
    try {
      await api(`${prefix}/reviews`, "POST", { round, reviews });
      const map = new Map(reviews.map((row) => [row.sample_id, row]));
      setData((previous) => ({
        ...previous,
        cases: previous.cases.map((row) =>
          map.has(row.sample_id) ? { ...row, ...map.get(row.sample_id) } : row,
        ),
      }));
      setDrafts((previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(([id]) => !map.has(id)),
        ),
      );
      setVerified((previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(([id]) => id !== group.id),
        ),
      );
      setNotes((previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(([id]) => id !== group.id),
        ),
      );
      setPlan(undefined);
      setNotice("本段标注已保存。");
    } catch (error) {
      setError(learningMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function showPlan() {
    setBusy(true);
    setError("");
    try {
      setPlan(await api<Plan>(`${prefix}/plan`));
      setConfirmed(false);
    } catch (error) {
      setError(learningMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function train() {
    if (!plan || !confirmed) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ round: string }>(`${prefix}/next`, "POST", {
        planHash: plan.planHash,
        confirmed: true,
      });
      setPlan(undefined);
      setNotice(
        `训练与回测已排队：${result.round}。完成后刷新并选择新轮次核对。`,
      );
      await refresh();
    } catch (error) {
      setError(learningMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`学习评审 · ${record.title}`}
      wide
      explicitCloseOnly
      onClose={close}
    >
      <div className="learning-review">
        <div className="learning-toolbar">
          <div className="learning-round">
            {" "}
            <Select
              label="学习轮次"
              value={round}
              options={(boot?.rounds || []).map((item) => ({
                value: item.name,
                label: `${item.name} · ${item.status}`,
              }))}
              onChange={(name) =>
                void load(name).catch((error) =>
                  setError(learningMessage(error)),
                )
              }
              disabled={busy || hasDrafts || !boot?.rounds.length}
            />
          </div>
          <Button
            disabled={busy || hasDrafts}
            onClick={() =>
              void refresh(true).catch((error) =>
                setError(learningMessage(error)),
              )
            }
          >
            刷新结果
          </Button>
          <Button
            disabled={busy || hasDrafts || record.capture !== "completed"}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`${prefix}/prepare`, "POST", {});
                setNotice("会后待标注已排队。");
                await refresh();
              } catch (error) {
                setError(learningMessage(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            生成待标注
          </Button>
          <Button
            variant="primary"
            disabled={busy || hasDrafts || !data.cases.length}
            onClick={() => void showPlan()}
          >
            训练与回测
          </Button>
        </div>
        <div className="learning-summary">
          <span>
            <b>{groups.length}</b> 个发言片段
          </span>
          <span>
            <b>{groups.filter((group) => !group.rows.some(pending)).length}</b>{" "}
            个已标注
          </span>
          <span>
            {data.report?.goldTestReady
              ? "已有人工作为评测参考"
              : "人工测试集待建立"}
          </span>
        </div>
        {hasDrafts && (
          <p className="fine-print" role="status">
            有待保存的标注；保存后可刷新或训练。
          </p>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {["queued", "running"].includes(boot?.training?.status || "") && (
          <p role="status">正在训练与回测，完成后会保留新的可标注结果。</p>
        )}
        {["failed", "stale"].includes(boot?.training?.status || "") && (
          <p className="notice">
            上轮训练未完成或标注已变化，请刷新后重新核对训练计划。
          </p>
        )}
        {plan && (
          <section className="learning-plan">
            <h3>确认训练与回测</h3>
            <p>{plan.message}</p>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>我确认使用上述人工标签训练</span>
            </label>
            <div className="actions">
              <Button disabled={busy} onClick={() => setPlan(undefined)}>
                暂不训练
              </Button>
              <Button
                variant="primary"
                disabled={busy || !confirmed || !plan.ready}
                onClick={() => void train()}
              >
                确认并开始
              </Button>
            </div>
          </section>
        )}
        {!data.cases.length ? (
          <p role="status">
            {boot?.message ||
              (["queued", "running"].includes(boot?.status || "")
                ? "正在生成会后待标注结果…"
                : "会议结束并排空转录后，待标注结果会出现在这里。")}
          </p>
        ) : (
          <div className="learning-layout">
            <aside className="learning-sidebar">
              <Select
                label="筛选任务"
                value={family}
                onChange={setFamily}
                options={[
                  { value: "all", label: "全部任务" },
                  { value: "intent", label: "意图识别" },
                  { value: "asr", label: "转录候选" },
                ]}
              />
              <input
                type="search"
                aria-label="搜索本次待标注片段"
                placeholder="查找本次会议的发言…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={onlyPending}
                  onChange={(event) => setOnlyPending(event.target.checked)}
                />
                <span>仅看待标注</span>
              </label>
              <nav aria-label="本次会议待标注片段">
                {filtered.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={`learning-case ${item.id === group?.id ? "selected" : ""}`}
                    onClick={() => setSelected(item.id)}
                  >
                    <small>
                      {timecode(item.startMs || 0)} ·{" "}
                      {visible(item).some(pending) ? "待标注" : "已标注"}
                    </small>
                    <span>{item.text}</span>
                  </button>
                ))}
              </nav>
            </aside>
            <section className="learning-detail" aria-label="片段核对">
              {!group ? (
                <p>
                  当前筛选下的片段已标注。可以查看已标注片段，或核对训练计划。
                </p>
              ) : (
                <>
                  <div className="learning-focus-heading">
                    <h3>核对这段发言</h3>
                    <span>
                      {{
                        train: "训练分组",
                        dev: "验证分组 · 先盲标",
                        test: "测试分组 · 先盲标",
                      }[current[0].split] || current[0].split}
                    </span>
                  </div>
                  <p className="fine-print">
                    {timecode(group.startMs || 0)}–{timecode(group.endMs || 0)}{" "}
                    · 转录 v{current[0].source.transcriptRevision} · 片段 @
                    {current[0].source.focus.revision}
                  </p>
                  <p className="learning-speech">{group.text}</p>
                  {current.some((row) => row.rejected) && (
                    <p className="notice" role="status">
                      这段输入超出模型预算，暂未生成预测。请保留原文核对；超限样本不会进入本轮训练。
                    </p>
                  )}
                  {group.text !== group.original && (
                    <details className="learning-original">
                      <summary>识别原文</summary>
                      <p>{group.original}</p>
                    </details>
                  )}
                  {audioRow && (
                    <audio
                      key={group.id}
                      controls
                      preload="none"
                      src={`/api${prefix}/audio?round=${encodeURIComponent(round)}&sample=${encodeURIComponent(audioRow.sample_id)}`}
                      onError={() => {
                        setAudioErrors((previous) => ({
                          ...previous,
                          [group.id]: true,
                        }));
                      }}
                    />
                  )}
                  <p className="fine-print">
                    {hasAudioError
                      ? "这段原音不可用；未核听的候选不能用于已确认训练。"
                      : "请按原音核对候选。简洁显示不会改写保存的转录。"}
                  </p>
                  <details className="learning-predictions">
                    <summary>模型与教师结果</summary>
                    {current.map((row) => (
                      <p key={row.sample_id}>
                        <b>{names[row.task]}</b>：
                        {row.split !== "train" && pending(row)
                          ? "独立评测样本，先标注再展示预测。"
                          : `训练前 ${describe(row, row.basePrediction)} ｜ 本轮 ${describe(row, row.adapterPrediction)} ｜ 教师弱标 ${describe(row, row.teacherTarget ? { choice: row.teacherTarget } : null)}`}
                      </p>
                    ))}
                    <p className="fine-print">预测和教师弱标不是原话真值。</p>
                  </details>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save();
                    }}
                  >
                    {current.map((row) => (
                      <fieldset className="learning-task" key={row.sample_id}>
                        <legend>{names[row.task]}</legend>
                        <div
                          className={
                            row.family === "intent"
                              ? "learning-intent-options"
                              : "learning-asr-options"
                          }
                        >
                          {(row.family === "asr"
                            ? [
                                ...(row.display.candidates || []).map(
                                  (text, index) => ["c" + index, text],
                                ),
                                ["none", "候选均不正确／无法判断"],
                                ["skip", "跳过"],
                              ]
                            : [
                                ["present", "存在"],
                                ["absent", "不存在"],
                                ["skip", "跳过"],
                              ]
                          ).map(([value, text]) => (
                            <label key={value} className="learning-choice">
                              <input
                                type="radio"
                                name={row.sample_id}
                                value={value}
                                checked={target(row) === value}
                                onChange={() => change(row, { target: value })}
                              />
                              <span>{text}</span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    ))}
                    {asr && (
                      <>
                        <label>
                          核听后的正确文字
                          <textarea
                            rows={2}
                            value={correction}
                            maxLength={2000}
                            onChange={(event) =>
                              change(asr, { correctedText: event.target.value })
                            }
                            placeholder="候选均不正确时填写；下轮会成为新的候选"
                          />
                        </label>
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={audioVerified}
                            disabled={hasAudioError}
                            onChange={(event) =>
                              setVerified((previous) => ({
                                ...previous,
                                [group.id]: event.target.checked,
                              }))
                            }
                          />
                          <span>
                            我已核听这段原音
                            {hasAudioError && wasVerified
                              ? "（保留历史确认；更改候选需重新核听）"
                              : ""}
                          </span>
                        </label>
                      </>
                    )}
                    <div className="learning-fields">
                      <label>
                        标注者
                        <input
                          value={reviewer}
                          maxLength={80}
                          required
                          onChange={(event) => setReviewer(event.target.value)}
                        />
                      </label>
                      <label>
                        备注
                        <input
                          value={notes[group.id] ?? current[0].note ?? ""}
                          maxLength={2000}
                          onChange={(event) =>
                            setNotes((previous) => ({
                              ...previous,
                              [group.id]: event.target.value,
                            }))
                          }
                        />
                      </label>
                    </div>
                    <Button variant="primary" type="submit" disabled={busy}>
                      {busy ? "请稍候…" : "保存本段标注"}
                    </Button>
                  </form>
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </Modal>
  );
}
