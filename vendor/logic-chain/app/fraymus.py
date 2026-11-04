"""Fraymus identity and the signed, hash-chained audit trail. Pure Python, no dependencies.

The scheme is the one Fraymus v13 mail uses, so a stage record here verifies with that tool too:
- Ed25519 (RFC 8032) keys; the seed never leaves this machine.
- fx number = first 16 hex of SHA-256(public key), shown as fx-xxxx-xxxx-xxxx-xxxx.
- signed bytes = "fraymus/v13\\nmsg\\n{to_fx}\\n{payload}"; records are addressed to the signer's own fx.
- each record links to the one before: link = SHA-256(prev + "|" + payload), the first prev being 64 zeros.
A signature proves which key wrote a record and that it has not changed since. It does not prove the content is right.
"""
import hashlib
import json
import os
from pathlib import Path

GENESIS = '0'*64
SCHEME = 'fraymus-logic-chain/1'

# ---- Ed25519, RFC 8032 section 5.1, extended coordinates ----
P = 2**255-19
L = 2**252+27742317777372353535851937790883648493
D = -121665*pow(121666,P-2,P)%P
SQRT_M1 = pow(2,(P-1)//4,P)

def sha512(data):
    return hashlib.sha512(data).digest()

def sha256_hex(data):
    return hashlib.sha256(data if isinstance(data,bytes) else data.encode('utf-8')).hexdigest()

def point_add(a, b):
    x1,y1,z1,t1 = a; x2,y2,z2,t2 = b
    A = (y1-x1)*(y2-x2)%P; B = (y1+x1)*(y2+x2)%P
    C = 2*t1*t2*D%P; Dd = 2*z1*z2%P
    E,F,G,H = B-A,Dd-C,Dd+C,B+A
    return (E*F%P, G*H%P, F*G%P, E*H%P)

def scalar_mult(s, point):
    result = (0,1,1,0)
    while s:
        if s&1: result = point_add(result,point)
        point = point_add(point,point)
        s >>= 1
    return result

def point_equal(a, b):
    return (a[0]*b[2]-b[0]*a[2])%P==0 and (a[1]*b[2]-b[1]*a[2])%P==0

def recover_x(y, sign):
    if y >= P: return None
    x2 = (y*y-1)*pow(D*y*y+1,P-2,P)%P
    if x2 == 0: return None if sign else 0
    x = pow(x2,(P+3)//8,P)
    if (x*x-x2)%P: x = x*SQRT_M1%P
    if (x*x-x2)%P: return None  # not on the curve
    if (x&1) != sign: x = P-x
    return x

G_Y = 4*pow(5,P-2,P)%P
G = (recover_x(G_Y,0), G_Y, 1, recover_x(G_Y,0)*G_Y%P)

def encode_point(point):
    zinv = pow(point[2],P-2,P)
    x,y = point[0]*zinv%P, point[1]*zinv%P
    return int.to_bytes(y|((x&1)<<255),32,'little')

def decode_point(data):
    if len(data) != 32: raise ValueError('An Ed25519 point is 32 bytes')
    y = int.from_bytes(data,'little')
    sign = y>>255
    y &= (1<<255)-1
    x = recover_x(y,sign)
    if x is None: raise ValueError('Point is not on the curve')
    return (x,y,1,x*y%P)

def secret_expand(seed):
    if len(seed) != 32: raise ValueError('An Ed25519 seed is 32 bytes')
    h = sha512(seed)
    a = int.from_bytes(h[:32],'little')
    a &= (1<<254)-8
    a |= 1<<254
    return a, h[32:]

def public_key(seed):
    return encode_point(scalar_mult(secret_expand(seed)[0],G))

def sign(seed, message):
    a,prefix = secret_expand(seed)
    A = encode_point(scalar_mult(a,G))
    r = int.from_bytes(sha512(prefix+message),'little')%L
    R = encode_point(scalar_mult(r,G))
    h = int.from_bytes(sha512(R+A+message),'little')%L
    return R+int.to_bytes((r+h*a)%L,32,'little')

def verify(public, message, signature):
    """True only for a valid signature. Malformed keys and signatures are rejected, never raised."""
    try:
        if len(signature) != 64: return False
        A = decode_point(public)
        R = decode_point(signature[:32])
    except ValueError:
        return False
    s = int.from_bytes(signature[32:],'little')
    if s >= L: return False
    h = int.from_bytes(sha512(signature[:32]+public+message),'little')%L
    return point_equal(scalar_mult(s,G),point_add(R,scalar_mult(h,A)))

# ---- Fraymus v13 identity and message form ----
def fx_number(public):
    digest = sha256_hex(public)[:16]
    return 'fx-'+'-'.join(digest[i:i+4] for i in range(0,16,4))

def canonical_message(to_fx, payload, attachments=()):
    """Byte-for-byte the string fraymus_v13_real.sign_message signs."""
    text = f'fraymus/v13\nmsg\n{to_fx}\n{payload}'
    if attachments: text += '\n'+','.join(attachments)
    return text.encode('utf-8')

class Identity:
    def __init__(self, seed):
        self.seed = seed
        self.public = public_key(seed)
        self.fx = fx_number(self.public)
    def sign(self, payload):
        return sign(self.seed,canonical_message(self.fx,payload)).hex()

def identity_path():
    configured = os.environ.get('FRAYMUS_IDENTITY_FILE')
    if configured: return Path(configured).expanduser()
    from .engine import data_root
    return data_root()/'identity'/'ed25519.seed'

def load_identity(create=True):
    """The seed is 64 hex characters in a file only this user can read. A missing file gets a fresh key once."""
    path = identity_path()
    if path.exists():
        text = path.read_text(encoding='utf-8').strip()
        try:
            seed = bytes.fromhex(text)
        except ValueError:
            seed = b''
        if len(seed) != 32: raise ValueError(f'{path} must hold a 32-byte Ed25519 seed as 64 hex characters')
        return Identity(seed)
    if not create: raise FileNotFoundError(f'No identity at {path}')
    path.parent.mkdir(parents=True,exist_ok=True)
    try: os.chmod(path.parent,0o700)
    except OSError: pass
    seed = os.urandom(32)
    fd = os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w',encoding='utf-8') as f: f.write(seed.hex()+'\n')
    return Identity(seed)

# ---- the audit chain ----
def digest(value):
    """SHA-256 of canonical JSON: sorted keys, no spaces, UTF-8. Any edit to the value changes it."""
    return sha256_hex(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False))

def record_payload(run_id, index, kind, ref, body_sha256, prev):
    return f'{SCHEME}\nrun={run_id}\nrecord={index}\nkind={kind}\nref={ref}\nbody={body_sha256}\nprev={prev}'

def append(run, ident, kind, ref, body):
    """Seal one finished object onto the run. The payload names the previous link, so records cannot be reordered or dropped."""
    chain = run.setdefault('audit',{'scheme':SCHEME,'signer':ident.fx,'public':ident.public.hex(),'records':[]})
    if chain['public'] != ident.public.hex(): raise ValueError('This run was signed by a different identity')
    records = chain['records']
    prev = records[-1]['link'] if records else GENESIS
    body_sha = digest(body)
    payload = record_payload(run['id'],len(records),kind,ref,body_sha,prev)
    sig = ident.sign(payload)
    record = {'index':len(records),'kind':kind,'ref':ref,'body_sha256':body_sha,'prev':prev,'link':sha256_hex(prev+'|'+payload),'sig':sig,'sig_sha256':sha256_hex(bytes.fromhex(sig))[:16]}
    records.append(record)
    return record

def request_body(run):
    return {'request':run['request'],'created_at':run['created_at'],'config_snapshot':run.get('config_snapshot',[])}

def seal_body(run):
    """What the end of a run commits to. The summary is left out because it carries wall-clock timing."""
    return {'status':run['status'],'stop_reason':run.get('stop_reason'),'mode':run.get('mode'),'ledger_sha256':digest(run['ledger']),'dropped':run.get('dropped',{}),'review_sha256':digest(run.get('review')),'synthesis_sha256':digest(run.get('synthesis')),'stages':[s['number'] for s in run['stages']]}

def as_fraymus_message(run, record):
    """The record as a Fraymus v13 mail message, for checking with that tool."""
    chain = run['audit']
    payload = record_payload(run['id'],record['index'],record['kind'],record['ref'],record['body_sha256'],record['prev'])
    return {'from':chain['signer'],'public':chain['public'],'to':chain['signer'],'payload':payload,'sig':record['sig'],'sig_sha256':record['sig_sha256'],'attachments':[]}
