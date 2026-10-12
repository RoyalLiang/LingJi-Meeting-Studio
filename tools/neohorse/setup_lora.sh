#!/usr/bin/env bash
set -euo pipefail
root="${1:?Usage: setup_lora.sh /absolute/installation/root}"
py="$root/.venv/bin/python"
# Core dependencies were verified by setup_env.sh. Install only the optional PEFT wheel.
"$py" -m pip install --no-deps --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
  --cache-dir "$root/.cache/pip" 'peft==0.21.2'
"$py" -m pip check
"$py" - <<'PY'
from importlib.metadata import version
from peft import LoraConfig, PeftModel, get_peft_model, prepare_model_for_kbit_training
expected = {"torch": "2.8.0+cu126", "transformers": "5.17.0", "bitsandbytes": "0.50.2", "pydantic": "2.13.5"}
for name, value in expected.items():
    assert version(name) == value, f"Unexpected existing {name} version"
print("PEFT imports and preserved core versions passed", flush=True)
PY
"$py" -m pip freeze > "$root/evidence/requirements-lora.lock.txt"
echo LORA_SETUP_COMPLETE
