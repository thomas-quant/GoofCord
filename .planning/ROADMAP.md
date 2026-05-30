# Roadmap: GoofCord — Windows Streaming Fixes

## Overview

This is a tight, Windows-focused bug-fix milestone for a brownfield Electron/Vencord Discord client. Two related screenshare bugs are in scope. Bug A (primary): after a user cancels the source picker, the second "start stream" click is inert — no picker appears. Bug B (related, separable): Windows system/app audio (`audio: "loopback"`) may not be captured. Research converged strongly: Bug A must be diagnosed on an instrumented Windows CI build before fixing (CI round-trips are scarce), then fixed surgically by consolidating per-request teardown into an exactly-once `finishRequest()` and ensuring the renderer rejection resets Discord's latched go-live state. Bug B is investigated only after Bug A is closed (a working screenshare is needed to validate audio), gating the Linux Patchcord track-removal on `platform !== "win32"` and ensuring both renderer `audio:true` and handler `audio:"loopback"` are set. All verification is manual on a Windows x64 CI artifact; all fixes stay minimal and upstream-PR-able with no new dependencies.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Fix Bug A — Cancel then Restart Works** - Diagnose on an instrumented Windows build, then make the second start-stream click after a cancel re-open the picker and stream normally (completed 2026-05-30)
- [ ] **Phase 2: Fix Bug B — Windows Loopback Audio Captured** - Recon-only: identify and document how Discord captures per-process audio on Windows (the echo fix); no GoofCord code this phase

## Phase Details

### Phase 1: Fix Bug A — Cancel then Restart Works

**Goal**: On Windows, a user can cancel the screenshare source picker and start a stream again immediately — the picker re-opens and the stream works, with no app restart, and no progressive wedging across repeated cancel/retry cycles.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: STREAM-01, STREAM-02, STREAM-03, STREAM-04, UPST-01
**Success Criteria** (what must be TRUE):

  1. On a Windows x64 CI build, after cancelling the source picker, clicking "Go Live" / start-stream again re-opens the source picker (a picker window appears). [STREAM-01]
  2. A screenshare that was cancelled and then restarted starts and streams normally, verified end-to-end on the Windows build with no application restart required. [STREAM-02]
  3. Cancelling the source picker shows no uncaught or visible JavaScript error in Discord (the `710cfde` behaviour is preserved). [STREAM-03]
  4. Repeated cancel then retry cycles remain stable on the Windows build — the start-stream control keeps working after multiple cancellations with no progressive wedging and no main-process "Object has been destroyed" errors. [STREAM-04]
  5. The diff is surgical — `finishRequest()` consolidation in `screenshare.ts` plus the renderer error-shape adjustment in `screensharePatch.ts`; no handler re-registration, no `useSystemPicker`, no new dependencies; PR-ready for upstream GoofCord. [UPST-01]

**Plans**: 2 plans
Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Instrument Bug A (log points A/B/C → DevTools + userData `screenshare-debug.log`) as a distinct, revertable commit; rides the single combined Windows build with the fix (D-01)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-02-PLAN.md — Apply the surgical fix (exactly-once `finishRequest()` in `screenshare.ts` + evidence-gated rejection-name in `screensharePatch.ts`), run the single combined Windows build, verify cancel→restart manually, then strip instrumentation for the upstream PR (D-04)

### Phase 2: Fix Bug B — Windows Loopback Audio Captured

**Goal**: On Windows, determine and document exactly how the official Discord desktop client captures per-process / system audio for screenshare *without* echoing the call back to viewers — i.e. identify the mechanism (an installed virtual audio device driver vs. the public WASAPI Application Loopback API with process-tree exclusion, `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`). Deliverable is a recon findings document that lets a later phase decide, from evidence, whether GoofCord can replicate it clean-room from the public Microsoft API. No GoofCord code change and no prototype in this phase. (Re-scoped 2026-05-30 — Bug B retargeted to the echo symptom, upstream #46; see 02-CONTEXT.md.)
**Depends on**: Phase 1
**Requirements**: AUDIO-01, AUDIO-02 (investigated only — delivery deferred to a follow-on implementation phase; see 02-CONTEXT.md)
**Success Criteria** (what must be TRUE):

  1. A findings document records Discord's Windows per-process audio-capture mechanism (installed virtual audio driver vs. public WASAPI Application Loopback `EXCLUDE_TARGET_PROCESS_TREE`), backed by concrete evidence — native-module/DLL symbol inspection (`ActivateAudioInterfaceAsync` / `AUDIOCLIENT_ACTIVATION_PARAMS` / `PROCESS_LOOPBACK`) and/or a Device Manager virtual-device check.
  2. The document captures the parameters needed to replicate from the public Microsoft API: include-vs-exclude mode, which process tree Discord excludes (accounting for Electron running audio in a separate process), the minimum Windows build (e.g. 20348+), and the fallback story for older builds.
  3. The document gives a clear, evidence-based clean-room recommendation on whether GoofCord can replicate the mechanism from the public WASAPI API only (no copied Discord code) — producing the go/no-go inputs for the deferred native-module-vs-workaround decision.
  4. Recon-only boundary honoured: no GoofCord source changed and no prototype built in this phase; any future implementation stays clean-room and dependency-minimal. [UPST-01]

**Plans**: 2 plans

Plans:
**Wave 1**

- [ ] 02-01-PLAN.md — Desk-research baseline + inspection runbook: write the public WASAPI process-loopback baseline (API surface, min build 20348, macOS-driver contrast, Electron multi-process complication) into the `02-FINDINGS.md` skeleton, and author the copy-pasteable `02-RECON-RUNBOOK.md` the developer will run on their Windows box. Autonomous (no machine access needed). (D-02, D-05)

**Wave 2** *(blocked on Wave 1 completion)*

- [ ] 02-02-PLAN.md — Human checkpoint + findings synthesis: the developer executes the runbook on their physical Windows box and records raw observations (`02-RECON-OBSERVATIONS.md`), then `02-FINDINGS.md` is finalized — mechanism verdict + evidence, replication parameters (excluded process tree, build + fallback), and the clean-room go/no-go feeding the deferred D-06 implementation decision. Not autonomous (requires the developer's Windows box). (D-04, D-05, D-08, D-09)

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Fix Bug A — Cancel then Restart Works | 2/2 | Complete    | 2026-05-30 |
| 2. Fix Bug B — Windows Loopback Audio Captured | 0/2 | Not started | - |
