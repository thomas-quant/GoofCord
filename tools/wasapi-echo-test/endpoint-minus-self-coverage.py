#!/usr/bin/env python3
"""Memory-bounded, whole-recording arithmetic audit; never rewrites captured output.

Waveform searches select independent raw-observation frame indexes, not a fitted
canceller. Every complete output second is classified, including failed mappings,
muting and transition-spanning mismatches. Reports diagnostics, not a universal PASS.
"""
import argparse
import json
from pathlib import Path
import numpy as np
from scipy.signal import correlate
SR=48000


def find_start(needle, haystack, expected, radius):
    start=max(0, int(expected)-radius)
    end=min(len(haystack), int(expected)+radius+len(needle))
    if end-start < len(needle):
        raise ValueError("not enough raw coverage")
    dots=correlate(haystack[start:end].astype(np.float64), needle.astype(np.float64), mode='valid', method='fft')
    return start+int(np.argmax(dots))


def select_match(expected, block, prior_local=None):
    """Prefer the established mapping only when every sample matches exactly."""
    n = len(block)
    if (prior_local is not None and 0 <= prior_local <= len(expected) - n
            and np.array_equal(expected[prior_local:prior_local + n], block)):
        return prior_local
    dots = sum(correlate(expected[:, ch].astype(float), block[:, ch].astype(float),
                         mode='valid', method='fft') for ch in range(2))
    return int(np.argmax(dots))


def classify(endpoint, own, output):
    if endpoint.shape != own.shape or own.shape != output.shape:
        raise ValueError('incomplete raw coverage')
    expected=np.subtract(endpoint,own,dtype=np.float32)
    muted=np.all(output==0,axis=1)
    exact=np.all(output==expected,axis=1)&~muted
    unmatched=~(muted|exact)
    return {'frames':len(output),'mutedFrames':int(muted.sum()),'exactFrames':int(exact.sum()),
            'unmatchedFrames':int(unmatched.sum()),'maxAbsoluteError':np.max(np.abs(output.astype(float)-expected),axis=0).tolist()}


def index(path):
    return [json.loads(line) for line in path.read_text().splitlines() if 'frameStart' in json.loads(line)]


def audit(directory):
    p=Path(directory)
    def stereo(name):return np.memmap(p/name,dtype='<f4',mode='r').reshape(-1,2)
    ep=stereo('raw-endpoint.f32');rf=stereo('raw-self.f32');out=stereo('captured.f32')
    ref=np.fromfile(p/'calibration-reference-left.f32',dtype='<f4')[:SR]
    # Calibration positive control, only in the first 30 seconds. The gain/correlation
    # is recorded; no sample rescaling follows from it.
    starts={};positive={}
    for name,buf in [('endpoint',ep),('self',rf)]:
        starts[name]=find_start(ref,buf[:30*SR,0],0,30*SR)
        observed=buf[starts[name]:starts[name]+len(ref),0].astype(float)
        r=ref.astype(float);corr=float(observed@r/np.linalg.norm(observed)/np.linalg.norm(r))
        positive[name]={'frame':starts[name],'correlation':corr,'gain':float(observed@r/(r@r))}
        if corr < .5:raise ValueError('no positive self calibration evidence on '+name)
    self_offset=starts['self']-starts['endpoint']
    ei=index(p/'raw-endpoint-index.ndjson');oi=index(p/'captured-index.ndjson')
    et=np.array([x['wallClockMs'] for x in ei]);ef=np.array([x['frameStart'] for x in ei])
    ot=np.array([x['wallClockMs'] for x in oi]);of=np.array([x['frameStart'] for x in oi])
    rows=[];radius=12000;prior_offset=None
    for start in range(0,len(out),SR):
        block=out[start:min(start+SR,len(out))];n=len(block)
        if np.all(block==0):
            rows.append({'outputFrame':start,'frames':n,'mutedFrames':n,'exactFrames':0,'unmatchedFrames':0});continue
        wall=np.interp(start,of,ot);guess=round(np.interp(wall,et,ef))
        lo=max(0,-self_offset,guess-radius);hi=min(len(ep),len(rf)-self_offset,guess+radius+n)
        if hi-lo<n:
            rows.append({'outputFrame':start,'frames':n,'unverifiedFrames':n,'reason':'insufficient raw coverage'});continue
        # Build an expected *observation* for indexing only; never emit or use this as
        # replacement output. Then count exact identities against unchanged output.
        expected=np.subtract(ep[lo:hi],rf[lo+self_offset:hi+self_offset],dtype=np.float32)
        local=select_match(expected,block,None if prior_offset is None else start-prior_offset-lo);e=lo+local
        row={'outputFrame':start,'endpointFrame':e,'outputMinusEndpointFrames':start-e,
             **classify(ep[e:e+n],rf[e+self_offset:e+self_offset+n],block)}
        rows.append(row)
        if row['exactFrames'] == n:prior_offset=start-e
    totals={k:sum(r.get(k,0) for r in rows) for k in ['frames','mutedFrames','exactFrames','unmatchedFrames','unverifiedFrames']}
    stats=[json.loads(x) for x in (p/'status-log.ndjson').read_text().splitlines()]
    transitions=[];last=None
    for s in stats:
        key=(s['state'],s['generation'])
        if key!=last:transitions.append(s);last=key
    return {'verdict':'WHOLE_RECORDING_DIAGNOSTIC_NOT_PRODUCT_ACCEPTANCE','positiveControl':positive,'rawSelfOffsetFrames':self_offset,
            'totals':totals,'seconds':{k:v/SR for k,v in totals.items()},'statusTransitions':transitions,'lastStatus':stats[-1],
            'windows':rows,'limitations':['Raw self/endpoint offset is fixed from calibration; raw tap discontinuities can invalidate it. Unmatched frames are not silently discarded.',
            'All-zero output is counted separately, not called successful preservation. Timeline searches are local within 250ms of callback timestamps.',
            'Nonmatching windows include transitions, wrong mappings or genuine arithmetic errors and require investigation. No gain or fractional correction is applied.',
            'One-second identity coverage is diagnostic arithmetic, not proof of arbitrary endpoint DSP or real-call performance.']}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('directory',type=Path);args=parser.parse_args()
    result=audit(args.directory);(args.directory/'coverage.json').write_text(json.dumps(result,indent=2,allow_nan=False)+'\n')
    print(json.dumps({'totals':result['totals'],'seconds':result['seconds'],'lastStatus':result['lastStatus']},indent=2))
