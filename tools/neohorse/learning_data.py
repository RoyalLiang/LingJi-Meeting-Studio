"""Versioned dual-task shadow cases and reviewed/weak-supervision datasets."""
import collections
import copy
import json
import random

import build_dataset as intents
from intent_inputs import _WindowRedactor, digest, validate_segments

VERSION = "alpha-dual-learning-v1"


def asr_case(record, row, budget):
    segments = validate_segments(record)
    index = next((i for i, segment in enumerate(segments) if segment["id"] == row["segmentId"]), None)
    if index is None or segments[index]["revision"] != row["revision"]:
        raise ValueError("ASR candidate source revision is stale")
    focus = segments[index]
    prior = [s for s in segments[:index] if s["endMs"] <= focus["startMs"]][-2:]
    candidates = []
    for candidate in row["candidates"]:
        if not isinstance(candidate.get("text"), str) or not candidate["text"].strip():
            raise ValueError("Invalid ASR candidate text")
        if candidate["text"].strip() not in candidates:
            candidates.append(candidate["text"].strip())
    if not 1 <= len(candidates) <= 4:
        raise ValueError("ASR selection accepts one to four distinct candidates")
    while True:
        redactor = _WindowRedactor(prior + [focus], {})
        state = "\n".join(f"[前文][{redactor.speaker(s)}]{redactor.text(s['text'])}" for s in prior)
        state += "\n[待核听]以下只是同一原音的转录候选，未确认真实原话。"
        options = {f"c{i}": redactor.text(text) for i, text in enumerate(candidates)}
        options["none"] = "全部不合适或仅凭文字无法判断"
        request = {"state": state.strip(), "questions": {"asr_selection": {"type": "choice",
            "instructions": "比较候选与已有前文的匹配程度。你不能听到原音，缺少依据选择 none，不因通顺就声称真实原话。", "criteria": options}}}
        size = budget(request)
        if (size["state"] <= 128 and size["row"] <= 256) or not prior:
            break
        prior = prior[1:]
    source = {"recordId": record["id"], "transcriptRevision": record["transcriptRevision"],
              "focus": {"segmentId": focus["id"], "revision": focus["revision"]},
              "evidence": [{"segmentId": s["id"], "revision": s["revision"]} for s in prior + [focus]],
              "audioSha256": row.get("audio", {}).get("sha256")}
    identity = {"version": VERSION, "source": source, "request": request, "candidateProvenance": row["candidates"]}
    return {"sample_id": digest(identity), "input_hash": digest(identity), "family": "asr", "task": "asr_selection",
            "request": request, "source": source, "tokens": size, "candidateCount": len(candidates),
            "display": {"original": focus["text"], "candidates": candidates, "audio": row.get("audio")},
            "rejected": "token_budget" if size["state"] > 128 or size["row"] > 256 else None}


def build_cases(records, policy, budget, asr_rows=(), split_map=None, per_record=12):
    allowed = {r["id"] for r in records}
    samples, rejected, skipped, fingerprints = intents.make_candidates(records, allowed, policy, budget, 2, {})
    mapping = intents.assign_groups(samples, fingerprints, "alpha-learning-v1", split_map)
    selected = set()
    for record in records:
        ids = {s["source"]["focus"]["segmentId"] for s in samples if s["source"]["recordId"] == record["id"]}
        selected.update((record["id"], sid) for sid in sorted(ids, key=lambda sid: digest(sid))[:per_record])
    cases = []
    lookup = {r["id"]: r for r in records}
    for sample in samples:
        key = (sample["source"]["recordId"], sample["source"]["focus"]["segmentId"])
        if key not in selected:
            continue
        cases.append({**sample, "family": "intent", "rejected": None,
                      "display": {"original": next(s["text"] for s in lookup[key[0]]["segments"] if s["id"] == key[1])}})
    for row in asr_rows:
        record = lookup.get(row["recordId"])
        if not record or record["id"] not in mapping:
            continue
        case = asr_case(record, row, budget)
        case["split"] = mapping[record["id"]]
        cases.append(case)
    # Dataset-only exact request deduplication later prevents repeated binary rows.
    return cases, {"schema": VERSION, "split_map": mapping, "source_records": len(records),
                   "source_segments": sum(len(r["segments"]) for r in records), "cases": len(cases),
                   "per_family": dict(collections.Counter(c["family"] for c in cases)),
                   "intent_budget_rejections": len(rejected), "skipped_records": skipped,
                   "per_record_focus_limit": per_record, "source_truth": "unreviewed ASR; predictions are candidates"}


