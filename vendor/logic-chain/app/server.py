"""Local HTTP dashboard and JSON API. No dependencies. Bind to loopback only."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
import hmac, json, os, threading, time
from . import benchmark, engine, quality, settings, verify
from .engine import ROOT, delete_run, execute, export_skill, list_runs, load_run, recover_interrupted, render_document
from .providers import OLLAMA_CLOUD_MODELS, connection_status, is_remote_slot, list_ollama_models

PORT=int(os.environ.get('FRAYMUS_PORT','8765'))
MAX_BODY=256000
STATIC={'/':('index.html','text/html; charset=utf-8'),'/app.js':('app.js','application/javascript; charset=utf-8'),'/style.css':('style.css','text/css; charset=utf-8'),'/favicon.svg':('favicon.svg','image/svg+xml')}
CSP="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'"

class Job:
    def __init__(self, rid):
        self.id=rid
        self.cancel=threading.Event()
        self.snapshot=None
        self.version=0
        self.done=False
        self.error=None

CHANGED=threading.Condition()
JOB=None
BENCH=None
QUALITY=None

def publish(job, run):
    # Serialized here, on the worker thread, so readers never see a run mid-mutation.
    blob=json.dumps(run,ensure_ascii=False)
    with CHANGED:
        job.snapshot=blob
        job.version+=1
        CHANGED.notify_all()

def worker(job, request, config, resume=None):
    try:
        execute(request,config,callback=lambda run:publish(job,run),call=engine.call_provider,cancel=job.cancel,run_id=job.id,resume=resume)
    except Exception as exc:
        print(f'Run {job.id} crashed: {type(exc).__name__}: {exc}',flush=True)
    finally:
        with CHANGED:
            job.done=True
            job.version+=1
            CHANGED.notify_all()

def busy():
    return any(job and not job.done for job in (JOB,BENCH,QUALITY))

def start_job(request, config, resume=None):
    """Claim the single run slot and start the worker, or return None if one is active."""
    global JOB
    with CHANGED:
        if busy(): return None
        job=JOB=Job(resume['id'] if resume else engine.new_id())
    threading.Thread(target=worker,args=(job,request,config,resume),daemon=True).start()
    # The first publish follows the first save, so a client can read the run as soon as it has the id.
    with CHANGED:
        CHANGED.wait_for(lambda:job.version>0,5)
    return job

def bench_worker(job, config):
    try:
        benchmark.save_report(benchmark.run(config,engine.call_provider,job.cancel,lambda report:publish(job,report)))
    except engine.Cancelled:
        pass
    except Exception as exc:
        job.error=f'{type(exc).__name__}: {str(exc)[:300]}'
        print(f'Benchmark crashed: {job.error}',flush=True)
    finally:
        with CHANGED:
            job.done=True
            job.version+=1
            CHANGED.notify_all()

def start_benchmark(config):
    """Shares the run slot's rule: one job at a time, so scores are never skewed by a chain using the same seats."""
    global BENCH
    with CHANGED:
        if busy(): return None
        job=BENCH=Job(engine.new_id())
    threading.Thread(target=bench_worker,args=(job,config),daemon=True).start()
    return job

def benchmark_state():
    with CHANGED:
        job=BENCH
        running=bool(job and not job.done)
        blob=job.snapshot if running else None
        error=job.error if job and job.done else None
    return {'running':running,'error':error,'report':json.loads(blob) if blob else None if running else benchmark.latest_report()}

def quality_worker(job, config):
    try:
        quality.save_report(quality.run(config,engine.call_provider,job.cancel,lambda report:publish(job,report)))
    except engine.Cancelled:
        pass
    except Exception as exc:
        job.error=f'{type(exc).__name__}: {str(exc)[:300]}'
        print(f'Quality test crashed: {job.error}',flush=True)
    finally:
        with CHANGED:
            job.done=True
            job.version+=1
            CHANGED.notify_all()

def start_quality(config):
    """The same single slot: a quality test reads saved runs and calls the same seats."""
    global QUALITY
    with CHANGED:
        if busy(): return None
        job=QUALITY=Job(engine.new_id())
    threading.Thread(target=quality_worker,args=(job,config),daemon=True).start()
    return job

def quality_state():
    with CHANGED:
        job=QUALITY
        running=bool(job and not job.done)
        blob=job.snapshot if running else None
        error=job.error if job and job.done else None
    return {'running':running,'error':error,'report':json.loads(blob) if blob else None if running else quality.latest_report(),'criteria':quality.criteria_text(),'current_hash':quality.cases_hash()}

def active_job():
    with CHANGED:
        return JOB if JOB and not JOB.done else None

