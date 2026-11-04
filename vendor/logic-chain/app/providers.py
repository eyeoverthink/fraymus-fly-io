"""Small, dependency-free REST provider adapters. Keys never enter browser UI."""
import json
import os
import re
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# In a container, Ollama runs on the host: FRAYMUS_OLLAMA_URL=http://host.docker.internal:11434.
OLLAMA_BASE = os.environ.get('FRAYMUS_OLLAMA_URL','http://127.0.0.1:11434').rstrip('/')
DEFAULT_URLS = {
    'openai': 'https://api.openai.com/v1/chat/completions',
    'anthropic': 'https://api.anthropic.com/v1/messages',
    'ollama': OLLAMA_BASE+'/api/chat',
    'github_models': 'https://models.github.ai/inference/chat/completions',
}
# Extra names that are this machine, such as host.docker.internal from inside the container.
LOCAL_HOSTS = ('127.0.0.1', 'localhost', '::1', *filter(None,os.environ.get('FRAYMUS_LOCAL_HOSTS','').split(',')))
CLI_KINDS = ('claude_cli','codex_cli')
DEFAULT_KEY_ENV = {'openai':'OPENAI_API_KEY','anthropic':'ANTHROPIC_API_KEY','gemini':'GEMINI_API_KEY'}
CLOUD_TAG = re.compile(r'[:-]cloud$')
# Current Ollama Cloud names that passed a real JSON call; the daemon serves them once signed in.
OLLAMA_CLOUD_MODELS = ('deepseek-v4.1-flash:cloud','kimi-k3:cloud','glm-5.3:cloud','minimax-m3:cloud','mistral-large-4:cloud')
# GLM stays selectable, but it left the mix: on a 40k-character ledger it spent 16,000 tokens reasoning and never answered.
OLLAMA_CLOUD_SEATS = tuple(m for m in OLLAMA_CLOUD_MODELS if not m.startswith('glm-'))
LOCAL_OUTPUT_LIMIT = 4000
USER_AGENT = 'fraymus-logic-chain/1.0'
GITHUB_CATALOG = 'https://models.github.ai/catalog/models'

class Reply(str):
    """Model text that also carries what the provider reported using, so every caller can keep treating it as text."""
    usage = None

def spent(tokens_in=None, tokens_out=None, total=None):
    if tokens_in is None and tokens_out is None and total is None: return None
    if total is None: total = (tokens_in or 0)+(tokens_out or 0)
    return {'input':tokens_in or 0,'output':tokens_out or 0,'total':total}

def reply_with(text, usage):
    reply = Reply(text)
    reply.usage = usage
    return reply

def billing(slot):
    """How tokens are paid for. Ollama Cloud spends a plan's dollar credits per token, while membership CLIs use plan limits."""
    kind = slot.get('kind','demo')
    if kind == 'demo': return 'none'
    if kind in ('claude_cli','codex_cli','github_models'): return 'plan'
    if kind == 'ollama': return 'credits' if CLOUD_TAG.search(slot.get('model') or '') else 'local'
    return 'per_token' if is_remote_slot(slot) else 'local'

class ProviderError(Exception):
    """A provider call failed; worth retrying (network, timeout, 5xx, rate limit)."""
    def __init__(self, message='', usage=None):
        super().__init__(message)
        self.usage = usage

class PermanentProviderError(ProviderError):
    """Retrying cannot help (bad key, unknown model, missing configuration)."""

def chat_tokens(data):
    used = data.get('usage') or {}
    return spent(used.get('prompt_tokens'),used.get('completion_tokens'),used.get('total_tokens'))

def post_json(url, payload, headers, timeout):
    data = json.dumps(payload).encode('utf-8')
    # Ollama forwards the client's name to its cloud, whose firewall refuses Python's default with HTTP 403.
    req = Request(url, data=data, method='POST', headers={'Content-Type':'application/json', 'User-Agent':USER_AGENT, **headers})
    try:
        with urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except HTTPError as e:
        kind = ProviderError if e.code in (408, 429) or e.code >= 500 else PermanentProviderError
        raise kind(f'HTTP {e.code}: {e.read(500).decode("utf-8", "replace")}') from e
    except (URLError, TimeoutError) as e:
        raise ProviderError(str(e)) from e

def effective_url(slot):
    return slot.get('url') or DEFAULT_URLS.get(slot.get('kind'), '')

