"""Calls, tokens and estimated cost per run, as providers report them, and the caps that stop a run.

Where a provider reports nothing, tokens are estimated and marked. Dollars are list prices from prices.json, so they ignore cache discounts and can go stale.
Plan limits have no dollar price, so those providers are capped by calls instead.
"""
import json, re, threading
from pathlib import Path
from .jev import identity
from .providers import billing

PRICES = json.loads(Path(__file__).with_name('prices.json').read_text(encoding='utf-8'))['models']
PRICED = ('per_token','credits')

PHASES = {'TASK: REVIEW':'review','TASK: GROUP':'grouping','TASK: SYNTHESIZE':'brief','TASK: JUDGE':'judging','TASK: TRACE':'tracing'}
ORDER = ('stages','review','grouping','brief','judging','tracing')
CHARS_PER_TOKEN = 4  # A rough rule for English text, used only when a provider reports nothing

def blank():
    return {'calls':0,'failed':0,'input':0,'output':0,'total':0,'estimated_calls':0,'usd':0.0,'unpriced_calls':0}

def rates(slot):
    """Input and output price, and whether it is known. An unknown model is assumed to cost as much as the priciest listed one, so a cap stays safe."""
    model = re.sub(r'[:-]cloud$','',slot.get('model') or '')
    if model in PRICES: return (*PRICES[model],True)
    return (max(p[0] for p in PRICES.values()),max(p[1] for p in PRICES.values()),False)

def phase_of(prompt):
    return next((phase for task,phase in PHASES.items() if prompt.startswith(task)),'stages')

def estimate(text):
    return len(text or '')//CHARS_PER_TOKEN

def counted(usage, sent, reply):
    """Returns input, output, total and whether they were estimated. The total wins: xAI bills reasoning that neither side includes."""
    if not usage or usage.get('total') is None:
        tokens_in, tokens_out = estimate(sent), estimate(reply)
        return tokens_in, tokens_out, tokens_in+tokens_out, True
    output = usage.get('output')
    if output is None: output = min(estimate(reply),usage['total'])
    return usage.get('input',usage['total']-output), output, usage['total'], False

def add(record, usage, sent, reply, failed, slot):
    record['calls'] += 1
    record['failed'] += failed
    if failed and not usage: return
    tokens_in, tokens_out, total, estimated = counted(usage,sent,reply)
    record['estimated_calls'] += estimated
    record['input'] += tokens_in
    record['output'] += tokens_out
    record['total'] += total
    if billing(slot) in PRICED:
        rate_in, rate_out, known = rates(slot)
        record['usd'] += (tokens_in*rate_in+(total-tokens_in)*rate_out)/1e6  # Reasoning outside both sides bills as output
        record['unpriced_calls'] += not known

def meter(run, call, slots, config=None):
    """Wraps a provider call. Every key exists before the first call, so a save on another thread never sees a dict change size."""
    usage = run.setdefault('usage',{'all':blank(),'phases':{},'providers':{}})
    for phase in ORDER: usage['phases'].setdefault(phase,blank())
    for slot in slots: usage['providers'].setdefault(identity(slot),{**blank(),'billing':billing(slot)})
    lock = threading.Lock()
    def metered(slot, system, prompt, **options):
        sent = system+prompt
        records = (usage['all'],usage['phases'][phase_of(prompt)],usage['providers'][identity(slot)])
        def record(spent, reply, failed):
            with lock:
                for entry in records: add(entry,spent,sent,reply,failed,slot)
        try:
            reply = call(slot,system,prompt,**options)
        except Exception as exc:  # a refused call used nothing; an empty answer can still have used its whole limit
            record(getattr(exc,'usage',None),'',True)
            raise
        record(getattr(reply,'usage',None),reply,False)
        return reply
    def over():
        """Why the run must stop, or None. Checked before each step, so calls already running can overshoot a little."""
        cents = (config or {}).get('max_run_cents',0)
        calls = (config or {}).get('max_plan_calls',0)
        if cents and usage['all']['usd']*100>=cents: return f'Cost cap of ${cents/100:.2f} reached'
        made = sum(p['calls'] for p in usage['providers'].values() if p['billing']=='plan')
        if calls and made>=calls: return f'Cap of {calls} plan calls reached'
        return None
    metered.over = over
    return metered
