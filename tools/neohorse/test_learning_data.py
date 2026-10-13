import copy
import json
import pathlib
import unittest
import tempfile
import subprocess
import sys
from learning_data import asr_case, build_cases, import_labels, datasets, training_order, apply_corrections
from score_learning import score
from test_build_dataset import record, budget

POLICY = json.loads((pathlib.Path(__file__).parent / 'intent_policy.json').read_text())


class LearningTests(unittest.TestCase):
    def test_round_publication_preserves_blind_review_and_runtime_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);dataset=root/'dataset';dataset.mkdir()
            def write(path,value):
                path.write_text(json.dumps(value)+'\n')
            write(dataset/'manifest.json',{'per_family':{'intent':1},'counts':{'train.jsonl':0}})
            write(dataset/'cases.jsonl',{'sample_id':'fixture','input_hash':'hash','family':'intent'})
            write(dataset/'effective-reviews.jsonl',{'sample_id':'fixture','input_hash':'hash','target':'present','reviewer':'fixture','blindReview':True})
            write(root/'base-predictions.jsonl',{'sample_id':'fixture','input_hash':'hash','choice':'present'})
            write(root/'base-scores.json',{'gold_test_ready':False})
            runtime={'files':{'learning_data.py':'fixture-hash'}};write(root/'runtime-manifest.json',runtime)
            script=pathlib.Path(__file__).parent/'finalize_learning_round.py'
            subprocess.run([sys.executable,str(script),'--root',str(root),'--round-id','r001'],check=True,capture_output=True,timeout=10)
            annotated=json.loads((root/'annotation-results.jsonl').read_text())
            self.assertTrue(annotated['blindReview']);self.assertEqual(annotated['target'],'present')
            report=json.loads((root/'round-report.json').read_text())
            self.assertEqual(report['runtimeManifest'],runtime);self.assertEqual(report['businessWrites'],0)
            self.assertFalse(report['trained'])

    def examples(self):
        r = record(text='我来跟进接口文档。')
        row = {'recordId':r['id'],'segmentId':'s1','revision':1,
               'candidates':[{'text':r['segments'][0]['text'],'source':'stored_asr'}, {'text':'我来跟进接口稳定。','source':'real_asr'}],
               'audio':{'sha256':'a'*64}}
        cases, _ = build_cases([r], POLICY, budget, [row], {'r1':'train'})
        return r, row, cases

    def teacher(self, case, target):
        return {'sample_id':case['sample_id'],'input_hash':case['input_hash'],'target':target,
                'model':'independent-teacher','promptVersion':'v1','runId':'test'}

    def test_dual_families_share_record_split_and_no_implicit_labels(self):
        _,_,cases=self.examples()
        self.assertEqual({c['family'] for c in cases},{'intent','asr'})
        self.assertTrue(all(c['split']=='train' for c in cases))
        self.assertFalse(datasets(cases,{})['train'])

    def test_teacher_only_enters_train_when_explicit_and_never_gold_test(self):
        _,_,cases=self.examples(); labels=import_labels(cases,teachers=[self.teacher(cases[0],'absent')])
        self.assertFalse(datasets(cases,labels)['train'])
        self.assertEqual(len(datasets(cases,labels,True)['train']),1)
        cases[0]['split']='test'
        result=datasets(cases,labels,True)
        self.assertFalse(result['test']); self.assertEqual(len(result['weak-test']),1)

    def test_human_skip_removes_teacher_label_and_bad_target_is_rejected(self):
        _,_,cases=self.examples(); teacher=self.teacher(cases[0],'present')
        skip={**teacher,'target':'skip','reviewer':'human'}
        self.assertFalse(import_labels(cases,[skip],[teacher]))
        with self.assertRaisesRegex(ValueError,'candidate key'):
            import_labels(cases,teachers=[{**teacher,'target':'invented'}])

    def test_asr_gold_requires_audio_verification_and_stale_review_fails(self):
        _,_,cases=self.examples(); c=cases[-1]
        review={**self.teacher(c,'c1'),'reviewer':'human'}
        self.assertEqual(import_labels(cases,[review])[c['sample_id']]['quality'],'silver')
        review['audioVerified']=True
        self.assertEqual(import_labels(cases,[review])[c['sample_id']]['quality'],'gold')
        review['input_hash']='stale'
        with self.assertRaisesRegex(ValueError,'stale'):
            import_labels(cases,[review])

    def test_asr_has_no_current_asr_text_outside_options_or_future_context(self):
        r,row,_=self.examples()
        c=asr_case(r,row,budget)
        self.assertNotIn(r['segments'][0]['text'],c['request']['state'])
        full=copy.deepcopy(r)
        full['segments'].append({'id':'future','revision':1,'text':'未来秘密','speaker':'王伟','startMs':3000,'endMs':4000})
        self.assertEqual(c['request'],asr_case(full,row,budget)['request'])
        row['revision']=2
        with self.assertRaisesRegex(ValueError,'stale'):
            asr_case(r,row,budget)

    def test_balanced_training_updates_both_families_and_is_deterministic(self):
        samples=[{'family':'intent'}]*20+[{'family':'asr'}]*2
        order=training_order(samples,12,7,True)
        self.assertEqual(order,training_order(samples,12,7,True))
        self.assertEqual([samples[i]['family'] for i in order].count('asr'),6)

    def test_conflicting_identical_requests_do_not_cross_splits(self):
        _,_,cases=self.examples(); a=cases[0]; b=copy.deepcopy(a)
        b.update(sample_id='other',input_hash='other',split='test')
        labels=import_labels([a,b],teachers=[self.teacher(a,'present'),self.teacher(b,'present')])
        output=datasets([a,b],labels,True)
        self.assertFalse(output['train']); self.assertFalse(output['weak-test'])

    def test_verified_correction_gets_new_case_and_preserves_old_identity(self):
        r,row,cases=self.examples();old=cases[-1]
        review={**self.teacher(old,'none'),'reviewer':'fixture','audioVerified':True,'correctedText':'我来更新接口文档。'}
        rows,rewritten,superseded=apply_corrections([r],[row],cases,[review],budget)
        self.assertIn(old['sample_id'],superseded)
        updated=asr_case(r,rows[0],budget)
        self.assertEqual(rewritten[0]['sample_id'],updated['sample_id'])
        self.assertEqual(rewritten[0]['target'],'c2')
        self.assertEqual(rewritten[0]['correctionBasedOn']['input_hash'],old['input_hash'])
        updated['split']='train'
        self.assertEqual(import_labels([updated],rewritten)[updated['sample_id']]['quality'],'gold')
        review['input_hash']='stale'
        with self.assertRaisesRegex(ValueError,'stale correction'):apply_corrections([r],[row],cases,[review],budget)

    def test_corrected_text_does_not_override_human_skip(self):
        r,row,cases=self.examples();old=cases[-1]
        review={**self.teacher(old,'skip'),'reviewer':'fixture','correctedText':'我来更新接口文档。'}
        rows,rewritten,_=apply_corrections([r],[row],cases,[review],budget)
        updated=asr_case(r,rows[0],budget)
        self.assertEqual(rewritten[0]['target'],'skip')
        self.assertFalse(import_labels([updated],rewritten))

    def test_exposed_holdout_labels_are_not_gold_evaluation(self):
        _,_,cases=self.examples();c=cases[0];c['split']='test'
        review={**self.teacher(c,'present'),'reviewer':'fixture'}
        self.assertFalse(datasets(cases,import_labels(cases,[review]),True)['test'])
        review['blindReview']=True
        self.assertEqual(len(datasets(cases,import_labels(cases,[review]),True)['test']),1)

    def test_cer_requires_gold_audio_reference_and_stale_predictions_fail(self):
        _,_,cases=self.examples();c=cases[-1]
        prediction={'sample_id':c['sample_id'],'input_hash':c['input_hash'],'choice':'c0'}
        label={'sample_id':c['sample_id'],'target':'c1','family':'asr','label_quality':'silver'}
        self.assertIsNone(score(cases,[prediction],[label])['families']['asr']['cer'])
        label['label_quality']='gold'
        self.assertGreater(score(cases,[prediction],[label])['families']['asr']['cer'],0)
        prediction['input_hash']='stale'
        with self.assertRaisesRegex(ValueError,'stale'):score(cases,[prediction],[label])


if __name__=='__main__':unittest.main()
