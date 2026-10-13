#!/usr/bin/env python3
"""Build private, versioned intent datasets from explicitly selected Record backups. No network calls."""
import argparse
import collections
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import tempfile

from intent_inputs import (NativeBudget, PREPROCESSING_VERSION, digest, native_metadata, prepare_intent_windows,
                           preprocessing_contract, validate_segments)

ROOT = pathlib.Path(__file__).parent
SPLITS = ("train", "dev", "test")
LABELS = ("present", "absent")


def read_json(path):
    content = path.read_bytes()
    if len(content) > 20 * 1024 ** 2:
        raise ValueError(f"Input exceeds 20 MiB: {path.name}")
    return json.loads(content)


def annotation_file(path):
    if path is None:
        return []
    content = path.read_bytes()
    if len(content) > 20 * 1024 ** 2:
        raise ValueError("Annotation file exceeds 20 MiB")
    return [json.loads(line) for line in content.decode().splitlines() if line.strip()]


def load_records(paths):
    records, sources, total_bytes = [], [], 0
    for path in paths:
        content = path.read_bytes()
        total_bytes += len(content)
        if len(content) > 20 * 1024 ** 2 or total_bytes > 100 * 1024 ** 2:
            raise ValueError("Backups exceed per-file 20 MiB or total 100 MiB budget")
        value = json.loads(content)
        batch = value if isinstance(value, list) else value.get("records", [value]) if isinstance(value, dict) else None
        if not isinstance(batch, list) or not all(isinstance(record, dict) for record in batch):
            raise ValueError("Input must be a Record, an array, or {records: [...]} JSON")
        records.extend(batch)
        sources.append({"file": path.name, "sha256": hashlib.sha256(content).hexdigest()})
        if len(records) > 200:
            raise ValueError("At most 200 Record backups are supported")
    if len(records) > 200 or len({record.get("id") for record in records}) != len(records):
        raise ValueError("At most 200 distinct Record IDs are supported")
    return records, sources


def make_candidates(records, allowed, policy, budget, context_turns, redactions):
    samples, rejected, skipped, record_fingerprints = [], [], collections.Counter(), {}
    policy_hash = digest(policy)
    preprocessing = preprocessing_contract(context_turns, redactions)
    total = 0
    for record in sorted(records, key=lambda value: value.get("id", "")):
        if record.get("id") not in allowed:
            skipped["not_selected_for_training"] += 1
            continue
        if record.get("deleted"):
            skipped["deleted"] += 1
            continue
        if record.get("deleteAt"):
            expires = datetime.datetime.fromisoformat(record["deleteAt"].replace("Z", "+00:00"))
            if expires.tzinfo is None:
                raise ValueError("Retention timestamp must include timezone")
            if expires <= datetime.datetime.now(datetime.timezone.utc):
                skipped["expired"] += 1
                continue
        segments = validate_segments(record)
        if not segments:
            skipped["no_confirmed_segments"] += 1
            continue
        total += len(segments)
        if total > 10000:
            raise ValueError("At most 10000 selected segments per build")
        windows = prepare_intent_windows(record, policy, budget, context_turns=context_turns, redactions=redactions)
        record_fingerprints[record["id"]] = digest([re.sub(r"\s+", "", window["focus_text"]).casefold() for window in windows])
        insights = record.get("insights") or {}
        stored = insights.get("items", []) if insights.get("method") == "model" and insights.get("transcriptRevision") == record["transcriptRevision"] else []
        for window in windows:
            requests, sizes = window["requests"], window["tokens"]
            provenance = {"recordId": record["id"], "transcriptRevision": record["transcriptRevision"],
                          "focus": window["focus"], "evidence": window["evidence"]}
            rule = next((kind for kind, pattern in policy["positive_patterns"] if re.search(pattern, window["focus_text"])), None)
            for kind, request in requests.items():
                sid = digest({"source": provenance, "task": kind, "policy": policy_hash, "preprocessing": preprocessing})
                sample = {"sample_id": sid, "input_hash": digest({"request": request, "source": provenance, "policy": policy_hash, "preprocessing": preprocessing}),
                          "model_input_hash": window["model_input_hashes"][kind], "preprocessing_version": PREPROCESSING_VERSION,
                          "task": kind, "request": request, "source": provenance, "tokens": sizes[kind], "signals": []}
                if kind in window["rejected_tasks"]:
                    rejected.append({**sample, "reason": window["rejected_tasks"][kind]})
                    continue
                if rule == kind:
                    sample["signals"].append({"source": "rules", "label": "present", "version": policy["version"]})
                if any(item.get("kind") == kind and item.get("evidence") == [provenance["focus"]] for item in stored):
                    sample["signals"].append({"source": "stored_model", "label": "present", "independence_verified": False})
                samples.append(sample)
    return samples, rejected, dict(skipped), record_fingerprints


