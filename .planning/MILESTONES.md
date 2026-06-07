# Project Milestones: GoofCord — Windows Streaming Fixes (Fork)

Entries in reverse chronological order — newest first.

## v1.2 Feature Viability Investigations (Completed: 2026-06-07)

**Delivered:** A four-idea viability triage — investigate-only, no feature code. Four independent spikes ran in parallel, each producing a `FINDINGS.md` with a GO/NO-GO/DEFER verdict + tech-debt estimate. Lean shell by design (no roadmapper/research agents, no plan/execute/verify loops).

**Phases completed:** 6-9 (4 investigation spikes, 0 plans — investigation milestone).

**Verdicts:**
- **INV-01 Encryption hardening → NO-GO.** Verified against the real on-disk config: secrets are `safeStorage`/DPAPI ciphertext, not plaintext; StegCloak = Argon2+AEAD; cloud = scrypt+AES-256-GCM. Only `cloudToken` is cleartext (guards an already-E2E blob) → optional 1-line micro-PR.
- **INV-02 Keybinds non-alphanumeric → GO (S).** Root cause is GoofCord's own `String.fromCharCode(domKeyCode)` at `preload/keybinds.ts:53` (not venbind). ~15-line pure-TS fix, most upstream-able. → **v1.3 KEY-01.**
- **INV-03 Deafen/mute → NO-GO.** Inherited Discord-web-in-Chromium behaviour (Windows comms auto-ducking + web gain-ramp); GoofCord touches no audio-graph code.
- **INV-04 Resource usage → DEFER/AVOID.** Thin shell; renderer dominates; Windows un-throttles by design for streaming. **Byproduct bug found:** `main.ts:67` flag typo `disable-disable-backgrounding-occluded-windows` (silent no-op). → **v1.3 STREAM-05.**

**Outcome:** 2 surgical upstream-able fixes promoted to v1.3 + 1 optional micro-PR; 2 clean "nothing to build" closes. Cost: one parallel spike pass.

**What's next:** v1.3 — Small Upstream-able Fixes (KEY-01 keybinds + STREAM-05 flag typo).

---

## v1.1 Windows Screenshare Echo Fix (Shipped: 2026-06-06)

**Delivered:** The Windows screenshare echo fix (upstream #46) — native WASAPI per-process-tree EXCLUDE loopback that captures the whole endpoint mix except GoofCord's own Electron process tree, replacing Chromium's whole-mix `"loopback"` so remote viewers no longer hear the call echoed back.

**Phases completed:** 3-5 (13 plans total)

**Key accomplishments:**
- Proved the make-or-break delivery path (GO spike): PCM → renderer `MediaStreamTrackGenerator` track → `getDisplayMedia` swap seam → viewer, confirmed on Electron 41.3.0 / Chrome 146 — the bridge Discord's native client never had to solve because GoofCord wraps the *web* client.
- Built a clean-room Rust + napi-rs WASAPI EXCLUDE-process-tree `.node` addon (hardcoded 48k/stereo/f32, dynamic LoadLibrary/GetProcAddress activation, bounded drop-oldest ThreadsafeFunction push) from the public Microsoft `ApplicationLoopback` sample — MIT notice retained, zero Discord symbols.
- Wired it into `screenshare.ts` as an additive 3-way gate (Linux patchcord → Windows native exclude-tree → `"loopback"` fallback) over a per-share MessageChannel transport, excluding the root Electron PID so the Audio Service child is covered.
- Verified viewer-side on a real Windows x64 CI build (build 19045): viewer hears desktop audio with no call echo; `--no-wasapi` A/B shows echo returns on fallback, proving the suppression is attributable to the EXCLUDE-tree path. Graceful fallback, no Linux/macOS regression.
- Stripped all diagnostic instrumentation and shipped the addon as a separate prebuilt-`.node` repo (`thomas-quant/wasapi-loopback`) consumed via one `optionalDependencies` line — the venbind/patchcord pattern. Upstream PR #211 opened (Closes #46).

**Stats:**
- 11 source files modified (~558 source insertions); 3 phases, 13 plans
- ~6,569 LOC TypeScript in `src/` at ship; native addon is a separate Rust repo
- ~4 days (2026-06-02 → 2026-06-06)

**Git range:** `feat(03-01)` (0708ee7) → `fix(screenshare)` (68bfb05, per-share feeder rebuild)

**Known deferred at close:** 0 real gaps. The close-time `audit-open` flagged 4 items (Phase 01 UAT/verification status flags, Phase 03/04 CONTEXT probe questions) — all reviewed as stale/already-resolved (see STATE.md → Deferred Items). Scope deferrals carried forward: user-side workaround (out of scope) and WSTRM-01 (v2).

**What's next:** No active milestone. Reopen via `/gsd-new-milestone` if further Windows streaming bugs surface (WSTRM-01).

---

## v1.0 Windows Streaming Fixes (Shipped: 2026-05-30)

**Delivered:** The cancel-then-restart streaming fix (Bug A) plus a recon-only investigation identifying Discord's Windows per-process audio-capture mechanism (Bug B), setting up the v1.1 echo fix.

**Phases completed:** 1-2 (4 plans total)

**Key accomplishments:**
- Fixed Bug A: after cancelling the source picker, the second start-stream click was inert — consolidated per-request teardown into an exactly-once `finishRequest(wcId, result)` (map-delete as the idempotency token) and kept the deliberate `NotAllowedError` cancellation re-throw. Verified on Windows CI build 26673048740.
- Identified the not-reset-on-cancel state: per-request teardown was racing/duplicating the Electron `callback` across the select/cancel and window-`closed` paths.
- Recon (Bug B): documented that Discord uses the public WASAPI Application Loopback API (EXCLUDE process-tree, dynamically loaded) — NOT a virtual-device driver — and produced a clean-room GO verdict (`02-FINDINGS.md`), retargeting Bug B to the echo symptom (#46).
- Kept both fixes surgical and upstream-PR-able (no new dependencies, no handler re-registration). Wayland portal-cancel re-open later folded into upstream PR #210.

**Stats:**
- 2 phases, 4 plans
- 1 day (2026-05-30)

**Git range:** `docs(01)` (cf1f6f5) → `docs(02)` (5ec21db)

**What's next:** v1.1 — Windows Screenshare Echo Fix (the native implementation of the Bug B recon).

---
