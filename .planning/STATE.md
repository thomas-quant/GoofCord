---
gsd_state_version: 1.0
milestone: v1.3
milestone_name: Small Upstream-able Fixes
status: in_progress
last_updated: "2026-06-07T05:31:59.115Z"
last_activity: 2026-06-07 — KEY-01 first Windows test inconclusive (wrong build base); map CONFIRMED correct vs ground truth; handoff written (10-HANDOFF.md)
progress:
  total_phases: 3
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-06)

**Core value:** On Windows, a user can start a screenshare, cancel the source picker, and start again — and the stream works — without the app getting stuck or requiring a restart.
**Current focus:** v1.3 — Small Upstream-able Fixes (build). KEY-01 keybinds non-alphanumeric fix (`preload/keybinds.ts:53`) + STREAM-05 occluded-window flag typo (`main.ts:67`), promoted from the v1.2 investigations. SEC-01 `cloudToken` is an optional deferred stretch. Keybind/flag verification is manual on a Windows x64 CI artifact.

## Current Position

Phase: 10 (KEY-01 in-debug — map correct, end-to-end unvalidated) · 11 (STREAM-05 committed, unvalidated) · 12 (deferred stretch)
Plan: —
Status: KEY-01 (`7103149`) map **confirmed correct vs ground truth** (Discord persists standard DOM keyCodes — localStorage: 188=`,`, 190=`.`, 192=`` ` ``). **WIN (user-confirmed):** with the fix, non-alpha keybinds (`]`, Ctrl-combos) **register/fire when FOCUSED** — they didn't before (Discord runs desktop/embedded → relies on venbind, so the fix's registration string is on the focused firing path too; earlier "focused=Discord-native" model was WRONG). **PRESERVE this — it's the success.** Remaining gap: **out-of-focus/global** firing unvalidated (broke on wrong `origin/main` base; suspect the `venbind.ts:38` focus-gate). **Next agent:** see `phases/10-keybinds-non-alphanumeric-fix/10-HANDOFF.md` — bun:test on the pure map, named-key gap (F-keys/space), re-validate on the **dev/release base** with a focused-regression guard. **Targets upstream #179** (non-alpha global keybinds, OPEN — maintainer blamed venbind, we found it's GoofCord's `String.fromCharCode` glue; KEY-01 likely Closes #179; study his reverted `3f9096e` before PRing). STREAM-05 (`c988872`) separate/low-risk, unvalidated. SEC-01 deferred.

**⚠ Clean-room:** the keybind map is grounded in the PUBLIC DOM keyCode standard; Discord internals were not copied — keep Discord-mapping investigation OUT of repo/commits/PRs.
Last activity: 2026-06-07 — KEY-01 debugged to ground truth; handoff written for next agent

## Performance Metrics

**Velocity:**

- Total plans completed: 14 (v1.0)
- Average duration: — min
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 2 | - | - |
| 02 | 2 | - | - |
| 03 | 3 | - | - |
| 04 | 3 | - | - |
| 05 | 7 | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*

## Accumulated Context

### Roadmap Evolution

- v1.2 roadmap created (2026-06-07): phases 6-9 added (numbering continued from v1.1). **Investigate-only triage milestone** — no feature code ships; each phase is an independent spike producing a `FINDINGS.md` verdict. Lean shell by user request (no roadmapper/research agents, no per-phase discuss/plan/execute/verify loops). Phases run in parallel (no inter-dependencies).
- v1.1 roadmap created (2026-05-30): phases 3-5 added; numbering continued from v1.0 (started at 3). Native-only scope — user-side workaround explicitly NOT a deliverable (supersedes research SUMMARY's "workaround-first").
- Build gate relaxed: WASAPI process-loopback functional on Win10 2004 / build 19041+ (confirmed by official Discord echo-free on maintainer's 19045 box — 02-FINDINGS §2.3 UPDATE). Native path IS locally verifiable; sub-2004 is a minor graceful-fallback (ECHO-03), not a phase.
- Delivery-path spike kept as its own distinct first phase (Phase 3, user's explicit choice) — a GO/NO-GO gate owning no requirement.
- Phase 2 (v1.0) was re-scoped to recon-only: Bug B retargeted to echo (#46); AUDIO-01/02 marked investigated-only.

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [v1.2 verdicts, 2026-06-07] Four parallel investigation spikes landed:
  - **INV-01 encryption → NO-GO.** Secrets are safeStorage/DPAPI ciphertext at rest (verified on real `%APPDATA%/goofcord/.../settings.json`); StegCloak = Argon2+AEAD; cloud = scrypt+AES-256-GCM. Only `cloudToken` is plaintext (guards an already-E2E blob) → optional S micro-PR `encrypted:true`. (`06-FINDINGS.md`)
  - **INV-02 keybinds → GO (S).** Root cause is GoofCord's own `String.fromCharCode(domKeyCode)` at `src/windows/main/preload/keybinds.ts:53` (OEM keyCodes 186-222 → Latin-1 garbage, e.g. `]`221→`ý`), NOT venbind (which Unicode-matches the physical key correctly). Fix = ~15-line keyCode→char map, pure-TS, ships via ts-out preload (confirmed not a fetched bundle), most upstream-able. (`07-FINDINGS.md`)
  - **INV-03 deafen/mute → NO-GO.** Inherited Discord-web-in-Chromium behaviour: Windows "communications" auto-ducking (native Discord's C++ engine bypasses it; the Electron WebRTC path can't) + web gain-ramp. GoofCord touches zero audio-graph code. Nothing to build. (`08-FINDINGS.md`)
  - **INV-04 resource usage → DEFER/AVOID.** Thin shell; renderer dominates; Windows deliberately un-throttles for streaming. Safe win = measure-first baseline (S). **Byproduct bug:** `src/main.ts:67` `disable-disable-backgrounding-occluded-windows` is a typo (real flag drops one `disable-`) → silent no-op; fixing it is a streaming-stability correctness fix (S, upstream-able; Vesktop has the correct name). (`09-FINDINGS.md`)
  - **v1.3 candidates:** INV-02 keybinds fix + INV-04 `main.ts` typo fix (both surgical, upstream-able, streaming-adjacent) + optional INV-01 `cloudToken`.
- [Roadmap v1.1]: Phase shape = spike (3) → native addon + integration (4) → verification + upstream PR (5). Spike gates the native investment.
- [Roadmap v1.1]: ECHO-01..04 owned by Phase 4; UPST-02 owned by Phase 5; Phase 3 owns no requirement (de-risk gate).
- [03-03]: **Phase 3 delivery-path spike verdict = GO** (03-FINDINGS.md). `MediaStreamTrackGenerator` (Insertable Streams) is CONFIRMED present + working on Electron 41.3.0 / Chrome 146 (resolves A1/A2); a renderer-reconstructed synthetic audio track swapped at `screensharePatch.ts:79-84` was heard by a second-device viewer on Windows x64 CI artifact (run 26740748142). Proven path: renderer MSTG reconstruction → getDisplayMedia swap seam → RTCPeerConnection → viewer. KEEP the MSTG/Web-Audio reconstruction + swap seam as the Phase 4 seed; THROW AWAY the synthetic beep generator + getStats poll. The main→renderer PCM transport is the named Phase 4 residual risk (chunked transferables, NEVER per-frame ipcRenderer.send — ARCHITECTURE.md:250-253). `getStats` showed audioSenders=0 (Pitfall 4: Discord uses replaceTrack on a pre-created transceiver, not addTrack) — an instrumentation blind spot, NOT a delivery failure; viewer-audible is the dispositive ground truth.
- [02-02]: Mechanism = public WASAPI Application Loopback, EXCLUDE process-tree, dynamically loaded (not a virtual-device driver); clean-room GO from the public MS ApplicationLoopback sample (D-05 LOCKED).
- [01-02]: Bug A fixed by exactly-once finishRequest + kept NotAllowedError; verified on combined Windows CI build run 26673048740; instrumentation stripped (UPST-01).

### Pending Todos

[From .planning/todos/pending/ — ideas captured during sessions]

None yet.

### Blockers/Concerns

[Issues that affect future work]

All v1.1 blockers resolved at milestone close — none carried forward:

- ~~PCM → `getDisplayMedia` MediaStream delivery in Electron 41.3.0~~ — RESOLVED (Phase 3 GO; per-share MessageChannel transport + MSTG, verified viewer-side).
- ~~Exclude target = root Electron PID covers the Audio Service child~~ — CONFIRMED on hardware (root 19076, Audio Service 12280 in its `app.getAppMetrics()` subtree; `05-VERIFICATION.md`).
- ~~Clean-room boundary~~ — HELD (public Microsoft `ApplicationLoopback` sample only, MIT notice retained, zero Discord symbols).
- Verification remains MANUAL on a Windows x64 CI artifact (no automated screenshare repro; echo check needs a second device, audio playing) — relevant again only if a future milestone touches streaming.

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Scope | User-side separate-output-device workaround | Out of scope (rejected as deliverable) | v1.1 |
| Scope | WSTRM-01 — further Windows streaming bugs | Deferred to v2 | v1.0 close |

**Close-time open-artifact audit (2026-06-06):** the `audit-open` query flagged 4 items at v1.1 close, all reviewed as **stale/resolved, not real gaps** (user proceeded):

| Item | Audit flag | Disposition |
|------|-----------|-------------|
| `01-HUMAN-UAT.md` | partial (0 pending scenarios) | Bug A human-verified on CI 26673048740; status flag never flipped |
| `01-VERIFICATION.md` | human_needed | Phase 1 human-verified (STREAM-01..04 all complete); flag stale |
| `03-CONTEXT.md` | 3 open questions | The spike's own probe questions — resolved by the GO verdict (`03-FINDINGS.md`) |
| `04-CONTEXT.md` | 3 open questions | Addon-home / transport questions — resolved in Phase 4 (in-repo crate + env override, shipped) |

## Session Continuity

Last session: 2026-06-07
Stopped at: v1.2 milestone opened (lean shell); 4 parallel investigation spikes dispatched
Resume file: .planning/phases/06-encryption-hardening-investigation/ (and 07/08/09 — FINDINGS.md per phase)
