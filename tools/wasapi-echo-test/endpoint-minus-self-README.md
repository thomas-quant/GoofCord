# endpoint-minus-self integration validation harness

Deterministic, real-Electron integration test for the addon's endpoint-minus-self API:

```
startEndpointMinusSelf(rootPid: number, deviceId: string | undefined | null, errorFirstBufferCallback): number
getSubtractionStatus(sessionId: number): { state: "aligning" | "running" | "failed", reason: string, offsetFrames: number, bufferedFrames: number, generation: number }
stopSession(sessionId: number): void
```

Output is expected to be 48 kHz stereo f32, 480-frame chunks (the same shape as the rest of
`wasapi-loopback`; see `src/modules/native/wasapiLoopback.ts`).

## Usage

```sh
node endpoint-minus-self-harness.mjs --out <dir> [--addon <path.node>] [--device-id <id>] [options]
```

Windows only beyond the CLI itself: the addon is a WASAPI API and only exists on `win32`. Run this
from a normal (non-root) shell so Electron's sandbox stays on; if you must run as root (e.g. a
root container) the harness detects that and adds `--no-sandbox` for you.

Key options (all have defaults — see the top of `endpoint-minus-self-harness.mjs`):
`--calibration-seconds`, `--holdout-seconds`, `--other-margin-seconds`, `--lead-in-seconds`,
`--align-timeout-seconds`, `--trim-ms`, `--max-lag-frames`, `--peak-amplitude`, `--seed-*`,
`--diagnostic-raw`.

Everything a run produces — `schedule.json`, `self-manifest.json`, `other-manifest.json`,
`captured.f32`, `captured-index.ndjson`, `status-log.ndjson`, `other-reference-{left,right}.f32`,
`report.json` — is written under `--out` and nowhere else.

## What a run actually does

1. Spawns a real Electron process (`endpoint-minus-self-other-audio.cjs`) that renders a known,
   independently seeded stereo broadband signal through Web Audio — the "other app" a correct
   subtraction must preserve.
2. Spawns a second real Electron process (`endpoint-minus-self-electron-main.cjs`), the process
   under test. It loads the real addon from `--addon`, opens a real capture session via
   `startEndpointMinusSelf(process.pid, deviceId, onChunk)`, and plays its own deterministic
   audio in two back-to-back segments:
   - **calibration** — while nothing else is playing, so a strict own-signal-only cancellation
     check is possible, and so the addon has content to align against
     (`getSubtractionStatus` is polled until `state === "running"`, with a bounded deadline —
     never assumed);
   - **hold-out** — a disjoint segment (different seeds, never played before) that overlaps with
     the other process's signal, which the harness schedules to start exactly when hold-out
     begins.
3. Captures the addon's real chunk stream and real `getSubtractionStatus()` polling stream to disk.
4. Offline, in the parent process (`endpoint-minus-self-report.mjs`), scores the raw capture
   against the known references: exact cancellation (calibration window), no leakage of the
   disjoint hold-out own-signal, no perpetual-silence false pass, preservation of the other
   process's signal, L/R cross-wiring, and offset-report stability. See
   `endpoint-minus-self-scorer.mjs` for the gate implementations and
   `endpoint-minus-self-scorer.test.mjs` / `endpoint-minus-self-report.test.mjs` for their
   synthetic-fixture unit tests.

No microphone use, no killing of pre-existing processes, no global audio/device/volume changes.
Any offline alignment/gain computed during scoring (cross-correlation lag, the scalar gain fit in
`scorePreservation`) is read-only: it is used to report a score, never fed back to alter what the
addon produced or to replace the native subtraction itself.

## Exit codes

The harness (`endpoint-minus-self-harness.mjs`) exits:
- `0` — every gate passed;
- the self process's own code (see `endpoint-minus-self-electron-main.cjs` header) when the run
  was **skipped** for an environment reason (not Windows, addon missing/incompatible, etc) — this
  is reported as `SKIPPED`, never as a pass;
- `1` — one or more gates failed, or a harness-level error occurred.

## Concurrent raw diagnostics

