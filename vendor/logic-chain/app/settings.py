"""Provider configuration: load, auto-detect, validate, save. Stores key variable NAMES, never key values."""
from urllib.parse import urlparse
import json, os, re
from .engine import ROOT, data_root
from .providers import CLI_KINDS, OLLAMA_CLOUD_SEATS, is_remote_slot, list_ollama_models

KINDS = ('demo','ollama','claude_cli','codex_cli','github_models','openai','openai_compatible','anthropic','gemini')
ROLES = (
    ('Architect','Define the components, their boundaries and how they fit together.'),
    ('Algorithm','Specify the core procedures, their inputs, outputs and complexity.'),
    ('Data Model','Specify the data, state, schemas and how state changes over time.'),
    ('Implementation','Turn the design into concrete build steps, in order.'),
    ('Critic','Attack assumptions. Name what would fail, conflict, or is unproven.'),
    ('Test Designer','Propose specific checks that could prove this design wrong.'),
    ('Optimizer','Find waste, bottlenecks and simpler alternatives; say what to measure first.'),
    ('Integrator','Resolve loose ends and state what is still missing before this can ship.'),
)
LIMITS = {'max_run_cents':(0,1000000,200),'max_plan_calls':(0,100000,60),'timeout_seconds':(1,3600,180),'max_elapsed_seconds':(1,86400,18000),'max_output_tokens':(64,32000,1500),'retries':(0,3,1),'max_context_chars':(1000,500000,16000),'num_ctx':(512,128000,8192)}
# Only credential-looking names: a key_env of PATH or the server token would leak it to the slot's endpoint.
MIN_STRONG_SEATS = 5
KEY_ENV = re.compile(r'[A-Z][A-Z0-9_]*(_API_KEY|_KEY)')

def load_env(path=None):
    """Read KEY=VALUE from .env without overriding the shell. Only credentials and FRAYMUS_ settings."""
    path = path or ROOT/'.env'
    if not path.exists(): return
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip().removeprefix('export ')
        if line.startswith('#') or '=' not in line: continue
        name, value = (part.strip() for part in line.split('=',1))
        value = value.strip('\'"')
        if value and (KEY_ENV.fullmatch(name) or name.startswith('FRAYMUS_')): os.environ.setdefault(name,value)

def config_path():
    return data_root()/'config'/'providers.json'

def auto_config(models):
    """First-run default: installed Ollama models across the eight roles, else clearly labelled fixtures."""
    usable = [m for m in models if 'embed' not in m.lower()]
    slots = []
    for i, (name, focus) in enumerate(ROLES):
        if usable: slots.append({'name':name,'kind':'ollama','model':usable[i % len(usable)],'focus':focus})
        else: slots.append({'name':name,'kind':'demo','model':'fixture','focus':focus})
    return {'slots':slots,'passes':2,'allow_remote':False,'synthesize':True,'source':'ollama' if usable else 'demo',**{k:v[2] for k,v in LIMITS.items()}}

def recommended_config(connections, local_models):
    """Spread the eight roles across every ready provider so no vendor reviews only its own work."""
    ready = {c['id'] for c in connections if c['ready']}
    seats = []
    if 'claude_cli' in ready: seats.append(('claude_cli',''))
    if 'codex_cli' in ready: seats.append(('codex_cli',''))
    if 'gemini' in ready: seats.append(('gemini','gemini-pro-latest'))
    if 'xai' in ready: seats.append(('openai_compatible','grok-4.7'))
    cloud = list(OLLAMA_CLOUD_SEATS) if 'ollama_cloud' in ready else []
    if 'github_models' in ready: seats.append(('github_models','openai/gpt-4o-mini'))
    seats += [('ollama',m) for m in cloud]
    # Local models only fill gaps: at real ledger size the small ones echo it back instead of answering.
    if len(seats) < MIN_STRONG_SEATS: seats += [('ollama',m) for m in local_models if 'embed' not in m.lower()]
    if not seats: return auto_config([])
    seats = seats[:len(ROLES)]
    slots = []
    for i, (name, focus) in enumerate(ROLES):
        # Count back from the last role so the Integrator, which also writes the brief, gets the strongest seat.
        kind, model = seats[(i-len(ROLES)+1) % len(seats)]
        slot = {'name':name,'kind':kind,'model':model,'focus':focus}
        if kind == 'openai_compatible': slot.update(url='https://api.x.ai/v1/chat/completions',key_env='XAI_API_KEY')
        slots.append(slot)
    remote = any(is_remote_slot(s) for s in slots)
    return {**auto_config([]),'slots':slots,'allow_remote':remote,'source':'recommended','timeout_seconds':300,'max_output_tokens':16000,'max_context_chars':40000,'num_ctx':16384}