def assign_groups(samples, fingerprints, seed, split_map):
    parents = {key: key for key in fingerprints}
    def find(key):
        while parents[key] != key:
            parents[key] = parents[parents[key]]
            key = parents[key]
        return key
    def union(a, b):
        a, b = find(a), find(b)
        parents[max(a, b)] = min(a, b)
    seen = {}
    for rid, value in sorted(fingerprints.items()):
        if value in seen:
            union(rid, seen[value])
        seen[value] = rid
    seen = {}
    for sample in samples:
        state = re.sub(r"\s+", "", sample["request"]["state"]).casefold()
        if len(state) < 32:
            continue
        key, rid = digest(state), sample["source"]["recordId"]
        if key in seen:
            union(rid, seen[key])
        seen[key] = rid
    groups = collections.defaultdict(list)
    for rid in parents:
        groups[find(rid)].append(rid)
    result = {}
    for group, ids in groups.items():
        if split_map is not None:
            values = {split_map.get(rid) for rid in ids}
            if len(values) != 1 or next(iter(values)) not in SPLITS:
                raise ValueError("Split map must cover records and keep exact duplicates in one split")
            split = next(iter(values))
        else:
            bucket = int(digest([seed, group])[:8], 16) % 100
            split = "train" if bucket < 80 else "dev" if bucket < 90 else "test"
        for rid in ids:
            result[rid] = {"group_id": digest(sorted(ids)), "split": split}
    for sample in samples:
        sample.update(result[sample["source"]["recordId"]])
    return {rid: value["split"] for rid, value in result.items()}


def attach_annotations(samples, rows, human):
    lookup, seen = {sample["sample_id"]: sample for sample in samples}, set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Annotation rows must be objects")
        if row.get("label") is None:
            continue
        sid = row.get("sample_id")
        if sid not in lookup or sid in seen:
            raise ValueError("Unknown, stale or duplicate annotation sample_id")
        seen.add(sid)
        sample = lookup[sid]
        if row.get("input_hash") != sample["input_hash"]:
            raise ValueError("Stale annotation input_hash")
        if human:
            if row.get("label") not in (*LABELS, "skip") or not str(row.get("reviewer", "")).strip():
                raise ValueError("Human labels require present/absent/skip and reviewer")
            sample["review"] = {key: row.get(key) for key in ("label", "reviewer", "note")}
        else:
            if row.get("label") not in (*LABELS, "abstain") or not all(isinstance(row.get(k), str) and row[k].strip() for k in ("model", "prompt_version", "run_id")):
                raise ValueError("Teacher label requires model, prompt_version and run_id")
            evidence = row.get("evidence", [])
            if not isinstance(evidence, list) or any(ref not in sample["source"]["evidence"] for ref in evidence):
                raise ValueError("Teacher evidence does not match source snapshot")
            if row["label"] != "abstain" and sample["source"]["focus"] not in evidence:
                raise ValueError("Teacher must reference the focal segment")
            sample["teacher"] = {key: row.get(key) for key in ("label", "model", "prompt_version", "run_id", "evidence")}


