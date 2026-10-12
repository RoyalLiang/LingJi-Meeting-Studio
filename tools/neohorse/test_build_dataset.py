"""Dataset integrity tests; real native tokenization/LoRA are validated separately on wgs."""
import copy
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import Mock

import build_dataset as ds

POLICY = json.loads((pathlib.Path(__file__).parent / "intent_policy.json").read_text())


def record(rid="r1", text="我来跟进接口文档。", sid="s1"):
    return {"id": rid, "transcriptRevision": 1, "segments": [{"id": sid, "revision": 1,
            "text": text, "speaker": "", "startMs": 0, "endMs": 1000}]}


def budget(request):
    # A controllable test seam, not a claim about the model tokenizer.
    return {"state": len(request["state"]) + 1, "row": len(request["state"]) + 50}


class DatasetTests(unittest.TestCase):
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
