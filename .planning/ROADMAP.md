# Roadmap: GoofCord — Windows Streaming Fixes

## Overview

This is a tight, Windows-focused bug-fix project for a brownfield Electron/Vencord Discord client, run as two milestones.

**Milestone v1.0 (complete)** — two related screenshare bugs. Bug A (primary): after a user cancels the source picker, the second "start stream" click is inert. Fixed surgically by consolidating per-request teardown into an exactly-once `finishRequest()` and re-throwing the renderer cancellation as `NotAllowedError`. Bug B (related): a recon-only investigation that identified Discord's Windows per-process audio-capture mechanism (the public WASAPI Application Loopback API, EXCLUDE process-tree, dynamically loaded) and produced a clean-room GO verdict — documented in `02-FINDINGS.md`.

**Milestone v1.1 (this milestone) — Windows Screenshare Echo Fix.** Implements the echo fix (upstream #46): on Windows, when a user screenshares system/app audio, Chromium's `"loopback"` mode captures the whole default-endpoint mix — including GoofCord's own playback of the call — so remote viewers hear themselves echoed back. The fix replaces that whole-mix capture with native WASAPI per-process-tree EXCLUDE loopback (capture everything except GoofCord's own Electron process tree), built clean-room from the public Microsoft `ApplicationLoopback` sample (MIT) and shipped as a venbind-style prebuilt `.node` addon. This is **native-only** — the user-side separate-output-device workaround is explicitly NOT a deliverable. The build gate is relaxed: the public process-loopback API is functional on Windows 10 version 2004 / build 19041+ (confirmed by official Discord working echo-free on the maintainer's build-19045 box — see `02-FINDINGS.md §2.3 UPDATE`), so the native path IS locally verifiable; sub-2004 builds are a minor graceful-fallback detail. The single genuine unknown — getting natively-captured PCM into Discord's web-client `getDisplayMedia` MediaStream in Electron 41.3.0 — is de-risked in a distinct first spike phase (a GO/NO-GO gate) before the native investment. All verification is manual on a Windows x64 CI artifact; the echo check specifically requires a second device/account as the viewer with non-call audio actively playing. All fixes stay surgical and upstream-PR-able.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

### Milestone v1.0 — Windows Streaming Fixes (complete)

- [x] **Phase 1: Fix Bug A — Cancel then Restart Works** - Diagnose on an instrumented Windows build, then make the second start-stream click after a cancel re-open the picker and stream normally (completed 2026-05-30)
- [x] **Phase 2: Fix Bug B — Windows Loopback Audio Captured** - Recon-only: identify and document how Discord captures per-process audio on Windows (the echo fix); no GoofCord code this phase (completed 2026-05-30)

### Milestone v1.1 — Windows Screenshare Echo Fix

- [x] **Phase 3: Delivery-Path Spike — PCM → MediaStream (GO/NO-GO)** - Prove, on a real Windows CI build, that a stub/synthetic audio source can be driven through Electron 41.3.0 into Discord's `getDisplayMedia` MediaStream viewer-side — the GO/NO-GO gate before any native investment (completed 2026-06-02)
- [ ] **Phase 4: Native Clean-Room Exclude-Tree Addon + Integration** - Build the clean-room WASAPI process-tree EXCLUDE loopback `.node` addon and wire it into the Windows audio branch via the proven delivery path, with graceful fallback and no Linux/macOS regression
- [ ] **Phase 5: Verification + Upstream PR** - Verify the fix end-to-end viewer-side on a real Windows build with audio playing, strip instrumentation, and shape the surgical upstream-PR-ready diff plus the separate addon repo

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

- [x] 02-01-PLAN.md — Desk-research baseline + inspection runbook: write the public WASAPI process-loopback baseline (API surface, min build 20348, macOS-driver contrast, Electron multi-process complication) into the `02-FINDINGS.md` skeleton, and author the copy-pasteable `02-RECON-RUNBOOK.md` the developer will run on their Windows box. Autonomous (no machine access needed). (D-02, D-05)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 02-02-PLAN.md — Human checkpoint + findings synthesis: the developer executes the runbook on their physical Windows box and records raw observations (`02-RECON-OBSERVATIONS.md`), then `02-FINDINGS.md` is finalized — mechanism verdict + evidence, replication parameters (excluded process tree, build + fallback), and the clean-room go/no-go feeding the deferred D-06 implementation decision. Not autonomous (requires the developer's Windows box). (D-04, D-05, D-08, D-09)

### Phase 3: Delivery-Path Spike — PCM → MediaStream (GO/NO-GO)

**Goal**: Prove the ONE genuine architectural unknown before any native investment: that audio originating outside Discord's own pipeline can be driven through Electron 41.3.0 into the Discord web client's `getDisplayMedia` MediaStream and be heard by a remote viewer. Discord's native client never had to solve this (it owns its own audio pipeline); GoofCord wraps the WEB client, so this PCM→MediaStream bridge is GoofCord-specific and is the make-or-break of the native fix. The spike uses a stub / synthetic audio source (e.g. a generated tone or a fixed PCM buffer) — NO clean-room native WASAPI code yet — to isolate the delivery path. It resolves which mechanism works in this exact Electron/Chromium build (Option B `MediaStreamTrackGenerator` / Insertable Streams vs. a Web Audio `MediaStreamAudioDestinationNode` fallback, fed over IPC from the main process), and ends in an explicit GO/NO-GO gate for the native path.
**Mode:** spike
**Depends on**: Phase 2 (clean-room GO verdict + integration shape from `02-FINDINGS.md` and the v1.1 research)
**Requirements**: (none owned — de-risk gate that proves the delivery path for ECHO-01; ECHO-01 is owned and delivered in Phase 4)
**Success Criteria** (what must be TRUE):

  1. On a Windows x64 CI build (`.github/workflows/testBuild.yml`), with a synthetic/stub audio source (not the real WASAPI capture), a second-device viewer **hears** the injected test audio in a live Discord screenshare — proving end-to-end PCM → renderer track → `getDisplayMedia` MediaStream → viewer works. (Manual, viewer-side; the streamer cannot self-verify because Electron mutes local echo.)
  2. The spike records, in `screenshare-debug.log` (userData file — no DevTools, per the 60%-keyboard constraint), exactly which delivery mechanism succeeded in Electron 41.3.0's bundled Chromium: `MediaStreamTrackGenerator` (Insertable Streams) availability is confirmed or refuted, and the working transport (chunked `ArrayBuffer`/transferable IPC vs. the Web Audio destination-node fallback) is named.
  3. An explicit, written **GO/NO-GO decision** is produced: GO = a viable, upstream-shaped delivery path is proven and named (the path Phase 4 will wire the real capture into); NO-GO = no path delivers audio without a kernel/virtual-audio driver, which would force a milestone re-scope (documented, not silently absorbed).
  4. The spike touches no Linux/macOS code path and leaves the existing Windows `"loopback"` behaviour intact behind the experiment — it is additive, throwaway-where-possible scaffolding, and any code kept is marked for the Phase 4 integration.

**Plans**: 3 plans

Plans:
**Wave 1**

- [x] 03-01-PLAN.md — Main-process plumbing: new `screenshareDebug.ts` with `appendScreenshareDebug<IPCHandle>` (userData `screenshare-debug.log` writer) + `isDeliverySpikeEnabled<IPCOn>` (`GOOFCORD_DELIVERY_SPIKE` env/argv gate), regenerated IPC, and two `goofcord` bridge fields (`deliverySpike` + `appendScreenshareDebug`)

**Wave 2** *(blocked on Wave 1)*

- [x] 03-02-PLAN.md — Packaged spike renderer module + gated main-world injection: `spike-loaded` reachability log, MSTG-probe→Web-Audio reconstruction of a distinctive 48k/stereo/f32 track, swap-seam injection at `screensharePatch.ts:79-84`, `RTCRtpSender` capture + `getStats()` poll, STREAM_CLOSE teardown — shipped from `ts-out/**` via `webFrame.executeJavaScript` (NOT the downloaded `postVencord.js`)

**Wave 3** *(blocked on Wave 2 — has human checkpoint)*

- [x] 03-03-PLAN.md — Manual verification runbook + the terminal GO/NO-GO verdict (`03-FINDINGS.md`): trigger the Windows x64 CI build, confirm `spike-loaded` reachability, run the second-device audible test, read `getStats`, and write the evidence-backed GO/NO-GO decision naming the working path (GO) or Option A (NO-GO) plus the main→renderer transport residual risk for Phase 4

### Phase 4: Native Clean-Room Exclude-Tree Addon + Integration

**Goal**: Build and integrate the actual echo fix — a venbind-style prebuilt `.node` addon (Rust + napi-rs + the `windows` crate) that performs WASAPI process-tree EXCLUDE loopback of GoofCord's own Electron process tree, replacing the whole-mix `"loopback"` capture so the call audio is no longer echoed to viewers. The addon is clean-room from the public Microsoft `ApplicationLoopback` sample (MIT — copyright notice retained), never from Discord code. It is wired into `screenshare.ts`'s Windows audio branch as an explicit additive 3-way gate (Linux patchcord → Windows native exclude-tree → existing `"loopback"` fallback), delivering captured PCM into the stream via the path proven GO in Phase 3. The exclude target is GoofCord's root Electron PID (resolved via `app.getAppMetrics()`), so the separate Audio Service utility child process is covered by the tree semantics. Activation is gated dynamically (`LoadLibrary`/`GetProcAddress`, not static link) so the `.node` loads on all Windows builds and only *activates* the native path where the API is present (Win10 2004 / 19041+), degrading gracefully to today's `"loopback"` everywhere else.
**Mode:** mvp
**Depends on**: Phase 3 (GO verdict + proven delivery path)
**Requirements**: ECHO-01, ECHO-02, ECHO-03, ECHO-04
**Success Criteria** (what must be TRUE):

  1. On a Windows x64 CI build, when a user screenshares with audio while a call is live and non-call audio is playing, a second-device viewer **hears** the shared desktop/app audio but does **NOT** hear the Discord call echoed back — confirmed viewer-side (the core #46 fix). [ECHO-01]
  2. `screenshare-debug.log` shows the native exclude-tree path **activated** on a current Windows build (Win10 2004 / 19041+ and Windows 11), with the excluded root PID logged and the Audio Service PID confirmed within its `app.getAppMetrics()` subtree (so the exclude actually covers where call audio plays). [ECHO-02]
  3. Existing behaviour is preserved with no regression: Linux patchcord audio still works, macOS is untouched, and on any Windows build where the per-process API is unavailable the code falls through to today's `"loopback"` with no crash and no worse-than-current behaviour — the `.node` `require()`s and reports "unsupported" rather than throwing. [ECHO-03]
  4. The native capability is implemented clean-room from the public Microsoft `ApplicationLoopback` sample with Microsoft's MIT copyright notice retained in the addon source; no Discord symbol layout (`ActivateApplicationLoopbackForProcessTree`, `excludedSubtrees`, etc.) is used as a recipe, and the addon hardcodes a fixed `WAVEFORMATEX` (no `GetMixFormat` on the loopback device). [ECHO-04]
  5. The addon loads under Electron 41.3.0 (N-API, verified by an in-Electron smoke call — not just bare Node) and is packaged into the Windows artifact (`copyNativeModules()` entry + `nativeModulePlugin` glob name match + electron-builder inclusion), with a CI packaging assertion that the `.node` is present in the build output. [ECHO-01, ECHO-03]

**Plans**: TBD

### Phase 5: Verification + Upstream PR

**Goal**: Honestly close the milestone and produce the upstream contribution. Because the fix cannot be self-verified by the streamer (Electron mutes local echo) and WASAPI loopback yields silence on an idle endpoint, verification is a first-class deliverable: a structured manual loop on a real Windows CI build, viewer-side (second account/device) with non-call audio actively playing, confirming BOTH (a) the viewer hears desktop audio and (b) the viewer hears no echoed call. Then strip all diagnostic instrumentation (`screenshare-debug.log` probes, branch/PID logging) and shape two upstream-ready artifacts: the surgical GoofCord-side diff (additive 3-way dispatch, new `wasapiLoopback.ts`, one `copyNativeModules()` entry, regenerated IPC — no Discord symbols cited, MS copyright retained) and the separate prebuilt-`.node` addon repo (venbind-style per-platform prebuilds + its own CI).
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: UPST-02
**Success Criteria** (what must be TRUE):

  1. A completed verification report (per the PITFALLS.md two-device + CI protocol) records, on a real Windows build: the detected build number and native-branch-activated log line, the excluded root PID with the Audio Service PID in its subtree, a second-device viewer hearing desktop audio AND no call echo with audio actively playing, the dev-box graceful-fallback check (loads + reports "unsupported", no regression), and Linux patchcord + macOS non-regression. (This re-confirms ECHO-01 end-to-end.)
  2. All diagnostic instrumentation is stripped from the shipped code — no `screenshare-debug.log` probes or branch/PID dumps remain in the upstream diff (at most one intentional, conventional "unsupported on this build, using fallback" log line). [UPST-02]
  3. The GoofCord-side change is a surgical, upstream-PR-ready diff: native code ships via the existing prebuilt-`.node` pattern (a separate addon repo publishing per-platform prebuilds, copied by `copyNativeModules()`); the in-repo footprint is the additive `screenshare.ts` gate, `wasapiLoopback.ts`, one build-script entry, one `optionalDependencies` line, and regenerated IPC — with no Linux/macOS regression. [UPST-02]
  4. The separate native addon repo is shaped for publication: clean-room from the public Microsoft sample (MIT notice retained, no Discord symbols), builds its prebuilt `.node` on a `windows-latest` runner in its own CI, and ships per-platform/arch prebuilds named to match the `nativeModulePlugin` glob (`wasapi-loopback-win32-x64.node`). [UPST-02]

**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Fix Bug A — Cancel then Restart Works | 2/2 | Complete | 2026-05-30 |
| 2. Fix Bug B — Windows Loopback Audio Captured | 2/2 | Complete | 2026-05-30 |
| 3. Delivery-Path Spike — PCM → MediaStream (GO/NO-GO) | 3/3 | Complete    | 2026-06-02 |
| 4. Native Clean-Room Exclude-Tree Addon + Integration | 0/0 | Not started | - |
| 5. Verification + Upstream PR | 0/0 | Not started | - |