def resolve(samples, accept_silver, train_limit, seed):
    accepted, audit, review, duplicate_inputs = {key: [] for key in SPLITS}, [], [], collections.defaultdict(list)
    for sample in samples:
        signals, human, teacher = sample["signals"], sample.get("review"), sample.get("teacher")
        labels = {signal["label"] for signal in signals}
        if teacher and teacher["label"] in LABELS:
            labels.add(teacher["label"])
        status, label = "needs_review", None
        if human:
            status, label = ("skipped", None) if human["label"] == "skip" else ("gold", human["label"])
        elif (accept_silver and sample["split"] == "train" and teacher and teacher["label"] == "present"
              and "neohorse" not in teacher["model"].casefold()
              and any(s["source"] == "rules" for s in signals) and labels == {"present"}):
            status, label = "silver", "present"
        elif len(labels) > 1:
            status = "conflict"
        sample.update(status=status, label=label, exported=False)
        duplicate_inputs[digest(sample["request"])].append(sample)
    for duplicates in duplicate_inputs.values():
        labels = {sample["label"] for sample in duplicates if sample["label"] is not None}
        if len(labels) > 1:
            for sample in duplicates:
                sample.update(status="duplicate_label_conflict", label=None)
    candidates = sorted((sample for sample in samples if sample["label"] is not None),
                        key=lambda s: (s["status"] != "gold", digest([seed, s["sample_id"]])))
    seen = set()
    for sample in candidates:
        key = digest(sample["request"])
        if key in seen:
            sample["export_reason"] = "duplicate_input"
            continue
        if sample["split"] == "train" and train_limit is not None and len(accepted["train"]) >= train_limit:
            sample["export_reason"] = "train_limit"
            continue
        seen.add(key)
        sample["exported"] = True
        accepted[sample["split"]].append({"sample_id": sample["sample_id"], "request": sample["request"], "target": sample["label"]})
    for sample in samples:
        audit.append({key: value for key, value in sample.items() if key != "request"})
        if sample["label"] is None and sample["status"] != "skipped":
            review.append({"sample_id": sample["sample_id"], "input_hash": sample["input_hash"], "request": sample["request"],
                           "source": sample["source"], "suggested_label": next(iter({s["label"] for s in sample["signals"]}), None),
                           "status": sample["status"], "label": None, "reviewer": "", "note": ""})
    return accepted, audit, review


def write_output(output, payloads, manifest):
    if output.exists():
        raise ValueError("Output already exists; select a new dataset version directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = pathlib.Path(tempfile.mkdtemp(prefix=".intent-dataset-", dir=output.parent))
    try:
        for name, rows in payloads.items():
            path = temp / name
            path.write_text("".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows))
            path.chmod(0o600)
        for name, value in (("manifest.json", manifest), ("split-map.json", manifest["record_splits"])):
            path = temp / name
            path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
            path.chmod(0o600)
        if output.exists():
            raise ValueError("Output directory was concurrently created")
        temp.rename(output)
    finally:
        if temp.exists():
            shutil.rmtree(temp)


