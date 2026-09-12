"""Offline analyzer tests; these cannot verify a Windows capture."""
import importlib.util
from pathlib import Path
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location("raw_analysis", Path(__file__).with_name("endpoint-minus-self-raw-analysis.py"))
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)


class RawAnalysisTests(unittest.TestCase):
    def test_locates_delayed_reference_without_modifying_capture(self):
        reference = np.random.default_rng(51).normal(size=2000).astype(np.float32)
        captured = np.pad(reference, (123, 200))
        before = captured.copy()
        result = analysis.locate(reference, captured, min_overlap=1500)
        self.assertEqual(result["lagFrames"], 123)
        self.assertAlmostEqual(result["gain"], 1)
        self.assertGreater(result["correlation"], .9999)
        np.testing.assert_array_equal(captured, before)

    def test_identity_checks_native_output_not_an_offline_replacement(self):
        rng = np.random.default_rng(10)
        own = rng.normal(size=(2000, 2)).astype(np.float32)
        endpoint = (own + rng.normal(size=(2000, 2))).astype(np.float32)
        output = endpoint - own
        result = analysis.accounting_identity(endpoint, own, output)
        self.assertEqual(result["mismatchedSamples"], [0, 0])
        self.assertTrue(result["exactFloat32Equality"])
        output[800, 1] += .1
        result = analysis.accounting_identity(endpoint, own, output)
        self.assertEqual(result["mismatchedSamples"], [0, 1])
        self.assertFalse(result["exactFloat32Equality"])

    def test_rejects_incomplete_identity_windows(self):
        x = np.ones((10, 2), dtype=np.float32)
        with self.assertRaises(ValueError):
            analysis.accounting_identity(x, x[:9], x)


if __name__ == "__main__":
    unittest.main()
