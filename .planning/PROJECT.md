# GoofCord — Windows Streaming Fixes (Fork)

## What This Is

A fork of GoofCord (an Electron-based custom Discord client that wraps Vencord) whose purpose is to fix **Windows screenshare/streaming bugs** that affect the upstream project. Fixes are intended to be clean and minimal so they can be **submitted back upstream** to the main GoofCord repo. This milestone targets one in-flight bug plus a closely-related Windows audio issue — it is a focused bug-fix fork, not a feature fork.

## Core Value

On Windows, a user can start a screenshare, cancel the source picker, and start again — and the stream works — without the app getting stuck or requiring a restart. If everything else fails, restarting a stream after cancelling must work.

## Current Milestone: v1.1 — Windows Screenshare Echo Fix

**Goal:** On Windows, a user can screenshare system/app audio without remote viewers hearing the call echoed back to them (Bug B / upstream #46).

**Target features (approach decided by research):**
- Remove GoofCord's own call playback from the captured loopback audio (per-process / process-tree EXCLUDE), so viewers stop hearing themselves.
- The implementation path is chosen from evidence during research: a native WASAPI exclude-tree `.node` addon, a user-side separate-output-device workaround, or a hybrid (native where Windows build ≥ 20348, documented fallback below it).
- Graceful behavior on Windows builds < 20348 (the public process-loopback API's minimum).
- A verification path that does not depend on the maintainer's Win10 19045 dev box (Windows CI build + second device, verified viewer-side with audio actively playing).

**Builds on:** Phase 2 recon — `02-FINDINGS.md §3` (clean-room GO, conditional on build ≥ 20348) is the go/no-go input. Clean-room boundary is LOCKED: public Microsoft `ApplicationLoopback` API only, never copied Discord code.

## Requirements

### Validated

<!-- Inferred from the existing codebase (see .planning/codebase/). These already work and are relied upon. -->

- ✓ Electron-based Discord client wrapping Vencord (main / preload / renderer model) — existing
- ✓ Custom screenshare source picker window via `session.setDisplayMediaRequestHandler` (`src/windows/screenshare/screenshare.ts`) — existing
- ✓ Renderer-side `getDisplayMedia` patch applying resolution / framerate / content-hint settings (`src/windows/main/renderer/postVencord/screensharePatch.ts`) — existing
- ✓ Cancelling the picker no longer throws an uncaught error — translated to `NotAllowedError` DOMException (`710cfde`, Closes #196) — existing
- ✓ Screenshare audio routing: PipeWire/PulseAudio (`patchcord`) on Linux, Electron `"loopback"` on Windows — existing
- ✓ Windows x64 distribution + a CI workflow that builds a Windows x64 artifact for verification (`d606bc0`) — existing
- ✓ After cancelling the source picker, the second start-stream click re-opens the picker and the stream restarts normally — exactly-once `finishRequest()` teardown consolidation in `screenshare.ts` + the existing `NotAllowedError` cancellation name (Validated in Phase 1: Fix Bug A, `88baaf2`; Windows CI build 26673048740 confirmed cancellation error-free and restart working)
- ✓ The not-reset-on-cancel state was identified and cleaned: per-request teardown was racing/duplicating the Electron `callback` across the select/cancel and window-`closed` paths; consolidated into single-owner exactly-once `finishRequest(wcId, result)` with the `activeRequests` map-delete as the idempotency token (Validated in Phase 1: Fix Bug A)
- ✓ Windows echo mechanism identified (recon): Discord uses the public WASAPI Application Loopback API (EXCLUDE process-tree, dynamically loaded), not a virtual-device driver; clean-room replication is viable from the public Microsoft `ApplicationLoopback` sample, conditional on build ≥ 20348 (Validated in Phase 2: Bug B recon; see `02-FINDINGS.md`)
- ✓ Delivery path proven — GO (de-risk spike): a renderer-reconstructed non-Discord audio track (`MediaStreamTrackGenerator`, confirmed working on Electron 41.3.0 / Chrome 146) swapped into `getDisplayMedia` at the `screensharePatch.ts` seam is heard by a remote viewer on a Windows x64 CI build (run 26740748142). This is the make-or-break for the native echo fix; the remaining main→renderer PCM transport (chunked transferables, never per-frame `ipcRenderer.send`) is the named Phase 4 residual risk (Validated in Phase 3: Delivery-Path Spike; see `03-FINDINGS.md`)

### Active

<!-- This fork's goals for this milestone (v1.1). Hypotheses until shipped and verified on Windows. -->

- [ ] On Windows, screensharing system/app audio does NOT echo the call back to viewers (Bug B / #46) — v1.1 echo fix; approach (native exclude-tree addon vs. user-side workaround vs. hybrid) decided by research
- [ ] Graceful behavior on Windows builds < 20348 (below the public process-loopback API minimum)
- [ ] All fixes are kept minimal and conventional enough to submit as upstream PRs (no Linux/macOS regressions)

### Out of Scope

- Broader multi-bug "Windows streaming campaign" beyond cancel/re-click + audio — keep this milestone tight; revisit as a new milestone if more bugs surface
- Linux / macOS streaming behaviour — this fork is Windows-focused (don't regress them, but don't chase them)
- New streaming features (e.g., new quality options, new UI) — this is a bug-fix fork, not a feature fork
- Burning down the broader codebase tech-debt list in `.planning/codebase/CONCERNS.md` (ts-suppressions, QuickCSS CDN hack, etc.) — unrelated to streaming
- Rewriting the screenshare architecture — fixes should be surgical and upstream-friendly

## Context

- **Brownfield fork.** Upstream is `io.github.milkshiift.GoofCord`. A codebase map already exists in `.planning/codebase/` (ARCHITECTURE, STACK, CONCERNS, etc., mapped 2026-05-28).
- **Relevant code paths:**
  - `src/windows/screenshare/screenshare.ts` — main-process display-media handler, picker `BrowserWindow`, `activeRequests` map, `selectScreenshareSource` / `refreshScreenshareSources` IPC, cancel path calls `callback({})`.
  - `src/windows/main/renderer/postVencord/screensharePatch.ts` — renderer monkeypatch of `navigator.mediaDevices.getDisplayMedia`; now re-throws cancellation as `NotAllowedError`.
- **The bug chain so far:** Cancelling the picker → `callback({})` → Electron rejects `getDisplayMedia` with a generic error → previously surfaced as an uncaught error in Discord's web client. Fix `710cfde` re-throws it as a `NotAllowedError` so Discord swallows it. **Remaining symptom:** after that suppression, a second "start stream" click produces no picker at all — suggesting stream-start state (renderer or main process) is left in a stuck/in-flight condition and never reset for the next request.
- **Note on the encryption double-reload bug and other items in CONCERNS.md** — out of scope; this is purely streaming.

## Constraints

- **Tech stack**: Electron 41.3.0, TypeScript 6.x (strict, `noEmit`), Bun (runtime + bundler + package manager), Preact for settings UI — must work within the existing build (`build/build.ts`), no new build tooling.
- **Compatibility / Upstream**: Fixes must be **PR-ready for the main GoofCord repo** — follow existing conventions, minimize divergence, keep diffs surgical. Avoid fork-only hacks that couldn't be upstreamed.
- **Platform**: Bug is **Windows-specific** behaviour (`desktopCapturer`, `setDisplayMediaRequestHandler`, `"loopback"` audio). Must not regress Linux (patchcord) or macOS paths.
- **Verification**: No automated repro for screenshare on Windows. Verification is **manual**: trigger the Windows x64 CI build (`.github/workflows/testBuild.yml`) and test the picker/cancel/re-click flow by hand.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Scope = cancel/re-click bug + Windows audio capture only | Keep the milestone tight and shippable; avoid an open-ended bug campaign | — Pending |
| Fixes must be upstream-able (PR-ready for main repo) | This fork exists to feed fixes back upstream, not to diverge | — Pending |
| Verify via Windows x64 CI artifact + manual test | No reliable automated screenshare repro on Windows | — Pending |
| Build the cancellation-error fix as `NotAllowedError` (already shipped in `710cfde`) | Matches the standard browsers raise on cancellation so Discord ignores it | ⚠️ Revisit — stopped the crash but introduced/exposed the re-click failure |
| [v1.1] Echo-fix approach (D-06) decided by research, not pre-committed | Genuine native-addon-vs-workaround uncertainty + a verification constraint (dev box is build 19045, below the API minimum) — decide from evidence | — Pending (research-first) |
| [v1.1] Native exclude-tree path cannot be verified on the maintainer's box | Public process-loopback API needs build ≥ 20348; dev box is Win10 19045 — verification must use Windows CI + a second device, viewer-side, audio playing | — Pending |
| [v1.1] Delivery-path spike verdict = GO (Phase 3) | Prove PCM → renderer track → `getDisplayMedia` → viewer before any native investment | ✓ GO — `MediaStreamTrackGenerator` works on Chrome 146; renderer swap-seam delivery confirmed viewer-side on Windows CI; Phase 4 owns the main→renderer transport |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-06-02 — Phase 3 (Delivery-Path Spike) complete: GO verdict — MSTG → `getDisplayMedia` → viewer delivery proven on Windows x64 CI (run 26740748142, Chrome 146). Next: Phase 4 (native clean-room exclude-tree addon + integration); main→renderer PCM transport is the carried residual risk.*
