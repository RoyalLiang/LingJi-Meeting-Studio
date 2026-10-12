#!/usr/bin/env python3
"""Convert the explicitly synthetic label fixture into review-file test inputs."""
import argparse
import json
import pathlib


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidates", type=pathlib.Path, required=True)
    parser.add_argument("--labels", type=pathlib.Path, default=pathlib.Path(__file__).parent / "fixtures/intent-labels.json")
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    labels = json.loads(args.labels.read_text())
    rows = []
    for line in args.candidates.read_text().splitlines():
        sample = json.loads(line)
        rid, focus = sample["source"]["recordId"], sample["source"]["focus"]["segmentId"]
        if rid not in labels or not rid.startswith("synthetic-"):
            raise ValueError("This helper only supports the named synthetic fixture records")
        rows.append({"sample_id": sample["sample_id"], "input_hash": sample["input_hash"],
                     "label": "present" if sample["task"] in labels[rid][focus] else "absent",
                     "reviewer": "synthetic-fixture-spec", "note": "Test fixture, not a human-reviewed real meeting"})
    if args.output.exists():
        raise ValueError("Refusing to overwrite review file")
    args.output.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows))
    args.output.chmod(0o600)
    print(json.dumps({"synthetic_review_rows": len(rows)}))


if __name__ == "__main__":
    main()
