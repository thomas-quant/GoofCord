# Silent reader-stall validation

## Status

The 200 ms paired-capture buffer candidate has passed a finite-queue simulation and a short hardware recording. It is **not yet a fully verified or newly packaged fix**. No additional audio playback was used for the checks below. Further audible testing requires explicit permission.

## Mechanism and silent test

The capture owner performs synchronous route enumeration. Previously measured calls took approximately 24–29 ms, while the old endpoint capture buffer reported 1,056 frames (22 ms at 48 kHz). Commit `afd7d63` requests 200 ms for paired capture; the candidate endpoint reports 9,600 frames. It still drains on capture events rather than deliberately waiting 200 ms.

The regression test in `native/wasapi-loopback/subtract-core/tests/paired_capture.rs` models a single 30 ms reader stall three seconds into a six-second stream. It queues arriving packets, discards the oldest whole packets when capacity is exceeded, and marks the first retained packet discontinuous.

| Modeled capacity per leg | Dropped frames per leg | Result |
| --- | ---: | --- |
| 1,056 frames | 480 (10 ms) | Relocks; existing no-leak checks pass |
| 9,600 frames | 0 | Output and endpoint timestamps exactly match the unstalled baseline |

All 18 paired-capture tests pass. This is a deterministic engine/queue test, **not a controlled Windows WASAPI stall injection**. Applying equal capacities to the two modeled legs is a simulation assumption. Process-loopback `GetBufferSize` observations were inconsistent and are not reliable evidence of its actual queue capacity. The buffer-overrun explanation remains plausible, not causally established by this test.

## Existing hardware evidence

Candidate binary: `dist/audio-validation/buffer-addon/wasapi-loopback.node`, built from `afd7d63` by GitHub Actions run `34724986466`.

The saved `buffer-pilot-1` recording contains 71.22 seconds of captured output. It reports one initial lock, no realignments, and no drops. The revised raw coverage audit classifies 2,958,111 frames as exact nonzero output and 460,449 as zero output, with no unmatched or unverified frames. Zero output includes genuine silence or cancellation; it does **not** mean every such frame was deliberately muted by the engine. This recording does not establish behavior across output devices or arbitrary stalls.

The audit's former quiet-tail mismatch was an alignment-selection error: an unnormalized dot product preferred a louder, incorrect segment. The corrected audit reuses the preceding offset only when **every sample matches exactly**, otherwise retaining the original search. It does not rescale, filter, or re-subtract the captured output. The original report is preserved as `buffer-pilot-1/coverage-before-tail-fix.json`.

## Interrupted test correction

The attempted 30-minute recording was stopped after the user reported disruptive noise. It is not a completed soak. Both children exited unsuccessfully and the playback manifest lacked a completion timestamp, but the parent previously ignored those conditions and emitted a successful diagnostic-recorded status.

The harness now requires successful child exits, a healthy completed self-capture lifecycle, and a completed other-player manifest before reporting success. The saved `buffer-soak-30m-1/report.json` is corrected to `INCOMPLETE`; the original is retained as `report-before-completion-fix.json`. That correction is an audit of the existing run, not a rerun.

## Remaining limits

- No controlled old/new Windows reader-stall comparison has been performed.
- Startup/relock behavior and other output devices remain unverified by these checks.
- A 200 ms buffer cannot protect against every stall.
- `dist/audio-validation/subtraction-app/GoofCord-2.2.1-win-x64.zip` contains the older subtraction binary, not this buffer candidate.
- Do not describe the interrupted recording as a pass or this candidate as a fully verified shipped fix.
