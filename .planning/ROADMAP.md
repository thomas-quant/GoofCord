# Roadmap: GoofCord — Windows Streaming Fixes

## Overview

This is a tight, Windows-focused bug-fix milestone for a brownfield Electron/Vencord Discord client. Two related screenshare bugs are in scope. Bug A (primary): after a user cancels the source picker, the second "start stream" click is inert — no picker appears. Bug B (related, separable): Windows system/app audio (`audio: "loopback"`) may not be captured. Research converged strongly: Bug A must be diagnosed on an instrumented Windows CI build before fixing (CI round-trips are scarce), then fixed surgically by consolidating per-request teardown into an exactly-once `finishRequest()` and ensuring the renderer rejection resets Discord's latched go-live state. Bug B is investigated only after Bug A is closed (a working screenshare is needed to validate audio), gating the Linux Patchcord track-removal on `platform !== "win32"` and ensuring both renderer `audio:true` and handler `audio:"loopback"` are set. All verification is manual on a Windows x64 CI artifact; all fixes stay minimal and upstream-PR-able with no new dependencies.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Fix Bug A — Cancel then Restart Works** - Diagnose on an instrumented Windows build, then make the second start-stream click after a cancel re-open the picker and stream normally (completed 2026-05-30)
- [ ] **Phase 2: Fix Bug B — Windows Loopback Audio Captured** - When the user opts to share audio on Windows, a remote viewer hears system/app audio

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

**Goal**: On Windows, when the user opts into audio sharing, the captured system/application audio is present on the outgoing stream and a remote viewer hears it — without the Linux Patchcord track-handling ever stripping the Windows loopback track.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: AUDIO-01, AUDIO-02
**Success Criteria** (what must be TRUE):

  1. On a Windows x64 CI build, after a loopback grant, the stream carries an audio track (`stream.getAudioTracks().length > 0`) when the user opts into audio sharing. [AUDIO-01]
  2. A remote viewer (a second account/machine, not the streamer) hears the captured system/application audio during the screenshare — verified from the viewer side because local echo is muted by design. [AUDIO-01]
  3. The Linux virtual-mic / Patchcord audio-track-removal logic does not run on Windows and never strips the Windows `"loopback"` audio track (track-removal gated on `process.platform !== "win32"`; renderer requests `audio: true` and handler grants `audio: "loopback"`). [AUDIO-02]
  4. Linux (Patchcord) and macOS audio paths are unchanged, and the diff stays surgical with no new dependencies — PR-ready for upstream GoofCord. [UPST-01]

**Plans**: TBD

Plans:

- [ ] 02-01: Diagnose Bug B — on a Windows build, log `stream.getAudioTracks()` after a loopback grant and log `getVirtmic()` to confirm whether the Patchcord track-removal block fires on Windows
- [ ] 02-02: Apply the fix — gate the Patchcord track-removal on `process.platform !== "win32"` in `screensharePatch.ts`, confirm renderer `audio: true` and handler `audio: "loopback"` are both set, rebuild, and verify audio from a second viewer

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Fix Bug A — Cancel then Restart Works | 2/2 | Complete   | 2026-05-30 |
| 2. Fix Bug B — Windows Loopback Audio Captured | 0/2 | Not started | - |
