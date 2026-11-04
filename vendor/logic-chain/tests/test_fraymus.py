import copy, json, os, subprocess, sys, tempfile, unittest
from pathlib import Path
os.environ['FRAYMUS_DATA_DIR']=tempfile.mkdtemp(prefix='fraymus-tests-')
from app import engine, fraymus, verify
from app.engine import execute, export_skill, prepare_resume, save_run

ROOT=Path(__file__).resolve().parent.parent

def make_config(**extra):
    return {'slots':[{'name':f'P{i}','kind':'demo','model':'fixture'} for i in range(8)],'passes':2,'max_elapsed_seconds':120,'timeout_seconds':5,'retry_delay_seconds':0,**extra}

# RFC 8032 section 7.1, tests 1-3: secret key, public key, message, signature.
RFC8032=[
    ('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60','d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a','',
     'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'),
    ('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb','3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c','72',
     '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'),
    ('c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7','fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025','af82',
     '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a'),
]

class Ed25519Tests(unittest.TestCase):
    def test_rfc8032_vectors_match_exactly(self):
        for sk,pk,msg,sig in RFC8032:
            seed=bytes.fromhex(sk)
            self.assertEqual(fraymus.public_key(seed).hex(),pk)
            self.assertEqual(fraymus.sign(seed,bytes.fromhex(msg)).hex(),sig)
            self.assertTrue(fraymus.verify(bytes.fromhex(pk),bytes.fromhex(msg),bytes.fromhex(sig)))
    def test_any_change_breaks_the_signature(self):
        sk,pk,msg,sig=RFC8032[1]
        pk,sig=bytes.fromhex(pk),bytearray(bytes.fromhex(sig))
        self.assertFalse(fraymus.verify(pk,b'\x73',bytes(sig)))
        sig[10]^=1
        self.assertFalse(fraymus.verify(pk,b'\x72',bytes(sig)))
        self.assertFalse(fraymus.verify(bytes.fromhex(RFC8032[0][1]),b'\x72',bytes.fromhex(RFC8032[1][3])))
    def test_malformed_input_is_rejected_not_raised(self):
        pk=bytes.fromhex(RFC8032[0][1]); sig=bytes.fromhex(RFC8032[0][3])
        self.assertFalse(fraymus.verify(pk,b'',sig[:63]))
        self.assertFalse(fraymus.verify(b'\x00'*31,b'',sig))
        high_s=sig[:32]+int.to_bytes(int.from_bytes(sig[32:],'little')+fraymus.L,32,'little')
        self.assertFalse(fraymus.verify(pk,b'',high_s))
    def test_points_off_the_curve_are_refused(self):
        y=2  # (y^2-1)/(d y^2+1) is not a square mod p for this y
        while fraymus.recover_x(y,0) is not None: y+=1
        with self.assertRaises(ValueError): fraymus.decode_point(int.to_bytes(y,32,'little'))
    @unittest.skipUnless(__import__('importlib').util.find_spec('cryptography'),'cryptography is not installed')
    def test_agrees_with_openssl_on_random_keys(self):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
        from cryptography.hazmat.primitives import serialization as s
        for n in range(8):
            seed,msg=os.urandom(32),os.urandom(n*17)
            key=Ed25519PrivateKey.from_private_bytes(seed)
            pub=key.public_key().public_bytes(s.Encoding.Raw,s.PublicFormat.Raw)
            self.assertEqual(fraymus.public_key(seed),pub)
            self.assertEqual(fraymus.sign(seed,msg),key.sign(msg))
            Ed25519PublicKey.from_public_bytes(pub).verify(fraymus.sign(seed,msg),msg)

