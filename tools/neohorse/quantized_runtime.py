"""Local 4-bit loading adapter for the unmodified NeoHorse native runtime."""

import json
import pathlib
import threading

import bitsandbytes as bnb
import torch
from neohorse_decision import DecisionEngine
from neohorse_decision._vendor.model import DecisionModel, PointerHead
from safetensors.torch import load_file
from transformers import AutoModel, AutoTokenizer, BitsAndBytesConfig


class QuantizedDecisionEngine(DecisionEngine):
    """Retain upstream request validation and inference; replace only loading."""

    def __init__(self, model_dir, head_checkpoint=None):
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable; this adapter does not silently fall back to CPU")
        torch.set_num_threads(4)
        self.model_dir = pathlib.Path(model_dir).resolve()
        self.device = "cuda:0"
        free, _ = torch.cuda.mem_get_info(0)
        if free < 4 * 1024 ** 3:
            raise RuntimeError("Less than 4 GiB GPU memory available; stop and inspect other workloads")
        manifest = json.loads((self.model_dir / "model_manifest.json").read_text())
        self.tokenizer = AutoTokenizer.from_pretrained(self.model_dir / "tokenizer", local_files_only=True)
        backbone, info = AutoModel.from_pretrained(
            self.model_dir / "backbone", local_files_only=True,
            dtype=torch.bfloat16, attn_implementation="sdpa", device_map={"": 0},
            quantization_config=BitsAndBytesConfig(
                load_in_4bit=True, bnb_4bit_quant_type="nf4",
                bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.bfloat16,
            ), output_loading_info=True,
        )
        for key in ("missing_keys", "unexpected_keys", "mismatched_keys", "error_msgs"):
            if info.get(key):
                raise RuntimeError(f"Checkpoint loading error ({key}): {info[key]}")
        if type(backbone).__name__ != "Qwen3_5Model":
            raise RuntimeError(f"Unexpected backbone: {type(backbone).__name__}")
        model = DecisionModel.__new__(DecisionModel)
        torch.nn.Module.__init__(model)
        model.multimodal = backbone
        model.lm = backbone.language_model
        model.head = PointerHead(model.lm.config.hidden_size, dp=manifest["head_dim"])
        head_path = pathlib.Path(head_checkpoint) if head_checkpoint else self.model_dir / "pointer_head.safetensors"
        model.head.load_state_dict(load_file(str(head_path)))
        model.head.to(device=self.device, dtype=torch.float32)
        model.pad_id = self.tokenizer.pad_token_id or 0
        model.hybrid = "linear_attention" in set(getattr(model.lm.config, "layer_types", []) or [])
        model.option_isolation = manifest["option_isolation"]
        model.device = self.device
        if model.hybrid != manifest["hybrid"] or (model.hybrid and model.option_isolation):
            raise RuntimeError("Runtime/model isolation flags differ")
        model.eval()
        self.model = model
        self.max_state, self.max_branch = 1024, 2048
        self.max_questions, self.max_tokens = 8, 8192
        self._lock = threading.Lock()
        self.quantized_linear_count = sum(isinstance(layer, bnb.nn.Linear4bit) for layer in backbone.modules())
        if not self.quantized_linear_count:
            raise RuntimeError("No 4-bit layers were loaded")

    def runtime_info(self):
        return {
            "model": "TokenRhythm/NeoHorse-Jev-4B",
            "official_typesafe_jev": False,
            "quantization": "bitsandbytes NF4, double quantization, BF16 compute",
            "quantized_linear_count": self.quantized_linear_count,
            "gpu": torch.cuda.get_device_name(0),
            "allocated_mib": round(torch.cuda.memory_allocated() / 1024 ** 2, 1),
            "peak_allocated_mib": round(torch.cuda.max_memory_allocated() / 1024 ** 2, 1),
            "torch": torch.__version__, "cuda_runtime": torch.version.cuda,
        }
