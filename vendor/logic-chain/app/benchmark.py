"""Scores review members against warnings whose answers are known, through the real review prompt.

A vote only shows that models agree. These cases show whether they are right. Scores are a population
estimate on this set, written by one author, and never say that any single vote is correct. Every label
must follow from its scenario text, and contested cases are listed so a wrong label can be found and fixed.
"""
import hashlib, json, math, random, threading, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from . import jev
from .engine import Cancelled, data_root, interruptible, iso, neutralize, new_id

CORPUS = Path(__file__).with_name('known_answers.json')
MIN_SAMPLES = 30
BASELINE = 2/3  # Clearing every warning scores this on the set, so a score must beat it to mean anything
MIN_FOUND = 0.9
MIN_CALIBRATED_SEATS = 3  # Below this the panel keeps uncalibrated members, or it could not reach two valid votes after author exclusion

def load_corpus():
    return json.loads(CORPUS.read_text(encoding='utf-8'))

def corpus_hash():
    """Scores carry over only while the cases and the instructions they tested stay the same."""
    return hashlib.sha256((CORPUS.read_text(encoding='utf-8')+jev.REVIEW_SYSTEM).encode('utf-8')).hexdigest()[:16]

def reports_dir():
    path = data_root()/'benchmarks'
    path.mkdir(parents=True,exist_ok=True)
    return path

def shuffled(scenario):
    """Fixed per scenario, so a model cannot learn a label from position and reruns stay comparable."""
    items = list(scenario['items'])
    random.Random(scenario['id']).shuffle(items)
    return items

def wilson(right, total, z=1.96):
    """95% interval. Unlike accuracy alone, it shows how little a small sample proves."""
    if not total: return (0.0,1.0)
    p = right/total
    denominator = 1+z*z/total
    centre = (p+z*z/(2*total))/denominator
    margin = z*math.sqrt(p*(1-p)/total+z*z/(4*total*total))/denominator
    return (round(max(0.0,centre-margin),3),round(min(1.0,centre+margin),3))

def standing(stats):
    return 'calibrated' if stats['answered']>=MIN_SAMPLES and stats['low']>BASELINE and stats['found']>=MIN_FOUND else 'uncalibrated'

def distinct_members(config):
    members = {}
    for slot in config['slots']: members.setdefault(jev.identity(slot),slot)
    return list(members.values())

def ask_member(slot, scenarios, config, call, cancel, progress):
    """One review call per scenario. A failed call abstains on its cases, and is never retried for a better answer."""
    who = jev.identity(slot)
    options = jev.call_options(config)
    votes, errors = {}, {}
    started = time.monotonic()
    for scenario in scenarios:
        if cancel and cancel.is_set(): raise Cancelled()
        items = [{'id':f'q{i}','field':c['kind'],'text':c['text'],'key':f"{scenario['id']}/{c['id']}"} for i,c in enumerate(shuffled(scenario),1)]
        prompt = jev.review_prompt(scenario['request'],items,neutralize)
        try:
            ballot = jev.parse_ballot(interruptible(lambda:call(slot,jev.REVIEW_SYSTEM,prompt,**options),cancel))
            votes.update({item['key']:ballot.get(item['id']) for item in items})
        except Cancelled:
            raise
        except Exception as exc:
            errors[scenario['id']] = f'{type(exc).__name__}: {str(exc)[-300:]}'
        progress()
    return who, slot, votes, errors, round(time.monotonic()-started,1)

def triage_right(choice, case):
    """The review acts on whether a person is needed, so settled and noise count as the same answer."""
    return choice in jev.CHOICES and jev.outcome(choice)==jev.outcome(case['label'])

def share(hits, group):
    return round(sum(hits)/len(group),3) if group else None

def score_member(slot, votes, errors, seconds, cases):
    valid = {key:choice for key,choice in votes.items() if choice in jev.CHOICES}
    right = sum(triage_right(valid.get(key),case) for key,case in cases.items())
    real = [key for key,case in cases.items() if case['label']=='decide']
    clear = [key for key in cases if key not in real]
    recall = {}
    for label in jev.CHOICES:
        wanted = [key for key,case in cases.items() if case['label']==label]
        recall[label] = round(sum(valid.get(key)==label for key in wanted)/len(wanted),3)
    # Unanswered cases count as wrong, so a member cannot raise its score by skipping hard ones.
    low, high = wilson(right,len(cases))
    stats = {'name':slot.get('name',''),'cases':len(cases),'answered':len(valid),'right':right,'accuracy':round(right/len(cases),3),'low':low,'high':high,'found':share([valid.get(key)=='decide' for key in real],real),'cleared':share([valid.get(key) in ('settled','noise') for key in clear],clear),'recall':recall,'errors':errors,'seconds':seconds}
    return {**stats,'standing':standing(stats)}

