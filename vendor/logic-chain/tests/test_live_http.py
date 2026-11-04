"""End to end over real HTTP: every REST adapter talks to a fake provider on loopback. No real keys, no internet."""
import json, os, tempfile, threading, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
os.environ['FRAYMUS_DATA_DIR']=tempfile.mkdtemp(prefix='fraymus-tests-')
from app import engine, verify
from app.providers import call_provider, demo_reply, PermanentProviderError, ProviderError

FAKE_KEYS={'FAKE_OPENAI_API_KEY':'sk-test-openai-not-real','FAKE_ANTHROPIC_API_KEY':'sk-test-anthropic-not-real','FAKE_COMPAT_API_KEY':'sk-test-compat-not-real'}

class FakeProvider(BaseHTTPRequestHandler):
    """Speaks the three wire formats the adapters use, and answers with the demo fixture so the chain has real JSON to merge."""
    seen=[]
    fail_next=[]
    def log_message(self,*args): pass
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        FakeProvider.seen.append({'path':self.path,'headers':{k.lower():v for k,v in self.headers.items()},'body':body})
        if FakeProvider.fail_next:
            code=FakeProvider.fail_next.pop(0)
            self.send_response(code);self.end_headers();self.wfile.write(b'{"error":"fake"}');return
        if self.path=='/v1/chat/completions':
            auth=self.headers.get('Authorization','')
            if auth not in ('Bearer '+FAKE_KEYS['FAKE_OPENAI_API_KEY'],'Bearer '+FAKE_KEYS['FAKE_COMPAT_API_KEY']): return self.reply({'error':'bad key'},401)
            user=body['messages'][-1]['content']
            out={'choices':[{'message':{'content':demo_reply({'name':body['model']},user)}}],'usage':{'prompt_tokens':len(user)//4,'completion_tokens':50,'total_tokens':len(user)//4+50}}
        elif self.path=='/v1/messages':
            if self.headers.get('x-api-key')!=FAKE_KEYS['FAKE_ANTHROPIC_API_KEY'] or not self.headers.get('anthropic-version'): return self.reply({'error':'bad key'},401)
            user=body['messages'][-1]['content']
            out={'content':[{'type':'text','text':demo_reply({'name':body['model']},user)}],'usage':{'input_tokens':len(user)//4,'output_tokens':60}}
        elif self.path=='/api/chat':
            user=body['messages'][-1]['content']
            out={'message':{'role':'assistant','content':demo_reply({'name':body['model']},user)},'prompt_eval_count':len(user)//4,'eval_count':70,'done_reason':'stop'}
        else:
            return self.reply({'error':'no route'},404)
        self.reply(out)
    def reply(self,data,code=200):
        blob=json.dumps(data).encode()
        self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(blob)));self.end_headers();self.wfile.write(blob)

class LiveHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd=ThreadingHTTPServer(('127.0.0.1',0),FakeProvider)
        cls.base=f'http://127.0.0.1:{cls.httpd.server_address[1]}'
        threading.Thread(target=cls.httpd.serve_forever,daemon=True).start()
        os.environ.update(FAKE_KEYS)
    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown();cls.httpd.server_close()
        for k in FAKE_KEYS: os.environ.pop(k,None)
    def setUp(self):
        FakeProvider.seen.clear();FakeProvider.fail_next.clear()
    def slots(self):
        b=self.base
        kinds=[('openai',b+'/v1/chat/completions','FAKE_OPENAI_API_KEY'),('anthropic',b+'/v1/messages','FAKE_ANTHROPIC_API_KEY'),('ollama',b+'/api/chat',None),('openai_compatible',b+'/v1/chat/completions','FAKE_COMPAT_API_KEY')]
        return [{'name':f'{k}-{i}','kind':k,'model':f'fake-{k}','url':u,**({'key_env':e} if e else {})} for i,(k,u,e) in enumerate(kinds*2)]
    def config(self,**extra):
        return {'slots':self.slots(),'passes':2,'max_elapsed_seconds':120,'timeout_seconds':5,'retries':1,'retry_delay_seconds':0,**extra}
    def test_a_full_chain_runs_over_http_through_every_adapter_and_verifies(self):
        run=engine.execute('Build a relay over real sockets',self.config())
        self.assertEqual(run['status'],'complete',[s.get('error') for s in run['stages']])
        self.assertEqual(run['mode'],'real')
        self.assertEqual(sum(s['status']=='complete' for s in run['stages']),16)
        self.assertEqual(run['review']['status'],'complete')
        self.assertEqual(run['synthesis']['status'],'complete')
        paths={s['path'] for s in FakeProvider.seen}
        self.assertEqual(paths,{'/v1/chat/completions','/v1/messages','/api/chat'})
        self.assertGreaterEqual(len(FakeProvider.seen),17)  # 16 stages and a brief, plus review votes
        result=verify.verify_run(run)
        self.assertTrue(result['ok'],result['errors'])
        self.assertGreater(run['usage']['all']['input'],0)
    def test_keys_go_only_in_headers_and_never_into_the_run(self):
        run=engine.execute('Keep keys out',self.config(review=False,synthesize=False))
        saved=(engine.runs_dir()/f"{run['id']}.json").read_text()
        for key in FAKE_KEYS.values():
            self.assertNotIn(key,saved)
            for request in FakeProvider.seen: self.assertNotIn(key,json.dumps(request['body']))
        anthropic=next(s for s in FakeProvider.seen if s['path']=='/v1/messages')
        self.assertEqual(anthropic['headers']['x-api-key'],FAKE_KEYS['FAKE_ANTHROPIC_API_KEY'])
        self.assertNotIn('authorization',next(s for s in FakeProvider.seen if s['path']=='/api/chat')['headers'])
    def test_wire_formats_match_each_provider(self):
        slots=self.slots()
        call_provider(slots[0],'SYS','STAGE_NUMBER: 1',timeout=5,max_tokens=99)
        call_provider(slots[1],'SYS','STAGE_NUMBER: 2',timeout=5,max_tokens=99)
        call_provider(slots[2],'SYS','STAGE_NUMBER: 3',timeout=5,max_tokens=99,json_mode=True,num_ctx=8192)
        openai,anthropic,ollama=(s['body'] for s in FakeProvider.seen)
        self.assertEqual([m['role'] for m in openai['messages']],['system','user'])
        self.assertEqual(openai['max_tokens'],99)
        self.assertEqual((anthropic['system'],anthropic['max_tokens'],[m['role'] for m in anthropic['messages']]),('SYS',99,['user']))
        self.assertEqual((ollama['stream'],ollama['format'],ollama['options']['num_ctx'],ollama['options']['num_predict']),(False,'json',8192,99))
    def test_a_server_error_is_retried_and_a_bad_key_is_not(self):
        FakeProvider.fail_next[:]=[503]
        with self.assertRaises(ProviderError) as caught: call_provider(self.slots()[2],'S','STAGE_NUMBER: 1',timeout=5)
        self.assertNotIsInstance(caught.exception,PermanentProviderError)
        os.environ['FAKE_OPENAI_API_KEY']='wrong'
        try:
            with self.assertRaises(PermanentProviderError): call_provider(self.slots()[0],'S','STAGE_NUMBER: 1',timeout=5)
        finally:
            os.environ['FAKE_OPENAI_API_KEY']=FAKE_KEYS['FAKE_OPENAI_API_KEY']
        FakeProvider.fail_next[:]=[503]
        run=engine.execute('Retry once',self.config(review=False,synthesize=False))
        self.assertEqual(run['stages'][0]['attempts'],2)
        self.assertEqual(run['stages'][0]['status'],'complete')
    def test_a_missing_key_for_a_remote_url_is_refused_before_any_request(self):
        with self.assertRaises(PermanentProviderError):
            call_provider({'name':'x','kind':'openai','model':'m','key_env':'NOT_SET_ANYWHERE_KEY'},'S','U',timeout=1)
        self.assertEqual(FakeProvider.seen,[])

if __name__=='__main__': unittest.main()
