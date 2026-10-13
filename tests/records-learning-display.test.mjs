import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanSpeechDisplay,
  groupReviewCases,
} from "../packages/records/src/learning-display.mjs";
const row = (task, record = "meeting-one") => ({
  sample_id: record + "-" + task,
  input_hash: record + "-" + task,
  family: task === "asr_selection" ? "asr" : "intent",
  task,
  source: {
    recordId: record,
    transcriptRevision: 7,
    focus: { segmentId: "focus", revision: 2 },
  },
  display: {
    original: "为啥为啥他他他这些 IP 全全不通呢？",
    meetingTitle: record,
    startMs: 5000,
    endMs: 8000,
  },
  target: null,
});
test("review shows a focus once with all intent and ASR tasks and keeps meetings isolated", () => {
  const cases = [
    "decision",
    "action",
    "proposal",
    "question",
    "withdrawal",
    "asr_selection",
  ].map((task) => row(task));
  cases.push(row("decision", "meeting-two"));
  const before = JSON.stringify(cases),
    groups = groupReviewCases(cases);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].rows.length, 6);
  assert.equal(groups[1].recordId, "meeting-two");
  assert.equal(groups[0].text, "为啥他这些 IP 全不通呢？");
  assert.equal(JSON.stringify(cases), before);
});
test("speech display simplifies disfluency but preserves negation, numbers, names, emphasis and lexical reduplication", () => {
  assert.equal(
    cleanSpeechDisplay("为啥为啥他他他这些 IP 全全不通呢？"),
    "为啥他这些 IP 全不通呢？",
  );
  for (const text of [
    "不不不，这个不能发。",
    "不是不是，我撤回。",
    "人人天天都要一一核对 11 个 IP。",
    "爸爸妈妈看看星星，谢谢大家。",
    "非常非常重要。",
    "IP IP 10.1.1.1",
    "王王负责。",
    "为啥，为啥没通？",
  ])
    assert.equal(cleanSpeechDisplay(text), text);
});
test("same text at a different time or revision remains a separate evidence group", () => {
  const one = row("decision"),
    two = {
      ...row("action"),
      source: { ...one.source, focus: { segmentId: "later", revision: 2 } },
      display: { ...one.display, startMs: 9000 },
    };
  const revised = {
    ...one,
    sample_id: "revised",
    source: { ...one.source, focus: { ...one.source.focus, revision: 3 } },
  };
  assert.equal(groupReviewCases([one, two, revised]).length, 3);
});

test("meetings stay contiguous and their focus segments are ordered by time", () => {
  const late = row("decision"),
    early = {
      ...row("action"),
      sample_id: "early",
      source: { ...late.source, focus: { segmentId: "earlier", revision: 2 } },
      display: { ...late.display, startMs: 1000 },
    },
    other = row("question", "meeting-two");
  const groups = groupReviewCases([late, other, early]);
  assert.deepEqual(
    groups.map((group) => group.recordId),
    ["meeting-one", "meeting-one", "meeting-two"],
  );
  assert.deepEqual(
    groups.slice(0, 2).map((group) => group.startMs),
    [1000, 5000],
  );
});
