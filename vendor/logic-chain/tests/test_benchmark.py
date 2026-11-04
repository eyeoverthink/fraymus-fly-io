import json, os, tempfile, threading, unittest
os.environ['FRAYMUS_DATA_DIR']=tempfile.mkdtemp(prefix='fraymus-tests-')
from app import benchmark, jev
from app.engine import execute

def cases():
    return [c for s in benchmark.load_corpus()['scenarios'] for c in s['items']]

def slots(n=5):
    return [{'name':f'P{i}','kind':'ollama','model':f'model-{i}'} for i in range(n)]

def config(n=5,**extra):
    return {'slots':slots(n),'passes':2,**extra}

def oracle(choose):
    """Fake provider that votes through choose(model, case) using the real prompt it was sent."""
    truth={c['text']:c for c in cases()}
    calls=[]
    def call(slot,system,prompt,**kw):
        calls.append((slot['model'],system,prompt))
        block=prompt.split('<ledger>\n')[1].split('\n</ledger>')[0]
        return json.dumps({'votes':{q['id']:choose(slot['model'],truth[q['text']]) for q in json.loads(block)}})
    return call,calls

class Corpus(unittest.TestCase):
    def test_labels_are_balanced(self):
        counts={}
        for c in cases(): counts[c['label']]=counts.get(c['label'],0)+1
        self.assertEqual(counts,{'decide':16,'noise':16,'settled':16})
    def test_every_case_is_explained_and_valid(self):
        for c in cases():
            self.assertIn(c['label'],jev.CHOICES)
            self.assertIn(c['kind'],jev.REVIEWED)
            self.assertTrue(c['why'].strip())
    def test_ids_are_unique(self):
        ids=[f"{s['id']}/{c['id']}" for s in benchmark.load_corpus()['scenarios'] for c in s['items']]
        self.assertEqual(len(ids),len(set(ids)))
    def test_every_scenario_holds_every_label(self):
        for s in benchmark.load_corpus()['scenarios']:
            self.assertEqual({c['label'] for c in s['items']},set(jev.CHOICES))

class Prompt(unittest.TestCase):
    def test_answers_never_reach_the_model(self):
        call,calls=oracle(lambda m,c:c['label'])
        benchmark.run(config(1),call)
        for _,_,prompt in calls:
            block=prompt.split('<ledger>\n')[1].split('\n</ledger>')[0]
            self.assertTrue(all(set(q)=={'id','kind','text'} for q in json.loads(block)))
    def test_label_order_does_not_follow_the_file(self):
        scenario=benchmark.load_corpus()['scenarios'][0]
        self.assertNotEqual([c['id'] for c in benchmark.shuffled(scenario)],[c['id'] for c in scenario['items']])
    def test_order_is_repeatable(self):
        scenario=benchmark.load_corpus()['scenarios'][0]
        self.assertEqual(benchmark.shuffled(scenario),benchmark.shuffled(scenario))
    def test_it_uses_the_real_review_instructions(self):
        call,calls=oracle(lambda m,c:c['label'])
        benchmark.run(config(1),call)
        self.assertTrue(all(system==jev.REVIEW_SYSTEM for _,system,_ in calls))

class Scoring(unittest.TestCase):
    def test_perfect_member(self):
        call,_=oracle(lambda m,c:c['label'])
        member=benchmark.run(config(1),call)['members']['ollama:model-0']
        self.assertEqual((member['right'],member['accuracy'],member['answered']),(48,1.0,48))
    def test_always_decide_scores_only_chance(self):
        call,_=oracle(lambda m,c:'decide')
        member=benchmark.run(config(1),call)['members']['ollama:model-0']
        self.assertAlmostEqual(member['accuracy'],1/3,places=3)
        self.assertEqual(member['recall'],{'decide':1.0,'noise':0.0,'settled':0.0})
    def test_settled_and_noise_are_the_same_answer(self):
        call,_=oracle(lambda m,c:'decide' if c['label']=='decide' else 'noise')
        member=benchmark.run(config(1),call)['members']['ollama:model-0']
        self.assertEqual((member['right'],member['found'],member['cleared']),(48,1.0,1.0))
        self.assertEqual(member['recall']['settled'],0.0)
    def test_always_clearing_beats_nothing_and_is_never_calibrated(self):
        call,_=oracle(lambda m,c:'noise')
        member=benchmark.run(config(1),call)['members']['ollama:model-0']
        self.assertAlmostEqual(member['accuracy'],benchmark.BASELINE,places=3)
        self.assertEqual((member['found'],member['standing']),(0.0,'uncalibrated'))
    def test_always_decide_is_never_calibrated(self):
        call,_=oracle(lambda m,c:'decide')
        self.assertEqual(benchmark.run(config(1),call)['members']['ollama:model-0']['standing'],'uncalibrated')
    def test_a_failed_call_costs_its_cases(self):
        good,_=oracle(lambda m,c:c['label'])
        first=[]
        def call(slot,system,prompt,**kw):
            if not first:
                first.append(1);raise TimeoutError('slow')
            return good(slot,system,prompt,**kw)
        member=benchmark.run(config(1),call)['members']['ollama:model-0']
        self.assertEqual((member['answered'],member['right'],member['cases']),(42,42,48))
        self.assertEqual(len(member['errors']),1)
    def test_wilson_interval_is_wide_for_small_samples(self):
        low,high=benchmark.wilson(4,5)
        self.assertLess(low,.45);self.assertGreater(high,.95)
    def test_wilson_handles_nothing(self):
        self.assertEqual(benchmark.wilson(0,0),(0.0,1.0))

