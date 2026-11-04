import http.client, json, os, tempfile, threading, time, unittest
os.environ['FRAYMUS_DATA_DIR']=tempfile.mkdtemp(prefix='fraymus-tests-')
from app import engine, server, settings

DEMO={'slots':[{'name':f'P{i}','kind':'demo','model':'fixture'} for i in range(8)],'passes':2,'timeout_seconds':5,'max_elapsed_seconds':60,'max_output_tokens':500,'allow_remote':False}

class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        settings.write_config(DEMO)
        cls.httpd=server.make_server(0)
        cls.port=cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever,daemon=True).start()
    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown();cls.httpd.server_close()
    def tearDown(self):
        os.environ.pop('FRAYMUS_SERVER_TOKEN',None)
        settings.write_config(DEMO)
        server.wait_idle()
    def req(self,method,path,body=None,headers=None,raw=False):
        c=http.client.HTTPConnection('127.0.0.1',self.port,timeout=10)
        hdr={'Content-Type':'application/json'} if body is not None else {}
        hdr.update(headers or {})
        c.request(method,path,json.dumps(body) if body is not None and not raw else body,hdr)
        r=c.getresponse();data=r.read();c.close()
        try:return r.status,json.loads(data)
        except ValueError:return r.status,data
    def finish(self,rid):
        server.wait_idle()
        return self.req('GET','/api/runs/'+rid)[1]
    def test_static_assets_and_favicon(self):
        for path in ('/','/app.js','/style.css','/favicon.svg'):
            self.assertEqual(self.req('GET',path)[0],200,path)
    def test_foreign_host_rejected(self):
        self.assertEqual(self.req('GET','/api/runs',headers={'Host':'evil.example'})[0],403)
    def test_foreign_origin_rejected(self):
        self.assertEqual(self.req('POST','/api/run',{'request':'x'},{'Origin':'https://evil.example'})[0],403)
    def test_text_plain_post_rejected(self):
        self.assertEqual(self.req('POST','/api/run',{'request':'x'},{'Content-Type':'text/plain'})[0],415)
    def test_same_origin_post_allowed(self):
        status,out=self.req('POST','/api/run',{'request':'x'},{'Origin':f'http://127.0.0.1:{self.port}'})
        self.assertEqual(status,202);self.finish(out['id'])
    def test_token_required_when_set(self):
        os.environ['FRAYMUS_SERVER_TOKEN']='secret'
        self.assertEqual(self.req('GET','/api/runs')[0],401)
        self.assertEqual(self.req('GET','/api/runs',headers={'Authorization':'Bearer secret'})[0],200)
    def test_array_body_is_400(self):
        self.assertEqual(self.req('POST','/api/run',[1])[0],400)
    def test_blank_request_is_400(self):
        self.assertEqual(self.req('POST','/api/run',{'request':'  '})[0],400)
    def test_long_multibyte_request_within_limit_accepted(self):
        status,out=self.req('POST','/api/run',{'request':'\U0001F600'*6000})
        self.assertEqual(status,202);self.finish(out['id'])
    def test_over_limit_request_is_400(self):
        self.assertEqual(self.req('POST','/api/run',{'request':'x'*12001})[0],400)
    def test_run_stream_and_export_without_body(self):
        status,out=self.req('POST','/api/run',{'request':'Bake a sourdough loaf'})
        self.assertEqual(status,202)
        c=http.client.HTTPConnection('127.0.0.1',self.port,timeout=10)
        c.request('GET',f"/api/runs/{out['id']}/events")
        r=c.getresponse()
        self.assertEqual(r.getheader('Content-Type'),'text/event-stream')
        frames=[l for l in r.read().decode().splitlines() if l.startswith('data: ')]
        c.close()
        final=json.loads(frames[-1][6:])
        self.assertEqual(final['status'],'complete')
        self.assertEqual(self.req('POST',f"/api/export/{out['id']}")[1]['status'],'candidate_unverified')
        status,doc=self.req('GET',f"/api/runs/{out['id']}/document")
        self.assertEqual(status,200);self.assertIn(b'sourdough',doc)
    def test_verify_route_reports_the_signed_chain(self):
        status,out=self.req('POST','/api/run',{'request':'Verify over HTTP'})
        self.finish(out['id'])
        status,result=self.req('GET',f"/api/runs/{out['id']}/verify")
        self.assertEqual(status,200)
        self.assertTrue(result['ok'],result['errors'])
        self.assertEqual((result['records'],result['mode']),(18,'mock'))
        self.assertRegex(result['signer'],r'^fx-[0-9a-f]{4}(-[0-9a-f]{4}){3}$')
        self.assertEqual(self.req('GET','/api/runs/0123456789abcdef/verify')[0],404)
    def interrupted(self,rid='aaaaaaaaaaaaaaaa'):
        engine.save_run({'id':rid,'created_at':engine.iso(),'status':'interrupted','request':'Bake bread','stages':[],'ledger':engine.empty_ledger(),'summary':{}})
        return rid
    def test_an_interrupted_run_resumes_under_its_own_id(self):
        rid=self.interrupted()
        code,body=self.req('POST',f'/api/runs/{rid}/resume',{})
        self.assertEqual((code,body['id']),(202,rid))
        run=self.finish(rid)
        self.assertEqual((run['status'],len(run['stages'])),('complete',16))
        self.assertEqual(self.req('POST',f'/api/runs/{rid}/resume',{})[0],409)
    def test_resuming_an_unknown_run_is_not_found(self):
        self.assertEqual(self.req('POST','/api/runs/bbbbbbbbbbbbbbbb/resume',{})[0],404)
    def test_resuming_needs_consent_for_remote_slots(self):
        rid=self.interrupted('cccccccccccccccc')
        settings.write_config({**DEMO,'slots':[{'name':f'P{i}','kind':'openai','model':'m','key_env':'X_KEY'} for i in range(8)],'allow_remote':True})
        self.assertEqual(self.req('POST',f'/api/runs/{rid}/resume',{})[0],403)
        self.assertEqual(engine.load_run(rid)['status'],'interrupted')
    def test_second_run_conflicts_then_cancels(self):
        release=threading.Event()
        original=engine.call_provider
        def slow(*a,**k):
            release.wait(5);return json.dumps({'new_logic':['n']})
        engine.call_provider=slow
        try:
            status,out=self.req('POST','/api/run',{'request':'first'})
            self.assertEqual(status,202)
            self.assertEqual(self.req('POST','/api/run',{'request':'second'})[0],409)
            self.assertEqual(self.req('GET','/api/config')[1]['active_run'],out['id'])
            self.assertEqual(self.req('POST',f"/api/runs/{out['id']}/cancel")[0],202)
            run=self.finish(out['id'])
            self.assertEqual(run['status'],'cancelled')
        finally:
            release.set();engine.call_provider=original
    def test_run_is_readable_as_soon_as_it_starts(self):
        for _ in range(5):
            out=self.req('POST','/api/run',{'request':'read me now'})[1]
            self.assertEqual(self.req('GET','/api/runs/'+out['id'])[0],200)
            self.finish(out['id'])
    def test_delete_run(self):
        out=self.req('POST','/api/run',{'request':'gone'})[1];self.finish(out['id'])
        self.assertEqual(self.req('DELETE','/api/runs/'+out['id'])[0],200)
        self.assertEqual(self.req('GET','/api/runs/'+out['id'])[0],404)
    def test_config_round_trip_and_validation(self):
        cfg=self.req('GET','/api/config')[1]
        self.assertEqual(cfg['mode'],'demo')
        cfg['slots'][0]['name']='Renamed'
        self.assertEqual(self.req('POST','/api/config',cfg)[0],200)
        self.assertEqual(self.req('GET','/api/config')[1]['slots'][0]['name'],'Renamed')
        bad=dict(cfg,slots=cfg['slots'][:3])
        self.assertEqual(self.req('POST','/api/config',bad)[0],400)
        bad=json.loads(json.dumps(cfg));bad['slots'][0].update(kind='openai_compatible',model='m',url='file:///etc/passwd')
        self.assertEqual(self.req('POST','/api/config',bad)[0],400)
        bad=json.loads(json.dumps(cfg));bad['slots'][0].update(kind='openai',model='m',key_env='FRAYMUS_SERVER_TOKEN')
        self.assertEqual(self.req('POST','/api/config',bad)[0],400)
    def test_remote_gate_needs_config_and_per_run_approval(self):
        cfg=json.loads(json.dumps(DEMO));cfg['slots'][0].update(kind='ollama',model='m',url='https://gpu.example.com/api/chat')
        settings.write_config(cfg)
        self.assertEqual(self.req('POST','/api/run',{'request':'x','approve_remote':True})[0],403)
        cfg['allow_remote']=True;settings.write_config(cfg)
        self.assertEqual(self.req('POST','/api/run',{'request':'x'})[0],403)
    def test_slot_test_endpoint(self):
        status,out=self.req('POST','/api/test-slot',{'slot':{'name':'d','kind':'demo','model':'x'}})
        self.assertEqual(status,200);self.assertTrue(out['ok']);self.assertGreater(out['items'],0)

    def test_demo_benchmark_runs_and_scores_chance(self):
        status,_=self.req('POST','/api/benchmark',{})
        self.assertEqual(status,202)
        server.wait_idle()
        _,state=self.req('GET','/api/benchmark')
        self.assertFalse(state['running'])
        member=state['report']['members']['demo:fixture']
        self.assertAlmostEqual(member['accuracy'],1/3,places=3)
        self.assertEqual(member['standing'],'uncalibrated')
    def test_remote_benchmark_needs_approval(self):
        settings.write_config({**DEMO,'slots':[{'name':'R','kind':'openai_compatible','url':'https://api.example.com/v1/chat/completions','model':'m','key_env':'NOPE_KEY'}]*8,'allow_remote':True})
        self.assertEqual(self.req('POST','/api/benchmark',{})[0],403)
    def test_a_chain_and_a_benchmark_cannot_overlap(self):
        release=threading.Event()
        real=server.benchmark.run
        def held(config,call,cancel,notify):
            release.wait(5)
            return real(config,call,cancel,notify)
        server.benchmark.run=held
        try:
            self.assertEqual(self.req('POST','/api/benchmark',{})[0],202)
            self.assertEqual(self.req('POST','/api/run',{'request':'x'})[0],409)
            self.assertEqual(self.req('POST','/api/benchmark',{})[0],409)
            self.assertEqual(self.req('POST','/api/config',DEMO)[0],409)
        finally:
            release.set()
            server.wait_idle()
            server.benchmark.run=real
    def test_cancel_without_a_benchmark_is_refused(self):
        self.assertEqual(self.req('POST','/api/benchmark/cancel',{})[0],409)
    def test_demo_quality_test_seats_no_judges_and_scores_nothing(self):
        self.assertEqual(self.req('POST','/api/quality',{})[0],202)
        server.wait_idle()
        _,state=self.req('GET','/api/quality')
        self.assertFalse(state['running'])
        self.assertEqual((state['report']['status'],state['report']['runs']),('no_judges',[]))
        self.assertEqual(state['report']['cases_hash'],state['current_hash'])
        self.assertIn('n1',state['criteria'])
    def test_remote_quality_test_needs_approval(self):
        settings.write_config({**DEMO,'slots':[{'name':'R','kind':'openai_compatible','url':'https://api.example.com/v1/chat/completions','model':'m','key_env':'NOPE_KEY'}]*8,'allow_remote':True})
        self.assertEqual(self.req('POST','/api/quality',{})[0],403)
    def test_cancel_without_a_quality_test_is_refused(self):
        self.assertEqual(self.req('POST','/api/quality/cancel',{})[0],409)

