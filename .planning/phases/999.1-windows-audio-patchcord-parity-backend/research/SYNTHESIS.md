# AEC reliability research — 5-angle synthesis (2026-07-03)

Fan-out of 5 Codex researchers on RUN2's problem: endpoint-loopback (A) minus
process-loopback-INCLUDE-of-self (B) cancels 6–30 dB WHEN it locks, but the
per-block correlation delay search only locks ~10% of the time. Full proposals:
APPROACH-3 (proven-AEC-lib) and APPROACH-5 (windows-builtin-AEC) are on disk;
APPROACH-1 (deterministic-delay) and APPROACH-2 (reference-tap) were delivered as
text (key points captured below; R4 non-subtractive kept stalling and was filled
from R2 + design docs).

## Unanimous first step (all researchers, do regardless of route)
Add reference-level observability to the heartbeat: `reference_rms_db`,
`reference_active`, `endpoint_rms_db`, `output_rms_db`, `aec_reset_count`. RUN2
cannot distinguish "reduction=0 because B was silent (nothing to cancel, fine)"
from "reduction=0 because lock failed while B had audio (bad)". This also validates
R2's concern that process-INCLUDE actually captures Discord audio (rendered in
Electron's audio-service child of the main pid).

## Strong consensus
- KEEP the topology. Don't change the reference (R2 emphatic): process-loopback
  INCLUDE of GoofCord's MAIN process tree is the right no-driver tap. A render-side
  tap (tap what Chromium submits) would give deterministic delay but needs patching
  Electron/Chromium — out of envelope. Dedicated-sink / dual-endpoint reintroduce
  virtual drivers or clock drift.
- The bug is the DELAY CONTROL LOOP, not the signals. QPC alignment is already
  stable (±2.5 ms). Do NOT compare A/B device_position (independent origins;
  device_delta_frames diverges unboundedly — confirmed run2).

## Approach 1 — deterministic delay (LOWEST RISK; recommended first)
Kill the per-block search. Treat A→B echo-path delay as a session/device constant:
1. Always request device_position + qpc_position from GetBuffer (per-packet QPC = common timeline).
2. WASAPI timing as a PRIOR only: `api_prior_ms = max(0, endpoint_stream_latency - process_ref_latency)`;
   search window = prior ±20 ms; fallback 10–140 ms if latencies unreliable.
3. Wait until B has real energy (reference_rms above threshold), accumulate ~1–3 s,
   run ONE offline normalized delay calibration (downmix mono for search, high-pass,
   normalize by energy, coarse+refine, require subwindow agreement + peak separation).
4. LOCK delay_samples; DISABLE per-block search. Feed NLMS fixed-delay reads:
   `b_ref = reference_ring.read_at_qpc(a_chunk.qpc_start - locked_delay/48000, 480)`.
5. Recalibrate ONLY on watchdog: endpoint/device change, process-reference restart,
   sustained high residual. Guard divergence: freeze/leak adaptation when reference is low-energy.

## Approach 2 — better reference tap (verdict: keep current reference)
No public no-driver Windows API gives a self-only, post-endpoint, zero-delay tap.
Render-side tap ideal but needs Chromium patch/DLL hook (rejected). Dedicated sink
needs a virtual driver (rejected — no VAC dependency). Process-INCLUDE of main pid is
correct CONTENT (same mechanism the shipped EXCLUDE echo-fix relies on) but captured
BEFORE endpoint volume/APOs, so B is not bit-identical to self-in-A — the filter must
absorb that gain/spectral difference. Action: add reference RMS + log child PIDs to
confirm the audio-service child is in-tree.

## Approach 3 — proven AEC library (robust escalation; build risk)
Delete DIY NLMS+search; put WebRTC AEC3 behind a Rust `AecEngine` trait + a small C
ABI shim (feed B as reverse/render stream, A as capture, 10 ms frames). AEC3 owns
delay estimation, double-talk, divergence, reset. Fallback: vendored SpeexDSP (easy
`cc`-crate build, weaker delay/double-talk). Emergency: pure-Rust PBFDAF (avoid — "DIY
but fancier"). RISK: building AEC3 on MSVC inside `bun x napi build` without pulling
all of Chromium/WebRTC — time-box a CI build spike; disable APM AGC/NS/HPF (voice-tuned
processing damages music/game audio); may need 2 mono instances for stereo.

## Approach 4 — non-subtractive (filled from R2 + design docs)
Per-app process-loopback INCLUDE of the chosen app(s), mixed = echo-free AND VAC-free
BY CONSTRUCTION, no AEC. The picker UI's app-checklist already exists. Costs: user picks
apps (not "system audio"); some games/anti-cheat don't capture cleanly (OBS's known gap);
doesn't give "everything I hear". Best as a COMPLEMENTARY mode ("share this game's audio"),
not a replacement for endpoint-minus-self ("share everything but my voice"). Route-self-away
needs a virtual driver (rejected).

## Approach 5 — Windows built-in AEC (gamble; high fidelity risk)
Only `CWMAudioAEC` (Voice Capture DSP) filter mode is spike-worthy: A→AEC_CAPTURE_STREAM,
B→AEC_REFERENCE_STREAM (MFT via MFCreateSample, or DMO IMediaObject). OS owns delay/
double-talk. But voice-tuned: may force mono/16-bit/low-rate, apply AGC/NS/VAD that
damage non-voice system audio, add opaque latency. Comms AEC APO, DirectSound AEC = dead
ends (require real capture/render devices, not memory buffers). Only pursue if 1+3 stall.

## RECOMMENDATION (sequenced, low-regret)
1. Instrument reference RMS (unanimous, tiny) + one short controlled on-box read.
2. Fix delay via Approach 1 (lock-once + hold + watchdog) — smallest change, targets the
   diagnosed bug, keeps the proven topology. Steps 1+2 = one Codex pass.
3. Escalate to Approach 3 (AEC3) only if double-talk/divergence survives.
4. Keep Approach 4 (per-app INCLUDE) as a complementary mode; UI already present.
Proceeding with 1+2.
