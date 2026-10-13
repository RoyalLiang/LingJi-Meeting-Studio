#!/usr/bin/env python3
"""Prepare one focus's bounded decision requests; no inference or network calls."""
import argparse
import json
import os
import pathlib

from intent_inputs import (NativeBudget, digest, native_metadata, prepare_intent_windows,
                           preprocessing_contract)

ROOT = pathlib.Path(__file__).parent


def read_json(path):
    raw = path.read_bytes()
    if len(raw) > 20 * 1024 ** 2:
        raise ValueError("Snapshot/config input exceeds 20 MiB")
    return json.loads(raw)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=pathlib.Path, required=True, help="One confirmed Record snapshot JSON")
    parser.add_argument("--focus-id", required=True)
    parser.add_argument("--tokenizer", type=pathlib.Path, default=ROOT / "model/tokenizer")
    parser.add_argument("--policy", type=pathlib.Path, default=ROOT / "intent_policy.json")
    parser.add_argument("--context-turns", type=int, default=2)
    parser.add_argument("--redact-map", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path, required=True, help="New JSON file; never overwritten")
    args = parser.parse_args(argv)
    if args.output.exists():
        raise FileExistsError("Output already exists; select a new request file")
    record, policy = read_json(args.input), read_json(args.policy)
    redactions = read_json(args.redact_map) if args.redact_map else None
    contract = preprocessing_contract(args.context_turns, redactions)
    windows = prepare_intent_windows(record, policy, NativeBudget(args.tokenizer), context_turns=args.context_turns,
                                     redactions=redactions, focus_id=args.focus_id)
    document = {"format": "neohorse-intent-input-v2", "recordId": record["id"],
                "transcriptRevision": record["transcriptRevision"], "preprocessing": contract,
                "policy_sha256": digest(policy), "window": windows[0], **native_metadata(args.tokenizer)}
    encoded = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
    args.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(encoded)
    print(json.dumps({"output": str(args.output), "requests": len(windows[0]["requests"]),
                      "rejected_tasks": windows[0]["rejected_tasks"], "inference_called": False}))


if __name__ == "__main__":
    main()
