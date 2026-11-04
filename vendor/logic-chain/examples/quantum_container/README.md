# Quantum container: hand-written reference

**This was written by hand. It is not the output of a Logic Chain run.** It shows what a
finished skill looks like next to the `candidate-*` packages that `Export` writes, where
every acceptance test starts as `not_implemented`.

The original HTML mock had two bugs in its quantum container:

* `evolve()` set every amplitude to `exp(-iJ·dt)`. This threw the state away and left
  the norm at √dim instead of 1.
* `h` was stored but never used.

`container.py` simulates the transverse-field Ising chain
`H = -J Σ Z_i Z_{i+1} - h Σ X_i` with one first-order Trotter step per `evolve`. Both
factors are exactly unitary, so the norm stays at 1, and `h` drives the X rotation.

What this does not claim:

* It does not model hardware.
* It does not make "organisms".
* It does not enforce no-cloning. A classical program can always copy its array.
  `clone()` is refused only as an API rule.
* Trotter error is first order in `dt`.

```bash
python3 -m unittest discover -s examples/quantum_container -p 'test_*.py'
```

The main suite also runs these tests (`tests/test_examples.py`).
