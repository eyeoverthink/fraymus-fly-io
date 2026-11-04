import cmath, math, os, random, sys, unittest
sys.path.insert(0, os.path.dirname(__file__))
from container import QuantumContainer

class QuantumContainerTests(unittest.TestCase):
    def test_starts_normalized_in_the_all_zero_state(self):
        q = QuantumContainer(3)
        self.assertEqual(q.dim, 8)
        self.assertEqual(q.probabilities()[0], 1.0)
    def test_evolution_keeps_the_norm_at_one(self):
        q = QuantumContainer(4, J=1.3, h=0.7).evolve(0.1, steps=200)
        self.assertAlmostEqual(q.norm(), 1.0, places=10)
    def test_the_mock_bug_is_gone_norm_is_not_the_dimension(self):
        q = QuantumContainer(3).evolve(0.05)
        self.assertNotAlmostEqual(q.norm(), math.sqrt(q.dim))
        self.assertNotAlmostEqual(q.norm() ** 2, q.dim)
    def test_h_matters(self):
        still = QuantumContainer(2, h=0.0).evolve(0.1, steps=20)
        driven = QuantumContainer(2, h=0.8).evolve(0.1, steps=20)
        self.assertAlmostEqual(still.probabilities()[0], 1.0)
        self.assertLess(driven.probabilities()[0], 0.99)
    def test_one_qubit_matches_the_exact_rabi_formula(self):
        q = QuantumContainer(1, J=0.0, h=0.6).evolve(0.01, steps=150)
        self.assertAlmostEqual(q.probabilities()[1], math.sin(0.6 * 1.5) ** 2, places=10)
    def test_zz_alone_only_changes_phases(self):
        q = QuantumContainer(3, J=2.0, h=0.0)
        q.state = [1 / math.sqrt(8)] * 8
        q.evolve(0.3, steps=5)
        for p in q.probabilities(): self.assertAlmostEqual(p, 1 / 8)
        self.assertAlmostEqual(cmath.phase(q.state[0]), (2.0 * 1.5 * 2) % (2 * math.pi) - 2 * math.pi, places=9)
    def test_magnetization_is_bounded(self):
        q = QuantumContainer(3, h=1.0).evolve(0.1, steps=30)
        for i in range(3): self.assertTrue(-1 <= q.magnetization(i) <= 1)
    def test_measure_collapses_to_a_normalized_basis_state(self):
        q = QuantumContainer(3, h=1.0).evolve(0.1, steps=10)
        k = q.measure(random.Random(7))
        self.assertEqual(q.probabilities()[k], 1.0)
        self.assertAlmostEqual(q.norm(), 1.0)
    def test_measurement_statistics_follow_born_probabilities(self):
        base = QuantumContainer(1, J=0, h=0.6).evolve(0.01, steps=150)
        expected, rng, hits = base.probabilities()[1], random.Random(1), 0
        for _ in range(4000):
            q = QuantumContainer(1, J=0, h=0.6); q.state = list(base.state)
            hits += q.measure(rng)
        self.assertAlmostEqual(hits / 4000, expected, delta=0.03)
    def test_clone_is_refused_and_says_why(self):
        with self.assertRaisesRegex(TypeError, 'not physics'): QuantumContainer(2).clone()
    def test_size_is_bounded(self):
        with self.assertRaises(ValueError): QuantumContainer(13)

if __name__ == '__main__': unittest.main()