class Panel(unittest.TestCase):
    def test_unanimous_truth_is_all_answered_and_right(self):
        call,_=oracle(lambda m,c:c['label'])
        panel=benchmark.run(config(),call)['panel']
        self.assertEqual((panel['answered'],panel['right'],panel['wrongly_dismissed']),(48,48,0))
    def test_a_dismissed_real_issue_is_counted(self):
        call,_=oracle(lambda m,c:'noise')
        panel=benchmark.run(config(),call)['panel']
        self.assertEqual(panel['wrongly_dismissed'],16)
        self.assertEqual(panel['real_issues'],16)
    def test_a_split_between_clearing_labels_still_clears(self):
        call,_=oracle(lambda m,c:c['label'] if c['label']=='decide' else ('noise' if m in ('model-0','model-1','model-2') else 'settled'))
        panel=benchmark.run(config(),call)['panel']
        self.assertEqual((panel['answered'],panel['over_sent']),(48,0))
    def test_non_issues_that_reach_you_are_counted(self):
        call,_=oracle(lambda m,c:'decide')
        panel=benchmark.run(config(),call)['panel']
        self.assertEqual((panel['over_sent'],panel['non_issues']),(32,32))
    def test_split_votes_are_not_answered(self):
        call,_=oracle(lambda m,c:'noise' if m in ('model-0','model-1') else 'decide')
        panel=benchmark.run(config(),call)['panel']
        self.assertEqual((panel['answered'],panel['wrongly_dismissed'],panel['over_sent']),(0,0,32))
    def test_panel_is_capped_like_the_review(self):
        call,_=oracle(lambda m,c:c['label'])
        report=benchmark.run(config(7),call)
        self.assertEqual(len(report['members']),7)
        self.assertEqual(len(report['panel']['members']),jev.MAX_MEMBERS)

class Report(unittest.TestCase):
    def test_missed_cases_surface_most_contested_first(self):
        call,_=oracle(lambda m,c:'noise' if c['id']=='late-retry' else ('noise' if c['id']=='poison-event' and m=='model-0' else c['label']))
        missed=benchmark.run(config(),call)['missed']
        self.assertEqual(missed[0]['case'],'payments/late-retry')
        self.assertEqual((missed[0]['wrong'],missed[0]['label']),(5,'decide'))
        self.assertEqual(missed[1]['case'],'payments/poison-event')
        self.assertIn('why',missed[0])
    def test_a_member_that_never_answered_contests_nothing(self):
        good,_=oracle(lambda m,c:c['label'])
        def call(slot,system,prompt,**kw):
            if slot['model']=='model-1': raise RuntimeError('429')
            return good(slot,system,prompt,**kw)
        self.assertEqual(benchmark.run(config(2),call)['missed'],[])
    def test_one_identity_is_measured_once(self):
        call,calls=oracle(lambda m,c:c['label'])
        same=[{'name':f'P{i}','kind':'ollama','model':'same'} for i in range(4)]
        report=benchmark.run({'slots':same},call)
        self.assertEqual(list(report['members']),['ollama:same'])
        self.assertEqual(len(calls),8)
    def test_a_saved_report_comes_back(self):
        call,_=oracle(lambda m,c:c['label'])
        report=benchmark.run(config(2),call)
        benchmark.save_report(report)
        self.assertEqual(benchmark.latest_report()['id'],report['id'])
    def test_results_follow_the_exact_corpus(self):
        report={'corpus':{'hash':'old'},'members':{'a':{'standing':'calibrated'}}}
        self.assertEqual(benchmark.calibrated_members(report),set())
    def test_only_calibrated_members_are_returned(self):
        report={'corpus':{'hash':benchmark.corpus_hash()},'members':{'a':{'standing':'calibrated'},'b':{'standing':'uncalibrated'}}}
        self.assertEqual(benchmark.calibrated_members(report),{'a'})
    def test_cancel_stops_the_run(self):
        stop=threading.Event();stop.set()
        call,_=oracle(lambda m,c:c['label'])
        with self.assertRaises(benchmark.Cancelled):
            benchmark.run(config(2),call,stop)
    def test_progress_is_reported(self):
        seen=[]
        call,_=oracle(lambda m,c:c['label'])
        benchmark.run(config(1),call,notify=lambda r:seen.append(r['done']))
        self.assertEqual(seen[-1],8)
    def test_no_slots_is_refused(self):
        with self.assertRaises(ValueError):
            benchmark.run({'slots':[]},lambda *a,**k:'')