Add `--diagnostic-raw` and use a fresh `--out` directory. The self process records
`raw-endpoint.f32`, `raw-self.f32`, per-stream `*-index.ndjson`, `raw-stats.ndjson`,
`raw-manifest.json`, and generated self reference files alongside unchanged
`captured.f32`. No native rebuild is required. Capture errors/refusals are preserved;
only sessions created by this diagnostic are stopped.

**Windows constraint:** two INCLUDE clients targeting the same root PID were refused
on this machine. Subtraction still targets the main tree; the independent self tap
targets the identified Chromium Audio Service child. Its PID and Electron process
metrics are saved. This narrower tap is a positive control for these Web Audio
buffers, not proof of coverage of every possible GoofCord process. Failure to find
the Audio Service is an error, not permission to capture some other process.

Analyze a completed default-duration run (Python with NumPy/SciPy):

```sh
OPENBLAS_NUM_THREADS=1 python3 tools/wasapi-echo-test/endpoint-minus-self-raw-analysis.py dist/audio-validation/subtraction-raw-3
```

This writes `raw-analysis.json`, never a replacement capture or a rewritten
`report.json`. The analysis locates self in the independent raw taps and other in
the endpoint/output, then checks the arithmetic identity against the **actual native
output**. It uses fixed exploratory windows 3–7 s and 8.25–11.5 s after self onset;
these are not full-run acceptance gates. The analyzer requires positive stereo
waveform matches and enough recording coverage, and reports raw counters and all
observed state transitions.

## Concurrent hardware finding — subtraction arithmetic verified in sampled windows

Two completed captures on the default Realtek speakers endpoint:
`dist/audio-validation/subtraction-raw-2/` and `subtraction-raw-3/`.

- In **each run**, native output equals independently captured endpoint minus self
  **bit-for-bit at float32 precision** over 192,000 self-only-scheduled frames and
  156,000 mixed hold-out frames: **7.25 seconds**, both channels, zero mismatches.
  No gain, filter, or fractional correction was fitted/applied to native output.
  Run 2 established these exploratory windows; run 3 repeated them unchanged.
- Raw self matches the generated calibration and disjoint hold-out buffers with
  maximum absolute sample error **6.985e-10** (not byte-identical). Self content is
  positively identified in raw endpoint too. This is stronger evidence than low
  output correlation at an assumed timestamp.
- Other-audio output gains were **0.9993 / 1.0006** (run 2 L/R) and
  **1.0038 / 1.0076** (run 3), with correlations **0.8271 / 0.8306** and
  **0.8165 / 0.7949** respectively. These are read-only diagnostics, not corrected
  audio or confidence intervals.
- The supposedly self-only endpoint was **not quiet**: before self playback its
  RMS was **0.2724 / 0.2728** (run 2) and **0.0260 / 0.0198** (run 3), while the
  independent self tap was around **2.46e-10 RMS**. Post-lock native residual equals
  the raw endpoint content remaining after self subtraction. Thus total residual
  energy cannot be attributed to failed self cancellation in these runs.
- Both independent taps recorded zero dropped chunks, timestamp errors and callback
  errors. The paired session had startup discontinuities/timeline resets. Run 2
  also returned to aligning and re-locked after its first lock; run 3 remained
  running after its initial lock. These transitions are not hidden by the identity
  windows. Initial per-generation offset stability is not a full-session check.

**What this changes:** wrong subtraction arithmetic is ruled out in the compared
windows. The original cancellation-energy FAIL is not a valid isolated-self verdict
when unrelated endpoint content is present. This does not retroactively prove the
older `subtraction-run-2` recording (no raw taps) was correct, and its unexplained
46 Hz component has not been individually identified.

**What remains:** startup/re-lock behavior, arbitrary real call audio, device changes,
endpoint DSP, and sustained operation still need validation. An exact arithmetic
identity alone does not rule out self-dependent endpoint processing. The existing
ZIP remains experimental; no product/native code was changed in this diagnostic.
Original reports remain FAIL, rather than being relabeled as whole-feature PASS.

## Earlier hardware validation status — timing investigation

`dist/audio-validation/subtraction-run-2/report.json` remains an overall **FAIL**. The
experimental ZIP in `dist/audio-validation/subtraction-app/` is not certified by the
synthetic unit tests below or by this investigation.

Offline investigation of the unchanged run-2 recording found:

