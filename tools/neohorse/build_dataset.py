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

ROOT = pathlib.Path(__file__).parent
SPLITS = ("train", "dev", "test")
LABELS = ("present", "absent")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


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


class NativeBudget:
    def __init__(self, tokenizer_path):
        from transformers import AutoTokenizer
        from neohorse_decision._vendor.model import encode
        from neohorse_decision._vendor.schema import SystemOneRequest, to_record
        self.tokenizer = AutoTokenizer.from_pretrained(tokenizer_path, local_files_only=True)
        self.encode, self.schema, self.record = encode, SystemOneRequest, to_record

    def __call__(self, request):
        rec, _ = self.record(self.schema(**request))
        enc = self.encode(self.tokenizer, rec, strict=True, max_state=1000000, max_branch=1000000)
        return {"state": enc["seg"].count(0), "row": len(enc["ids"])}


class Redactor:
    def __init__(self, segments, extra):
        self.aliases, self.names, self.entities = {}, dict(extra), {}
        for segment in segments:
            identity = segment.get("speakerId") or (str(segment.get("sourceId", "")) + ":" + (segment.get("speaker") or ""))
            if segment.get("speakerId") or segment.get("speaker"):
                self.aliases.setdefault(identity, f"S{len(self.aliases) + 1}")
                name = segment.get("speaker") or ""
                if len(name) >= 2 and not re.match(r"说话人|发言人|Speaker", name, re.I):
                    self.names.setdefault(name, "[" + self.aliases[identity] + "]")

    def speaker(self, segment):
        key = segment.get("speakerId") or (str(segment.get("sourceId", "")) + ":" + (segment.get("speaker") or ""))
        return self.aliases.get(key, "S?")

    def text(self, text):
        for source in sorted(self.names, key=len, reverse=True):
            text = text.replace(source, self.names[source])
        patterns = [("EMAIL", r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}"),
                    ("PHONE", r"(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)"),
                    ("URL", r"https?://[^\s，。；]+")]
        for kind, pattern in patterns:
            def replace(match):
                key = (kind, match.group())
                if key not in self.entities:
                    self.entities[key] = f"[{kind}_{sum(k[0] == kind for k in self.entities) + 1}]"
                return self.entities[key]
            text = re.sub(pattern, replace, text)
        return text


def request_for(state, kind, policy):
    return {"state": state, "questions": {kind: {"type": "choice", "instructions": policy["tasks"][kind],
            "criteria": {"present": "存在该类讨论意图", "absent": "不存在该类讨论意图"}}}}


def validate_segments(record):
    segments = record.get("segments")
    if not isinstance(record.get("id"), str) or not record["id"] or not isinstance(segments, list):
        raise ValueError("Invalid Record export")
    if type(record.get("transcriptRevision")) is not int or record["transcriptRevision"] < 0:
        raise ValueError("Record requires transcriptRevision")
    ids = set()
    for segment in segments:
        if not isinstance(segment, dict) or not isinstance(segment.get("id"), str) or not segment["id"] or segment["id"] in ids:
            raise ValueError("Invalid or duplicate segment ID")
        ids.add(segment["id"])
        if any(segment.get(key) is not None and not isinstance(segment[key], str) for key in ("speaker", "speakerId", "sourceId")):
            raise ValueError("Speaker and source identifiers must be strings or null")
        if type(segment.get("revision")) is not int or segment["revision"] < 1:
            raise ValueError("Segment requires a positive revision")
        if not isinstance(segment.get("text"), str) or not segment["text"].strip() or len(segment["text"]) > 20000:
            raise ValueError("Invalid segment text")
        if any(type(segment.get(key)) not in (int, float) or not 0 <= segment[key] < 10 ** 12 for key in ("startMs", "endMs")):
            raise ValueError("Invalid segment timing")
        if segment["endMs"] < segment["startMs"]:
            raise ValueError("Negative segment duration")
    return sorted(segments, key=lambda segment: (segment["startMs"], segment["endMs"], segment["id"]))


def make_candidates(records, allowed, policy, budget, context_turns, redactions):
    samples, rejected, skipped, record_fingerprints = [], [], collections.Counter(), {}
    policy_hash = digest(policy)
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
        redactor = Redactor(segments, redactions)
        clean = {segment["id"]: redactor.text(segment["text"].strip()) for segment in segments}
        record_fingerprints[record["id"]] = digest([re.sub(r"\s+", "", clean[s["id"]]).casefold() for s in segments])
        insights = record.get("insights") or {}
        stored = insights.get("items", []) if insights.get("method") == "model" and insights.get("transcriptRevision") == record["transcriptRevision"] else []
        for index, focus in enumerate(segments):
            prior = [segment for segment in segments[:index] if segment["endMs"] <= focus["startMs"]][-context_turns:] if context_turns else []
            while True:
                state = "\n".join([f"[前文][{redactor.speaker(s)}]{clean[s['id']]}" for s in prior] +
                                  [f"[当前发言][{redactor.speaker(focus)}]{clean[focus['id']]}"])
                requests = {kind: request_for(state, kind, policy) for kind in policy["tasks"]}
                sizes = {kind: budget(request) for kind, request in requests.items()}
                if all(size["state"] <= 128 and size["row"] <= 256 for size in sizes.values()) or not prior:
                    break
                prior = prior[1:]
            evidence = [{"segmentId": s["id"], "revision": s["revision"]} for s in prior + [focus]]
            provenance = {"recordId": record["id"], "transcriptRevision": record["transcriptRevision"],
                          "focus": {"segmentId": focus["id"], "revision": focus["revision"]}, "evidence": evidence}
            rule = next((kind for kind, pattern in policy["positive_patterns"] if re.search(pattern, clean[focus["id"]])), None)
            for kind, request in requests.items():
                sid = digest({"source": provenance, "task": kind, "policy": policy_hash})
                sample = {"sample_id": sid, "input_hash": digest({"request": request, "source": provenance, "policy": policy_hash}),
                          "task": kind, "request": request, "source": provenance, "tokens": sizes[kind], "signals": []}
                if sizes[kind]["state"] > 128 or sizes[kind]["row"] > 256:
                    rejected.append({**sample, "reason": "focus_exceeds_token_budget"})
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
    if redactions is not None and (not isinstance(redactions, dict) or not all(isinstance(k, str) and k and isinstance(v, str) and v for k, v in redactions.items())):
        raise ValueError("Redaction map must contain nonempty string replacements")
    samples, rejected, skipped, fingerprints = make_candidates(records, allowed, policy, budget, context_turns, redactions or {})
    mapping = assign_groups(samples, fingerprints, seed, split_map)
    attach_annotations(samples, teachers, human=False)
    attach_annotations(samples, reviews, human=True)
    accepted, audit, review = resolve(samples, accept_silver, train_limit, seed)
    manifest = {"schema": "neohorse-intent-dataset-v1", "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "policy_sha256": digest(policy), "policy_version": policy["version"], "training_selection_sha256": digest(allowed_document),
                "seed": seed, "context_turns": context_turns, "state_limit": 128, "full_row_limit": 256,
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
    manifest["tokenizer_files_sha256"] = {name: hashlib.sha256((args.tokenizer / name).read_bytes()).hexdigest()
                                         for name in ("tokenizer.json", "tokenizer_config.json", "special_tokens_map.json")
                                         if (args.tokenizer / name).is_file()}
    from importlib.metadata import version
    manifest["native_runtime_version"] = version("neohorse-decision")
    write_output(args.output, payloads, manifest)
    print(json.dumps({"output": str(args.output), "counts": manifest["counts"], "statuses": manifest["statuses"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