class FraymusFormTests(unittest.TestCase):
    def test_fx_number_is_the_first_16_hex_of_sha256_of_the_key(self):
        pub=bytes.fromhex(RFC8032[0][1])
        fx=fraymus.fx_number(pub)
        self.assertRegex(fx,r'^fx-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$')
        self.assertEqual(fx.replace('fx-','').replace('-',''),fraymus.sha256_hex(pub)[:16])
    def test_canonical_message_is_the_v13_mail_form(self):
        self.assertEqual(fraymus.canonical_message('fx-1','hi'),b'fraymus/v13\nmsg\nfx-1\nhi')
        self.assertEqual(fraymus.canonical_message('fx-1','hi',['aa','bb']),b'fraymus/v13\nmsg\nfx-1\nhi\naa,bb')
    @unittest.skipIf(os.name=='nt','Windows has no Unix 0600 permission bits; os.chmod modes are not enforced there')
    def test_identity_file_is_mode_0600(self):
        path=Path(tempfile.mkdtemp())/'id'/'seed'
        os.environ['FRAYMUS_IDENTITY_FILE']=str(path)
        try:
            fraymus.load_identity()
            self.assertEqual(path.stat().st_mode&0o777,0o600)
        finally:
            os.environ.pop('FRAYMUS_IDENTITY_FILE',None)
    def test_identity_file_is_private_and_reused(self):
        path=Path(tempfile.mkdtemp())/'id'/'seed'
        os.environ['FRAYMUS_IDENTITY_FILE']=str(path)
        try:
            first=fraymus.load_identity()
            self.assertEqual(fraymus.load_identity().fx,first.fx)
            path.write_text('not hex')
            with self.assertRaises(ValueError): fraymus.load_identity()
        finally:
            os.environ.pop('FRAYMUS_IDENTITY_FILE')
    def test_a_record_reads_as_a_fraymus_message(self):
        run=execute('Sign me',make_config())
        message=fraymus.as_fraymus_message(run,run['audit']['records'][3])
        self.assertTrue(fraymus.verify(bytes.fromhex(message['public']),fraymus.canonical_message(message['to'],message['payload']),bytes.fromhex(message['sig'])))
        self.assertEqual(message['from'],fraymus.fx_number(bytes.fromhex(message['public'])))