- The independent other-audio waveform begins at capture frame **563,776** in both
  channels. Wall-clock windowing implies frame **559,728**, a difference of **4,048
  frames / 84.33 ms** at 48 kHz. The report's ±480-frame search cannot reach that
  reference alignment. The 250 ms trim guards segment boundaries; it does not align
  the reference samples inside those boundaries.
- With the reference indexed to that observed onset, the original 168,000-frame
  hold-out capture window gives diagnostic other-audio gains **0.9993 L / 1.0023 R**
  and correlations **0.9541 L / 0.9656 R**, within the existing preservation bounds.
  Only the reference indexing changes; the captured output is not corrected,
  rescaled, or re-subtracted. This explains the original preservation failure, not
  the cancellation failure, and is not a new full-run PASS.
- The calibration-window residual remains **−11.05 dB L / −12.98 dB R** relative to
  the generated self reference, versus the existing **−45 dB** gate. Its spectrum
  has prominent energy around 46 Hz. Without a raw endpoint/self baseline this
  cannot be attributed to self leakage versus unrelated endpoint content.
- The original low-correlation leakage/cross-wiring passes do **not** certify self
  removal: self playback needs an independently validated capture timeline and
  positive evidence it reached the selected endpoint. The observed other-audio
  offset must not simply be assumed to be the self-audio offset.

A separate scorer arithmetic bug has been fixed: preservation gain now uses the
same valid sample overlap as its correlation search for either lag sign and unequal
buffer lengths. Four regression cases cover it; two failed before the fix. This
repairs the measuring code, not the native subtraction implementation.

The concurrent raw tests above now provide that evidence for two **new** recordings,
not retroactively for this older recording. No thresholds have been relaxed; the
original report and capture remain unchanged.

## Known limitations (read before trusting a PASS or a FAIL)

- **Digital source vs render-device conversion.** The own/other signals are generated digitally in
  Web Audio. They only become a WASAPI-loopback-observable signal after passing through the OS
  render/mix/device pipeline (resampling, mixing, endpoint effects, possible enhancements).
  Scoring therefore uses correlation and gain bounds, never byte-exact equality against the
  digital source — see the design rationale in `DETERMINISTIC-SUBTRACTION-DESIGN.md`.
- **Not a substitute for a genuine live/real-device/real-app test.** This validates the addon
  against synthetic Electron-rendered content on whatever output device Electron and the addon
  each resolve as default (or the given `--device-id`, best-effort — Chromium's Web Audio device
  IDs and WASAPI endpoint IDs are different ID spaces, and this harness does not attempt to
  reconcile them). It says nothing about arbitrary third-party applications, every physical
  device/driver/enhancement combination, or long-running clock drift (see
  `DETERMINISTIC-SUBTRACTION-DESIGN.md` and `drift-test.mjs` for that separate question).
- **Deterministic DSP criteria, not statistical claims.** Every gate is a fixed threshold chosen
  ahead of time (a dB residual ceiling, a normalized-correlation ceiling/floor, a frame-jitter
  ceiling) evaluated once per run. This is not a significance test over repeated trials, and a
  single PASS is not a confidence interval.
- **No arbitrary subtraction gain fitting.** Any gain the scorer reports (e.g.
  `scorePreservation`'s estimated linear gain) is a read-only diagnostic of how faithfully a
  signal survived the render/capture pipeline. It is never fitted and applied back to the captured
  data before a pass/fail gate is evaluated — the addon's actual output is scored as-is.
- **Windowing precision is coarse (tens of ms), not sample-exact.** Segment boundaries are found by
  interpolating wall-clock timestamps recorded at packet arrival, then trimmed inward by
  `--trim-ms` (default 250 ms) on both sides. This is intentionally generous; it is not a claim
  about the addon's own alignment precision, which `offset-stability` and `status-log.ndjson`
  speak to separately.
- **Assumes a gap-free capture for windowing.** If `self-manifest.json`'s `packets.gaps` is
  nonzero (a chunk wasn't the expected 480 frames), the report notes it as a limitation on that
  run; windowing does not reconstruct dropped-frame silence, so treat that run's boundaries as
  approximate.
- **Two Electron processes on one machine is not "two arbitrary applications."** Both legs run the
  same Electron/Chromium build; a real third-party app's audio stack may behave differently.