def read_config():
    path = config_path()
    config = json.loads(path.read_text(encoding='utf-8')) if path.exists() else auto_config(list_ollama_models())
    config.setdefault('source','file')
    for cap in ('max_run_cents','max_plan_calls'): config.setdefault(cap,LIMITS[cap][2])  # Settings saved before caps existed still get them
    return config

def clean_slot(slot):
    if not isinstance(slot,dict): raise ValueError('Each slot must be an object')
    kind = slot.get('kind')
    if kind not in KINDS: raise ValueError(f'Unknown provider kind: {kind}')
    name = str(slot.get('name','')).strip()[:40]
    if not name: raise ValueError('Each slot needs a name')
    model = str(slot.get('model','')).strip()[:200]
    focus = str(slot.get('focus') or '').strip()[:300]
    if kind == 'demo':
        return {'name':name,'kind':kind,'model':'fixture',**({'focus':focus} if focus else {})}
    if not model and kind not in CLI_KINDS: raise ValueError(f'{name}: model required')
    out = {'name':name,'kind':kind,'model':model}
    url = str(slot.get('url') or '').strip()
    if url:
        parsed = urlparse(url)
        if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.username:
            raise ValueError(f'{name}: URL must be plain http(s)')
        out['url'] = url
    elif kind == 'openai_compatible':
        raise ValueError(f'{name}: endpoint URL required')
    key_env = str(slot.get('key_env') or '').strip()
    if key_env:
        if not KEY_ENV.fullmatch(key_env): raise ValueError(f'{name}: key variable must look like MY_API_KEY')
        out['key_env'] = key_env
    if focus: out['focus'] = focus
    return out

def clean_config(config):
    if not isinstance(config,dict): raise ValueError('Config must be an object')
    slots = config.get('slots')
    if not isinstance(slots,list) or len(slots)!=8: raise ValueError('Exactly 8 provider slots required')
    out = {'slots':[clean_slot(s) for s in slots],'passes':2,'allow_remote':config.get('allow_remote') is True,'synthesize':config.get('synthesize',True) is not False,'review':config.get('review',True) is not False}
    for key,(low,high,default) in LIMITS.items():
        value = config.get(key,default)
        if isinstance(value,bool) or not isinstance(value,int) or not low<=value<=high:
            raise ValueError(f'{key} must be a whole number from {low} to {high}')
        out[key] = value
    return out

def write_config(config):
    clean = clean_config(config)
    path = config_path()
    path.parent.mkdir(parents=True,exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(clean,indent=2)+'\n',encoding='utf-8')
    temp.replace(path)
    return clean

def public_config(config):
    """What the browser may see: variable names and whether they are set, never values."""
    out = {k:v for k,v in config.items() if k!='slots'}
    out['slots'] = [{**s,'remote':is_remote_slot(s),'key_present':bool(os.environ.get(s.get('key_env') or ''))} for s in config['slots']]
    kinds = {s.get('kind') for s in config['slots']}
    out['mode'] = 'demo' if kinds=={'demo'} else 'remote' if any(s['remote'] for s in out['slots']) else 'local'
    return out
