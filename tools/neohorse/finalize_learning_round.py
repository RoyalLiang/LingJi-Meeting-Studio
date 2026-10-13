#!/usr/bin/env python3
import argparse
import hashlib
import json
import pathlib
from learning_data import jsonl


def main():
    parser=argparse.ArgumentParser(description='Publish a round report and annotatable results, never business data')
    parser.add_argument('--root',type=pathlib.Path,required=True)
    parser.add_argument('--round-id',required=True)
    args=parser.parse_args();root=args.root
    if (root/'round-report.json').exists():raise ValueError('Round already finalized')
    manifest=json.loads((root/'dataset/manifest.json').read_text())
    cases=jsonl(root/'dataset/cases.jsonl')
    base={r['sample_id']:r for r in jsonl(root/'base-predictions.jsonl')}
    adapted={r['sample_id']:r for r in jsonl(root/'adapter-predictions.jsonl')} if (root/'adapter-predictions.jsonl').exists() else {}
    teacher={r['sample_id']:r for r in jsonl(root/'teacher.jsonl')} if (root/'teacher.jsonl').exists() else {}
    reviewed={r['sample_id']:r for r in jsonl(root/'dataset/effective-reviews.jsonl')} if (root/'dataset/effective-reviews.jsonl').exists() else {}
    output=[]
    for case in cases:
        previous=reviewed.get(case['sample_id'],{})
        output.append({**case,'basePrediction':base.get(case['sample_id']),'adapterPrediction':adapted.get(case['sample_id']),
                       'teacherTarget':teacher.get(case['sample_id'],{}).get('target'),
                       'target':previous.get('target'),'reviewer':previous.get('reviewer',''),'audioVerified':previous.get('audioVerified',False),
                       'blindReview':previous.get('blindReview',False),'reviewedAt':previous.get('reviewedAt',''),
                       'note':previous.get('note',''),'correctedText':previous.get('correctedText','')})
    path=root/'annotation-results.jsonl'
    path.write_text(''.join(json.dumps(row,ensure_ascii=False)+'\n' for row in output));path.chmod(0o600)
    training=json.loads((root/'checkpoint/lora-training-report.json').read_text()) if (root/'checkpoint/lora-training-report.json').exists() else None
    report={'roundId':args.round_id,'status':'complete','shadowOnly':True,'businessWrites':0,'cases':len(cases),
            'families':manifest['per_family'],'datasetCounts':manifest['counts'],'trained':bool(training),
            'updatesByFamily':training.get('updates_by_family') if training else {},
            'lossBefore':training.get('loss_before') if training else None,'lossAfter':training.get('loss_after') if training else None,
            'baseScores':json.loads((root/'base-scores.json').read_text()),
            'adapterScores':json.loads((root/'adapter-scores.json').read_text()) if (root/'adapter-scores.json').exists() else None,
            'goldTestReady':False,'annotationResultsSha256':hashlib.sha256(path.read_bytes()).hexdigest(),
            'qualityStatement':'Teacher labels are weak supervision. No quality improvement established without held-out human/audio-verified labels.'}
    report['runtimeManifest']=json.loads((root/'runtime-manifest.json').read_text()) if (root/'runtime-manifest.json').exists() else None
    report['goldTestReady']=report['baseScores']['gold_test_ready']
    (root/'round-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'round':args.round_id,'cases':len(cases),'trained':bool(training),'updates_by_family':report['updatesByFamily'],'gold_test_ready':report['goldTestReady']}))


if __name__=='__main__':main()