class Seats(unittest.TestCase):
    def report(self,**standing):
        return {'corpus':{'hash':benchmark.corpus_hash()},'members':{f'ollama:{name}':{'standing':state,'accuracy':score} for name,(state,score) in standing.items()}}
    def names(self,seated):
        return [s['model'] for s in seated]
    def test_with_no_scores_slot_order_stands(self):
        self.assertEqual(self.names(benchmark.panel(slots(7),{'members':{}})),[f'model-{i}' for i in range(5)])
    def test_old_scores_change_nothing(self):
        old={'corpus':{'hash':'old'},'members':{'ollama:model-4':{'standing':'calibrated','accuracy':1.0}}}
        self.assertEqual(self.names(benchmark.panel(slots(5),old))[0],'model-0')
    def test_only_calibrated_members_sit_when_there_are_enough(self):
        ok='calibrated'
        seated=benchmark.panel(slots(5),self.report(**{'model-4':(ok,.9),'model-3':(ok,1.0),'model-2':(ok,.8),'model-1':('uncalibrated',.99)}))
        self.assertEqual(self.names(seated),['model-3','model-4','model-2'])
    def test_a_high_score_that_missed_real_issues_ranks_below_a_pass(self):
        seated=benchmark.panel(slots(3),self.report(**{'model-0':('uncalibrated',.99),'model-1':('calibrated',.9)}))
        self.assertEqual(self.names(seated)[:2],['model-1','model-0'])
    def test_too_few_passes_keep_the_panel_full(self):
        seated=benchmark.panel(slots(6),self.report(**{'model-5':('calibrated',.9),'model-4':('calibrated',.9)}))
        self.assertEqual(len(seated),5);self.assertEqual(self.names(seated)[:2],['model-4','model-5'])
    def test_the_seat_rule_never_seats_a_slot_that_failed_its_stages(self):
        run={'stages':[{'status':'complete','kind':'ollama','model':'model-1'},{'status':'failed','kind':'ollama','model':'model-0'}]}
        self.assertEqual(self.names(jev.select_members(run,config(2))),['model-1'])
    def test_the_benchmark_panel_is_the_panel_a_run_would_seat(self):
        def choose(m,c): return c['label'] if m!='model-0' else 'decide'
        call,_=oracle(choose)
        report=benchmark.run(config(6),call)
        self.assertEqual(report['panel']['members'],[f'ollama:model-{i}' for i in range(1,6)])

class CalibrationReachesTheReview(unittest.TestCase):
    def test_warning_stays_unless_every_voter_is_calibrated(self):
        votes={'a':'noise','b':'noise'}
        self.assertIn('uncalibrated-members',jev.aggregate(votes,{'a'})['warnings'])
        self.assertNotIn('uncalibrated-members',jev.aggregate(votes,{'a','b'})['warnings'])
    def test_the_semantics_never_change(self):
        self.assertEqual(jev.aggregate({'a':'noise','b':'noise'},{'a','b'})['semantics'],jev.SEMANTICS)
    def test_a_saved_calibration_lifts_the_warning_on_a_real_review(self):
        def call(slot,system,prompt,**kw):
            if 'TASK: REVIEW' in prompt:
                return json.dumps({'votes':{i:'noise' for i in set(jev.QUESTION_ID.findall(prompt))}})
            if 'TASK: SYNTHESIZE' in prompt: return '# Brief'
            stage=prompt.split('STAGE_NUMBER: ')[1].split('\n')[0]
            return json.dumps({'new_logic':[f'idea {stage}'],'contradictions':[f'c {stage}'] if stage=='1' else []})
        names=[f'ollama:model-{i}' for i in range(8)]
        benchmark.save_report({'id':'z'*16,'created_at':'9999','status':'complete','corpus':{'hash':benchmark.corpus_hash()},'members':{n:{'standing':'calibrated'} for n in names}})
        try:
            run=execute('x',{'slots':slots(8),'passes':2,'retry_delay_seconds':0},call=call)
        finally:
            os.remove(benchmark.reports_dir()/f"{'z'*16}.json")
        self.assertNotIn('uncalibrated-members',run['review']['questions'][0]['warnings'])

if __name__=='__main__':unittest.main()
