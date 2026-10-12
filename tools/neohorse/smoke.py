#!/usr/bin/env python3
"""Functional GPU checks on synthetic examples, not a quality benchmark."""

import argparse
import json
import math
import pathlib
import time

from quantized_runtime import QuantizedDecisionEngine

CASES = [
    ("Please summarize this meeting.", "summarize"),
    ("请把刚才讨论的内容整理成会议纪要。", "summarize"),
    ("请列出会议里已经明确的待办事项。", "actions"),
    ("先别发给客户，等我确认后再说。", "none"),
    ("他说如果预算通过就发邮件，这还没有决定。", "none"),
    ("请找出这次会议已经做出的决定。", "decisions"),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", default=str(pathlib.Path(__file__).parent / "model"))
    parser.add_argument("--head-checkpoint", type=pathlib.Path, help="Optional trained pointer-head checkpoint")
    parser.add_argument("--lora-adapter", type=pathlib.Path, help="Optional local PEFT adapter directory")
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    started = time.monotonic()
    engine = QuantizedDecisionEngine(args.model_dir, head_checkpoint=args.head_checkpoint, lora_adapter=args.lora_adapter)
    loaded = time.monotonic() - started
    results = []
    for state, expected in CASES:
        request = {"state": state, "questions": {
            "intent": {"type": "choice", "instructions": "识别用户当前明确请求的软件操作。转述、假设或否定的操作不算当前请求。", "criteria": {
                "summarize": "生成会议纪要或摘要", "actions": "提取已经明确的待办事项",
                "decisions": "查找已经做出的会议决定", "none": "没有这些操作的明确请求或信息不足",
            }},
            "request_is_negated": {"type": "noul", "instructions": "说话者是否明确要求暂时不要执行正在讨论的操作？"},
            "urgency": {"type": "score", "instructions": "用户明确表达的处理紧迫程度。", "criteria": ["没有明确时间要求", "近期处理", "立即处理"]},
        }}
        started = time.monotonic()
        response = engine.predict(request)
        elapsed = time.monotonic() - started
        answers = response["answers"]
        for name in ("intent", "urgency"):
            probabilities = answers[name]["probabilities"]
            values = list(probabilities.values())
            assert all(math.isfinite(value) and 0 <= value <= 1 for value in values)
            assert abs(sum(values) - 1) < 1e-5
        assert answers["intent"]["choice"] in request["questions"]["intent"]["criteria"]
        assert 0 <= answers["request_is_negated"]["noul"] <= 1
        assert 0 <= answers["urgency"]["score"] <= 2
        item = {"state": state, "expected": expected, "seconds": round(elapsed, 3),
                "matches_expected": answers["intent"]["choice"] == expected, "response": response}
        results.append(item)
        print(json.dumps(item, ensure_ascii=False), flush=True)
    report = {"scope": "synthetic functional check; not a quality or calibration benchmark",
              "load_seconds": round(loaded, 3), "runtime": engine.runtime_info(),
              "expected_matches": sum(item["matches_expected"] for item in results), "cases": results}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"report": str(args.output), "runtime": report["runtime"],
                      "expected_matches": report["expected_matches"]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