def build(records, allowed_document, policy, budget, reviews=(), teachers=(), context_turns=2,
          seed="intent-v1", split_map=None, accept_silver=False, train_limit=None, redactions=None):
    if not isinstance(allowed_document, dict) or allowed_document.get("purpose") != "intent-training" or not isinstance(allowed_document.get("recordIds"), list):
        raise ValueError("Allowed-records document requires purpose=intent-training and recordIds")
    allowed = set(allowed_document["recordIds"])
    if not allowed or not all(isinstance(rid, str) and rid for rid in allowed):
        raise ValueError("Explicit nonempty training record selection required")
    if allowed - {record.get("id") for record in records}:
        raise ValueError("Selected Record IDs are missing from input backups")
    preprocessing_contract(context_turns, redactions)
    samples, rejected, skipped, fingerprints = make_candidates(records, allowed, policy, budget, context_turns, redactions or {})
    mapping = assign_groups(samples, fingerprints, seed, split_map)
    attach_annotations(samples, teachers, human=False)
    attach_annotations(samples, reviews, human=True)
    accepted, audit, review = resolve(samples, accept_silver, train_limit, seed)
    preprocessing = preprocessing_contract(context_turns, redactions)
    manifest = {"schema": "neohorse-intent-dataset-v2", "preprocessing": preprocessing, "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "policy_sha256": digest(policy), "policy_version": policy["version"], "training_selection_sha256": digest(allowed_document),
                "seed": seed, "context_turns": context_turns, "state_limit": preprocessing["state_limit"], "full_row_limit": preprocessing["full_row_limit"],
                "record_splits": mapping, "accept_silver": accept_silver, "train_limit": train_limit,
                "synthetic_inputs_only": bool(mapping) and all(record.get("synthetic") is True for record in records if record.get("id") in mapping),
                "counts": {"candidates": len(samples), "review": len(review), "rejected": len(rejected),
                           **{split: len(rows) for split, rows in accepted.items()}}, "skipped_records": skipped,
                "statuses": dict(collections.Counter(row["status"] for row in audit)),
                "label_counts": {split: dict(collections.Counter(next(iter(row["request"]["questions"])) + ":" + row["target"] for row in rows)) for split, rows in accepted.items()},
                "warnings": ["Weak agreement is not ground truth; teacher identity is declared, not authenticated.",
                             "No automatic negative labels. Review negatives and rare classes.",
                             "Basic redaction is incomplete; inspect outputs before further use.",
                             "Historical snapshots do not reconstruct original online ASR inputs.",
                             "Current LoRA verifier accepts at most 64 rows and is not a full trainer."]}
    if not accepted["dev"] or not accepted["test"]:
        manifest["warnings"].append("Human-labelled dev/test coverage is missing; no evaluation readiness claimed.")
    return {**{split + ".jsonl": rows for split, rows in accepted.items()}, "candidates.jsonl": samples,
            "audit.jsonl": audit, "review.jsonl": review, "rejected.jsonl": rejected}, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=pathlib.Path, nargs="+", required=True, help="Explicit Record JSON backups")
    parser.add_argument("--allowed-records", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True, help="Fresh version directory")
    parser.add_argument("--tokenizer", type=pathlib.Path, default=ROOT / "model/tokenizer")
    parser.add_argument("--policy", type=pathlib.Path, default=ROOT / "intent_policy.json")
    parser.add_argument("--reviews", type=pathlib.Path)
    parser.add_argument("--teacher-labels", type=pathlib.Path)
    parser.add_argument("--split-map", type=pathlib.Path)
    parser.add_argument("--redact-map", type=pathlib.Path)
    parser.add_argument("--context-turns", type=int, default=2)
    parser.add_argument("--seed", default="intent-v1")
    parser.add_argument("--train-limit", type=int)
    parser.add_argument("--accept-silver", action="store_true", help="Train-only rule + non-student teacher positive agreement")
    args = parser.parse_args()
    if not 0 <= args.context_turns <= 4 or (args.train_limit is not None and args.train_limit < 1):
        parser.error("context-turns must be 0–4; train-limit must be positive")
    os.umask(0o077)
    records, sources = load_records(args.input)
    policy = read_json(args.policy)
    reference = pathlib.Path(__file__).resolve().parents[2] / policy["source"]
    if reference.is_file() and hashlib.sha256(reference.read_bytes()).hexdigest() != policy["source_sha256"]:
        raise ValueError("Project intent rules changed; review and version the rule policy snapshot")
    payloads, manifest = build(records, read_json(args.allowed_records), policy, NativeBudget(args.tokenizer),
                              annotation_file(args.reviews), annotation_file(args.teacher_labels), args.context_turns,
                              args.seed, read_json(args.split_map) if args.split_map else None,
                              args.accept_silver, args.train_limit, read_json(args.redact_map) if args.redact_map else None)
    manifest["source_files"] = sources
    manifest.update(native_metadata(args.tokenizer))
    write_output(args.output, payloads, manifest)
    print(json.dumps({"output": str(args.output), "counts": manifest["counts"], "statuses": manifest["statuses"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
