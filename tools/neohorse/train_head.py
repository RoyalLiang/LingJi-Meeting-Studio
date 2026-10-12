#!/usr/bin/env python3
"""Train only the pointer head on synthetic, cached frozen-backbone features."""

import argparse
import json
import pathlib

import torch
from neohorse_decision._vendor.model import rows_of
from neohorse_decision._vendor.schema import SystemOneRequest, to_record
from safetensors.torch import load_file, save_file

from quantized_runtime import QuantizedDecisionEngine

SYNTHETIC = [
    ("请生成这次会议的纪要。", 0), ("Summarize the meeting, please.", 0),
    ("请把会议要点整理成摘要。", 0), ("先别生成纪要，等我补充完资料。", 1),
    ("Do not summarize yet.", 1), ("他说以后可以整理，但现在先不要操作。", 1),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", default=str(pathlib.Path(__file__).parent / "model"))
    parser.add_argument("--output-dir", type=pathlib.Path, required=True)
    parser.add_argument("--dataset", type=pathlib.Path, help="Optional JSONL: each row has request and target (one Choice question)")
    parser.add_argument("--steps", type=int, default=20)
    args = parser.parse_args()
    if not 1 <= args.steps <= 100:
        raise ValueError("This bounded smoke exercise permits 1–100 optimizer steps")
    torch.manual_seed(42)
    engine = QuantizedDecisionEngine(args.model_dir)
    model = engine.model
    model.requires_grad_(False)
    model.head.requires_grad_(True)
    model.lm.config.use_cache = False
    samples = []
    if args.dataset:
        with args.dataset.open() as stream:
            for line in stream:
                if line.strip():
                    samples.append(json.loads(line))
                if len(samples) > 1000:
                    raise ValueError("This bounded example supports at most 1000 rows")
    else:
        for state, target in SYNTHETIC:
            samples.append({"request": {"state": state, "questions": {"intent": {
                "type": "choice", "instructions": "用户现在是否明确要求生成会议纪要？",
                "criteria": {"summarize": "明确要求现在生成纪要", "none": "否定、转述、假设或没有请求"},
            }}}, "target": ["summarize", "none"][target]})
    if not samples:
        raise ValueError("Dataset is empty")
    features = []
    with torch.no_grad():
        for sample in samples:
            request = sample["request"]
            record, metadata = to_record(SystemOneRequest(**request))
            if len(metadata) != 1 or metadata[0]["type"] != "choice":
                raise ValueError("Each training request must contain exactly one Choice question")
            target = metadata[0]["keys"].index(sample["target"])
            encoded = model.encode(engine.tokenizer, record, strict=True, max_state=256, max_branch=256)
            state_ids, state_positions, branches = rows_of(encoded)
            branch = branches[0]
            ids = torch.tensor([state_ids + branch["ids"]], device=model.device)
            positions = torch.tensor([state_positions + branch["pos"]], device=model.device)
            hidden = model.lm(input_ids=ids, position_ids=positions, attention_mask=torch.ones_like(ids),
                              use_cache=False).last_hidden_state[0].float()
            decide = hidden[len(state_ids) + branch["decide"]].detach().clone()
            options = hidden[[len(state_ids) + index for index in branch["opts"]]].detach().clone()
            features.append((decide, options, target))
    original = {name: value.detach().clone() for name, value in model.head.state_dict().items()}
    optimizer = torch.optim.AdamW(model.head.parameters(), lr=1e-4)

    def loss_value():
        losses = [torch.nn.functional.cross_entropy(model.head(decide, options).unsqueeze(0),
                  torch.tensor([target], device=model.device)) for decide, options, target in features]
        return torch.stack(losses).mean()

    before = loss_value().item()
    losses = []
    for step in range(args.steps):
        optimizer.zero_grad(set_to_none=True)
        loss = loss_value()
        if not torch.isfinite(loss):
            raise RuntimeError("Non-finite training loss")
        loss.backward()
        optimizer.step()
        losses.append(loss.item())
        print(f"HEAD_TRAIN step={step + 1} loss={loss.item():.6f}", flush=True)
    after = loss_value().item()
    changed = any(not torch.equal(original[name], value) for name, value in model.head.state_dict().items())
    assert changed and after < before, "Synthetic optimizer check did not improve training loss"
    args.output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint = args.output_dir / "synthetic-pointer-head.safetensors"
    save_file({name: value.detach().cpu().contiguous() for name, value in model.head.state_dict().items()}, str(checkpoint))
    expected = [model.head(decide, options).detach().clone() for decide, options, _ in features]
    model.head.load_state_dict(load_file(str(checkpoint)))
    reload_equal = all(torch.equal(logits, model.head(decide, options).detach())
                       for logits, (decide, options, _) in zip(expected, features))
    assert reload_equal
    report = {"training_scope": "pointer head only; frozen quantized backbone; cached features",
              "data_source": str(args.dataset) if args.dataset else "built-in synthetic samples",
              "production_ready": False, "steps": args.steps, "samples": len(features),
              "trainable_parameters": sum(parameter.numel() for parameter in model.head.parameters()),
              "loss_before": before, "loss_after": after, "losses": losses,
              "weights_changed": changed, "checkpoint_reload_equal": reload_equal,
              "checkpoint": str(checkpoint), "runtime": engine.runtime_info()}
    (args.output_dir / "training-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
