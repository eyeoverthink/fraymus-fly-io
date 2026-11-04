# Signed chain

Every run is an Ed25519-signed, hash-linked record chain in the Fraymus form. Anyone with the
run file can check it, and an edit to any stage, the ledger or the outcome is caught. Back to
the [docs index](README.md).

## Identity

* The signing key is a 32-byte Ed25519 seed stored as 64 hex characters.
* By default it lives at `FRAYMUS_DATA_DIR/identity/ed25519.seed`. It is created on first use
  with mode `0600`, in a `0700` folder, and is gitignored.
* Set `FRAYMUS_IDENTITY_FILE` to use your own Fraymus seed instead.
* The signer's number is `fx-xxxx-xxxx-xxxx-xxxx`: the first 16 hex characters of
  SHA-256(public key), as in Fraymus v13.
* Ed25519 is implemented in pure Python (`app/fraymus.py`), following RFC 8032. It reproduces
  the RFC's test vectors 1–3 exactly, and the tests cross-check it against OpenSSL through
  `cryptography` when that package is installed. It is not constant-time. It is fine for
  signing audit records on your own machine, but don't reuse it as a general crypto library.

## Records

`run.audit.records` is a list. Each record is
`{index, kind, ref, body_sha256, prev, link, sig, sig_sha256}`.

| kind | ref | body that is hashed |
| --- | --- | --- |
| `request` | `request` | objective, created time, provider snapshot |
| `stage` | `stage:N` | the whole stage entry: provider, prompt hash, raw output, delta, status, error, times |
| `seal` | `seal` | status, stop reason, mode, ledger hash, drop counts, review hash, brief hash, stage numbers |

* `body_sha256` is SHA-256 of canonical JSON: sorted keys, no spaces, UTF-8.
* The payload is:

  ```
  fraymus-logic-chain/1
  run=<id>
  record=<index>
  kind=<kind>
  ref=<ref>
  body=<body_sha256>
  prev=<previous link>
  ```

* `link` is `SHA-256(prev + "|" + payload)`. The first `prev` is 64 zeros.
* `sig` signs the Fraymus v13 canonical message `fraymus/v13\nmsg\n<signer fx>\n<payload>`, so
  each record is a self-addressed Fraymus message. `sig_sha256` is the first 16 hex characters
  of SHA-256(sig), as in v13.

A stage is sealed after it ends and before anyone is told about it. A resumed run keeps
appending to the same chain, so it gets a second seal. A run made before signing existed gets
`audit.from_stage`, and verify warns that earlier stages are unsigned.

## Verify

```bash
python3 run.py verify <run-id> [more ids, run.json paths or skill folders]
curl http://127.0.0.1:8765/api/runs/<id>/verify
```

The output is JSON: `{ok, signer, public, records, head, mode, errors, warnings}`. The exit
code is 1 if any target fails.

Verify checks:

* the fx number against the public key
* the index, prev, link, signature and sig hash of every record
* that each stage record matches its stage
* that every finished stage is sealed
* that nothing is sealed twice
* that the final seal matches the outcome

Verify also **replays `merge` over the sealed stage deltas** and compares the result with the
saved ledger and drop counts. Because of this replay, an edited ledger is caught even though the
ledger has no record of its own.

If the server stopped during a stage, that stage is not sealed and verify warns about it
without failing.

## What the signature proves, and what it doesn't

The signature proves that this run file was written by the holder of this key and has not
changed since.

It does not prove that the models actually said this. Anyone holding the key could sign
invented output. It also does not prove that any content is true. A mock run verifies just
like a real one, so check `mode` (`mock`, `mixed`, `real`).

## Skill packages

**Export** writes `skills/candidate-<id>/`, which contains:

* `skill.json`: schema 0.3. It holds the ledger contents with their source stages, an
  `execution_contract` (inputs, outputs, invariants, acceptance tests all marked
  `not_implemented`), the run's audit head, SHA-256 of each file, and a signature over the
  manifest.
* `CONTRACT.md`
* `tests/test_acceptance.py`: three integrity tests that pass, plus one skipped test for each
  proposed acceptance test, so the package honestly reports `OK (skipped=N)` until someone
  implements them.

`python3 run.py verify skills/candidate-<id>` checks the files and the signature.
`skills/candidate-<id>.json` is still written for older readers.