def score_panel(names, ballots, cases):
    """The review's own rule, on the review's own seats. A dismissed real issue is the costly mistake."""
    answered = right = dismissed = over_sent = 0
    for key,case in cases.items():
        result = jev.aggregate({who:ballots[who].get(key) for who in names})
        cleared = result['answer'] in ('settled','noise')
        over_sent += case['label']!='decide' and not cleared
        if result['status']!='answered': continue
        answered += 1
        right += triage_right(result['answer'],case)
        dismissed += case['label']=='decide' and cleared
    real = sum(case['label']=='decide' for case in cases.values())
    low, high = wilson(right,answered)
    return {'members':names,'cases':len(cases),'answered':answered,'coverage':round(answered/len(cases),3),'right':right,'accuracy':round(right/answered,3) if answered else None,'low':low,'high':high,'real_issues':real,'wrongly_dismissed':dismissed,'non_issues':len(cases)-real,'over_sent':over_sent}

def missed_cases(ballots, cases):
    missed = []
    for key,case in cases.items():
        wrong = {who:ballot[key] for who,ballot in ballots.items() if ballot.get(key) in jev.CHOICES and not triage_right(ballot[key],case)}
        if wrong: missed.append({'case':key,'text':case['text'],'label':case['label'],'why':case['why'],'wrong':len(wrong),'votes':wrong})
    return sorted(missed,key=lambda m:(-m['wrong'],m['case']))

def run(config, call, cancel=None, notify=None):
    members = distinct_members(config)
    if not members: raise ValueError('No providers to benchmark')
    corpus = load_corpus()
    scenarios = corpus['scenarios']
    cases = {f"{s['id']}/{c['id']}":c for s in scenarios for c in s['items']}
    report = {'id':new_id(),'created_at':iso(),'status':'running','corpus':{'hash':corpus_hash(),'version':corpus['version'],'scenarios':len(scenarios),'cases':len(cases)},
              'baseline':round(BASELINE,3),'done':0,'total':len(members)*len(scenarios),'members':{},'panel':None,'missed':[],'semantics':jev.SEMANTICS}
    lock = threading.Lock()
    def progress():
        with lock:
            report['done'] += 1
            if notify: notify(report)
    if notify: notify(report)
    with ThreadPoolExecutor(max_workers=len(members)) as pool:
        results = list(pool.map(lambda slot:ask_member(slot,scenarios,config,call,cancel,progress),members))
    ballots = {who:votes for who,_,votes,_,_ in results}
    report['members'] = {who:score_member(slot,votes,errors,seconds,cases) for who,slot,votes,errors,seconds in results}
    report['panel'] = score_panel([jev.identity(m) for m in panel(members,report)],ballots,cases)
    report['missed'] = missed_cases(ballots,cases)
    report['status'] = 'complete'
    if notify: notify(report)
    return report

def save_report(report):
    path = reports_dir()/f"{report['id']}.json"
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    tmp.replace(path)

def latest_report():
    reports = []
    for path in reports_dir().glob('*.json'):
        try:
            reports.append(json.loads(path.read_text(encoding='utf-8')))
        except (OSError,ValueError):
            continue
    return max(reports,key=lambda r:r.get('created_at',''),default=None)

def current_scores(report):
    return report.get('members',{}) if report and report.get('corpus',{}).get('hash')==corpus_hash() else {}

def panel(slots, report=None):
    """Seats go to calibrated members, best score first. With no scores, slot order stands."""
    scores = current_scores(report if report is not None else latest_report())
    measured = lambda slot:scores.get(jev.identity(slot),{})
    ranked = sorted(slots,key=lambda slot:(measured(slot).get('standing')!='calibrated',-measured(slot).get('accuracy',-1)))
    passed = [slot for slot in ranked if measured(slot).get('standing')=='calibrated']
    return (passed if len(passed)>=MIN_CALIBRATED_SEATS else ranked)[:jev.MAX_MEMBERS]

def calibrated_members(report=None):
    """Identities that passed on the current cases. A changed case or instruction clears them all."""
    report = report if report is not None else latest_report()
    if not report or report.get('corpus',{}).get('hash')!=corpus_hash(): return set()
    return {who for who,stats in report.get('members',{}).items() if stats.get('standing')=='calibrated'}
