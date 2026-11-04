"""Runs the hand-written example packages inside the main suite."""
import pathlib, unittest
ROOT=pathlib.Path(__file__).resolve().parent.parent/'examples'
def load_tests(loader,tests,pattern):
    suite=unittest.TestSuite()
    for folder in sorted(p for p in ROOT.iterdir() if p.is_dir()):
        suite.addTests(loader.discover(str(folder),pattern='test_*.py',top_level_dir=str(folder)))
    return suite
