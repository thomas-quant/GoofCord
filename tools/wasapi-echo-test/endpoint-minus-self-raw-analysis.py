#!/usr/bin/env python3
"""Read-only three-stream diagnostic. Requires NumPy/SciPy, not Windows.

References must be generated from schedule.json with endpoint-minus-self-signal.mjs.
No corrected output is written or substituted into the integration scorer. The
accounting identity compares actual native output with independent raw observations;
it is not a second cancellation implementation used to claim a cleaned-up PASS.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from scipy.signal import correlate, correlation_lags

SR = 48000


def locate(reference, captured, min_overlap=SR):
    reference = reference.astype(np.float64)
    captured = captured.astype(np.float64)
    dots = correlate(captured, reference, method="fft")
    lags = correlation_lags(len(captured), len(reference))
    valid = (lags >= 0) & (lags <= len(captured) - min_overlap)
    if len(reference) < min_overlap or not np.any(valid):
        raise ValueError("insufficient waveform overlap")
    candidates = np.flatnonzero(valid)
    lag = int(lags[candidates[np.argmax(np.abs(dots[valid]))]])
    n = min(len(reference), len(captured) - lag)
    r, c = reference[:n], captured[lag:lag + n]
    energy = float(r @ r)
    denom = float(np.linalg.norm(r) * np.linalg.norm(c))
    return {"lagFrames": lag, "overlapFrames": n,
            "gain": float(c @ r / energy) if energy else None,
            "correlation": float(c @ r / denom) if denom else None}


def rms(x):
    return np.sqrt(np.mean(x.astype(np.float64) ** 2, axis=0)).tolist()


def accounting_identity(endpoint, own, output):
    if endpoint.shape != own.shape or own.shape != output.shape or not output.size:
        raise ValueError("identity requires equal nonempty stereo windows")
    expected = np.subtract(endpoint, own, dtype=np.float32)
    error = output.astype(np.float64) - expected.astype(np.float64)
    return {"frames": len(output), "exactFloat32Equality": bool(np.array_equal(output, expected)),
            "mismatchedSamples": np.sum(output != expected, axis=0).tolist(),
            "maxAbsoluteError": np.max(np.abs(error), axis=0).tolist(),
            "errorRms": rms(error), "endpointRms": rms(endpoint),
            "selfRms": rms(own), "nativeOutputRms": rms(output)}


def analyze(directory):
    p = Path(directory)
    def stereo(file):
        return np.fromfile(p / file, dtype="<f4").reshape(-1, 2)
    streams = {"endpoint": stereo("raw-endpoint.f32"), "self": stereo("raw-self.f32"), "output": stereo("captured.f32")}
    references = {name: np.column_stack([np.fromfile(p / f"{name}-reference-{ch}.f32", dtype="<f4") for ch in ("left", "right")]) for name in ("calibration", "holdout", "other")}
    raw = json.loads((p / "raw-manifest.json").read_text())
    statuses = [json.loads(line) for line in (p / "status-log.ndjson").read_text().splitlines()]
    matches = {}
    for stream, names in [("endpoint", references), ("self", ["calibration", "holdout"]), ("output", ["other"])]:
        matches[stream] = {name: [locate(references[name][:, ch], streams[stream][:, ch]) for ch in range(2)] for name in names}

    # Require positive waveform evidence before using any derived timeline. Low output
    # correlation against an arbitrary own-audio lag is never evidence of cancellation.
    for stream in matches.values():
        for pair in stream.values():
            if pair[0]["lagFrames"] != pair[1]["lagFrames"] or any(m["correlation"] is None or m["correlation"] < .5 for m in pair):
                raise ValueError("cannot establish a shared stereo waveform timeline")
    onset = {name: matches[name]["calibration"][0]["lagFrames"] for name in ["endpoint", "self"]}
    output_offset = matches["output"]["other"][0]["lagFrames"] - matches["endpoint"]["other"][0]["lagFrames"]
    onset["output"] = onset["endpoint"] + output_offset

    windows = []
    # Exploratory post-lock windows, not a substitute for full-run acceptance. The
    # second window tests disjoint self content mixed with the independent other.
    for begin, end in [(3, 7), (8.25, 11.5)]:
        parts = {name: x[onset[name] + round(begin * SR):onset[name] + round(end * SR)] for name, x in streams.items()}
        expected_frames = round((end - begin) * SR)
        if any(len(x) != expected_frames for x in parts.values()):
            raise ValueError("recording does not cover requested identity window")
        windows.append({"secondsAfterSelfOnset": [begin, end], **accounting_identity(parts["endpoint"], parts["self"], parts["output"])})

    # Independent positive control: compare raw self against generated content throughout
    # both complete buffers. Does not assert all possible self processes are covered.
    self_control = {}
    for name in ["calibration", "holdout"]:
        start = matches["self"][name][0]["lagFrames"]
        measured = streams["self"][start:start + len(references[name])]
        error = measured.astype(np.float64) - references[name].astype(np.float64)
        self_control[name] = {"exactFloat32Equality": bool(np.array_equal(measured, references[name])),
                              "maxAbsoluteError": np.max(np.abs(error), axis=0).tolist(),
                              "errorRms": rms(error)}
    baseline = {}
    for name in ["endpoint", "self"]:
        if onset[name] < 3 * SR:
            raise ValueError("insufficient pre-self baseline")
        baseline[name] = {"frameRange": [SR, 3 * SR], "rms": rms(streams[name][SR:3 * SR])}
    transitions = []
    previous = None
    for s in statuses:
        state = s["state"], s["generation"]
        if state != previous:
            transitions.append(s)
            previous = state
    return {
        "verdict": "DIAGNOSTIC_ONLY_NOT_FULL_RUN_ACCEPTANCE",
        "sampleRate": SR, "rawManifest": raw, "sourceMatches": matches,
        "rawSelfPositiveControl": self_control,
        "onsetFrames": onset, "endpointToOutputOffsetFrames": output_offset,
        "preSelfBaseline": baseline, "identityWindows": windows,
        "statusTransitions": transitions, "lastStatus": statuses[-1],
        "limitations": [
            "Independent endpoint and Audio Service child sessions, not internal paired buffers or complete main-tree coverage.",
            "Alignment is inferred from raw positive controls and preserved other audio; no capture samples are changed.",
            "Identity windows are exploratory post-lock selections. Startup/muting, discontinuities and relock are not certified by them.",
            "Exact endpoint-minus-self arithmetic does not by itself exclude self-dependent endpoint DSP or prove all-device/long-run cancellation.",
            "Calibration residual energy is not an isolated-self metric when the endpoint contains unrelated audio. Original integration FAIL remains unchanged.",
            "Deterministic observations on one run, not a confidence interval or a statistical absence claim.",
        ],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    result = analyze(args.directory)
    output = args.directory / "raw-analysis.json"
    output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(json.dumps({key: result[key] for key in ["verdict", "rawSelfPositiveControl", "onsetFrames", "preSelfBaseline", "identityWindows"]}, indent=2))
    print(f"Full diagnostic: {output}")
