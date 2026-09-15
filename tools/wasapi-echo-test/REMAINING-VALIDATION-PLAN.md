# Remaining subtraction validation

## Boundaries

No further audible playback tests without explicit user approval. The interrupted
30-minute run is not a completed soak test and must not be reported as one. A
30-minute run is not a prerequisite for investigating this scheduling mechanism.
Do not change system volume, default output devices, or capture microphone audio.

## Completed silent checks

- A finite-queue simulation introduces a 30 ms reader stall at 3 seconds. With a
  modeled 1,056-frame queue at 48 kHz, it drops 480 frames from each leg. With a
  9,600-frame queue, it drops none and the subtraction output is bit-for-bit equal
  to the unstalled baseline. This models a mechanism; it does not exercise WASAPI.
- All 18 paired-capture Rust tests pass, including the new stall regression.
- Harness completion validation rejects non-clean child exits, stale self
  lifecycle manifests, and missing other-player completion. An interrupted run
  can no longer become a successful repeated-playback diagnostic merely because
  capture files exist.
- Coverage regression tests retain a previously established offset only when
  every sample matches exactly, avoiding a false mismatch on the quiet tail.
  They do not repair, filter, rescale, or re-subtract the output being evaluated.

See [SILENT-STALL-FINDINGS.md](SILENT-STALL-FINDINGS.md) for evidence and limits.

## Hardware evidence already available

The recovered candidate addon is at
`dist/audio-validation/buffer-addon/wasapi-loopback.node` (commit `afd7d63`,
Actions run `34724986466`). Its existing `buffer-pilot-1` recording contains
71.22 seconds of capture, one initial alignment lock, no observed realignments,
and no dropped chunks. The revised offline audit finds no unmatched or
unverified frames. Zero-output frames include silence/cancellation and must not
all be described as deliberate native muting.

The interrupted `buffer-soak-30m-1` report is corrected to `INCOMPLETE`; its
original report and raw evidence are retained. It is not a completed 30-minute
reliability result.

## Still unverified

1. A controlled Windows capture-thread stall with the old and candidate buffer
   requests under otherwise identical conditions. The queue simulation and one
   hardware pilot do not establish that buffer capacity caused the earlier
   realignments. Process-loopback `GetBufferSize` values have been inconsistent;
   do not treat them as reliable reference-leg capacity measurements.
2. Startup/relock behavior and subtraction across the supported output-device
   configurations. A 200 ms request is not protection against arbitrary stalls.
3. Packaging the candidate addon into a new application artifact and verifying
   that exact packaged binary. The existing experimental subtraction ZIP uses
   an older addon and is not the buffer candidate.

If a hardware reproduction is needed, first specify a short, bounded test and
obtain permission for any audible stimulus. Until then, continue only silent
analysis and checks. Do not label the feature fully verified or shipped.
