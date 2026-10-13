"""Shared, bounded model-input preparation for offline data and future inference.

Only selected ended context and the focus can affect a request. Speaker aliases
and entity placeholders are local to that window; there is no record-wide state.
This prepares requests only and does not authorize, invoke, or publish inference.
"""
import hashlib
import json
import pathlib
import re

PREPROCESSING_VERSION = "intent-window-local-v2"
STATE_LIMIT = 128
FULL_ROW_LIMIT = 256


def digest(value):
    encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def preprocessing_contract(context_turns=2, redactions=None):
    if type(context_turns) is not int or not 0 <= context_turns <= 4:
        raise ValueError("context_turns must be an integer from 0 to 4")
    if redactions is not None and (not isinstance(redactions, dict) or not all(
            isinstance(k, str) and k and isinstance(v, str) and v for k, v in redactions.items())):
        raise ValueError("Redaction map must contain nonempty string replacements")
    return {"version": PREPROCESSING_VERSION, "speaker_alias_scope": "window",
            "context_turns": context_turns, "redactions_sha256": digest(redactions or {}),
            "state_limit": STATE_LIMIT, "full_row_limit": FULL_ROW_LIMIT}


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


def native_metadata(tokenizer_path):
    from importlib.metadata import version
    path = pathlib.Path(tokenizer_path)
    return {"tokenizer_files_sha256": {name: hashlib.sha256((path / name).read_bytes()).hexdigest()
                                for name in ("tokenizer.json", "tokenizer_config.json", "special_tokens_map.json")
                                if (path / name).is_file()}, "native_runtime_version": version("neohorse-decision")}


class _WindowRedactor:
    def __init__(self, window, extra):
        self.aliases, self.names, self.entities = {}, dict(extra), {}
        for segment in window:
            identity = self.identity(segment)
            if segment.get("speakerId") or segment.get("speaker"):
                self.aliases.setdefault(identity, f"S{len(self.aliases) + 1}")
                name = segment.get("speaker") or ""
                if len(name) >= 2 and not re.match(r"说话人|发言人|Speaker", name, re.I):
                    self.names.setdefault(name, "[" + self.aliases[identity] + "]")

    @staticmethod
    def identity(segment):
        return segment.get("speakerId") or (str(segment.get("sourceId", "")) + ":" + (segment.get("speaker") or ""))

    def speaker(self, segment):
        return self.aliases.get(self.identity(segment), "S?")

    def text(self, text):
        for source in sorted(self.names, key=lambda value: (-len(value), value)):
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
    if len(segments) > 10000:
        raise ValueError("At most 10000 segments per snapshot")
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


def prepare_intent_windows(record, policy, budget, *, context_turns=2, redactions=None, focus_id=None):
    """Return identical requests for a focus in a full snapshot or its prefix.

    Snapshot revisions remain caller-owned provenance. Appending later speech
    cannot change model inputs; changed/late prior ASR still needs a new snapshot.
    focus_id selects one window for inference preparation, without model calls.
    """
    preprocessing_contract(context_turns, redactions)
    segments = validate_segments(record)
    if focus_id is not None and not any(segment["id"] == focus_id for segment in segments):
        raise ValueError("Requested focus_id is missing from the snapshot")
    result = []
    for index, focus in enumerate(segments):
        if focus_id is not None and focus["id"] != focus_id:
            continue
        prior = []
        if context_turns:
            for previous in range(index - 1, -1, -1):
                segment = segments[previous]
                if segment["endMs"] <= focus["startMs"]:
                    prior.append(segment)
                    if len(prior) == context_turns:
                        break
            prior.reverse()
        while True:
            window = prior + [focus]
            redactor = _WindowRedactor(window, redactions or {})
            clean = [redactor.text(segment["text"].strip()) for segment in window]
            state = "\n".join(f"[{'当前发言' if i == len(window) - 1 else '前文'}][{redactor.speaker(segment)}]{text}"
                              for i, (segment, text) in enumerate(zip(window, clean)))
            requests = {kind: request_for(state, kind, policy) for kind in policy["tasks"]}
            sizes = {kind: budget(request) for kind, request in requests.items()}
            oversized = any(size["state"] > STATE_LIMIT or size["row"] > FULL_ROW_LIMIT for size in sizes.values())
            if not oversized or not prior:
                break
            prior = prior[1:]
        result.append({"focus": {"segmentId": focus["id"], "revision": focus["revision"]},
                       "evidence": [{"segmentId": s["id"], "revision": s["revision"]} for s in window],
                       "focus_text": clean[-1], "requests": requests, "tokens": sizes,
                       "model_input_hashes": {kind: digest(request) for kind, request in requests.items()},
                       "rejected_tasks": {kind: "focus_exceeds_token_budget" for kind, size in sizes.items()
                                          if size["state"] > STATE_LIMIT or size["row"] > FULL_ROW_LIMIT}})
    return result
