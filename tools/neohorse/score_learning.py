#!/usr/bin/env python3
"""Keep human evaluation separate from weak-teacher agreement."""
import argparse
import collections
import json
import pathlib
import re
from learning_data import jsonl


def distance(a,b):
    previous=list(range(len(b)+1))
    for i,x in enumerate(a,1):
        current=[i]
        for j,y in enumerate(b,1):
            current.append(min(current[-1]+1,previous[j]+1,previous[j-1]+(x!=y)))
        previous=current
    return previous[-1]


def score(cases, predictions, labels):
    cases={case['sample_id']:case for case in cases}
    predictions={row['sample_id']:row for row in predictions}
    grouped=collections.defaultdict(list)
    for row in labels:
        case=cases[row['sample_id']]; prediction=predictions.get(row['sample_id'])
        if not prediction or prediction['input_hash']!=case['input_hash']:
            raise ValueError('Missing or stale prediction')
        grouped[row.get('family','intent')].append((row,case,prediction))
    result={}
    for family,rows in grouped.items():
        correct=sum(label['target']==prediction.get('choice') for label,_,prediction in rows)
        item={'samples':len(rows),'accuracy_against_supplied_labels':correct/len(rows),'confusion':dict(collections.Counter(label['target']+'->'+str(prediction.get('choice')) for label,_,prediction in rows))}
        if family=='asr':
            edits,characters,verified=0,0,0
            for label,case,prediction in rows:
                if label.get('label_quality')!='gold':continue
                target=label['target']; selected=prediction.get('choice')
                if not target.startswith('c'):continue
                clean=lambda text:re.sub(r'[\W_]+','',text).casefold()
                reference=clean(case['display']['candidates'][int(target[1:])])
                actual=clean(case['display']['candidates'][int(selected[1:])]) if selected and selected.startswith('c') else ''
                if reference:
                    characters+=len(reference);edits+=distance(reference,actual);verified+=1
            item.update(audio_verified_references=verified,cer=edits/characters if characters else None)
        else:
            per_task={}
            for task in {case['task'] for _,case,_ in rows}:
                triples=[(label,case,prediction) for label,case,prediction in rows if case['task']==task]
                tp=sum(l['target']=='present' and p.get('choice')=='present' for l,_,p in triples)
                fp=sum(l['target']=='absent' and p.get('choice')=='present' for l,_,p in triples)
                fn=sum(l['target']=='present' and p.get('choice')!='present' for l,_,p in triples)
                per_task[task]={'samples':len(triples),'precision':tp/(tp+fp) if tp+fp else None,'recall':tp/(tp+fn) if tp+fn else None,'f1':2*tp/(2*tp+fp+fn) if 2*tp+fp+fn else None}
            item['per_task']=per_task
        result[family]=item
    return {'samples':len(labels),'families':result}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cases',type=pathlib.Path,required=True)
    parser.add_argument('--predictions',type=pathlib.Path,required=True)
    parser.add_argument('--datasets',type=pathlib.Path,required=True)
    parser.add_argument('--output',type=pathlib.Path,required=True)
    args=parser.parse_args()
    if args.output.exists():raise ValueError('Score output already exists')
    cases,predictions=jsonl(args.cases),jsonl(args.predictions)
    report={name:score(cases,predictions,jsonl(args.datasets/(name+'.jsonl'))) for name in ('train','dev','test','weak-test')}
    report.update(gold_test_ready=all(report['test']['families'].get(family,{}).get('samples',0)>0 for family in ('intent','asr')),weak_test_is_teacher_agreement_only=True,
                  no_improvement_claim_without_gold=True)
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'gold_test_samples':report['test']['samples'],'weak_test_samples':report['weak-test']['samples']}))


if __name__=='__main__':main()
