#!/usr/bin/env python3
import argparse
import json
import os
import pathlib

import build_dataset as ds
from intent_inputs import NativeBudget, native_metadata
from learning_data import build_cases, import_labels, datasets, jsonl, apply_corrections


def main():
    parser = argparse.ArgumentParser(description="Build private dual-task Alpha learning artifacts")
    parser.add_argument('--records', type=pathlib.Path, required=True)
    parser.add_argument('--asr-candidates', type=pathlib.Path)
    parser.add_argument('--policy', type=pathlib.Path, default=pathlib.Path(__file__).parent/'intent_policy.json')
    parser.add_argument('--tokenizer', type=pathlib.Path, default=pathlib.Path(__file__).parent/'model/tokenizer')
    parser.add_argument('--splits', type=pathlib.Path)
    parser.add_argument('--reviews', type=pathlib.Path)
    parser.add_argument('--teachers', type=pathlib.Path)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--accept-silver', action='store_true')
    parser.add_argument('--train-limit', type=int, default=256)
    parser.add_argument('--per-record', type=int, default=12)
    args = parser.parse_args()
    if not 1 <= args.train_limit <= 10000 or not 1 <= args.per_record <= 1000:
        raise ValueError('Invalid bounded round limits')
    os.umask(0o077)
    records, sources = ds.load_records([args.records])
    policy,budget=ds.read_json(args.policy),NativeBudget(args.tokenizer)
    asr_rows=jsonl(args.asr_candidates) if args.asr_candidates else []
    reviews=jsonl(args.reviews) if args.reviews else []
    teachers=jsonl(args.teachers) if args.teachers else []
    splits=ds.read_json(args.splits) if args.splits else None
    cases, manifest = build_cases(records,policy,budget,asr_rows,splits,args.per_record)
    asr_rows,reviews,superseded=apply_corrections(records,asr_rows,cases,reviews,budget)
    if superseded:
        cases,manifest=build_cases(records,policy,budget,asr_rows,splits,args.per_record)
    labels = import_labels(cases,reviews,[row for row in teachers if row['sample_id'] not in superseded])
    payload = {name+'.jsonl': rows for name, rows in datasets(cases, labels, args.accept_silver, args.train_limit).items()}
    payload['cases.jsonl'] = cases
    payload['review.jsonl'] = [{**case, 'target': None, 'reviewer': '', 'audioVerified': False, 'note': ''} for case in cases]
    payload['label-audit.jsonl'] = [{'sample_id': sid, **label} for sid, label in labels.items()]
    payload['asr-candidates.jsonl'] = asr_rows
    payload['effective-reviews.jsonl'] = reviews
    payload['asr-supervision.jsonl'] = [{'source':case['source'], 'text':case['display']['candidates'][int(labels[case['sample_id']]['target'][1:])],
        'quality':labels[case['sample_id']]['quality'], 'reviewer':labels[case['sample_id']]['provenance'].get('reviewer')}
        for case in cases if case['family']=='asr' and case['sample_id'] in labels and labels[case['sample_id']]['target'].startswith('c')]
    manifest.update(native_metadata(args.tokenizer))
    manifest.update(source_files=sources, record_splits=manifest['split_map'], counts={key:len(value) for key,value in payload.items()},
                    accept_silver=args.accept_silver, training_limit=args.train_limit,
                    human_corrections=len(superseded),
                    weak_test_is_not_quality_benchmark=True)
    ds.write_output(args.output, payload, manifest)
    print(json.dumps({'output':str(args.output),'counts':manifest['counts'],'per_family':manifest['per_family']}))


if __name__ == '__main__':
    main()
