"""Check a run's signed audit chain, and that its ledger is exactly what its sealed stages merge into."""
import json
from pathlib import Path
from . import fraymus
from .engine import FIELDS, empty_ledger, merge

FINISHED = ('complete','partial_failure','failed','cancelled','budget_exceeded')

def interrupted(stage):
    return str(stage.get('error','')).startswith('Interrupted')

def check_records(run, chain, errors):
    try:
        public = bytes.fromhex(chain['public'])
        fraymus.decode_point(public)
    except ValueError:
        errors.append('The signer public key is not a valid Ed25519 key'); return []
    if fraymus.fx_number(public) != chain.get('signer'):
        errors.append('The signer fx number does not match its public key')
    prev, good = fraymus.GENESIS, []
    for position,record in enumerate(chain.get('records',[])):
        where = f"record {position} ({record.get('ref','?')})"
        if record.get('index') != position: errors.append(f'{where}: out of order'); break
        if record.get('prev') != prev: errors.append(f'{where}: does not link to the record before it'); break
        payload = fraymus.record_payload(run['id'],position,record['kind'],record['ref'],record['body_sha256'],prev)
        if record.get('link') != fraymus.sha256_hex(prev+'|'+payload): errors.append(f'{where}: link hash is wrong'); break
        try:
            sig = bytes.fromhex(record.get('sig',''))
        except ValueError:
            sig = b''
        if not fraymus.verify(public,fraymus.canonical_message(chain['signer'],payload),sig): errors.append(f'{where}: signature does not verify'); break
        if record.get('sig_sha256') != fraymus.sha256_hex(sig)[:16]: errors.append(f'{where}: sig_sha256 is wrong'); break
        good.append(record); prev = record['link']
    return good

def replay(run):
    """ValidateMerge from an empty ledger over every completed stage, in order. It must land on the stored ledger."""
    ledger, dropped = empty_ledger(), {}
    for stage in sorted(run.get('stages',[]),key=lambda s:s['number']):
        if stage.get('status') == 'complete': merge(ledger,{f:stage['delta'].get(f,[]) for f in FIELDS},stage['number'],dropped)
    return ledger, dropped

def verify_run(run):
    errors, warnings = [], []
    chain = run.get('audit')
    if not chain or not chain.get('records'):
        return {'ok':False,'run':run.get('id'),'signer':None,'records':0,'errors':['This run carries no signed audit chain'],'warnings':[]}
    good = check_records(run,chain,errors)
    by_ref = {}
    for record in good:
        if record['kind'] != 'seal' and record['ref'] in by_ref: errors.append(f"{record['ref']} is sealed twice")
        by_ref[record['ref']] = record
    if not good or good[0]['ref'] != 'request': errors.append('The chain does not start with the request')
    elif good[0]['body_sha256'] != fraymus.digest(fraymus.request_body(run)): errors.append('The request or provider snapshot was changed after signing')
    first = chain.get('from_stage',1)
    if first > 1: warnings.append(f'Stages 1-{first-1} ran before signing was added and are not signed')
    for stage in run.get('stages',[]):
        ref = f"stage:{stage['number']}"
        record = by_ref.get(ref)
        if record is None:
            if stage['number'] < first: continue
            if stage.get('status') == 'running' or interrupted(stage): warnings.append(f"Stage {stage['number']} was cut off and never sealed")
            else: errors.append(f"Stage {stage['number']} is not sealed")
        elif record['body_sha256'] != fraymus.digest(stage): errors.append(f"Stage {stage['number']} was changed after it was signed")
    known = {f"stage:{s['number']}" for s in run.get('stages',[])}
    for ref in by_ref:
        if ref.startswith('stage:') and ref not in known: errors.append(f'{ref} was signed but is missing from the run')
    ledger, dropped = replay(run)
    if fraymus.digest(ledger) != fraymus.digest(run.get('ledger')): errors.append('The ledger is not what the sealed stages merge into')
    if dropped != run.get('dropped',{}): errors.append('The dropped-item counts do not match a replay of the stages')
    last = good[-1] if good else None
    if run.get('status') in FINISHED:
        if not last or last['kind'] != 'seal': errors.append('The run finished but its final seal is missing')
        elif last['body_sha256'] != fraymus.digest(fraymus.seal_body(run)): errors.append('Status, ledger, review or brief changed after the final seal')
    else:
        warnings.append(f"Run status is {run.get('status')}, so there is no final seal yet")
    return {'ok':not errors,'run':run.get('id'),'signer':chain.get('signer'),'public':chain.get('public'),'records':len(chain.get('records',[])),'head':last['link'] if last else None,'mode':run.get('mode'),'errors':errors,'warnings':warnings}

def verify_skill(folder):
    """A skill package's manifest must be unchanged since it was signed, and each file must match its listed hash."""
    folder = Path(folder)
    errors = []
    manifest = json.loads((folder/'skill.json').read_text(encoding='utf-8'))
    signature = manifest.pop('signature',None) or {}
    try:
        public = bytes.fromhex(signature.get('public',''))
        sig = bytes.fromhex(signature.get('sig',''))
    except ValueError:
        public = sig = b''
    payload = f"{fraymus.SCHEME}\nskill={manifest.get('id')}\nmanifest={fraymus.digest(manifest)}"
    if not public or fraymus.fx_number(public) != signature.get('signer'): errors.append('Signer fx number does not match its public key')
    if not fraymus.verify(public,fraymus.canonical_message(signature.get('signer',''),payload),sig): errors.append('Manifest signature does not verify')
    for name,expected in manifest.get('files',{}).items():
        path = folder/name
        if not path.is_file(): errors.append(f'{name} is missing')
        elif fraymus.sha256_hex(path.read_bytes()) != expected: errors.append(f'{name} changed after signing')
    return {'ok':not errors,'skill':manifest.get('id'),'signer':signature.get('signer'),'errors':errors}

def load(target):
    """A run id, a run file, or a skill folder."""
    from .engine import load_run
    path = Path(target)
    if path.is_dir(): return 'skill', path
    if path.is_file(): return 'run', json.loads(path.read_text(encoding='utf-8'))
    run = load_run(target)
    if run is None: raise SystemExit(f'No run, run file or skill folder called {target}')
    return 'run', run

def main(argv):
    if not argv: raise SystemExit('Usage: python3 run.py verify <run id | runs/<id>.json | skills/<folder>>')
    failed = False
    for target in argv:
        kind, value = load(target)
        result = verify_skill(value) if kind=='skill' else verify_run(value)
        print(json.dumps(result,indent=2))
        failed |= not result['ok']
    return 1 if failed else 0
