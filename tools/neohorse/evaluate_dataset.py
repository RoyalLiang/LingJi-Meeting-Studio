#!/usr/bin/env python3
"""Evaluate explicit Choice labels; never use this report as a substitute for independent gold labels."""
import argparse
import collections
import hashlib
import json
import pathlib

from quantized_runtime import QuantizedDecisionEngine


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", default=str(pathlib.Path(__file__).parent / "model"))
    parser.add_argument("--dataset", type=pathlib.Path, required=True)
    parser.add_argument("--lora-adapter", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    content = args.dataset.read_bytes()
    rows = [json.loads(line) for line in content.decode().splitlines() if line.strip()]
    if not 1 <= len(rows) <= 5000:
        raise ValueError("Evaluation requires 1–5000 labelled rows")
    engine = QuantizedDecisionEngine(args.model_dir, lora_adapter=args.lora_adapter)
    metrics, results = {}, []
    for row in rows:
        questions = row["request"]["questions"]
        if len(questions) != 1:
            raise ValueError("Each evaluation row requires one Choice question")
        task, question = next(iter(questions.items()))
        if question["type"] != "choice" or row["target"] not in question["criteria"]:
            raise ValueError("Invalid labelled Choice row")
        if set(question["criteria"]) != {"present", "absent"}:
            raise ValueError("This evaluator expects present/absent criteria")
        answer = engine.predict(row["request"])["answers"][task]
        counts = metrics.setdefault(task, collections.Counter())
        truth, predicted = row["target"], answer["choice"]
        counts["samples"] += 1
        counts["correct"] += int(truth == predicted)
        counts["tp" if truth == predicted == "present" else "tn" if truth == predicted == "absent" else "fp" if predicted == "present" else "fn"] += 1
        results.append({"sample_id": row.get("sample_id"), "task": task, "target": truth, "prediction": predicted,
                        "probabilities": answer["probabilities"]})
    for counts in metrics.values():
        for key in ("tp", "tn", "fp", "fn"):
            counts.setdefault(key, 0)
        counts["precision"] = counts["tp"] / (counts["tp"] + counts["fp"]) if counts["tp"] + counts["fp"] else None
        counts["recall"] = counts["tp"] / (counts["tp"] + counts["fn"]) if counts["tp"] + counts["fn"] else None
        counts["f1"] = 2 * counts["tp"] / (2 * counts["tp"] + counts["fp"] + counts["fn"]) if 2 * counts["tp"] + counts["fp"] + counts["fn"] else None
        counts["accuracy"] = counts["correct"] / counts["samples"]
    report = {"scope": "Scores against supplied labels; label correctness is not verified by this script",
              "dataset_sha256": hashlib.sha256(content).hexdigest(), "samples": len(rows),
              "accuracy": sum(result["target"] == result["prediction"] for result in results) / len(rows),
              "per_task": metrics, "results": results, "runtime": engine.runtime_info()}
    if args.output.exists():
        raise ValueError("Refusing to overwrite evaluation report")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    args.output.chmod(0o600)
    print(json.dumps({"samples": len(rows), "accuracy": report["accuracy"], "output": str(args.output)}))


if __name__ == "__main__":
    main()