class ChainAuditTests(unittest.TestCase):
    def setUp(self):
        self.run=execute('Design a signed relay',make_config())
    def broken(self, run):
        result=verify.verify_run(run)
        self.assertFalse(result['ok'])
        return ' '.join(result['errors'])
    def test_a_finished_run_verifies(self):
        result=verify.verify_run(self.run)
        self.assertTrue(result['ok'],result['errors'])
        self.assertEqual(result['records'],18)  # request + 16 stages + final seal
        self.assertEqual([r['kind'] for r in self.run['audit']['records']],['request']+['stage']*16+['seal'])
        self.assertEqual(result['signer'],fraymus.load_identity().fx)
    def test_the_chain_survives_a_save_and_reload(self):
        self.assertTrue(verify.verify_run(engine.load_run(self.run['id']))['ok'])
    def test_editing_a_stage_is_caught(self):
        run=copy.deepcopy(self.run); run['stages'][4]['raw']='edited'
        self.assertIn('Stage 5 was changed',self.broken(run))
    def test_editing_the_ledger_is_caught_by_replaying_the_merges(self):
        run=copy.deepcopy(self.run); run['ledger']['new_logic'][0]['text']='planted'
        self.assertIn('ledger is not what the sealed stages merge into',self.broken(run))
    def test_editing_a_delta_and_ledger_together_is_still_caught(self):
        run=copy.deepcopy(self.run); run['stages'][0]['delta']['new_logic']=['planted']; run['ledger']['new_logic'][0]['text']='planted'
        self.assertIn('Stage 1 was changed',self.broken(run))
    def test_removing_a_record_is_caught(self):
        run=copy.deepcopy(self.run); del run['audit']['records'][5]
        self.assertIn('out of order',self.broken(run))
    def test_a_rewritten_record_with_a_fresh_hash_but_no_key_is_caught(self):
        run=copy.deepcopy(self.run); stage=run['stages'][2]; stage['raw']='edited'
        record=run['audit']['records'][3]; record['body_sha256']=fraymus.digest(stage)
        payload=fraymus.record_payload(run['id'],3,'stage','stage:3',record['body_sha256'],record['prev'])
        record['link']=fraymus.sha256_hex(record['prev']+'|'+payload)
        self.assertIn('signature does not verify',self.broken(run))
    def test_a_different_signer_cannot_take_over_the_chain(self):
        run=copy.deepcopy(self.run); other=fraymus.Identity(os.urandom(32))
        run['audit'].update(public=other.public.hex(),signer=other.fx)
        self.assertIn('signature does not verify',self.broken(run))
    def test_changing_the_request_or_status_is_caught(self):
        run=copy.deepcopy(self.run); run['request']='something else'
        self.assertIn('request',self.broken(run))
        run=copy.deepcopy(self.run); run['status']='failed'
        self.assertIn('final seal',self.broken(run))
    def test_an_unsigned_run_does_not_verify(self):
        run=copy.deepcopy(self.run); run.pop('audit')
        self.assertIn('no signed audit chain',self.broken(run))
    def test_a_capped_run_resumes_and_the_chain_continues(self):
        def call(slot,system,prompt,**kw):return engine.call_provider({'kind':'demo'},system,prompt,**kw)
        config=make_config(slots=[{'name':f'P{i}','kind':'codex_cli','model':'x'} for i in range(8)],max_plan_calls=5,review=False,synthesize=False)
        run=execute('Resume me',config,call=call)
        self.assertEqual(run['status'],'budget_exceeded')
        self.assertTrue(verify.verify_run(run)['ok'])
        run=execute('Resume me',{**config,'max_plan_calls':0},call=call,resume=prepare_resume(run))
        result=verify.verify_run(run)
        self.assertTrue(result['ok'],result['errors'])
        self.assertEqual([r['kind'] for r in run['audit']['records']].count('seal'),2)
        self.assertEqual(result['records'],1+16+2)
    def test_a_crash_mid_stage_leaves_an_honest_unsealed_tail(self):
        seen=[]
        def callback(run):
            seen.append(copy.deepcopy(run))
        execute('Crash me',make_config(review=False,synthesize=False),callback=callback)
        crashed=next(r for r in seen if len(r['stages'])==6 and r['stages'][-1]['status']=='running')
        crashed['status']='interrupted'; crashed['stages'][-1].update(status='failed',error='Interrupted: the server stopped during this stage')
        result=verify.verify_run(crashed)
        self.assertTrue(result['ok'],result['errors'])
        self.assertTrue(any('Stage 6 was cut off' in w for w in result['warnings']))
        run=execute(crashed['request'],make_config(review=False,synthesize=False),resume=prepare_resume(crashed))
        self.assertTrue(verify.verify_run(run)['ok'])
    def test_an_unsigned_old_run_is_signed_from_where_it_resumes(self):
        run=copy.deepcopy(self.run); run.pop('audit'); run['stages']=run['stages'][:4]
        run['ledger'],run['dropped']=verify.replay(run); run['status']='interrupted'
        run=execute(run['request'],make_config(review=False,synthesize=False),resume=prepare_resume(run))
        result=verify.verify_run(run)
        self.assertTrue(result['ok'],result['errors'])
        self.assertIn('Stages 1-4 ran before signing',result['warnings'][0])

class MockLabelTests(unittest.TestCase):
    def test_a_demo_run_is_labelled_mock_everywhere(self):
        run=execute('Label me',make_config())
        self.assertEqual(run['mode'],'mock')
        self.assertIn('MOCK run',engine.render_document(run))
        self.assertEqual(export_skill(run)['mode'],'mock')
    def test_a_partly_demo_run_says_so(self):
        run={'stages':[{'kind':'demo'},{'kind':'ollama'}]}
        self.assertEqual(engine.run_mode(run),'mixed')
        self.assertEqual(engine.run_mode({'stages':[{'kind':'ollama'}]}),'real')

