"""Quantum container: a small, honest state-vector simulator.

HAND-WRITTEN reference implementation. It was not produced by a Logic Chain run.
It replaces the mock's evolve(), which set every amplitude to exp(-iJdt), threw the
state away, made the norm equal the dimension, and never used the stored field h.

Model: transverse-field Ising chain on n qubits (open boundary)
    H = -J * sum_i Z_i Z_{i+1}  -  h * sum_i X_i
evolve(dt) applies one first-order Trotter step exp(-i dt H_ZZ) . exp(-i dt H_X).
Both factors are exactly unitary, so the norm stays 1 to rounding error.

Not claimed: that this models any physical device, "organisms", or enforces
no-cloning. No-cloning is a theorem about quantum mechanics; a classical program
can copy its own array at will. clone() is refused here only as an API rule.
"""
import cmath, math

class QuantumContainer:
    def __init__(self, qubits=3, J=1.0, h=0.5):
        if not 1 <= qubits <= 12: raise ValueError('qubits must be between 1 and 12')
        self.n, self.J, self.h = qubits, float(J), float(h)
        self.state = [0j] * (2 ** qubits)
        self.state[0] = 1 + 0j
        self.time = 0.0

    @property
    def dim(self): return len(self.state)

    def norm(self): return math.sqrt(sum(abs(a) ** 2 for a in self.state))

    def bit(self, index, qubit): return (index >> qubit) & 1

    def apply_zz(self, dt):
        """Diagonal in the computational basis: phase exp(+i J dt * sum z_i z_{i+1})."""
        for k in range(self.dim):
            s = sum((1 - 2 * self.bit(k, q)) * (1 - 2 * self.bit(k, q + 1)) for q in range(self.n - 1))
            self.state[k] *= cmath.exp(1j * self.J * dt * s)

    def apply_x(self, dt):
        """exp(+i h dt X) on every qubit: [[cos, i sin], [i sin, cos]]."""
        c, s = math.cos(self.h * dt), 1j * math.sin(self.h * dt)
        for q in range(self.n):
            step = 1 << q
            for k in range(self.dim):
                if k & step: continue
                a, b = self.state[k], self.state[k | step]
                self.state[k], self.state[k | step] = c * a + s * b, s * a + c * b

    def evolve(self, dt=0.05, steps=1):
        for _ in range(steps):
            self.apply_x(dt)
            self.apply_zz(dt)
            self.time += dt
        return self

    def probabilities(self): return [abs(a) ** 2 for a in self.state]

    def magnetization(self, qubit):
        """<Z_qubit>, between -1 and 1."""
        return sum(p * (1 - 2 * self.bit(k, qubit)) for k, p in enumerate(self.probabilities()))

    def measure(self, rng):
        """Sample a basis state with Born probabilities and collapse to it."""
        r, total = rng.random(), 0.0
        for k, p in enumerate(self.probabilities()):
            total += p
            if r < total: break
        self.state = [0j] * self.dim
        self.state[k] = 1 + 0j
        return k

    def clone(self):
        raise TypeError('clone() is refused by this API. This is a design rule, not physics enforced by a classical program.')
