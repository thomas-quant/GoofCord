import importlib.util
from pathlib import Path
import unittest
import numpy as np
spec=importlib.util.spec_from_file_location('coverage',Path(__file__).with_name('endpoint-minus-self-coverage.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class CoverageTests(unittest.TestCase):
 def test_exact_muted_and_wrong_samples_are_separate(self):
  rng=np.random.default_rng(2);e=rng.normal(size=(960,2)).astype('f4');s=rng.normal(size=(960,2)).astype('f4');o=e-s
  o[:100]=0;o[500,0]+=1
  r=m.classify(e,s,o)
  self.assertEqual(r['mutedFrames'],100);self.assertEqual(r['exactFrames'],859);self.assertEqual(r['unmatchedFrames'],1)
 def test_delay_search_finds_positive_and_negative_shift(self):
  rng=np.random.default_rng(3);x=rng.normal(size=6000).astype('f4')
  for start in [1800,2200]:self.assertEqual(m.find_start(x[start:start+1000],x,2000,400),start)
 def test_failed_mapping_is_not_silently_counted_as_verified(self):
  x=np.ones((100,2),dtype='f4');r=m.classify(x,x,np.full_like(x,.1));self.assertEqual(r['unmatchedFrames'],100)
class MatchTests(unittest.TestCase):
 def test_quiet_tail_keeps_exact_prior_mapping(self):
  quiet=(np.random.default_rng(4).normal(size=(64,2))*1e-10).astype('f4')
  expected=np.zeros((512,2),dtype='f4');expected[32:96]=quiet;expected[256:320]=quiet*100
  self.assertEqual(m.select_match(expected,quiet,32),32)
 def test_prior_mapping_does_not_hide_changed_output(self):
  quiet=(np.random.default_rng(4).normal(size=(64,2))*1e-10).astype('f4')
  expected=np.zeros((512,2),dtype='f4');expected[32:96]=quiet;expected[256:320]=quiet*100
  changed=quiet.copy();changed[10,0]+=1e-8
  start=m.select_match(expected,changed,32)
  result=m.classify(expected[start:start+len(changed)],np.zeros_like(changed),changed)
  self.assertGreater(result['unmatchedFrames'],0)
if __name__=='__main__':unittest.main()