class SkillPackageTests(unittest.TestCase):
    def setUp(self):
        self.manifest=export_skill(execute('Package me',make_config()))
        self.folder=Path(self.manifest['package'])
    def test_package_has_contract_tests_and_a_valid_signature(self):
        for name in ('skill.json','CONTRACT.md','tests/test_acceptance.py'): self.assertTrue((self.folder/name).is_file(),name)
        self.assertEqual(self.manifest['status'],'candidate_unverified')
        self.assertIsNone(self.manifest['execution_contract']['entrypoint'])
        self.assertTrue(verify.verify_skill(self.folder)['ok'])
    def test_package_tests_run_and_report_unimplemented_tests_as_skips(self):
        done=subprocess.run([sys.executable,'-m','unittest','discover','-s','tests','-v'],cwd=self.folder,capture_output=True,text=True,timeout=60)
        self.assertEqual(done.returncode,0,done.stderr)
        proposed=len(self.manifest['execution_contract']['acceptance_tests'])
        self.assertGreater(proposed,0)
        self.assertIn(f'Ran {proposed+3} tests',done.stderr)
        self.assertIn(f'OK (skipped={proposed})',done.stderr)
    def test_package_files_are_written_with_lf_only(self):
        # Regression: on Windows, text-mode writes turned \n into \r\n and broke the signed hashes.
        files=[self.folder/'skill.json',self.folder/'CONTRACT.md',self.folder/'tests'/'test_acceptance.py']
        for path in files: self.assertNotIn(b'\r',path.read_bytes(),path.name)
        run_files=list(engine.runs_dir().glob('*.json'))
        self.assertTrue(run_files)
        for path in run_files: self.assertNotIn(b'\r',path.read_bytes(),path.name)
        self.assertTrue(verify.verify_skill(self.folder)['ok'])
    def test_editing_a_package_file_or_the_manifest_is_caught(self):
        (self.folder/'CONTRACT.md').write_text('edited')
        self.assertIn('CONTRACT.md changed after signing',verify.verify_skill(self.folder)['errors'])
        manifest=json.loads((self.folder/'skill.json').read_text()); manifest['status']='verified'
        (self.folder/'skill.json').write_text(json.dumps(manifest))
        self.assertIn('Manifest signature does not verify',verify.verify_skill(self.folder)['errors'])
    def test_model_text_cannot_inject_code_into_the_test_file(self):
        run=execute('Inject',make_config(review=False,synthesize=False))
        run['ledger']['test_cases'].append({'text':"x')\n        import os; os.system('echo pwned')  #",'stage':1,'verified':False})
        source=(Path(export_skill(run)['package'])/'tests'/'test_acceptance.py').read_text()
        compile(source,'test_acceptance.py','exec')
        self.assertNotIn("\n        import os",source)

class VerifyCommandTests(unittest.TestCase):
    def test_command_exits_zero_when_intact_and_one_when_tampered(self):
        run=execute('Command line',make_config())
        path=engine.runs_dir()/f"{run['id']}.json"
        env={**os.environ}
        good=subprocess.run([sys.executable,'run.py','verify',str(path)],cwd=ROOT,capture_output=True,text=True,env=env,timeout=60)
        self.assertEqual(good.returncode,0,good.stdout+good.stderr)
        self.assertTrue(json.loads(good.stdout)['ok'])
        run['stages'][0]['raw']='edited'; save_run(run)
        bad=subprocess.run([sys.executable,'run.py','verify',run['id']],cwd=ROOT,capture_output=True,text=True,env=env,timeout=60)
        self.assertEqual(bad.returncode,1)
        self.assertIn('Stage 1 was changed',bad.stdout)

if __name__=='__main__': unittest.main()
