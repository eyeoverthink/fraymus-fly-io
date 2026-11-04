import copy, json, os, tempfile, threading, unittest
os.environ['FRAYMUS_DATA_DIR']=tempfile.mkdtemp(prefix='fraymus-tests-')
from app import engine, jev
from app.engine import Cancelled, empty_ledger, execute, render_document, synthesis_prompt

class FindLast(unittest.TestCase):
    def test_a_dropped_last_brace_does_not_lose_a_complete_answer(self):
        self.assertEqual(jev.parse_ballot('{"votes": {"q1": {"a": 1}}'),{'q1':{'a':1}})
    def test_reasoning_before_it_is_allowed(self):
        self.assertEqual(jev.parse_ballot('thinking {"votes": {"q1": "noise"}'),{'q1':'noise'})
    def test_a_wrong_shape_is_still_refused(self):
        with self.assertRaises(ValueError): jev.parse_ballot('{"votes": [1]')

class AggregateLaws(unittest.TestCase):
    def test_agreement_at_threshold_answers(self):
        out=jev.aggregate({'a':'decide','b':'decide','c':'decide','d':'decide','e':'noise'})
        self.assertEqual((out['status'],out['answer'],out['agreement']),('answered','decide',.8))
        self.assertEqual(out['disagreement_bps'],2000)
        self.assertEqual(out['semantics'],'stability-signal-not-correctness')
    def test_below_threshold_never_decides(self):
        out=jev.aggregate({'a':'noise','b':'noise','c':'decide'})
        self.assertEqual((out['status'],out['reason']),('fallback','low-agreement'))
        self.assertIsNone(out['answer'])
    def test_agreement_is_on_the_outcome_not_the_label(self):
        out=jev.aggregate({'a':'noise','b':'noise','c':'settled'})
        self.assertEqual((out['status'],out['answer'],out['agreement']),('answered','noise',1.0))
    def test_a_split_clearing_label_cannot_outvote_decide_at_a_tie(self):
        out=jev.aggregate({'a':'noise','b':'settled','c':'decide','d':'decide'})
        self.assertEqual((out['status'],out['leader']),('fallback','decide'))
    def test_one_voter_is_not_independent(self):
        out=jev.aggregate({'a':'noise'})
        self.assertEqual((out['status'],out['reason']),('fallback','insufficient-members'))
        self.assertIn('limited-independence',out['warnings'])
        self.assertIn('shared-systematic-error-risk',out['warnings'])
    def test_no_votes_is_all_abstain(self):
        self.assertEqual(jev.aggregate({'a':None,'b':None})['reason'],'all-abstain')
    def test_invalid_choice_is_an_abstention(self):
        out=jev.aggregate({'a':'noise','b':'noise','c':'maybe'})
        self.assertEqual(out['abstained'],1)
        self.assertEqual(out['status'],'answered')
    def test_unanimity_warns_it_is_not_correctness(self):
        self.assertIn('high-agreement-not-correctness',jev.aggregate({'a':'noise','b':'noise'})['warnings'])
    def test_every_record_admits_no_calibration(self):
        self.assertIn('uncalibrated-members',jev.aggregate({'a':'noise','b':'noise'})['warnings'])
    def test_ties_cannot_answer_and_pick_lowest_id(self):
        out=jev.aggregate({'a':'settled','b':'decide'})
        self.assertEqual((out['status'],out['leader']),('fallback','decide'))

def slots():
    return [{'name':f'P{i}','kind':'ollama','model':f'model-{i}'} for i in range(8)]

def voter(by_model=None, default='noise'):
    """Fake provider: stages add one warning each; the review votes per model."""
    calls=[]
    def call(slot,system,prompt,**kw):
        if 'TASK: REVIEW' in prompt:
            calls.append(slot['model'])
            ids=sorted(set(jev.QUESTION_ID.findall(prompt)))
            return json.dumps({'votes':{i:(by_model or {}).get(slot['model'],default) for i in ids}})
        if 'TASK: SYNTHESIZE' in prompt:
            calls.append('brief:'+prompt)
            return '# Brief'
        stage=prompt.split('STAGE_NUMBER: ')[1].split('\n')[0]
        return json.dumps({'new_logic':[f'idea {stage}'],'contradictions':[f'conflict {stage}'] if stage in ('1','2') else []})
    return call,calls

