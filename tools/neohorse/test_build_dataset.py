"""Dataset integrity tests; real native tokenization/LoRA are validated separately on wgs."""
import copy
import contextlib
import io
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import build_dataset as ds
import intent_inputs as inputs
import prepare_intents as inference

POLICY = json.loads((pathlib.Path(__file__).parent / "intent_policy.json").read_text())


def record(rid="r1", text="我来跟进接口文档。", sid="s1"):
    return {"id": rid, "transcriptRevision": 1, "segments": [{"id": sid, "revision": 1,
            "text": text, "speaker": "", "startMs": 0, "endMs": 1000}]}


def budget(request):
    # A controllable test seam, not a claim about the model tokenizer.
    return {"state": len(request["state"]) + 1, "row": len(request["state"]) + 50}


class DatasetTests(unittest.TestCase):
    def test_full_record_and_every_inference_prefix_have_identical_inputs(self):
        r = record(text="请王伟跟进接口文档。")
        r["segments"][0].update(speakerId="host", speaker="主持人")
        for i, text in enumerate(["联系 first@example.org。", "我来确认，网址 https://example.org。", "为什么要取消？", "决定保留原方案。"], 1):
            r["segments"].append({"id": f"s{i+1}", "revision": 1, "speakerId": f"person-{i%2}",
                                  "speaker": "王伟" if i % 2 else "李明", "text": text,
                                  "startMs": i * 2000, "endMs": i * 2000 + 1000})
        r["transcriptRevision"] = 9
        for turns in (0, 1, 2, 4):
            dataset, _ = self.prepare([r], context_turns=turns)
            for index, segment in enumerate(r["segments"]):
                prefix = copy.deepcopy(r)
                prefix["segments"] = prefix["segments"][:index + 1]
                prefix["transcriptRevision"] = index + 1
                window = inputs.prepare_intent_windows(prefix, POLICY, budget, context_turns=turns, focus_id=segment["id"])[0]
                rows = [row for row in dataset["candidates.jsonl"] if row["source"]["focus"]["segmentId"] == segment["id"]]
                for row in rows:
                    kind = row["task"]
                    self.assertEqual(row["request"], window["requests"][kind])
                    self.assertEqual(row["tokens"], window["tokens"][kind])
                    self.assertEqual(row["model_input_hash"], window["model_input_hashes"][kind])
                    self.assertEqual(row["source"]["evidence"], window["evidence"])

    def test_trimming_rebuilds_aliases_and_entity_placeholders(self):
        r = record(text="背景" * 60 + " first@example.org")
        r["segments"][0].update(speakerId="old", speaker="张三")
        focus = {"id": "s2", "revision": 1, "speakerId": "new", "speaker": "李明",
                 "text": "联系 second@example.org。", "startMs": 2000, "endMs": 3000}
        r["segments"].append(focus)
        full = inputs.prepare_intent_windows(r, POLICY, budget, focus_id="s2")[0]
        one = inputs.prepare_intent_windows({**r, "segments": [focus]}, POLICY, budget, focus_id="s2")[0]
        self.assertEqual(full["requests"], one["requests"])
        self.assertEqual(full["evidence"], [{"segmentId": "s2", "revision": 1}])
        self.assertIn("[S1]", full["requests"]["action"]["state"])
        self.assertIn("[EMAIL_1]", full["requests"]["action"]["state"])

    def test_future_revision_does_not_change_prior_requests(self):
        r = record(text="请王伟跟进。")
        r["segments"].append({"id": "s2", "revision": 1, "speakerId": "later", "speaker": "王伟",
                              "text": "今天讨论。", "startMs": 2000, "endMs": 3000})
        before = inputs.prepare_intent_windows(r, POLICY, budget, focus_id="s1")[0]
        r["transcriptRevision"] += 1
        r["segments"][1].update(revision=2, speaker="李明", text="新的修订资料 first@example.org。")
        after = inputs.prepare_intent_windows(r, POLICY, budget, focus_id="s1")[0]
        self.assertEqual(before, after)

    def test_v2_contract_invalidates_legacy_annotations(self):
        data, info = self.prepare()
        sample = data["candidates.jsonl"][0]
        self.assertEqual(info["schema"], "neohorse-intent-dataset-v2")
        self.assertEqual(info["preprocessing"]["version"], inputs.PREPROCESSING_VERSION)
        legacy = self.review(sample)
        legacy["sample_id"] = ds.digest({"source": sample["source"], "task": sample["task"], "policy": ds.digest(POLICY)})
        with self.assertRaisesRegex(ValueError, "sample_id"):
            self.prepare(reviews=[legacy])
        _, changed = self.prepare(redactions={"未出现": "替换"})
        self.assertNotEqual(info["preprocessing"], changed["preprocessing"])
        with self.assertRaisesRegex(ValueError, "sample_id"):
            self.prepare(reviews=[self.review(sample)], redactions={"未出现": "替换"})

    def test_single_focus_cli_matches_dataset_and_preserves_output(self):
        r = record(text="张三请联系 user@example.org。")
        r["segments"][0].update(speakerId="person", speaker="张三")
        data, info = self.prepare([r])
        with tempfile.TemporaryDirectory() as directory:
            directory = pathlib.Path(directory)
            source, output = directory / "record.json", directory / "prepared.json"
            source.write_text(json.dumps(r))
            args = ["--input", str(source), "--focus-id", "s1", "--output", str(output)]
            with patch.object(inference, "NativeBudget", return_value=budget), patch.object(inference, "native_metadata", return_value={}), contextlib.redirect_stdout(io.StringIO()):
                inference.main(args)
                saved = output.read_bytes()
                with self.assertRaises(FileExistsError):
                    inference.main(args)
                self.assertEqual(output.read_bytes(), saved)
            prepared = json.loads(saved)
            self.assertEqual(prepared["preprocessing"], info["preprocessing"])
            self.assertEqual(prepared["policy_sha256"], info["policy_sha256"])
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            for sample in data["candidates.jsonl"]:
                self.assertEqual(sample["request"], prepared["window"]["requests"][sample["task"]])

    def test_inference_preparation_validates_focus_and_shared_limits(self):
        with self.assertRaisesRegex(ValueError, "focus_id"):
            inputs.prepare_intent_windows(record(), POLICY, budget, focus_id="missing")
        with self.assertRaisesRegex(ValueError, "context_turns"):
            inputs.prepare_intent_windows(record(), POLICY, budget, context_turns=5)
        r = record(text="长" * 200)
        window = inputs.prepare_intent_windows(r, POLICY, budget, focus_id="s1")[0]
        rejected, _ = self.prepare([r])
        self.assertEqual(set(window["rejected_tasks"]), {row["task"] for row in rejected["rejected.jsonl"]})

    def test_future_speaker_name_cannot_change_earlier_model_input(self):
        prefix = record(text="请王伟跟进接口文档。")
        prefix["segments"][0].update(speakerId="host", speaker="主持人")
        full = copy.deepcopy(prefix)
        full["segments"].append({"id": "s2", "revision": 1, "speakerId": "guest", "speaker": "王伟",
                                 "text": "我稍后处理。", "startMs": 2000, "endMs": 3000})
        before, _ = self.prepare([prefix])
        after, _ = self.prepare([full])
        earlier = [row for row in after["candidates.jsonl"] if row["source"]["focus"]["segmentId"] == "s1"]
        self.assertEqual([row["request"] for row in before["candidates.jsonl"]], [row["request"] for row in earlier])

    def test_overlapping_later_speech_cannot_supply_names(self):
        prefix = record(text="请王伟跟进。")
        prefix["segments"][0].update(startMs=1000, endMs=2000)
        full = copy.deepcopy(prefix)
        full["segments"].insert(0, {"id": "long", "revision": 1, "speakerId": "guest", "speaker": "王伟",
                                    "text": "稍后才结束的另一音源。", "startMs": 0, "endMs": 5000})
        before, _ = self.prepare([prefix])
        after, _ = self.prepare([full])
        earlier = [row for row in after["candidates.jsonl"] if row["source"]["focus"]["segmentId"] == "s1"]
        self.assertEqual([row["request"] for row in before["candidates.jsonl"]], [row["request"] for row in earlier])

    def test_unused_history_cannot_renumber_current_window_entities(self):
        r = record(text="联系 first@example.org。")
        r["segments"] += [{"id": "s2", "revision": 1, "text": "继续联系 second@example.org。", "speaker": "",
                           "startMs": 2000, "endMs": 3000}]
        full, _ = self.prepare([r], context_turns=0)
        focus_only = copy.deepcopy(r)
        focus_only["segments"] = [focus_only["segments"][1]]
        one, _ = self.prepare([focus_only], context_turns=0)
        focus = [row for row in full["candidates.jsonl"] if row["source"]["focus"]["segmentId"] == "s2"]
        self.assertEqual([row["request"] for row in one["candidates.jsonl"]], [row["request"] for row in focus])

    def test_empty_record_is_skipped_without_negative_examples(self):
        r = record()
        r["segments"] = []
        r["transcriptRevision"] = 0
        data, info = self.prepare([r])
        self.assertEqual(info["skipped_records"], {"no_confirmed_segments": 1})
        self.assertFalse(data["candidates.jsonl"])
        self.assertFalse(data["train.jsonl"])

    def test_parse_and_fingerprint_use_the_same_single_read(self):
        raw = json.dumps(record()).encode()
        path = Mock()
        path.name = "mutable-backup.json"
        path.read_bytes.side_effect = [raw, AssertionError("Backup read twice")]
        records, sources = ds.load_records([path])
        import hashlib
        self.assertEqual(records[0]["id"], "r1")
        self.assertEqual(sources[0]["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(path.read_bytes.call_count, 1)

    def test_nullable_unknown_speaker_and_invalid_speaker(self):
        r = record()
        r["segments"][0]["speaker"] = None
        data, _ = self.prepare([r])
        self.assertIn("[S?]", data["candidates.jsonl"][0]["request"]["state"])
        r["segments"][0]["speaker"] = {"invalid": True}
        with self.assertRaisesRegex(ValueError, "identifiers"):
            self.prepare([r])

    def test_reviewed_groups_are_isolated_in_three_splits(self):
        records = [record("a", "决定采用方案A。"), record("b", "建议收集方案B。"), record("c", "为什么出现问题C？")]
        mapping = {"a": "train", "b": "dev", "c": "test"}
        data, _ = self.prepare(records, split_map=mapping)
        reviews = [self.review(s, "present" if s["signals"] else "absent") for s in data["candidates.jsonl"]]
        result, _ = self.prepare(records, split_map=mapping, reviews=reviews)
        source = {row["sample_id"]: row["source"]["recordId"] for row in result["audit.jsonl"]}
        for split in ds.SPLITS:
            self.assertEqual(len(result[split + ".jsonl"]), 5)
            self.assertTrue(all(mapping[source[row["sample_id"]]] == split for row in result[split + ".jsonl"]))

    def prepare(self, records=None, **kwargs):
        records = records or [record()]
        allowed = {"purpose": "intent-training", "recordIds": [r["id"] for r in records]}
        kwargs.setdefault("split_map", {r["id"]: "train" for r in records})
        return ds.build(records, allowed, POLICY, budget, **kwargs)

    def review(self, sample, label="present"):
        return {"sample_id": sample["sample_id"], "input_hash": sample["input_hash"], "label": label, "reviewer": "synthetic-reviewer"}

    def teacher(self, sample, label="present", model="independent-synthetic-teacher"):
        return {"sample_id": sample["sample_id"], "input_hash": sample["input_hash"], "label": label,
                "model": model, "prompt_version": "fixture-v1", "run_id": "synthetic", "evidence": [sample["source"]["focus"]]}

    def test_no_negative_from_missing_rule_and_no_default_export(self):
        data, info = self.prepare()
        self.assertEqual(info["counts"]["candidates"], 5)
        self.assertEqual(data["train.jsonl"], [])
        self.assertTrue(all(sample["label"] is None for sample in data["candidates.jsonl"]))
        self.assertEqual([s["task"] for s in data["candidates.jsonl"] if s["signals"]], ["action"])

    def test_multi_label_review_and_explicit_negative(self):
        records = [record(text="决定采用方案A，我来跟进。")]
        data, _ = self.prepare(records)
        reviews = [self.review(s, "present" if s["task"] in ("decision", "action") else "absent") for s in data["candidates.jsonl"]]
        result, _ = self.prepare(records, reviews=reviews)
        labels = {next(iter(row["request"]["questions"])): row["target"] for row in result["train.jsonl"]}
        self.assertEqual(labels["decision"], "present")
        self.assertEqual(labels["action"], "present")
        self.assertEqual(labels["question"], "absent")

    def test_silver_requires_explicit_flag_teacher_and_train_split(self):
        data, _ = self.prepare()
        sample = next(s for s in data["candidates.jsonl"] if s["task"] == "action")
        teachers = [self.teacher(sample)]
        result, _ = self.prepare(teachers=teachers)
        self.assertFalse(result["train.jsonl"])
        result, _ = self.prepare(teachers=teachers, accept_silver=True)
        self.assertEqual(len(result["train.jsonl"]), 1)
        result, _ = self.prepare(teachers=[self.teacher(sample, model="TokenRhythm/NeoHorse-Jev-4B")], accept_silver=True)
        self.assertFalse(result["train.jsonl"])
        result, _ = self.prepare(teachers=teachers, accept_silver=True, split_map={"r1": "test"})
        self.assertFalse(result["test.jsonl"])

    def test_conflicting_teacher_requires_review_and_human_overrides(self):
        data, _ = self.prepare()
        sample = next(s for s in data["candidates.jsonl"] if s["task"] == "action")
        teacher = self.teacher(sample, "absent")
        result, _ = self.prepare(teachers=[teacher], accept_silver=True)
        self.assertEqual(next(s for s in result["candidates.jsonl"] if s["task"] == "action")["status"], "conflict")
        result, _ = self.prepare(teachers=[teacher], reviews=[self.review(sample, "absent")])
        self.assertEqual(result["train.jsonl"][0]["target"], "absent")

    def test_stale_annotations_rejected_even_when_id_does_not_change(self):
        data, _ = self.prepare()
        sample = data["candidates.jsonl"][0]
        changed = [record(text="今天讨论完全不同的内容。")]
        with self.assertRaisesRegex(ValueError, "input_hash"):
            self.prepare(changed, reviews=[self.review(sample)])
        stale_revision = [record()]
        stale_revision[0]["segments"][0]["revision"] = 2
        with self.assertRaisesRegex(ValueError, "sample_id"):
            self.prepare(stale_revision, reviews=[self.review(sample)])

    def test_invalid_teacher_evidence_is_not_accepted(self):
        data, _ = self.prepare()
        teacher = self.teacher(data["candidates.jsonl"][0])
        teacher["evidence"] = [{"segmentId": "invented", "revision": 1}]
        with self.assertRaisesRegex(ValueError, "evidence"):
            self.prepare(teachers=[teacher])

    def test_future_text_excluded_and_only_earlier_context_trimmed(self):
        r = record(text="背景" * 60)
        r["segments"] += [{"id": "s2", "revision": 1, "text": "我来跟进。", "speaker": "", "startMs": 2000, "endMs": 3000},
                          {"id": "s3", "revision": 1, "text": "未来才决定的秘密", "speaker": "", "startMs": 4000, "endMs": 5000}]
        data, _ = self.prepare([r])
        focus = next(s for s in data["candidates.jsonl"] if s["source"]["focus"]["segmentId"] == "s2")
        self.assertNotIn("未来", focus["request"]["state"])
        self.assertEqual(focus["source"]["evidence"], [{"segmentId": "s2", "revision": 1}])
        self.assertIn("我来跟进。", focus["request"]["state"])

    def test_oversized_focus_is_rejected_without_truncation(self):
        data, info = self.prepare([record(text="长" * 200)])
        self.assertEqual(info["counts"]["rejected"], 5)
        self.assertFalse(data["train.jsonl"])
        self.assertIn("长" * 200, data["rejected.jsonl"][0]["request"]["state"])

    def test_duplicate_records_cannot_cross_splits(self):
        records = [record("a"), record("b", sid="other-id")]
        with self.assertRaisesRegex(ValueError, "duplicates"):
            self.prepare(records, split_map={"a": "train", "b": "test"})
        data, _ = self.prepare(records)
        reviews = [self.review(s) for s in data["candidates.jsonl"] if s["task"] == "action"]
        result, _ = self.prepare(records, reviews=reviews)
        self.assertEqual(len(result["train.jsonl"]), 1)

    def test_duplicate_label_conflicts_are_excluded(self):
        records = [record("a"), record("b", sid="other-id")]
        data, _ = self.prepare(records)
        selected = [s for s in data["candidates.jsonl"] if s["task"] == "action"]
        result, _ = self.prepare(records, reviews=[self.review(selected[0]), self.review(selected[1], "absent")])
        self.assertFalse(result["train.jsonl"])
        self.assertEqual(sum(s["status"] == "duplicate_label_conflict" for s in result["audit.jsonl"]), 2)

    def test_explicit_selection_and_retention(self):
        records = [record("allowed"), record("private", text="private@example.org")]
        allowed = {"purpose": "intent-training", "recordIds": ["allowed"]}
        data, info = ds.build(records, allowed, POLICY, budget)
        self.assertNotIn("private@example.org", json.dumps(data))
        self.assertEqual(info["skipped_records"]["not_selected_for_training"], 1)
        records[0]["deleted"] = True
        _, info = ds.build(records, allowed, POLICY, budget)
        self.assertEqual(info["skipped_records"]["deleted"], 1)
        records[0].pop("deleted")
        records[0]["deleteAt"] = "2000-01-01T00:00:00Z"
        _, info = ds.build(records, allowed, POLICY, budget)
        self.assertEqual(info["skipped_records"]["expired"], 1)
        with self.assertRaises(ValueError):
            ds.build(records, {"purpose": "analysis", "recordIds": ["allowed"]}, POLICY, budget)

    def test_basic_redaction_and_source_outside_request(self):
        r = record(text="张三请联系 user@example.org，电话13812345678。")
        r["segments"][0]["speaker"] = "张三"
        data, _ = self.prepare([r])
        state = data["candidates.jsonl"][0]["request"]["state"]
        self.assertNotIn("张三", state)
        self.assertNotIn("user@example.org", state)
        self.assertNotIn("13812345678", state)
        self.assertNotIn("source", data["candidates.jsonl"][0]["request"])

    def test_stored_model_is_only_valid_positive_weak_evidence(self):
        r = record()
        r["insights"] = {"method": "model", "transcriptRevision": 1, "items": [{"kind": "action", "evidence": [{"segmentId": "s1", "revision": 1}]}]}
        data, _ = self.prepare([r], accept_silver=True)
        self.assertFalse(data["train.jsonl"])
        self.assertTrue(any(s["source"] == "stored_model" for c in data["candidates.jsonl"] for s in c["signals"]))
        r["insights"]["transcriptRevision"] = 0
        data, _ = self.prepare([r])
        self.assertFalse(any(s["source"] == "stored_model" for c in data["candidates.jsonl"] for s in c["signals"]))

    def test_determinism_train_limit_and_output_preservation(self):
        records = [record("a"), record("b", text="建议考虑另一方案。", sid="s2")]
        data, _ = self.prepare(records)
        reviews = [self.review(s, "present" if s["signals"] else "absent") for s in data["candidates.jsonl"]]
        first, info = self.prepare(records, reviews=reviews, train_limit=3)
        second, _ = self.prepare(list(reversed(records)), reviews=list(reversed(reviews)), train_limit=3)
        self.assertEqual(first["train.jsonl"], second["train.jsonl"])
        self.assertEqual(len(first["train.jsonl"]), 3)
        with tempfile.TemporaryDirectory() as directory:
            out = pathlib.Path(directory) / "v1"
            ds.write_output(out, first, info)
            original = (out / "train.jsonl").read_bytes()
            self.assertEqual((out / "train.jsonl").stat().st_mode & 0o777, 0o600)
            with self.assertRaisesRegex(ValueError, "already exists"):
                ds.write_output(out, second, info)
            self.assertEqual((out / "train.jsonl").read_bytes(), original)

    def test_policy_priority_matches_actual_project_rules(self):
        project = pathlib.Path(__file__).resolve().parents[2]
        texts = ["我来跟进。", "决定采用方案A，我来跟进。", "建议我来跟进。", "为什么要取消？", "今天开始。"]
        script = "import {ruleIntents} from './packages/records/src/intents.mjs';" + \
                 "const t=JSON.parse(process.argv[1]);console.log(JSON.stringify(t.map((text,i)=>ruleIntents([{id:String(i),revision:1,text}]).items[0]?.kind||null)));"
        native = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", script, json.dumps(texts)], cwd=project, text=True))
        import re
        expected = [next((kind for kind, pattern in POLICY["positive_patterns"] if re.search(pattern, text)), None) for text in texts]
        self.assertEqual(native, expected)


if __name__ == "__main__":
    unittest.main()
