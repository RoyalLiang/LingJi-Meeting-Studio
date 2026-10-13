#!/usr/bin/env python3
"""Private batch shadow inference. Never commits business transcript or actions."""
import argparse
import hashlib
import json
import os
import pathlib
import time

from intent_inputs import digest
from learning_data import jsonl


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cases', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--model-dir', default=str(pathlib.Path(__file__).parent/'model'))
    parser.add_argument('--adapter', type=pathlib.Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.output.exists():
        raise ValueError('Prediction output already exists; use a new round artifact')
    cases = jsonl(args.cases)
    if not 1 <= len(cases) <= 10000:
        raise ValueError('Prediction round must contain 1–10000 cases')
    from quantized_runtime import QuantizedDecisionEngine
    engine = QuantizedDecisionEngine(args.model_dir, lora_adapter=args.adapter)
    cache, rows, failures = {}, [], 0
    started = time.monotonic()
    for case in cases:
        row = {key:case[key] for key in ('sample_id','input_hash','family','task')}
        if case.get('rejected'):
            row.update(error=case['rejected'], choice=None, probabilities={})
        else:
            try:
                key = digest(case['request'])
                if key not in cache:
                    cache[key] = engine.predict(case['request'])
                result = cache[key]
                answer = result['answers'][case['task']]
                if answer['choice'] not in case['request']['questions'][case['task']]['criteria']:
                    raise ValueError('Invalid native choice')
                row.update(choice=answer['choice'], probabilities=answer['probabilities'], input_tokens=result.get('input_tokens'))
            except Exception as error:
                failures += 1
                row.update(error=type(error).__name__, choice=None, probabilities={})
        rows.append(row)
        if len(rows)%100==0:
            print(json.dumps({'shadow_predictions':len(rows),'model_calls':len(cache),'failures':failures}),flush=True)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(''.join(json.dumps(row,ensure_ascii=False)+'\n' for row in rows))
    report = {'cases':len(cases),'predictions':len(rows),'model_calls':len(cache),'failures':failures,
              'seconds':round(time.monotonic()-started,3),'runtime':engine.runtime_info(),
              'cases_sha256':hashlib.sha256(args.cases.read_bytes()).hexdigest(),
              'adapter_sha256':hashlib.sha256((args.adapter/'adapter_model.safetensors').read_bytes()).hexdigest() if args.adapter else None,
              'shadow_only':True,'business_writes':0,'quality_benchmark':False}
    args.output.with_suffix('.report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({key:report[key] for key in ('cases','predictions','model_calls','failures','seconds')}),flush=True)
    if failures:
        raise RuntimeError('Shadow predictions contain failures; artifacts retained for annotation')


if __name__=='__main__':main()