def is_local_url(url):
    try:
        return urlparse(url).hostname in LOCAL_HOSTS
    except ValueError:
        return False

def is_remote_slot(slot):
    """True when this slot would send data off this machine. Gemini's URL is model-derived and always remote."""
    kind = slot.get('kind', 'demo')
    if kind == 'demo':
        return False
    # Cloud models and membership CLIs look local to the caller, but the data leaves this machine.
    if kind in CLI_KINDS or (kind == 'ollama' and CLOUD_TAG.search(slot.get('model') or '')):
        return True
    return not is_local_url(effective_url(slot))

def list_ollama_models(url=OLLAMA_BASE+'/api/tags', timeout=1):
    """Installed local model names; empty when Ollama is not reachable."""
    try:
        with urlopen(url, timeout=timeout) as response:
            return [m['name'] for m in json.load(response).get('models', [])]
    except (URLError, TimeoutError, ValueError, KeyError, OSError):
        return []

def cli_path(name):
    """A server started outside a login shell may lack these folders on PATH."""
    found = shutil.which(name)
    if found: return found
    for folder in (Path.home()/'.local'/'bin', Path('/opt/homebrew/bin'), Path('/usr/local/bin')):
        if (folder/name).exists(): return str(folder/name)
    return None

def cli_failure(done):
    """Codex echoes the prompt to stderr. Reading only its ERROR lines keeps prompt words out of the diagnosis."""
    text = (done.stderr.strip() or done.stdout.strip())
    errors = [line for line in text.splitlines() if line.startswith('ERROR')]
    return (errors[-1] if errors else text)[-400:]

