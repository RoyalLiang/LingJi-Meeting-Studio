#!/usr/bin/env python3
"""Bounded QLoRA verification on native decision logits, not generated text."""
import argparse
import hashlib
import json
import math
import pathlib
import time
from collections import Counter

import bitsandbytes as bnb
import torch
from neohorse_decision._vendor.model import rows_of
from neohorse_decision._vendor.schema import SystemOneRequest, to_record
from peft import LoraConfig, get_peft_model, get_peft_model_state_dict, prepare_model_for_kbit_training, set_peft_model_state_dict
from safetensors.torch import load_file

from quantized_runtime import QuantizedDecisionEngine
from train_head import SYNTHETIC
from learning_data import training_order


def examples(dataset, max_examples=64):
    if dataset:
        content = dataset.read_bytes()
        samples = [json.loads(line) for line in content.decode().splitlines() if line.strip()]
        digest = hashlib.sha256(content).hexdigest()
    else:
        samples = [{"request": {"state": state, "questions": {"intent": {
            "type": "choice", "instructions": "用户现在是否明确要求生成会议纪要？",
            "criteria": {"summarize": "明确要求现在生成纪要", "none": "否定、转述、假设或没有请求"},
        }}}, "target": ("summarize", "none")[target]} for state, target in SYNTHETIC]
        digest = hashlib.sha256(json.dumps(samples, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    if not 1 <= len(samples) <= max_examples:
        raise ValueError(f"This bounded run permits 1–{max_examples} examples")
    return samples, digest


def encode_samples(engine, samples):
    result = []
    for sample in samples:
        rec, metadata = to_record(SystemOneRequest(**sample["request"]))
        if len(metadata) != 1 or metadata[0]["type"] != "choice":
            raise ValueError("Each row must contain exactly one Choice question")
        target = metadata[0]["keys"].index(sample["target"])
        # Upstream max_branch includes the repeated state, so it is a full-row budget.
        enc = engine.model.encode(engine.tokenizer, rec, strict=True, max_state=128, max_branch=256)
        state, positions, branches = rows_of(enc)
        branch = branches[0]
        ids = torch.tensor([state + branch["ids"]], device=engine.device)
        pos = torch.tensor([positions + branch["pos"]], device=engine.device)
        result.append({"ids": ids, "positions": pos, "decide": len(state) + branch["decide"],
                       "options": [len(state) + index for index in branch["opts"]], "target": target})
    return result


def logits_for(engine, sample):
    with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
        hidden = engine.model.lm(input_ids=sample["ids"], position_ids=sample["positions"],
                                 attention_mask=torch.ones_like(sample["ids"]), use_cache=False).last_hidden_state[0]
        return engine.model.head(hidden[sample["decide"]], hidden[sample["options"]]).float()


def evaluate(engine, rows):
    engine.model.eval()
    with torch.no_grad():
        logits = [logits_for(engine, row) for row in rows]
        loss = torch.stack([torch.nn.functional.cross_entropy(value.unsqueeze(0),
            torch.tensor([row["target"]], device=engine.device)) for value, row in zip(logits, rows)]).mean().item()
    return loss, [value.cpu().tolist() for value in logits]


def verify(args, samples, digest):
    expected = json.loads((args.output_dir / "lora-training-report.json").read_text())
    if expected["dataset_sha256"] != digest:
        raise ValueError("Reload verification requires the same dataset")
    adapter = args.output_dir / "adapter"
    engine = QuantizedDecisionEngine(args.model_dir, lora_adapter=adapter)
    actual_weights = get_peft_model_state_dict(engine.model.multimodal)
    saved_weights = load_file(str(adapter / "adapter_model.safetensors"))
    assert set(actual_weights) == set(saved_weights), "Adapter tensor keys differ"
    assert all(torch.equal(actual_weights[key].cpu(), value) for key, value in saved_weights.items()), "Adapter weights differ"
    rows = encode_samples(engine, samples)
    loss, actual = evaluate(engine, rows)
    assert len(actual) == len(expected["expected_logits"])
    assert all(len(x) == len(y) for x, y in zip(actual, expected["expected_logits"]))
    logits_delta = max(abs(a - b) for x, y in zip(actual, expected["expected_logits"]) for a, b in zip(x, y))
    probability_delta = max((torch.tensor(x).softmax(-1) - torch.tensor(y).softmax(-1)).abs().max().item()
                            for x, y in zip(actual, expected["expected_logits"]))
    assert logits_delta <= 0.05 and probability_delta <= 0.002, "Reload output exceeds numerical tolerance"
    native = engine.predict(samples[0]["request"])
    report = {"fresh_process_reload": True, "adapter_weights_equal": True,
              "maximum_logit_difference": logits_delta, "maximum_probability_difference": probability_delta,
              "probability_tolerance": 0.002, "loss": loss, "native_inference": native,
              "runtime": engine.runtime_info(), "quality_benchmark": False}
    (args.output_dir / "lora-reload-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False), flush=True)


def train(args, samples, digest):
    torch.manual_seed(args.seed)
    engine = QuantizedDecisionEngine(args.model_dir)
    model = engine.model
    model.requires_grad_(False)
    original_head = {key: value.detach().cpu().clone() for key, value in model.head.state_dict().items()}
    backbone = model.multimodal
    targets = [name for name, module in backbone.named_modules()
               if name.startswith("language_model.") and name.rsplit(".", 1)[-1] in ("q_proj", "v_proj")
               and isinstance(module, bnb.nn.Linear4bit)]
    if not targets:
        raise RuntimeError("No quantized text q_proj/v_proj targets found")
    backbone = prepare_model_for_kbit_training(backbone, use_gradient_checkpointing=True,
                                              gradient_checkpointing_kwargs={"use_reentrant": False})
    backbone = get_peft_model(backbone, LoraConfig(r=args.rank, lora_alpha=2 * args.rank,
                             target_modules=targets, lora_dropout=0, bias="none"))
    if args.resume_adapter:
        config = json.loads((args.resume_adapter / 'adapter_config.json').read_text())
        if config['r'] != args.rank or set(config['target_modules']) != set(targets):
            raise ValueError('Resume adapter rank/targets differ from this run')
        saved = load_file(str(args.resume_adapter / 'adapter_model.safetensors'))
        set_peft_model_state_dict(backbone, saved)
        loaded = get_peft_model_state_dict(backbone)
        assert set(loaded) == set(saved) and all(torch.equal(loaded[key].detach().cpu(), value) for key, value in saved.items()), 'Resume weights differ'
    model.multimodal, model.lm = backbone, backbone.language_model
    engine.lora_adapter = str((args.output_dir / "adapter").resolve())
    model.lm.config.use_cache = False
    assert model.lm.is_gradient_checkpointing, "Gradient checkpointing was not enabled"
    trainable = {name: parameter for name, parameter in backbone.named_parameters() if parameter.requires_grad}
    assert trainable and all(".lora_A." in name or ".lora_B." in name for name in trainable)
    assert not any(parameter.requires_grad for parameter in model.head.parameters())
    original = {name: parameter.detach().cpu().clone() for name, parameter in trainable.items()}
    rows = encode_samples(engine, samples)
    before, _ = evaluate(engine, rows)
    optimizer = torch.optim.AdamW(trainable.values(), lr=args.learning_rate, weight_decay=0)
    steps = []
    order = training_order(samples, args.steps, args.seed, args.balance_families)
    started = time.monotonic()
    for step in range(args.steps):
        model.train()
        optimizer.zero_grad(set_to_none=True)
        sample = rows[order[step]]
        logits = logits_for(engine, sample)
        loss = torch.nn.functional.cross_entropy(logits.unsqueeze(0), torch.tensor([sample["target"]], device=engine.device))
        if not torch.isfinite(loss):
            raise RuntimeError("Non-finite training loss")
        loss.backward()
        norm = torch.nn.utils.clip_grad_norm_(list(trainable.values()), 1.0).item()
        if not math.isfinite(norm) or norm <= 0:
            raise RuntimeError("No finite, nonzero LoRA gradient")
        optimizer.step()
        item = {"step": step + 1, "loss": loss.item(), "gradient_norm_before_clip": norm}
        steps.append(item)
        print("LORA_TRAIN " + json.dumps(item), flush=True)
    torch.cuda.synchronize()
    elapsed = time.monotonic() - started
    after, expected = evaluate(engine, rows)
    changed = [name for name, parameter in trainable.items() if not torch.equal(original[name], parameter.detach().cpu())]
    assert changed, "No LoRA tensor changed"
    assert all(torch.equal(original_head[key], value.detach().cpu()) for key, value in model.head.state_dict().items()), "Pointer head changed"
    adapter = args.output_dir / "adapter"
    backbone.save_pretrained(adapter, safe_serialization=True, save_embedding_layers=False)
    checkpoint = adapter / "adapter_model.safetensors"
    assert checkpoint.stat().st_size < 32 * 1024 ** 2, "Unexpectedly large adapter artifact"
    report = {"training_scope": "NF4 frozen backbone + text attention q_proj/v_proj LoRA; pointer head frozen",
              "rank": args.rank, "target_modules": targets, "target_module_count": len(targets),
              "trainable_parameters": sum(parameter.numel() for parameter in trainable.values()),
              "base_parameters_frozen": True, "pointer_head_unchanged": True,
              "gradient_checkpointing": True, "batch_size": 1, "samples": len(rows), "steps": args.steps,
              "maximum_sequence_tokens": max(row["ids"].shape[1] for row in rows),
              "dataset_sha256": digest, "data_source": str(args.dataset) if args.dataset else "built-in synthetic samples",
              "learning_rate": args.learning_rate, "loss_before": before, "loss_after": after,
              "families": dict(Counter(sample.get('family', 'legacy') for sample in samples)),
              "updates_by_family": dict(Counter(samples[index].get('family', 'legacy') for index in order)),
              "balanced_families": args.balance_families, "seed": args.seed,
              "resume_adapter": str(args.resume_adapter) if args.resume_adapter else None,
              "resume_weights_verified": bool(args.resume_adapter),
              "steps_seconds": round(elapsed, 3), "step_results": steps, "changed_tensors": changed,
              "expected_logits": expected, "adapter_bytes": checkpoint.stat().st_size,
              "adapter_sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
              "runtime": {**engine.runtime_info(), "peak_reserved_mib": round(torch.cuda.max_memory_reserved() / 1024 ** 2, 1)},
              "quality_benchmark": False, "production_ready": False}
    (args.output_dir / "lora-training-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in ["trainable_parameters", "target_module_count", "loss_before", "loss_after", "runtime"]}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", default=str(pathlib.Path(__file__).parent / "model"))
    parser.add_argument("--output-dir", type=pathlib.Path, required=True)
    parser.add_argument("--dataset", type=pathlib.Path, help="Optional JSONL request/target rows; same format as train_head.py")
    parser.add_argument("--steps", type=int, default=6)
    parser.add_argument("--rank", type=int, default=4)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--verify-only", action="store_true", help="Reload a saved adapter in a separate process")
    parser.add_argument("--max-examples", type=int, default=64, help="Explicit learning-round cap; legacy default remains 64")
    parser.add_argument("--balance-families", action="store_true", help="Alternate task families with a deterministic shuffled schedule")
    parser.add_argument("--resume-adapter", type=pathlib.Path)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    if not 1 <= args.steps <= 2000 or not 1 <= args.rank <= 8 or not 0 < args.learning_rate <= 1e-3 or not 1 <= args.max_examples <= 2048:
        raise ValueError("Bounded run: steps 1–2000, examples 1–2048, rank 1–8, learning rate (0, 0.001]")
    if not args.verify_only and args.output_dir.exists() and any(args.output_dir.iterdir()):
        raise ValueError('Training output is not empty; select a new round checkpoint directory')
    args.output_dir.mkdir(parents=True, exist_ok=True)
    samples, digest = examples(args.dataset, args.max_examples)
    if args.verify_only:
        verify(args, samples, digest)
    else:
        train(args, samples, digest)


if __name__ == "__main__":
    main()