def wait_idle(timeout=10):
    with CHANGED:
        return CHANGED.wait_for(lambda:not busy(),timeout)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        if os.environ.get('FRAYMUS_DEBUG'): super().log_message(*args)

    def respond(self, obj, status=200):
        blob=json.dumps(obj,ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(blob)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.end_headers();self.wfile.write(blob)

    def send_static(self, name, mime):
        data=(ROOT/'app'/name).read_bytes()
        self.send_response(200)
        self.send_header('Content-Type',mime)
        self.send_header('Content-Length',str(len(data)))
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Cache-Control','no-cache')
        if name=='index.html': self.send_header('Content-Security-Policy',CSP)
        self.end_headers();self.wfile.write(data)

    def authorized(self):
        token=os.getenv('FRAYMUS_SERVER_TOKEN')
        return not token or hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+token)

    def trusted(self):
        """Block DNS rebinding (foreign Host) and cross-site requests (foreign Origin)."""
        port=self.server.server_address[1]
        allowed={f'127.0.0.1:{port}',f'localhost:{port}'}
        if self.headers.get('Host') not in allowed: return False
        origin=self.headers.get('Origin')
        return not origin or origin.removeprefix('http://') in allowed

    def guard(self):
        if not self.trusted():
            self.respond({'error':'Forbidden origin'},403);return False
        if not self.authorized():
            self.respond({'error':'Unauthorized'},401);return False
        return True

    def read_body(self, required=True):
        size=int(self.headers.get('Content-Length','0'))
        if size==0:
            if required: raise ValueError('JSON body required')
            return {}
        if size<0 or size>MAX_BODY: raise ValueError('Request body too large')
        if self.headers.get_content_type()!='application/json': raise TypeError('content-type')
        body=json.loads(self.rfile.read(size))
        if not isinstance(body,dict): raise ValueError('JSON object required')
        return body

    def do_GET(self):
        p=urlparse(self.path).path
        if p in STATIC:
            if not self.trusted(): return self.respond({'error':'Forbidden origin'},403)
            return self.send_static(*STATIC[p])
        if not self.guard(): return
        parts=p.strip('/').split('/')
        try:
            if p=='/api/config':
                config=settings.public_config(settings.read_config())
                job=active_job()
                config['active_run']=job.id if job else None
                return self.respond(config)
            if p=='/api/ollama/models':
                return self.respond({'models':list_ollama_models()+list(OLLAMA_CLOUD_MODELS)})
            if p=='/api/connections':
                return self.respond(connection_status())
            if p=='/api/recommended':
                return self.respond(settings.recommended_config(connection_status(),list_ollama_models()))
            if p=='/api/runs':
                return self.respond(list_runs())
            if p=='/api/benchmark':
                return self.respond(benchmark_state())
            if p=='/api/quality':
                return self.respond(quality_state())
            if len(parts)==3 and parts[:2]==['api','runs']:
                run=load_run(parts[2]);return self.respond(run) if run else self.respond({'error':'Not found'},404)
            if len(parts)==4 and parts[:2]==['api','runs'] and parts[3]=='events':
                return self.stream(parts[2])
            if len(parts)==4 and parts[:2]==['api','runs'] and parts[3]=='verify':
                run=load_run(parts[2])
                return self.respond(verify.verify_run(run)) if run else self.respond({'error':'Not found'},404)
            if len(parts)==4 and parts[:2]==['api','runs'] and parts[3]=='document':
                run=load_run(parts[2])
                if not run: return self.respond({'error':'Not found'},404)
                data=render_document(run).encode('utf-8')
                self.send_response(200);self.send_header('Content-Type','text/markdown; charset=utf-8');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);return
            return self.respond({'error':'Not found'},404)
        except (ValueError,KeyError) as e:
            return self.respond({'error':str(e)},500)

    def stream(self, rid):
        with CHANGED:
            job=JOB if JOB and JOB.id==rid else None
        if job is None and not load_run(rid): return self.respond({'error':'Not found'},404)
        self.send_response(200)
        self.send_header('Content-Type','text/event-stream')
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.end_headers()
        try:
            seen=-1
            while job:
                with CHANGED:
                    CHANGED.wait_for(lambda:job.version!=seen,15)
                    changed,seen,blob,done=job.version!=seen,job.version,job.snapshot,job.done
                if done: break
                self.wfile.write(f'data: {blob}\n\n'.encode('utf-8') if changed and blob else b': ping\n\n')
                self.wfile.flush()
            self.wfile.write(f'data: {json.dumps(load_run(rid),ensure_ascii=False)}\n\n'.encode('utf-8'))
            self.wfile.flush()
        except (BrokenPipeError,ConnectionResetError):
            pass

    def do_POST(self):
        if not self.guard(): return
        p=urlparse(self.path).path
        parts=p.strip('/').split('/')
        try:
            if p=='/api/run':
                body=self.read_body()
                request=engine.check_request(body.get('request'))
                config=settings.read_config()
                # Consent gate: remote providers require config opt-in and explicit request confirmation.
                if any(is_remote_slot(s) for s in config['slots']) and not (config.get('allow_remote') and body.get('approve_remote') is True):
                    return self.respond({'error':'Remote providers require allow_remote=true in config AND approve_remote=true on this run'},403)
                job=start_job(request,config)
                return self.respond({'id':job.id},202) if job else self.respond({'error':'Another chain is running'},409)
            if p=='/api/config':
                if busy(): return self.respond({'error':'Settings cannot change while a job is running'},409)
                return self.respond(settings.public_config(settings.write_config(self.read_body())))
            if p=='/api/test-slot':
                return self.test_slot(self.read_body())
            if p=='/api/benchmark':
                body=self.read_body()
                config=settings.read_config()
                if any(is_remote_slot(s) for s in config['slots']) and not (config.get('allow_remote') and body.get('approve_remote') is True):
                    return self.respond({'error':'Remote providers require allow_remote=true in config AND approve_remote=true on this benchmark'},403)
                job=start_benchmark(config)
                return self.respond({'id':job.id},202) if job else self.respond({'error':'Another job is running'},409)
            if p=='/api/quality':
                body=self.read_body()
                config=settings.read_config()
                if any(is_remote_slot(s) for s in config['slots']) and not (config.get('allow_remote') and body.get('approve_remote') is True):
                    return self.respond({'error':'Remote providers require allow_remote=true in config AND approve_remote=true on this test'},403)
                job=start_quality(config)
                return self.respond({'id':job.id},202) if job else self.respond({'error':'Another job is running'},409)
            if p=='/api/quality/cancel':
                self.read_body(required=False)
                with CHANGED:
                    job=QUALITY if QUALITY and not QUALITY.done else None
                if not job: return self.respond({'error':'No quality test is running'},409)
                job.cancel.set()
                return self.respond({'id':job.id},202)
            if p=='/api/benchmark/cancel':
                self.read_body(required=False)
                with CHANGED:
                    job=BENCH if BENCH and not BENCH.done else None
                if not job: return self.respond({'error':'No benchmark is running'},409)
                job.cancel.set()
                return self.respond({'id':job.id},202)
            if len(parts)==4 and parts[:2]==['api','runs'] and parts[3]=='resume':
                body=self.read_body()
                run=load_run(parts[2])
                if not run: return self.respond({'error':'Run not found'},404)
                if run.get('status') not in engine.RESUMABLE: return self.respond({'error':'Only an interrupted or capped run can be resumed'},409)
                config=settings.read_config()
                if any(is_remote_slot(s) for s in config['slots']) and not (config.get('allow_remote') and body.get('approve_remote') is True):
                    return self.respond({'error':'Remote providers require allow_remote=true in config AND approve_remote=true on this run'},403)
                job=start_job(run['request'],config,engine.prepare_resume(run))
                return self.respond({'id':job.id},202) if job else self.respond({'error':'Another chain is running'},409)
            if len(parts)==4 and parts[:2]==['api','runs'] and parts[3]=='cancel':
                job=active_job()
                if not job or job.id!=parts[2]: return self.respond({'error':'Run is not active'},409)
                job.cancel.set()
                return self.respond({'id':job.id},202)
            if len(parts)==3 and parts[:2]==['api','export']:
                self.read_body(required=False)
                run=load_run(parts[2])
                if not run: return self.respond({'error':'Run not found'},404)
                return self.respond(export_skill(run))
            return self.respond({'error':'Not found'},404)
        except TypeError:
            return self.respond({'error':'Content-Type must be application/json'},415)
        except (ValueError,KeyError) as e:
            return self.respond({'error':str(e)},400)
        except Exception as e:
            return self.respond({'error':f'{type(e).__name__}: {e}'},500)

    def test_slot(self, body):
        slot=settings.clean_slot(body.get('slot'))
        if is_remote_slot(slot) and body.get('approve_remote') is not True:
            return self.respond({'error':'Testing a remote provider sends one billable request; approval required'},403)
        started=time.monotonic()
        try:
            items=engine.check_stage(slot,settings.read_config(),engine.call_provider)
            return self.respond({'ok':True,'seconds':round(time.monotonic()-started,2),'items':items})
        except Exception as e:
            return self.respond({'ok':False,'error':f'{type(e).__name__}: {str(e)[:300]}'})

    def do_DELETE(self):
        if not self.guard(): return
        parts=urlparse(self.path).path.strip('/').split('/')
        if len(parts)==3 and parts[:2]==['api','runs']:
            job=active_job()
            if job and job.id==parts[2]: return self.respond({'error':'Cancel the run before deleting it'},409)
            return self.respond({'deleted':parts[2]}) if delete_run(parts[2]) else self.respond({'error':'Not found'},404)
        return self.respond({'error':'Not found'},404)

def make_server(port=PORT, host=None):
    # Loopback by default. The container sets 0.0.0.0 and publishes the port on the host's loopback only.
    return ThreadingHTTPServer((host or os.environ.get('FRAYMUS_HOST','127.0.0.1'),port),Handler)

def main():
    try:
        httpd=make_server()
    except OSError as e:
        raise SystemExit(f'Cannot use port {PORT}: {e}. Is FRAYMUS already running? Set FRAYMUS_PORT to use another port.')
    recover_interrupted()
    print(f'FRAYMUS Logic Chain: http://127.0.0.1:{PORT}', flush=True)
    httpd.serve_forever()

if __name__=='__main__': main()