def import_labels(cases, reviews=(), teachers=()):
    lookup = {case["sample_id"]: case for case in cases}
    labels = {}
    for human, rows in ((False, teachers), (True, reviews)):
        seen = set()
        for row in rows:
            target = row.get("target")
            if target in (None, "") or (not human and target in ("abstain", "skip")):
                continue
            sid = row.get("sample_id")
            if sid not in lookup or sid in seen or row.get("input_hash") != lookup[sid]["input_hash"]:
                raise ValueError("Unknown, duplicate or stale annotation")
            seen.add(sid)
            case = lookup[sid]
            if human and not str(row.get("reviewer", "")).strip():
                raise ValueError("Reviewed labels require reviewer identity")
            if human and target in ('skip', 'abstain'):
                labels.pop(sid, None)
                continue
            if target not in next(iter(case["request"]["questions"].values()))["criteria"]:
                raise ValueError("Annotation target is not a candidate key")
            if not human and not all(row.get(k) for k in ("model", "promptVersion", "runId")):
                raise ValueError("Teacher provenance missing")
            gold = human and (case["family"] != "asr" or (row.get("audioVerified") is True and case["source"].get("audioSha256")))
            if human and case['split'] in ('dev','test') and row.get('blindReview') is not True:
                gold = False
            labels[sid] = {"target": target, "quality": "gold" if gold else "silver", "provenance": row}
    return labels


def apply_corrections(records, asr_rows, cases, reviews, budget):
    """Bind human-added text to the reviewed old input, then issue a new case ID."""
    lookup = {case['sample_id']:case for case in cases}
    record_map = {record['id']:record for record in records}
    rows, updated, superseded = copy.deepcopy(list(asr_rows)), [], set()
    seen = set()
    for review in reviews:
        if not str(review.get('correctedText') or '').strip():
            updated.append(review)
            continue
        sid=review.get('sample_id'); case=lookup.get(sid)
        if not case or case['family']!='asr' or review.get('input_hash')!=case['input_hash'] or sid in seen:
            raise ValueError('Unknown, duplicate or stale correction')
        seen.add(sid)
        text=review['correctedText'].strip()
        if len(text)>2000 or not str(review.get('reviewer','')).strip():
            raise ValueError('Correction needs reviewer and at most 2000 characters')
        source=case['source']; row=next(r for r in rows if r['recordId']==source['recordId'] and r['segmentId']==source['focus']['segmentId'])
        texts=[candidate['text'].strip() for candidate in row['candidates']]
        if text not in texts:
            if len(texts)>=4:raise ValueError('At most four ASR candidates; preserve correction and rebuild a smaller candidate set')
            row['candidates'].append({'text':text,'source':'human_correction','reviewer':review['reviewer'],
                                      'basedOn':{'sample_id':sid,'input_hash':case['input_hash']}})
        new=asr_case(record_map[source['recordId']],row,budget)
        updated.append({**review,'sample_id':new['sample_id'],'input_hash':new['input_hash'],
                         'target':review['target'] if review.get('target') in ('skip','abstain') else 'c'+str([c['text'].strip() for c in row['candidates']].index(text)),
                        'correctionBasedOn':{'sample_id':sid,'input_hash':case['input_hash']}})
        if new['sample_id']!=sid:superseded.add(sid)
    return rows,updated,superseded


def datasets(cases, labels, accept_silver=False, train_limit=256):
    output = {s: [] for s in ("train", "dev", "test", "weak-test")}
    candidates = []
    for case in cases:
        label = labels.get(case["sample_id"])
        if case.get("rejected") or not label:
            continue
        split = case["split"]
        if label["quality"] == "silver":
            if split != "train":
                split = "weak-test"
            elif not accept_silver:
                continue
        candidates.append((case, label, split))
    groups = collections.defaultdict(list)
    for case, label, split in candidates:
        groups[digest(case["request"])].append((case, label, split))
    for identical in groups.values():
        if len({row[1]["target"] for row in identical}) > 1 or len({row[2] for row in identical}) > 1:
            continue
        case, label, split = sorted(identical, key=lambda row: (row[1]["quality"] != "gold", row[0]["sample_id"]))[0]
        output[split].append({"sample_id": case["sample_id"], "request": case["request"], "target": label["target"],
                              "family": case["family"], "label_quality": label["quality"], "source": case["source"]})
    # Equal per-family allowance; no family silently consumes the whole train cap.
    families = sorted({row["family"] for row in output["train"]})
    output["train"] = [row for family in families for row in sorted(
        (r for r in output["train"] if r["family"] == family), key=lambda r: (r["label_quality"] != "gold", r["sample_id"]))[:train_limit // max(1, len(families))]]
    return output


def training_order(samples, steps, seed=42, balance=False):
    rng = random.Random(seed)
    groups = collections.defaultdict(list)
    for index, sample in enumerate(samples):
        groups[sample.get("family", "legacy")].append(index)
    for indices in groups.values():
        rng.shuffle(indices)
    if not balance:
        return [step % len(samples) for step in range(steps)]
    names = sorted(groups)
    return [groups[names[step % len(names)]][(step // len(names)) % len(groups[names[step % len(names)]])] for step in range(steps)]


def jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
