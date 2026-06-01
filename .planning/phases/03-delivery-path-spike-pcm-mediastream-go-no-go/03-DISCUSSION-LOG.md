# Phase 3: Delivery-Path Spike — PCM → MediaStream (GO/NO-GO) - Discussion Log

**Date:** 2026-05-31
**Areas discussed:** Injection technique, Spike input source, GO/NO-GO success bar, Fallback if Option B fails, Scaffolding lifecycle

---

## Injection technique

### Q: Which renderer-side mechanism should the spike use to turn PCM into a live MediaStreamTrack?
**Options presented:**
- Probe both, MSTG first — feature-detect MediaStreamTrackGenerator, fall back to Web Audio MediaStreamAudioDestinationNode
- Web Audio only — known-good single path
- MediaStreamTrackGenerator only — cleanest if available, hard NO-GO if not

**Selected:** Probe both, MSTG first
**Notes:** Satisfies SC#2 (MSTG availability confirmed/refuted) and names the working path for Phase 4.

### Q: Where should the spike inject the reconstructed track?
**Options presented:**
- Reuse existing swap seam — screensharePatch.ts:79-84 behind a spike flag
- Separate isolated path — standalone getDisplayMedia wrapper

**Selected:** Reuse existing swap seam
**Notes:** Proves the real Phase 4 integration point.

### Q: Should the spike also exercise the main→renderer PCM transport, or isolate the renderer reconstruction?
**Options presented:**
- Include transport (main→renderer) — generate PCM in main, ship over MessagePort/transferable ArrayBuffer chunks
- Isolate renderer only — generate tone in-renderer, no IPC

**Selected:** Include transport end-to-end
**Notes:** This question was initially asked twice (a redundant follow-up with a fabricated "simplest" premise produced a conflicting "renderer-only" answer). Reconciled with an explicit tie-break question; user locked **Include transport end-to-end** — the spike proves the whole Phase 4 bridge including the flagged IPC-throughput/GC risk.

---

## Spike input source

### Q: What should the synthetic audio actually sound like (for unambiguous viewer-side confirmation)?
**Options presented:**
- Distinctive pattern — periodic beeps / repeating sweep
- Steady pure tone — single continuous sine
- Looped recorded clip — bundled music/speech

**Selected:** Distinctive pattern
**Notes:** Viewer on a second device with no DevTools must be certain they hear the injected test audio, not Discord/silence/noise.

### Q: What PCM format should the synthetic source use?
**Options presented:**
- Match Phase 4 exactly — 48 kHz, stereo, float32
- Simplest to generate — e.g. mono 16-bit

**Selected:** Match Phase 4 exactly
**Notes:** Mirrors WebRTC/Opus, Web Audio, and the WASAPI fixed WAVEFORMATEX; no conversion surprises deferred to Phase 4.

### Q: At what cadence should main generate and ship the PCM?
**Options presented:**
- Realistic streaming cadence — ~10 ms / 480-frame chunks, ~100 chunks/sec
- One-shot / large buffer — single big buffer looped in-renderer

**Selected:** Realistic streaming cadence
**Notes:** Genuinely stresses the transport throughput/GC — the reason transport was included.

---

## GO/NO-GO success bar

### Q: What is the GO bar — audible confirmation alone, or audible PLUS logged technical corroboration?
**Options presented:**
- Audible + logged corroboration — viewer hears it AND screenshare-debug.log records corroborating signals
- Audible only — viewer hears it, full stop

**Selected:** Audible + logged corroboration
**Notes:** Viewer's ear is the truth; the log makes the verdict auditable and diagnoses a NO-GO without DevTools.

### Q: Which corroborating signal best proves audio is actually leaving the streamer (logged, no DevTools)?
**Options presented:**
- getStats outbound-rtp audio — RTCRtpSender.getStats() packetsSent/bytesSent climbing
- Track/sender state only — mechanism chosen, track.readyState, sender attached

**Selected:** getStats outbound-rtp audio
**Notes:** Strongest viewer-independent proof packets are leaving the peer connection; cheap local signals logged too.

---

## Fallback if Option B fails

### Q: If BOTH MediaStreamTrackGenerator and Web Audio fail to reach a viewer, what does the spike do?
**Options presented:**
- NO-GO, name Option A next — declare NO-GO, verdict names Option A (virtual capture device, no kernel driver) as first re-scope avenue; don't build it
- Try Option A in this spike — attempt Option A before declaring NO-GO
- Hard NO-GO, full re-scope — Option B failing = re-scope, no Option A pursuit

**Selected:** NO-GO, name Option A next
**Notes:** Keeps the spike tight; doesn't silently dead-end the milestone. Option A's no-driver feasibility is itself unproven, so out of this phase's scope.

---

## Scaffolding lifecycle

### Q: How should the spike code be contained / activated so it rides the CI artifact but doesn't pollute normal builds?
**Options presented:**
- Env-var gate on throwaway branch — GOOFCORD_* flag (e.g. GOOFCORD_DELIVERY_SPIKE=1), dormant by default
- Branch-only, always-on — active on the throwaway branch, no flag

**Selected:** Env-var gate on throwaway branch
**Notes:** Toggleable on the artifact without rebuild; trivially stripped; mirrors --no-patchcord / GOOFCORD_*_PATH precedent.

### Q: What survives into Phase 4 vs gets thrown away?
**Options presented:**
- Keep proven delivery, drop generator — keep reconstruction + transport wiring as marked Phase 4 seed; throw away generator/beep/getStats logging
- Pure throwaway — everything thrown away; Phase 4 re-implements from the verdict

**Selected:** Keep proven delivery, drop generator
**Notes:** Matches SC#4 — any code kept is marked for Phase 4 integration.

---

## Deferred Ideas

- A/V sync between injected audio and screenshare video — deferred to Phase 4; the spike only proves "audio reaches the viewer at all."
- Option A (virtual capture device, no kernel driver) — not built in this spike; named in the NO-GO verdict as the first re-scope avenue.
- Real exclude-tree WASAPI capture + PID resolution — Phase 4.

## Claude's Discretion

- Exact chunk size / beep cadence / env-var name / `screenshare-debug.log` line format — left to the planner/executor as implementation details.
- A/V sync was offered as a 4th gray area but the user did not select it; recorded as explicitly deferred to Phase 4.
