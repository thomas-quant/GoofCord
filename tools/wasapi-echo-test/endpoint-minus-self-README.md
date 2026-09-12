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
`--align-timeout-seconds`, `--trim-ms`, `--max-lag-frames`, `--peak-amplitude`, `--seed-*`.

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