class ReviewStage(unittest.TestCase):
    def config(self,**extra):
        return {'slots':slots(),'passes':2,'retry_delay_seconds':0,**extra}
    def test_each_member_gets_one_batch_call(self):
        call,calls=voter()
        run=execute('x',self.config(),call=call)
        self.assertEqual(len([c for c in calls if c.startswith('model')]),jev.MAX_MEMBERS)
        self.assertEqual(run['review']['status'],'complete')
        self.assertEqual(len(run['review']['questions']),2)
    def test_author_cannot_vote_on_its_own_claim(self):
        call,_=voter()
        run=execute('x',self.config(),call=call)
        q=run['review']['questions'][0]
        self.assertEqual(q['stage'],1)
        self.assertNotIn('ollama:model-0',q['votes'])
    def test_low_agreement_goes_to_the_person(self):
        call,_=voter({'model-1':'settled','model-2':'decide','model-3':'noise','model-4':'settled'})
        run=execute('x',self.config(),call=call)
        self.assertEqual(run['review']['questions'][0]['outcome'],'needs_you')
    def test_agreed_noise_is_marked_but_never_removed(self):
        call,_=voter()
        run=execute('x',self.config(),call=call)
        self.assertEqual(run['review']['questions'][0]['outcome'],'resolved')
        self.assertEqual(len(run['ledger']['contradictions']),2)
    def test_review_never_changes_the_ledger(self):
        call,_=voter()
        run=execute('x',self.config(review=False),call=call)
        before=copy.deepcopy(run['ledger'])
        run['stages']=run['stages']
        jev.review(run,self.config(),call,None,lambda:None)
        self.assertEqual(run['ledger'],before)
    def test_a_failed_voter_is_recorded_and_the_run_survives(self):
        good,_=voter()
        def call(slot,system,prompt,**kw):
            if 'TASK: REVIEW' in prompt and slot['model']=='model-1': raise RuntimeError('voter down')
            return good(slot,system,prompt,**kw)
        run=execute('x',self.config(),call=call)
        self.assertEqual(run['status'],'complete')
        self.assertIn('ollama:model-1',run['review']['member_errors'])
    def test_total_review_failure_does_not_fail_the_run(self):
        good,_=voter()
        def call(slot,system,prompt,**kw):
            if 'TASK: REVIEW' in prompt: raise RuntimeError('down')
            return good(slot,system,prompt,**kw)
        run=execute('x',self.config(),call=call)
        self.assertEqual(run['status'],'complete')
        self.assertEqual(run['review']['questions'][0]['reason'],'all-abstain')
    def test_brief_receives_open_decisions(self):
        call,calls=voter(default='decide')
        execute('x',self.config(),call=call)
        brief=next(c for c in calls if c.startswith('brief:'))
        self.assertIn('OPEN DECISIONS',brief);self.assertIn('conflict 1',brief)
    def test_document_lists_decisions_with_the_semantics_warning(self):
        call,_=voter(default='decide')
        doc=render_document(execute('x',self.config(),call=call))
        self.assertIn('## Decisions for you',doc);self.assertIn('not proof',doc)
    def warned(self,count):
        ledger=empty_ledger()
        half=count//2
        ledger['contradictions']=[{'text':f'c{i}','stage':99,'verified':False} for i in range(count-half)]
        ledger['unsupported_claims']=[{'text':f'u{i}','stage':99,'verified':False} for i in range(half)]
        stages=[{'number':i+1,'status':'complete','kind':'ollama','model':f'model-{i}'} for i in range(8)]
        return {'request':'x','ledger':ledger,'stages':stages}
    def review_of(self,count,call,**extra):
        run=self.warned(count)
        jev.review(run,self.config(),call,extra.pop('cancel',None),lambda:None,**extra)
        return run
    def test_every_warning_gets_a_vote(self):
        call,calls=voter()
        run=self.review_of(jev.BATCH_SIZE*2+1,call)
        questions=run['review']['questions']
        self.assertEqual(len(questions),jev.BATCH_SIZE*2+1)
        self.assertEqual(len({q['id'] for q in questions}),len(questions))
        self.assertEqual({q['outcome'] for q in questions},{'resolved'})
        self.assertEqual(len([c for c in calls if c.startswith('model')]),3*jev.MAX_MEMBERS)
        self.assertEqual((run['review']['done'],run['review']['total']),(15,15))
    def test_batches_mix_both_kinds_the_same_way_each_time(self):
        items=jev.select_items(self.warned(jev.BATCH_SIZE*2))
        rounds=jev.batches(items)
        self.assertEqual(rounds,jev.batches(items))
        self.assertEqual(sorted(i['id'] for r in rounds for i in r),sorted(i['id'] for i in items))
        for batch in rounds:
            self.assertGreater(min(sum(i['field']==f for i in batch) for f in jev.REVIEWED),jev.BATCH_SIZE//4)
    def test_one_failed_batch_abstains_only_on_its_items(self):
        good,_=voter()
        first=jev.batches(jev.select_items(self.warned(jev.BATCH_SIZE+1)))[0][0]['id']
        def call(slot,system,prompt,**kw):
            if 'TASK: REVIEW' in prompt and slot['model']=='model-1' and f'"id": "{first}"' in prompt: raise RuntimeError('rate limited')
            return good(slot,system,prompt,**kw)
        review=self.review_of(jev.BATCH_SIZE+1,call)['review']
        by_id={q['id']:q for q in review['questions']}
        self.assertNotIn('ollama:model-1',by_id[first]['votes'])
        self.assertIn('ollama:model-1',by_id[jev.batches(jev.select_items(self.warned(jev.BATCH_SIZE+1)))[1][0]['id']]['votes'])
        self.assertIn('1 of 2 batches',review['member_errors']['ollama:model-1'])
        self.assertIn('rate limited',review['member_errors']['ollama:model-1'])
    def test_a_reply_cannot_vote_outside_its_batch(self):
        def call(slot,system,prompt,**kw):
            ids=sorted(set(jev.QUESTION_ID.findall(prompt)))
            return json.dumps({'votes':{f'q{i}':'noise' for i in range(1,jev.BATCH_SIZE+2)}} if len(ids)>1 else {'votes':{}})
        review=self.review_of(jev.BATCH_SIZE+1,call)['review']
        self.assertEqual(sum(q['reason']=='all-abstain' for q in review['questions']),1)
    def test_cancelling_stops_before_the_next_batch(self):
        cancel=threading.Event()
        call,calls=voter()
        def stopping(slot,system,prompt,**kw):
            cancel.set()
            return call(slot,system,prompt,**kw)
        with self.assertRaises(Cancelled): self.review_of(jev.BATCH_SIZE*3,stopping,cancel=cancel)
        self.assertLessEqual(len(calls),jev.MAX_MEMBERS)
    def test_the_time_limit_leaves_the_rest_to_the_person(self):
        call,calls=voter()
        review=self.review_of(jev.BATCH_SIZE*2,call,stop=lambda:'Run time limit reached')['review']
        self.assertEqual(calls,[])
        self.assertEqual({q['outcome'] for q in review['questions']},{'needs_you'})
        self.assertIn('Run time limit',next(iter(review['member_errors'].values())))
    def test_one_identity_cannot_settle_anything(self):
        single=[{'name':f'P{i}','kind':'ollama','model':'same'} for i in range(8)]
        call,_=voter()
        run=execute('x',{'slots':single,'passes':2},call=call)
        self.assertEqual(run['review']['questions'][0]['reason'],'all-abstain')
        self.assertEqual(run['review']['questions'][0]['outcome'],'needs_you')
    def test_demo_chain_reviews_without_error(self):
        config={'slots':[{'name':f'D{i}','kind':'demo','model':'fixture'} for i in range(8)],'passes':2}
        self.assertIn('review',execute('Bake bread',config))

class Grouping(unittest.TestCase):
    ids=['q1','q2','q3','q4']
    def reply(self,*groups):
        return json.dumps({'groups':list(groups)})
    def group(self,items,severity='medium',title='T'):
        return {'title':title,'severity':severity,'why':'W','items':items}
    def test_highest_severity_comes_first(self):
        out=jev.parse_groups(self.reply(self.group(['q1'],'low'),self.group(['q2'],'high'),self.group(['q3','q4'])),self.ids)
        self.assertEqual([g['severity'] for g in out],['high','medium','low'])
    def test_a_warning_the_model_forgot_stays_visible(self):
        out=jev.parse_groups(self.reply(self.group(['q1','q2'])),self.ids)
        self.assertEqual(sorted(i for g in out for i in g['items']),self.ids)
        self.assertIn('Not grouped',[g['title'] for g in out])
    def test_an_invented_id_is_dropped(self):
        out=jev.parse_groups(self.reply(self.group(['q1','q99','q2','q3','q4'])),self.ids)
        self.assertEqual(out[0]['items'],self.ids)
    def test_a_warning_in_two_groups_keeps_its_first(self):
        out=jev.parse_groups(self.reply(self.group(['q1','q2']),self.group(['q2','q3','q4'])),self.ids)
        self.assertEqual(sorted(i for g in out for i in g['items']),self.ids)
    def test_an_unknown_severity_is_not_trusted(self):
        self.assertEqual(jev.parse_groups(self.reply(self.group(self.ids,'catastrophic')),self.ids)[0]['severity'],'medium')
    def test_titles_cannot_carry_markup_lines(self):
        self.assertNotIn('\n',jev.parse_groups(self.reply(self.group(self.ids,title='a\n# b')),self.ids)[0]['title'])
    def test_reasoning_around_the_json_is_fine(self):
        text='I think {so}. '+self.reply(self.group(self.ids))
        self.assertEqual(jev.parse_groups(text,self.ids)[0]['items'],self.ids)
    def test_nothing_usable_is_an_error(self):
        with self.assertRaises(ValueError): jev.parse_groups(self.reply(self.group(['q99'])),self.ids)

class GroupingInARun(unittest.TestCase):
    def config(self):
        return {'slots':slots(),'passes':2,'retry_delay_seconds':0}
    def caller(self,reply):
        good,_=voter(default='decide')
        def call(slot,system,prompt,**kw):
            if 'TASK: GROUP' in prompt: return reply(prompt)
            return good(slot,system,prompt,**kw)
        return call
    def many(self,good):
        def call(slot,system,prompt,**kw):
            if 'TASK: GROUP' in prompt: return good(slot,system,prompt,**kw)
            if 'STAGE_NUMBER' in prompt:
                stage=prompt.split('STAGE_NUMBER: ')[1].split('\n')[0]
                return json.dumps({'new_logic':[f'idea {stage}'],'contradictions':[f'conflict {stage}'] if int(stage)<=4 else []})
            return good(slot,system,prompt,**kw)
        return call
    def test_every_open_warning_lands_in_a_group(self):
        call=self.many(self.caller(lambda p:json.dumps({'groups':[{'title':'T','severity':'high','why':'W','items':sorted(set(jev.QUESTION_ID.findall(p)))}]})))
        run=execute('x',self.config(),call=call)
        grouping=run['review']['grouping']
        self.assertEqual(grouping['status'],'complete')
        self.assertEqual(len(grouping['groups'][0]['items']),len(run['review']['questions']))
    def test_grouping_asks_for_room_to_list_every_id(self):
        seen={}
        def grouped(prompt):return json.dumps({'groups':[{'title':'T','severity':'high','why':'W','items':sorted(set(jev.QUESTION_ID.findall(prompt)))}]})
        inner=self.many(self.caller(grouped))
        def call(slot,system,prompt,**kw):
            if 'TASK: GROUP' in prompt: seen.update(kw)
            return inner(slot,system,prompt,**kw)
        execute('x',{**self.config(),'max_output_tokens':500},call=call)
        self.assertEqual(seen['max_tokens'],1000)
    def test_the_brief_gets_decisions_not_every_warning_twice(self):
        call,calls=voter()
        inner=self.many(self.caller(lambda p:json.dumps({'groups':[{'title':'Pick a store','severity':'high','why':'W','items':sorted(set(jev.QUESTION_ID.findall(p)))}]})))
        briefs=[]
        def spy(slot,system,prompt,**kw):
            if 'TASK: SYNTHESIZE' in prompt: briefs.append(prompt.split('</ledger>')[1])
            return inner(slot,system,prompt,**kw)
        execute('x',self.config(),call=spy)
        self.assertIn('high: Pick a store (4 warnings)',briefs[0])
        self.assertNotIn('conflict 1',briefs[0])
    def test_a_flat_list_cannot_outgrow_the_brief_prompt(self):
        decisions=[{'text':'w'*200} for _ in range(100)]
        tail=synthesis_prompt('x',empty_ledger(),8000,decisions).split('</ledger>')[1]
        self.assertLess(len(tail),2300)
        self.assertRegex(tail,r'and \d+ more open warnings, all in the ledger above')
    def test_the_next_seat_groups_after_a_failure(self):
        seen=[]
        grouped=self.caller(lambda p:json.dumps({'groups':[{'title':'T','severity':'high','why':'W','items':sorted(set(jev.QUESTION_ID.findall(p)))}]}))
        inner=self.many(grouped)
        def call(slot,system,prompt,**kw):
            if 'TASK: GROUP' in prompt:
                seen.append(slot['model'])
                if len(seen)==1: return 'not json'
            return inner(slot,system,prompt,**kw)
        grouping=execute('x',self.config(),call=call)['review']['grouping']
        self.assertEqual((grouping['status'],len(seen)),('complete',2))
        self.assertNotIn('error',grouping)
        self.assertEqual(grouping['member'],'ollama:'+seen[1])
    def test_grouping_gives_up_after_three_seats(self):
        seen=[]
        inner=self.many(self.caller(lambda p:'not json'))
        def call(slot,system,prompt,**kw):
            if 'TASK: GROUP' in prompt: seen.append(slot['model'])
            return inner(slot,system,prompt,**kw)
        self.assertEqual(execute('x',self.config(),call=call)['review']['grouping']['status'],'failed')
        self.assertEqual(len(seen),jev.GROUP_TRIES)
    def test_a_failed_grouping_leaves_the_flat_list(self):
        def boom(prompt): raise RuntimeError('down')
        run=execute('x',self.config(),call=self.many(self.caller(boom)))
        self.assertEqual(run['status'],'complete')
        self.assertEqual(run['review']['grouping']['status'],'failed')
        self.assertIn('## Decisions for you',render_document(run))
        self.assertIn('conflict 1',render_document(run))
    def test_too_few_warnings_are_not_grouped(self):
        call,_=voter(default='decide')
        self.assertNotIn('grouping',execute('x',self.config(),call=call)['review'])
    def test_the_document_keeps_warning_text_under_its_group(self):
        call=self.many(self.caller(lambda p:json.dumps({'groups':[{'title':'Pick one','severity':'high','why':'W','items':sorted(set(jev.QUESTION_ID.findall(p)))}]})))
        doc=render_document(execute('x',self.config(),call=call))
        self.assertIn('### High: Pick one',doc);self.assertIn('conflict 3',doc);self.assertIn('Severity is its judgment',doc)
    def test_grouping_never_changes_votes_or_the_ledger(self):
        call=self.many(self.caller(lambda p:json.dumps({'groups':[{'title':'T','severity':'low','why':'','items':['q1']}]})))
        run=execute('x',self.config(),call=call)
        self.assertTrue(all(q['outcome']=='needs_you' for q in run['review']['questions']))
        self.assertEqual(len(run['ledger']['contradictions']),4)

if __name__=='__main__':unittest.main()