def run_cli(argv, prompt, cwd, timeout):
    """Fixed argv, no shell, prompt on stdin, in an empty folder: model output cannot reach a command line."""
    try:
        done = subprocess.run(argv, input=prompt, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise ProviderError(f'{Path(argv[0]).name} timed out after {timeout}s') from e
    except OSError as e:
        raise PermanentProviderError(f'Could not start {argv[0]}: {e}') from e
    if done.returncode:
        detail = cli_failure(done)
        if re.search(r'auth|log.?in|credential|expired', detail, re.I):
            raise PermanentProviderError(f'{Path(argv[0]).name} is not signed in: {detail}')
        raise ProviderError(f'{Path(argv[0]).name} exited {done.returncode}: {detail}')
    return done

def call_claude_cli(slot, system, user, timeout):
    """Uses the signed-in Claude membership. All tools, MCP servers and user settings are off."""
    binary = cli_path('claude')
    if not binary: raise PermanentProviderError('Claude Code is not installed')
    argv = [binary,'-p','--tools','','--strict-mcp-config','--setting-sources','','--disable-slash-commands','--no-session-persistence','--system-prompt',system]
    if slot.get('model'): argv += ['--model',slot['model']]
    with tempfile.TemporaryDirectory(prefix='fraymus-cli-') as cwd:
        return run_cli(argv, user, cwd, timeout).stdout

def codex_tokens(done):
    """Codex prints one total, and no split between prompt and reply, so input and output stay unset."""
    found = re.findall(r'tokens used\D{0,4}([\d,]+)', done.stdout+'\n'+done.stderr, re.I)
    return {'total':int(found[-1].replace(',',''))} if found else None

def call_codex_cli(slot, system, user, timeout):
    """Uses the signed-in ChatGPT plan. Shell, web search and MCP are off; the sandbox is a second layer."""
    binary = cli_path('codex')
    if not binary: raise PermanentProviderError('Codex CLI is not installed')
    with tempfile.TemporaryDirectory(prefix='fraymus-cli-') as cwd:
        out = Path(cwd)/'reply.txt'
        argv = [binary,'exec','--sandbox','read-only','--skip-git-repo-check','--ephemeral','--cd',cwd,'--color','never','-c','features.shell_tool=false','-c','features.unified_exec=false','-c','web_search=disabled','-c','mcp_servers={}','-o',str(out)]
        if slot.get('model'): argv += ['-m',slot['model']]
        done = run_cli(argv+['-'], f'{system}\n\n{user}', cwd, timeout)
        return reply_with(out.read_text(encoding='utf-8') if out.exists() else '', codex_tokens(done))

def github_token():
    token = os.environ.get('GITHUB_MODELS_KEY','')
    if token: return token
    binary = cli_path('gh')
    if not binary: return ''
    done = subprocess.run([binary,'auth','token'], capture_output=True, text=True, timeout=8)
    return done.stdout.strip() if done.returncode == 0 else ''

def call_provider(slot, system, user, timeout=90, max_tokens=1500, json_mode=False, num_ctx=None):
    kind = slot.get('kind','demo')
    if kind == 'demo':
        return reply_with(demo_reply(slot, user), spent(0,0))
    if kind == 'claude_cli':
        return call_claude_cli(slot, system, user, timeout)
    if kind == 'codex_cli':
        return call_codex_cli(slot, system, user, timeout)
    model = slot.get('model')
    if not model or model.startswith('YOUR_'):
        raise PermanentProviderError(f'{slot.get("name")}: set a real model name in provider settings')
    key = os.environ.get(slot.get('key_env') or DEFAULT_KEY_ENV.get(kind,''), '')
    url = effective_url(slot)
    if kind in ('openai','openai_compatible'):
        if not url:
            raise PermanentProviderError(f'{slot.get("name")}: endpoint URL required')
        if not key and not is_local_url(url):
            raise PermanentProviderError(f'{slot.get("name")}: missing API key')
        headers = {'Authorization':'Bearer '+key} if key else {}
        data = post_json(url, {'model':model,'messages':[{'role':'system','content':system},{'role':'user','content':user}], 'temperature':0.2,'max_tokens':max_tokens}, headers, timeout)
        return reply_with(data['choices'][0]['message']['content'] or '', chat_tokens(data))
    if kind == 'github_models':
        token = key or github_token()
        if not token: raise PermanentProviderError('Run gh auth login, or set GITHUB_MODELS_KEY')
        data = post_json(url, {'model':model,'messages':[{'role':'system','content':system},{'role':'user','content':user}],'max_tokens':max_tokens}, {'Authorization':'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28'}, timeout)
        return reply_with(data['choices'][0]['message']['content'] or '', chat_tokens(data))
    if kind == 'anthropic':
        if not key: raise PermanentProviderError('Missing Anthropic API key')
        data = post_json(url, {'model':model,'max_tokens':max_tokens,'system':system,'messages':[{'role':'user','content':user}]}, {'x-api-key':key,'anthropic-version':'2023-06-01'}, timeout)
        used = data.get('usage',{})
        return reply_with('\n'.join(x.get('text','') for x in data.get('content',[]) if x.get('type')=='text'), spent(used.get('input_tokens'),used.get('output_tokens')))
    if kind == 'gemini':
        if not key: raise PermanentProviderError('Missing Gemini API key')
        url = url or f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
        generation = {'maxOutputTokens':max_tokens,'temperature':0.2}
        if json_mode: generation['responseMimeType'] = 'application/json'
        data = post_json(url, {'systemInstruction':{'parts':[{'text':system}]},'contents':[{'role':'user','parts':[{'text':user}]}],'generationConfig':generation}, {'x-goog-api-key':key},timeout)
        text = '\n'.join(p.get('text','') for c in data.get('candidates',[]) for p in c.get('content',{}).get('parts',[]) if 'text' in p)
        meta = data.get('usageMetadata',{})
        used = spent(meta.get('promptTokenCount'),(meta.get('candidatesTokenCount') or 0)+(meta.get('thoughtsTokenCount') or 0) or None,meta.get('totalTokenCount'))
        if not text.strip():
            reason = next((c.get('finishReason') for c in data.get('candidates',[])), None) or data.get('promptFeedback',{}).get('blockReason')
            raise ProviderError(f"{model} gave no answer: stopped by {reason} after {meta.get('totalTokenCount')} tokens", used)
        return reply_with(text, used)
    if kind == 'ollama':
        # A small local model can echo the ledger back until the limit: 16,000 tokens at 18/s outlasts any timeout.
        limit = max_tokens if CLOUD_TAG.search(model) else min(max_tokens, LOCAL_OUTPUT_LIMIT)
        options = {'temperature':0.2,'num_predict':limit}
        # Ollama's default context silently truncates long prompts; ask for what the chain needs.
        if num_ctx: options['num_ctx'] = num_ctx
        payload = {'model':model,'stream':False,'messages':[{'role':'system','content':system},{'role':'user','content':user}],'options':options}
        if json_mode: payload['format'] = 'json'
        # Thinking shares the output budget: measured at 4000 tokens, it consumed all of it and left no answer.
        if CLOUD_TAG.search(model): payload['think'] = False
        data = post_json(url, payload, {}, timeout)
        message = data['message']
        used = spent(data.get('prompt_eval_count'),data.get('eval_count'))
        if not (message.get('content') or '').strip():
            raise ProviderError(f"{model} gave no answer: stopped by {data.get('done_reason')} after {data.get('eval_count')} tokens, {len(message.get('thinking') or '')} characters of thinking", used)
        return reply_with(message['content'], used)
    raise PermanentProviderError(f'Unsupported kind: {kind}')

def quiet(argv, timeout=10):
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return done.returncode, done.stdout+done.stderr
    except (OSError, subprocess.TimeoutExpired):
        return 127, ''

def check_ollama():
    models = list_ollama_models()
    if models: return True, f'{len(models)} installed models'
    return False, 'Install Ollama and pull a model, or start the Ollama app'

def check_ollama_cloud():
    try:
        name = post_json(OLLAMA_BASE+'/api/me', {}, {}, 5).get('name')
    except (ProviderError, ValueError):
        name = None
    return (True, f'Signed in as {name}') if name else (False, 'Run: ollama signin')

def check_codex():
    binary = cli_path('codex')
    if not binary: return False, 'Install Codex CLI, then run: codex login'
    code, text = quiet([binary,'login','status'])
    return (True, 'Using your ChatGPT plan') if code == 0 and 'Logged in' in text else (False, 'Run: codex login')

def check_claude():
    binary = cli_path('claude')
    if not binary: return False, 'Install Claude Code, then run: claude auth login'
    code, text = quiet([binary,'auth','status'])
    try:
        state = json.loads(text)
    except ValueError:
        state = {}
    if not state.get('loggedIn'): return False, 'Run: claude auth login'
    # The status file can outlive the session; only a real call proves it, which the Test button does.
    return True, f"Signed in ({state.get('subscriptionType') or state.get('authMethod')})"

def check_github():
    token = github_token()
    if not token: return False, 'Run: gh auth login'
    try:
        with urlopen(Request(GITHUB_CATALOG, headers={'Authorization':'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28'}), timeout=8) as response:
            catalog = json.load(response)
        if isinstance(catalog, list) and catalog: return True, f'{len(catalog)} models available'
    except (URLError, TimeoutError, ValueError, OSError):
        pass
    return False, 'Not reachable. Run: gh auth refresh -s models:read'

def key_check(name, where):
    return lambda: (True, f'{name} is set') if os.environ.get(name) else (False, f'Add {name} to .env ({where})')

def listed_key_check(name, where, url, header):
    """A set key can still be wrong, so ask the provider. Listing models costs nothing."""
    def check():
        key = os.environ.get(name)
        if not key: return False, f'Add {name} to .env ({where})'
        try:
            with urlopen(Request(url, headers=header(key)), timeout=8) as response:
                data = json.load(response)
            count = len(data.get('models') or data.get('data') or [])
            return (True, f'Key accepted, {count} models') if count else (False, 'No models returned')
        except HTTPError:
            return False, f'Key rejected. Create a new one at {where}'
        except (URLError, TimeoutError, ValueError, OSError):
            return False, 'Could not reach the provider'
    return check

CONNECTIONS = (
    ('ollama','Ollama local','local',check_ollama),
    ('ollama_cloud','Ollama Cloud','membership',check_ollama_cloud),
    ('claude_cli','Claude membership','membership',check_claude),
    ('codex_cli','ChatGPT membership','membership',check_codex),
    ('github_models','GitHub Models','membership',check_github),
    ('anthropic','Anthropic API','api key',key_check('ANTHROPIC_API_KEY','console.anthropic.com')),
    ('openai','OpenAI API','api key',key_check('OPENAI_API_KEY','platform.openai.com')),
    ('gemini','Gemini API','api key',listed_key_check('GEMINI_API_KEY','aistudio.google.com','https://generativelanguage.googleapis.com/v1beta/models?pageSize=5',lambda k:{'x-goog-api-key':k})),
    ('xai','xAI API','api key',listed_key_check('XAI_API_KEY','console.x.ai','https://api.x.ai/v1/models',lambda k:{'Authorization':'Bearer '+k})),
)

def connection_status():
    """What can be used right now, each with its own next step. Secrets are checked, never returned."""
    def probe(entry):
        key, name, access, check = entry
        ready, detail = check()
        return {'id':key,'name':name,'access':access,'ready':ready,'detail':detail}
    with ThreadPoolExecutor(len(CONNECTIONS)) as pool:
        return list(pool.map(probe, CONNECTIONS))

DEMO_STAGES = [
    ('Model "{t}" as a versioned component graph.', 'Define the components, edges and lifecycle events for "{t}".', 'Does the design for "{t}" hold if one component is replaced?'),
    ('Choose the core procedure for "{t}" before tuning it.', 'Write the step-by-step procedure for "{t}" as pseudocode.', 'Run the procedure for "{t}" on the smallest valid input.'),
    ('Give every piece of state in "{t}" one owner.', 'List the state that "{t}" stores and how it changes.', 'Replay recorded state changes for "{t}" and compare the result.'),
    ('Build the smallest working version of "{t}" first.', 'Create a minimal end-to-end path for "{t}".', 'Confirm the minimal path for "{t}" runs from a clean start.'),
    ('List what would make "{t}" fail before committing to it.', 'Record each assumption behind "{t}" as an open question.', 'Try a deliberately bad input against "{t}".'),
    ('Define what success means for "{t}" in measurable terms.', 'Write acceptance checks for "{t}".', 'Check every acceptance criterion for "{t}" independently.'),
    ('Measure "{t}" before optimizing it.', 'Capture a baseline measurement for "{t}".', 'Repeat the baseline for "{t}" and compare the variance.'),
    ('Expose "{t}" through one stable interface.', 'Package "{t}" with a versioned manifest.', 'Exercise the interface for "{t}" from a separate client.'),
]

def demo_topic(user):
    match = re.search(r'<request>\n(.*?)\n</request>', user, re.S)
    text = ' '.join(match.group(1).split()) if match else 'this objective'
    return (text[:70].rstrip() + '…') if len(text) > 70 else text

def demo_brief(topic):
    return (f'# Demo brief: {topic}\n\n> This text comes from a synthetic fixture. No AI model evaluated your objective. '
            'Connect a real provider in Providers for actual results.\n\n'
            '## Approach\nStart with the smallest working version, define measurable success, then iterate.\n\n'
            '## Next steps\n1. Connect a provider.\n2. Run the chain again.\n3. Test the proposals yourself.')

def demo_reply(slot, user):
    """Synthetic fixture that echoes the objective, never described as a real model result."""
    topic = demo_topic(user)
    if 'TASK: SYNTHESIZE' in user:
        return demo_brief(topic)
    if 'TASK: REVIEW' in user:
        return json.dumps({'votes':{q:'decide' for q in re.findall(r'"id": "(q\d+)"', user)}})
    if 'TASK: GROUP' in user:
        return json.dumps({'groups':[{'title':'Which open warnings should be resolved first?','severity':'medium','why':'Synthetic demonstration only.','items':sorted(set(re.findall(r'"id": "(q\d+)"', user)))}]})
    match = re.search(r'STAGE_NUMBER:\s*(\d+)', user)
    stage = int(match.group(1)) if match else 1
    logic, step, test = (line.format(t=topic) for line in DEMO_STAGES[(stage-1) % 8])
    delta = {'new_logic':[], 'improved_logic':[], 'contradictions':[], 'implementation_steps':[], 'test_cases':[], 'unsupported_claims':[], 'remaining_dependencies':[], 'confidence':'unverified', 'notes':'Synthetic demonstration only'}
    if stage <= 8:
        delta.update(new_logic=[logic], implementation_steps=[step], test_cases=[test])
        if stage == 5:
            delta['unsupported_claims'] = [f'Synthetic fixture: nothing about "{topic}" was evaluated by a model.']
    else:
        delta['improved_logic'] = [f'Pass 2, {slot.get("name", "slot")}: tighten this. {logic}']
        if stage == 13:
            delta['contradictions'] = [f'Speed and completeness may conflict for "{topic}"; decide which one wins.']
        if stage == 16:
            delta['remaining_dependencies'] = ['A real provider is needed before these proposals mean anything.']
    return json.dumps(delta)
