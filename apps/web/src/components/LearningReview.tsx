import { useEffect, useMemo, useRef, useState } from "react";
import { AudioPlayer } from "./AudioPlayer";
import { Modal, Button, Status } from "./ui";
import { Select } from "./Select";
import { api, messageOf } from "../api";
import { timecode } from "../model";
import type { LearningService } from "../useLearningService";
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
type Scores = { gold_test_ready?:boolean; test?: { families?: Record<string,{samples:number;accuracy_against_supplied_labels?:number}> } };
type Round = {
  cases: ReviewCase[];
  report?: {
    trained?: boolean;
    baseScores?: Scores | null;
    adapterScores?: Scores | null;
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
  evaluationBySplit?: Record<string,{intent:number;asr:number}>;
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
    learning_service_unavailable: "学习评审服务未连接，恢复后可继续。",
    learning_disabled: "学习评审当前未启用。",
    learning_requires_local_store: "会后学习目前支持 Alpha 本机存储。",
    audio_not_verified: "缺少可核听的原音，不能确认这条转录训练标签。",
  };
  return labels[code] || fallback;
}
export function LearningReview({
  record,
  service,
  close,
}: {
  record: RecordDetail;
  service: LearningService;
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
  const [closePending,setClosePending]=useState(false),[showResults,setShowResults]=useState(false);
  const loadVersion=useRef(0),detailRoot=useRef<HTMLElement>(null);

  async function load(name: string) {
    const version=++loadVersion.current;
    const next = await api<Round>(
      `${prefix}/round?name=${encodeURIComponent(name)}`,
    );
    if(version!==loadVersion.current)return;
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
    }, ["queued","running"].includes(boot?.status || "") || ["queued","running"].includes(boot?.training?.status || "") ? 1500 : 10000);
    return () => clearInterval(timer);
  }, [prefix, round, data.cases.length, boot?.status, boot?.training?.status]);
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
  useEffect(()=>{detailRoot.current?.scrollTo({top:0});},[group?.id]);
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
  async function save(skipAll=false) {
    if (!group || !service.available) return;
    setError("");
    setNotice("");
    const reviews = [];
    for (const row of current) {
      const choice = skipAll ? "skip" : target(row),
        correctedText = !skipAll && row.family === "asr" ? correction.trim() : "";
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
      const index=filtered.findIndex(item=>item.id===group.id);
      setSelected(filtered[index+1]?.id || filtered[0]?.id || "");
    } catch (error) {
      setError(learningMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function showPlan() {
    if(!service.available || hasDrafts)return;
    setShowResults(false);
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
    if (!plan || !confirmed || !service.available || hasDrafts) return;
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
  const complete=groups.filter(item=>!item.rows.some(pending)).length;
  const trainingBusy=["queued","running"].includes(boot?.training?.status || "");
  const stage=showResults?3:plan || trainingBusy?2:groups.length?1:0;
  const canSave=Boolean(group && current.length && current.every(row=>target(row)) && reviewer.trim());
  const requestClose=()=>hasDrafts?setClosePending(true):close();
  const prepare=async()=>{
    if(!service.available || hasDrafts)return;
    setBusy(true);setError("");
    try{await api(`${prefix}/prepare`,"POST",{});setNotice("待标注准备已排队。");await refresh();}
    catch(error){setError(learningMessage(error));}finally{setBusy(false);}
  };
  const score=(scores:Scores|null|undefined,family:string)=>{
    const value=scores?.test?.families?.[family];
    return value?.samples && typeof value.accuracy_against_supplied_labels==='number'
      ? `${(value.accuracy_against_supplied_labels*100).toFixed(1)}% · ${value.samples} 条` : "尚无独立测试标签";
  };
  const statusLabel=service.available?"评审服务已连接":service.status==='checking'?"正在检测服务":"服务连接中断";
  const footer=closePending?<div className="learning-footer"><span role="status">有尚未保存的标注</span><div className="actions"><Button onClick={()=>setClosePending(false)}>继续编辑</Button><Button variant="danger" onClick={close}>放弃修改并关闭</Button></div></div>:
    <div className="learning-footer"><span className="muted" role="status">{hasDrafts?"有未保存修改":notice || (service.available?"标注与原会议分别保存":"已输入内容保留，恢复后可保存")}</span><div className="actions">
      {stage===1 && group && <><Button variant="ghost" disabled={busy || !service.available} onClick={()=>void save(true)}>跳过本段</Button><Button variant="primary" disabled={busy || !service.available || !canSave} onClick={()=>void save()}>{busy?"保存中…":asr && target(asr) && !audioVerified && target(asr)!=="skip"?"暂存并下一段":"保存并下一段"}</Button></>}
      {plan && <><Button onClick={()=>setPlan(undefined)}>返回标注</Button><Button variant="primary" disabled={busy || !service.available || !confirmed || !plan.ready} onClick={()=>void train()}>确认训练与回测</Button></>}
      {stage===0 && <Button variant="primary" disabled={busy || !service.available || record.capture!=="completed" || ["queued","running"].includes(boot?.status||"")} onClick={()=>void prepare()}>生成待标注</Button>}
      {showResults && <Button variant="primary" onClick={()=>setShowResults(false)}>继续标注</Button>}
      {trainingBusy && <Button onClick={requestClose}>关闭窗口</Button>}
    </div></div>;
  return <Modal title="学习评审" className="learning-modal" wide explicitCloseOnly onClose={requestClose} headerActions={<Status tone={service.available?'':'warning'}>{statusLabel}</Status>} footer={footer}>
    <div className="learning-review">
      <p className="learning-record-name">{record.title}</p>
      <nav className="learning-steps" aria-label="学习评审流程">{["准备样本","人工标注","训练回测","查看结果"].map((label,index)=><span key={label} className={index===stage?'current':index<stage?'done':''} aria-current={index===stage?'step':undefined}><b>{index<stage?'✓':index+1}</b>{label}</span>)}</nav>
      <div className="learning-toolbar"><div className="learning-round"><Select label="评审轮次" value={round} disabled={busy || hasDrafts || !boot?.rounds.length} onChange={name=>{setShowResults(false);void load(name).catch(error=>setError(learningMessage(error)));}} options={(boot?.rounds||[]).map(item=>({value:item.name,label:`${item.name} · ${item.status}`}))}/></div><div className="learning-progress"><span>已标注 <b>{complete}</b> / {groups.length} 个片段</span><progress value={complete} max={groups.length||1}/></div><Button variant="ghost" disabled={busy || hasDrafts} onClick={()=>void refresh(true).catch(error=>setError(learningMessage(error)))}>刷新结果</Button>{groups.length>0 && <Button disabled={busy || hasDrafts || !service.available || trainingBusy} onClick={()=>void showPlan()}>训练与回测</Button>}{data.report && <Button variant="ghost" disabled={hasDrafts} onClick={()=>{setPlan(undefined);setShowResults(true);}}>查看结果</Button>}</div>
      {!service.available && <p className="learning-connection" role="status">{service.status==='checking'?"正在重新检测学习评审服务…":"评审服务暂不可用；当前材料可查看，生成、保存与训练暂时禁用。"}</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {["failed","stale"].includes(boot?.training?.status||"") && <p className="notice" role="status">上轮训练未完成或标签已变化，已保存材料保留。请重新核对训练计划。</p>}
      {showResults ? <section className="learning-results"><h3>{data.report?.trained?`${round} · 回测结果`:`${round} · 标注准备已完成`}</h3><p className="muted">{(data.report?.goldTestReady || data.report?.baseScores?.gold_test_ready)?"独立测试与训练会议隔离，结果仅适用于下列样本。":"尚无可用的独立测试结果，不能据此判断真实识别质量提升。"}</p><table><thead><tr><th>独立测试</th><th>训练前</th><th>本轮</th></tr></thead><tbody>{[["asr","转录候选"],["intent","意图判断"]].map(([family,label])=><tr key={family}><td>{label}</td><td>{score(data.report?.baseScores,family)}</td><td>{score(data.report?.adapterScores,family)}</td></tr>)}</tbody></table><p className="muted">训练结果不会自动启用到会议转录。</p></section> : plan ? <section className="learning-plan"><h3>确认本轮训练与回测</h3><p>{plan.message}</p><div className="learning-plan-columns"><table><thead><tr><th>样本分组</th><th>转录校正</th><th>意图判断</th></tr></thead><tbody><tr><td>训练集</td><td>{plan.counts.asr} 条</td><td>{plan.counts.intent} 条</td></tr>{[['dev','验证集'],['test','独立测试集']].map(([key,label])=><tr key={key}><td>{label}</td><td>{plan.evaluationBySplit?.[key]?.asr??'—'}</td><td>{plan.evaluationBySplit?.[key]?.intent??'—'}</td></tr>)}</tbody></table><div className="learning-plan-note"><h4>本次训练边界</h4><p>仅使用已保存的人工标签。未核听、跳过和输入版本不一致的转录标签不进入训练。</p><p>验证与测试按会议隔离；盲标前隐藏模型判断。训练结果先回测，不自动启用。</p></div></div><label className="checkbox-label"><input type="checkbox" checked={confirmed} disabled={!service.available} onChange={event=>setConfirmed(event.target.checked)}/><span>我已核对样本与分组，确认使用上述人工标签训练及回测</span></label></section> : trainingBusy ? <section className="learning-empty" role="status"><h3>{boot?.training?.round} · 训练与回测进行中</h3><p>任务在后台继续，完成后会保留新的可标注结果。</p><Button disabled={busy || hasDrafts} onClick={()=>void refresh(true).catch(error=>setError(learningMessage(error)))}>检查最新结果</Button></section> : !data.cases.length ? <section className="learning-empty" role="status"><h3>{["queued","running"].includes(boot?.status||"")?"正在准备本场评审":boot?.status==='failed'?"待标注准备未完成":"这场会议还没有待标注片段"}</h3><p>{boot?.message || "使用已确认转录与留存原音，创建人工评审材料。"}</p>{["queued","running"].includes(boot?.status||"") && <ol><li>冻结转录与原音版本</li><li>建立转录候选与五类意图问题</li><li>准备完成后开始人工核听标注</li></ol>}</section> : <div className="learning-layout"><aside className="learning-sidebar"><input type="search" aria-label="搜索本次待标注片段" placeholder="搜索发言内容" value={query} onChange={event=>setQuery(event.target.value)}/><Select label="筛选任务" value={family} onChange={setFamily} options={[{value:'all',label:'全部任务'},{value:'intent',label:'意图判断'},{value:'asr',label:'转录候选'}]}/><label className="checkbox-label"><input type="checkbox" checked={onlyPending} onChange={event=>setOnlyPending(event.target.checked)}/>仅看待标注</label><nav aria-label="本次会议待标注片段">{filtered.map(item=><button type="button" key={item.id} className={`learning-case ${item.id===group?.id?'selected':''}`} onClick={()=>setSelected(item.id)}><small>{timecode(item.startMs||0)}–{timecode(item.endMs||0)}<span>{visible(item).some(pending)?'待标注':'已标注'}</span></small><span>{item.text}</span></button>)}</nav></aside><section ref={detailRoot} className="learning-detail" aria-label="片段核对">{!group ? <div className="learning-empty"><h3>当前筛选下的片段已标注</h3><p>可切换筛选查看已有标签，或核对训练计划。</p></div> : <>
        <div className="learning-mobile-nav"><Select label="选择发言片段" value={group.id} onChange={setSelected} options={filtered.map((item,index)=>({value:item.id,label:`${index+1} · ${timecode(item.startMs||0)} ${item.text.slice(0,28)}`}))}/></div>
        <div className="learning-focus-heading" aria-live="polite"><h3>片段 {groups.findIndex(item=>item.id===group.id)+1} · {names[current[0].task]==='转录候选'?'转录核对':'发言核对'}</h3><span>{timecode(group.startMs||0)}–{timecode(group.endMs||0)}</span></div>
        <p className="learning-version">转录 v{current[0].source.transcriptRevision} · 片段 v{current[0].source.focus.revision} · {{train:'训练分组',dev:'验证分组 · 先盲标',test:'测试分组 · 先盲标'}[current[0].split]||current[0].split}</p>
        {audioRow && <AudioPlayer sources={[{id:group.id,label:"核听当前发言原音",src:`/api${prefix}/audio?round=${encodeURIComponent(round)}&sample=${encodeURIComponent(audioRow.sample_id)}`}]} durationMs={Math.max(0,(group.endMs||0)-(group.startMs||0))} onError={()=>setAudioErrors(previous=>({...previous,[group.id]:true}))}/>}
        <fieldset className="learning-edit-fields" disabled={busy || !service.available}>
          {asr && <label className="checkbox-label learning-listened"><input type="checkbox" checked={audioVerified} disabled={hasAudioError} onChange={event=>setVerified(previous=>({...previous,[group.id]:event.target.checked}))}/>我已核听这段原音{hasAudioError && wasVerified?'（保留历史确认）':''}</label>}
          {hasAudioError && <p className="learning-audio-warning" role="status">原音不可用；可暂存或跳过，未核听的标签不会用于训练。</p>}
          {!asr && <p className="learning-speech">{group.text}</p>}
          {group.text!==group.original && <details className="learning-original"><summary>识别原文</summary><p>{group.original}</p></details>}
          {current.some(row=>row.rejected) && <p className="notice">输入超出模型预算，标签可保留，但该样本不进入本轮训练。</p>}
          {[...current].sort((a,b)=>Number(b.family==='asr')-Number(a.family==='asr')).map(row=><fieldset className={`learning-task ${row.family}`} key={row.sample_id}><legend>{row.family==='asr'?'哪一份转录与原音一致？':names[row.task]}</legend><div className={row.family==='asr'?'learning-asr-options':'learning-intent-options'}>{(row.family==='asr'?[...(row.display.candidates||[]).map((text,index)=>['c'+index,text]),['none','均不正确／无法判断'],['skip','跳过']]:[['present','存在'],['absent','不存在'],['skip','跳过']]).map(([value,text],index)=><label className="learning-choice" key={value}><input type="radio" name={row.sample_id} value={value} checked={target(row)===value} onChange={()=>change(row,{target:value})}/><span>{text}</span>{row.family==='asr' && value.startsWith('c') && <small>候选 {String.fromCharCode(65+index)}</small>}</label>)}</div></fieldset>)}
          {asr && (target(asr)==='none' || correction) && <label className="learning-correction">核听后的正确文字<textarea rows={2} value={correction} maxLength={2000} onChange={event=>change(asr,{correctedText:event.target.value})} placeholder="候选均不正确时填写；下轮会成为新候选"/></label>}
          <div className="learning-fields"><label>标注者<input value={reviewer} maxLength={80} required onChange={event=>setReviewer(event.target.value)}/></label><label>备注<input value={notes[group.id]??current[0].note??''} maxLength={2000} onChange={event=>setNotes(previous=>({...previous,[group.id]:event.target.value}))}/></label></div>
        </fieldset>
        <details className="learning-predictions"><summary>模型与教师结果</summary>{current.map(row=><p key={row.sample_id}><b>{names[row.task]}</b>：{row.split!=='train' && pending(row)?'独立评测样本，先标注再展示预测。':`训练前 ${describe(row,row.basePrediction)} ｜ 本轮 ${describe(row,row.adapterPrediction)} ｜ 教师弱标 ${describe(row,row.teacherTarget?{choice:row.teacherTarget}:null)}`}</p>)}<p>预测和教师弱标不是原话真值。</p></details>
      </>}</section></div>}
    </div>
  </Modal>;
}
