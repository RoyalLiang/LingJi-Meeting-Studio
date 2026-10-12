#!/usr/bin/env bash
set -euo pipefail

root="${1:?Usage: setup_env.sh /absolute/installation/root}"
mkdir -p "$root/evidence"
if [[ ! -x "$root/.venv/bin/python" ]]; then
  python3 -m venv "$root/.venv"
fi
py="$root/.venv/bin/python"
"$py" -m pip install 'torch==2.8.0' \
  --index-url https://download.pytorch.org/whl/cu126 --cache-dir "$root/.cache/pip"
"$py" - <<'PY'
import json
import torch
assert torch.cuda.is_available(), "CUDA initialization failed"
value = (torch.ones(3, device="cuda") * 2).cpu().tolist()
assert value == [2, 2, 2]
print(json.dumps({"cuda_probe": "passed", "torch": torch.__version__,
                  "cuda": torch.version.cuda, "gpu": torch.cuda.get_device_name(0)}), flush=True)
PY
printf 'torch==2.8.0+cu126\n' > "$root/constraints.txt"
"$py" -m pip install --constraint "$root/constraints.txt" \
  --index-url https://mirrors.aliyun.com/pypi/simple --cache-dir "$root/.cache/pip" \
  'transformers==5.17.0' 'accelerate==1.15.0' 'bitsandbytes==0.50.2' \
  'pydantic==2.13.5' 'safetensors==0.8.0' 'pillow==12.3.0'
"$py" -m pip install --no-deps "$root/model/dist/neohorse_decision-1.0.0-py3-none-any.whl"
"$py" -m pip check
"$py" -m pip freeze > "$root/evidence/requirements.lock.txt"
echo SETUP_COMPLETE
