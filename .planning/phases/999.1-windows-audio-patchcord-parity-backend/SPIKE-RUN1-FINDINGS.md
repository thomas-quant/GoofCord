# Spike run 1 — on-box findings (2026-07-03)

Build: CI run 28662879774 (green), portable tested on the real Windows box. Two
capture sessions logged to `%APPDATA%/goofcord/wasapi-aec-spike.log` (~11 min + ~4 min).

## Proven (do NOT re-litigate)
- **Concurrency works.** `startEndpointMinusSelf` ran the default-render **endpoint
  loopback (A)** and **process-loopback INCLUDE of GoofCord's own tree (B)**
  concurrently. Every activation `hr=0x00000000`; clean stop + restart between the
  two sessions; **no CoreMessaging crash**. This settles the concurrency unknown.
- **Endpoint loopback (A) correctly excludes the virtual audio cable.** Real-world
  result: a 2nd device heard desktop audio but NOT the VAC (the VAC is a separate
  render endpoint, so it is never in A). This half is solid.

## The bug to FIX: the self-cancellation (A − B) does essentially nothing
The NLMS canceller is a near-passthrough. Evidence from the log:
- `before_db == after_db` **exactly** in **894 of 903** heartbeats (filter output ==
  input → NLMS not adapting; taps stay ~0).
- `reduction_db=0.00` in **802 of 807**. Only 5 heartbeats ever cancelled — but one
  reached **11.58 dB**, proving the NLMS math is fine WHEN aligned.
- **Root cause = near-end/far-end misalignment, not the DSP.** The reference (far-end,
  B) buffer **grows to a ~230 ms backlog and pins there** (`reference_buffered_samples`
  climbs 0 → 3840 → … → 23040 → 22080 and stays), while `delay_samples` sits **stuck
  at 0**. The one 11.58 dB success occurred while the backlog was still small
  (`reference_buffered_samples=3840`); once it ballooned, cancellation never recovered.

### Why it misaligns (design analysis)
A (endpoint) and B (process-loopback) are **two independent IAudioClients with
independent device clocks and independent packet cadence**. The current canceller
consumes them from separate buffers without time-locking them, so:
1. the far-end buffer accumulates an unbounded backlog (producer/consumer + clock
   drift) → the reference the filter sees is ~230 ms stale vs the near-end block;
2. the delay estimator never locks (stuck at 0) so the filter can't find the true
   render→endpoint echo delay;
3. NLMS therefore never adapts → `output == input`.

## Fix requirements (for the next pass)
1. **Time-align A and B.** Use each WASAPI capture's timestamps — `GetBuffer` returns
   `*pu64DevicePosition` and `*pu64QPCPosition`; align near-end and far-end blocks by
   QPC/device position so the same wall-clock audio is compared. Coarse-align by
   timestamp, then let NLMS fine-tune the residual delay.
2. **Bound the far-end buffer / handle clock drift.** The reference must not grow
   unboundedly. Cap the jitter/delay buffer; on overflow, drop-to-realign (or resample
   for drift) rather than letting a fixed 230 ms backlog build. The two independent
   device clocks WILL drift — the alignment must tolerate/correct it continuously.
3. **Make the delay estimator actually lock** (it's pinned at 0). Search a realistic
   render→endpoint delay range and hold the lock; re-search only on large error.
4. Keep the existing 48k/stereo/f32, 3840-byte chunk contract and the diagnostics
   (before/after dB, delay_samples, buffered-samples) — they're what let us read this.
   Add a lock/aligned indicator to the heartbeat so we can confirm the fix on-box.
5. Preserve everything already proven: concurrent A+B activation, the fallback to
   EXCLUDE `start()`, never running Chromium loopback alongside native capture.

Success target for run 2: sustained `reduction_db` well above 0 (the 11.58 dB blip
shows the ceiling is much higher) whenever GoofCord is rendering audio, with
`reference_buffered_samples` staying bounded and `delay_samples` locking to a stable value.