class DefaultConfigTests(unittest.TestCase):
    def test_settings_saved_before_caps_still_get_them(self):
        path=settings.config_path()
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(json.dumps(DEMO),encoding='utf-8')
        self.assertEqual((settings.read_config()['max_run_cents'],settings.read_config()['max_plan_calls']),(200,60))
        path.unlink()
    def test_env_file_loads_only_credentials_and_keeps_shell_values(self):
        path=engine.data_root()/'test.env'
        path.write_text('export TESTVAR_API_KEY="abc"\nPATH=/evil\n# NOTE_KEY=no\nEMPTY_KEY=\nSHELLWINS_KEY=file\n')
        os.environ['SHELLWINS_KEY']='shell'
        settings.load_env(path)
        self.assertEqual(os.environ.pop('TESTVAR_API_KEY'),'abc')
        self.assertNotEqual(os.environ['PATH'],'/evil')
        self.assertNotIn('NOTE_KEY',os.environ)
        self.assertEqual(os.environ.pop('SHELLWINS_KEY'),'shell')
    def test_recommended_mix_spreads_roles_and_uses_only_ready_providers(self):
        conn=[{'id':'claude_cli','ready':False},{'id':'codex_cli','ready':True},{'id':'ollama_cloud','ready':True},{'id':'github_models','ready':False}]
        cfg=settings.recommended_config(conn,['local:1'])
        kinds=[s['kind'] for s in cfg['slots']]
        self.assertNotIn('claude_cli',kinds);self.assertNotIn('github_models',kinds)
        self.assertEqual(kinds[7],'codex_cli')
        self.assertGreater(len({s['model'] for s in cfg['slots']}),4)
        self.assertTrue(cfg['allow_remote'])
        settings.clean_config(cfg)
    def test_strong_providers_take_seats_before_local_models(self):
        conn=[{'id':'codex_cli','ready':True},{'id':'ollama_cloud','ready':True}]
        cfg=settings.recommended_config(conn,[f'local:{i}' for i in range(5)])
        self.assertEqual(sum(s['model'].startswith('local') for s in cfg['slots']),0)
        self.assertFalse(any(s['model'].startswith('glm') for s in cfg['slots']))
        self.assertEqual(cfg['slots'][7]['kind'],'codex_cli')
    def test_gemini_joins_the_mix_when_its_key_is_accepted(self):
        conn=[{'id':'codex_cli','ready':True},{'id':'gemini','ready':True},{'id':'ollama_cloud','ready':True}]
        slots=settings.recommended_config(conn,['local:1'])['slots']
        self.assertIn('gemini',[s['kind'] for s in slots])
        self.assertEqual(slots[7]['kind'],'codex_cli')
        settings.clean_slot(next(s for s in slots if s['kind']=='gemini'))
    def test_xai_joins_the_mix_with_its_endpoint_and_key_name(self):
        slots=settings.recommended_config([{'id':'codex_cli','ready':True},{'id':'xai','ready':True}],[])['slots']
        slot=next(s for s in slots if s['kind']=='openai_compatible')
        self.assertEqual(settings.clean_slot(slot)['key_env'],'XAI_API_KEY')
        self.assertTrue(slot['url'].startswith('https://api.x.ai/'))
    def test_local_models_fill_gaps_when_few_strong_providers_exist(self):
        cfg=settings.recommended_config([{'id':'codex_cli','ready':True}],['local:1','local:2'])
        self.assertTrue(any(s['model'].startswith('local') for s in cfg['slots']))
    def test_recommended_falls_back_to_demo_with_nothing_ready(self):
        self.assertEqual(settings.recommended_config([],[])['source'],'demo')
    def test_membership_slot_needs_no_model(self):
        self.assertEqual(settings.clean_slot({'name':'A','kind':'codex_cli'})['kind'],'codex_cli')
    def test_tests_do_not_touch_project_config(self):
        self.assertNotEqual(settings.config_path(),engine.ROOT/'config'/'providers.json')
    def test_auto_config_uses_installed_models(self):
        cfg=settings.auto_config(['alpha:1','nomic-embed-text:latest','beta:2'])
        self.assertEqual(cfg['source'],'ollama')
        self.assertEqual({s['kind'] for s in cfg['slots']},{'ollama'})
        self.assertEqual({s['model'] for s in cfg['slots']},{'alpha:1','beta:2'})
    def test_demo_slot_keeps_no_stale_model(self):
        self.assertEqual(settings.clean_slot({'name':'A','kind':'demo','model':'real-model','url':'http://x.example'}),{'name':'A','kind':'demo','model':'fixture'})
    def test_auto_config_falls_back_to_demo(self):
        cfg=settings.auto_config([])
        self.assertEqual(cfg['source'],'demo')
        self.assertEqual({s['kind'] for s in cfg['slots']},{'demo'})

if __name__=='__main__':unittest.main()
