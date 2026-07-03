# Spike run 2 — on-box findings (2026-07-03)

Build: CI 28666863639 (green), portable tested on the real Windows box. One ~108 min
session, 6,376 `aec heartbeat` lines in `%APPDATA%/goofcord/wasapi-aec-spike.log`.
This is the alignment-fix build (QPC-timestamped queues, bounded, delay search 10–140 ms,
correlation lock).

## What now works (do NOT regress)
- **Concurrency**: endpoint loopback (A) + process-loopback INCLUDE of GoofCord's own
  tree (B) run together, all `hr=0x00000000`, no CoreMessaging crash. Repeated across runs.
- **Alignment is bounded** (run-1's runaway backlog is fixed): `aligned=true` in all 6,377
  heartbeats; `reference_buffered_samples` drains to ~0; buffers small; ~1 chunk/sec dropped
  on each stream (`dropped_*_chunks` ≈ 6,280 over 108 min).
- **The canceller WORKS when it locks.** A contiguous ~3-minute window (elapsed 2121–2293 s)
  showed sustained `delay_locked=true` with `reduction_db` of **6–30 dB** (peak **29.95 dB**,
  before_db −13.96 → after_db −43.91). Endpoint-minus-self AEC is mechanism-proven.
- Endpoint loopback (A) alone already excludes the virtual audio cable (separate endpoint) —
  proven in run 1 (2nd device heard desktop audio, not the VAC).

## The problem to solve: the delay lock is UNRELIABLE
- `delay_locked=true` in only **613 / 6,377** heartbeats (~10%); `aec_locked=true` 613.
- `delay_score` (correlation strength) is **0 in 6,056**, ≥0.4 in only **85**. The
  correlation-based delay search rarely catches; when it does (score 0.2–0.8) it locks and
  cancels 6–30 dB, but it loses lock quickly.
- `reduction_db`: >0.05 dB in 234 heartbeats (max 29.95), ~0 in 6,080, and **negative
  (made it WORSE) in 63** — occasional NLMS divergence/misadaptation.
- Net user experience: cancellation engaged ~10% of the time → self-echo still leaks most of
  the time → "didn't work".

## Key technical observations for solvers
- **QPC alignment is precise and stable**: `alignment_delta_ms` held around −2.5 ms (range
  ~−10..+3 ms). So near/far time-alignment via QPC works. The unreliable part is the
  ADDITIONAL echo-path `delay_samples` search (the render→endpoint pipeline delay on top of
  QPC alignment), done by correlation.
- **`device_delta_frames` is garbage**: it diverges unboundedly (−73M → −384M over the run)
  because the two IAudioClients' `device_position` counters have independent origins/clocks.
  It is only logged, not used for alignment (QPC is), but it shows device_position is NOT a
  shared reference between the two streams.
- **Diagnostic gap**: there is no far-end (reference B) level metric. `before_db` is the
  near-end (endpoint A) level. So we currently CANNOT distinguish "reduction=0 because B was
  silent (GoofCord playing nothing → nothing to cancel, fine)" from "reduction=0 because the
  lock failed while B had real audio (bad)". Any solution should add a reference-RMS/level
  field to make this observable.
- The render→endpoint echo-path delay for a fixed device SHOULD be roughly constant (WASAPI
  shared-mode engine + endpoint buffering, tens of ms), not wildly varying — yet the search
  flails, suggesting correlation is the wrong tool when far-end energy is intermittent.

## Current architecture (what a solution plugs into)
- Rust napi addon (`native/wasapi-loopback/src/lib.rs`, mirrored to `wasapi-loopback-repo/`),
  windows-rs 0.62.2. Two capture threads → timestamped chunk queues → a canceller thread
  running a block-NLMS with a correlation delay search. Output = A − est(B), emitted as
  48k/stereo/f32 3840-byte chunks to the existing MSTG feeder. `startEndpointMinusSelf(self_pid,
  log_path, on_chunk)`. CI-only builds; no local/net.

## Goal
Reliable self-audio cancellation whenever GoofCord is actually rendering audio (a call's voice
through the captured endpoint), without regressing the proven concurrency / bounded-alignment /
VAC-exclusion, and without the occasional divergence. 30 dB is reachable; make it hold.
