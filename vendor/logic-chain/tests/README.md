# tests

Back to the [README](../README.md).

```bash
python3 -m unittest discover -s tests
```

Tests use a temporary folder, fake or demo providers, and no internet (`test_live_http.py` serves a fake provider on loopback), so they never touch your runs or settings and make no real model calls.

| File | Covers |
| --- | --- |
| `test_engine.py` | Parsing, merge, context limits, provider adapters, usage, saved runs, resume |
| `test_jev.py` | Vote rules, batches, seats, grouping, the brief's decisions |
| `test_benchmark.py` | Scoring, calibration and the review panel |
| `test_quality.py` | Quote checks, verdict rules, judge calibration, ledger scoring |
| `test_claims.py` | Claim splitting, retrieval, citation checks, planted fakes, new terms |
| `test_server.py` | HTTP routes, security checks and the consent gate |
| `test_fraymus.py` | Ed25519 against RFC 8032, fx numbers, the signed chain, tamper detection, MOCK labels, skill packages, the verify command |
| `test_live_http.py` | OpenAI, compatible, Anthropic and Ollama adapters over real HTTP against a fake provider: wire formats, headers, retries, keys kept out of runs |
| `test_examples.py` | Runs the tests inside `examples/` |
