# GoofCord — Windows Streaming Fixes (Fork)

## What This Is

A fork of GoofCord (an Electron-based custom Discord client that wraps Vencord) whose purpose is to fix **Windows screenshare/streaming bugs** that affect the upstream project. Fixes are intended to be clean and minimal so they can be **submitted back upstream** to the main GoofCord repo. v1.0–v1.1 were a focused bug-fix fork (cancel/restart + Windows audio echo), not a feature fork.

As of **v1.2**, the fork also runs occasional **viability-investigation milestones** — exploratory triage that assesses candidate improvements against the codebase and existing options *before* any build commitment. This does not commit the fork to becoming a feature fork; it decides, with evidence, which (if any) ideas earn a build milestone.

## Core Value

On Windows, a user can start a screenshare, cancel the source picker, and start again — and the stream works — without the app getting stuck or requiring a restart. If everything else fails, restarting a stream after cancelling must work.

## Current State

**Shipped v1.1 — Windows Screenshare Echo Fix (2026-06-06).** Both milestones are complete and contributed back upstream:

- **v1.0 — Windows Streaming Fixes** (Phases 1–2): Bug A (cancel-the-picker-then-restart wedge) fixed via an exactly-once `finishRequest(wcId, result)` teardown consolidation plus the kept `NotAllowedError` cancellation re-throw. Bug B was retargeted to a recon-only investigation that identified Discord's Windows per-process audio mechanism — the public WASAPI Application Loopback API, EXCLUDE process-tree, dynamically loaded (`02-FINDINGS.md`).
- **v1.1 — Windows Screenshare Echo Fix** (Phases 3–5): the #46 echo fix shipped. A clean-room Rust + napi-rs WASAPI EXCLUDE-process-tree `.node` addon (captures the whole endpoint mix *except* GoofCord's own Electron process tree) is wired into `screenshare.ts`'s Windows audio branch behind a proven main→renderer `MediaStreamTrackGenerator` transport, with graceful fallback to today's `"loopback"` where the API is unavailable. Verified viewer-side on a Windows x64 CI build (build 19045): the viewer hears shared desktop audio with **no** call echo; `--no-wasapi` A/B confirms the suppression is attributable to the EXCLUDE-tree path.

**Upstream PRs open:** #211 (Windows echo fix, Closes #46) and #210 (Wayland xdg-portal-cancel re-open). The native addon ships as a separate prebuilt-`.node` repo (`thomas-quant/wasapi-loopback`, MIT, clean-room) consumed via one `optionalDependencies` line — the venbind/patchcord pattern.

## Current Milestone: v1.3 — Small Upstream-able Fixes

**Goal:** Ship the two surgical, upstream-able fixes surfaced by the v1.2 investigations, plus one optional security one-liner. Each is small, self-contained, and PR-ready for upstream.

**Fixes (Phases 10-12):**
- **KEY-01 — Keybinds non-alphanumeric (Phase 10):** replace `String.fromCharCode(domKeyCode)` at `preload/keybinds.ts:53` with a DOM-keyCode→char map so OEM/punctuation binds (`]` `;` etc.) register and fire on Windows. Pure-TS, no native work. *(From INV-02.)*
- **STREAM-05 — Occluded-window flag typo (Phase 11):** fix `main.ts:67` `disable-disable-backgrounding-occluded-windows` → `disable-backgrounding-occluded-windows` so the intended anti-throttling switch actually applies on Windows (stream stability). *(From INV-04 byproduct.)*
- **SEC-01 — cloudToken encryption (Phase 12, optional/stretch):** mark `cloudToken` `encrypted: true` (the only cleartext secret). Deferred pending read-timing verification + user go-ahead. *(From INV-01.)*

> v1.2 (Feature Viability Investigations) completed 2026-06-07 — 4 verdicts; see MILESTONES.md + Key Decisions. Earlier candidate **WSTRM-01** (further Windows streaming bugs) remains deferred.

<details>
<summary>Archived: v1.1 milestone goal (in progress)</summary>

**Goal:** On Windows, a user can screenshare system/app audio without remote viewers hearing the call echoed back to them (Bug B / upstream #46).

**Target features (approach decided by research):**
- Remove GoofCord's own call playback from the captured loopback audio (per-process / process-tree EXCLUDE), so viewers stop hearing themselves.
- The implementation path is chosen from evidence during research: a native WASAPI exclude-tree `.node` addon, a user-side separate-output-device workaround, or a hybrid.
- Graceful behavior on Windows builds where the public process-loopback API is unavailable.
- A verification path that does not depend on the maintainer's Win10 19045 dev box (Windows CI build + second device, verified viewer-side with audio actively playing).

**Builds on:** Phase 2 recon — `02-FINDINGS.md §3` (clean-room GO). Clean-room boundary was LOCKED: public Microsoft `ApplicationLoopback` API only, never copied Discord code.

**Outcome:** Native exclude-tree addon chosen and shipped; the "20348" minimum proved over-stated (the API works on the 19041/2004 floor — verified on the 19045 dev box). User-side workaround was explicitly rejected as a deliverable (native-only).
</details>

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

- ✓ On Windows, screensharing system/app audio does NOT echo the call back to viewers (Bug B / #46) — v1.1 (native WASAPI EXCLUDE-process-tree `.node` addon replacing whole-mix `"loopback"`; verified viewer-side on Windows x64 CI build 19045, runs 27053219078 + 27054703843 — viewer hears desktop audio, no call echo) [ECHO-01/ECHO-02]
- ✓ Graceful behavior on Windows builds where the per-process API is unavailable — v1.1 (falls back to today's `"loopback"`; `--no-wasapi` A/B confirmed the fallback track stays audible — no crash, no silence) [ECHO-03]
- ✓ Native capability is clean-room from the public Microsoft `ApplicationLoopback` sample (MIT notice retained, no Discord symbols) — v1.1 [ECHO-04]
- ✓ Fixes kept minimal and conventional enough to submit upstream, no Linux/macOS regression — v1.1 (surgical additive 3-way `screenshare.ts` gate + `wasapiLoopback.ts` + one `optionalDependencies` line + regenerated IPC; native ships via the prebuilt-`.node` pattern like venbind/patchcord; PR #211 Closes #46) [UPST-02]

### Active

<!-- v1.3 build milestone (open). v1.2 investigation outcomes retained below for traceability. -->

**v1.3 — Small Upstream-able Fixes (Phases 10-12):**
- [ ] **KEY-01**: Non-alphanumeric (OEM/punctuation) global keybinds register and fire on Windows — Phase 10 (`preload/keybinds.ts:53`).
- [ ] **STREAM-05**: The Windows occluded-window anti-backgrounding switch is actually applied (flag-name typo) — Phase 11 (`main.ts:67`).
- [ ] **SEC-01** *(stretch, deferred)*: `cloudToken` encrypted at rest — Phase 12 (pending read-timing check + go-ahead).

**v1.2 — Feature Viability Investigations (complete 2026-06-07 — verdicts, not implementations):**
- [x] **INV-01**: Encryption-hardening viability assessment — **NO-GO** (crypto already sound; secrets are safeStorage/DPAPI ciphertext, not plaintext). Optional S micro-PR: `cloudToken`→`encrypted:true`. Phase 6 (`06-FINDINGS.md`).
- [x] **INV-02**: Keybinds non-alphanumeric viability assessment — **GO (S)**. Root cause = `String.fromCharCode(domKeyCode)` in `preload/keybinds.ts:53` (not venbind); ~15-line pure-TS map. Phase 7 (`07-FINDINGS.md`).
- [x] **INV-03**: Deafen/mute mechanism recon — **NO-GO** (inherited Discord-web/Chromium ducking; GoofCord touches no audio graph). Phase 8 (`08-FINDINGS.md`).
- [x] **INV-04**: Resource-usage / Electron-optimization viability assessment — **DEFER/AVOID** (thin shell; renderer dominates; Windows spends resources by design). Safe win: measure-first baseline (S). Byproduct bug: `main.ts:67` flag typo (S, streaming-correctness). Phase 9 (`09-FINDINGS.md`).

**v1.2 outcome:** 2 surgical upstream-able fixes (INV-02 keybinds, INV-04 `main.ts` typo) + 1 optional micro-PR (INV-01 `cloudToken`) → candidates for a small **v1.3** build milestone. INV-01-main and INV-03 are closed (nothing to build).

### Out of Scope

- Broader multi-bug "Windows streaming campaign" beyond cancel/re-click + audio — keep this milestone tight; revisit as a new milestone if more bugs surface
- Linux / macOS streaming behaviour — this fork is Windows-focused (don't regress them, but don't chase them)
- New streaming features (e.g., new quality options, new UI) — this is a bug-fix fork, not a feature fork
- Burning down the broader codebase tech-debt list in `.planning/codebase/CONCERNS.md` (ts-suppressions, QuickCSS CDN hack, etc.) — unrelated to streaming
- Rewriting the screenshare architecture — fixes should be surgical and upstream-friendly

## Context

- **Brownfield fork.** Upstream is `io.github.milkshiift.GoofCord`. A codebase map already exists in `.planning/codebase/` (ARCHITECTURE, STACK, CONCERNS, etc., mapped 2026-05-28).
- **Shipped state (after v1.1):** the streaming-fix surface is `screenshare.ts` (exactly-once `finishRequest` teardown + additive 3-way Linux→win32-native→`"loopback"` audio gate), `src/modules/native/wasapiLoopback.ts` (Windows EXCLUDE-tree addon loader + per-share MessageChannel transport), `screensharePatch.ts` (the `getDisplayMedia` swap seam), and one `optionalDependencies` entry for the prebuilt `wasapi-loopback` `.node`. v1.1 added ~558 net source LOC across 11 files. All diagnostic instrumentation was stripped before the PR; the shipped build writes nothing to `screenshare-debug.log`.
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
| Scope = cancel/re-click bug + Windows audio capture only | Keep the milestone tight and shippable; avoid an open-ended bug campaign | ✓ Good — both bugs fixed and shipped upstream (#210/#211); milestone stayed tight |
| Fixes must be upstream-able (PR-ready for main repo) | This fork exists to feed fixes back upstream, not to diverge | ✓ Good — surgical diffs; PRs #210 + #211 opened upstream |
| Verify via Windows x64 CI artifact + manual test | No reliable automated screenshare repro on Windows | ✓ Good — every fix verified on Windows CI artifacts; echo fix verified viewer-side with a second device |
| Build the cancellation-error fix as `NotAllowedError` (already shipped in `710cfde`) | Matches the standard browsers raise on cancellation so Discord ignores it | ✓ Good — kept; the re-click failure was a *separate* `finishRequest` teardown race, fixed in Phase 1. `NotAllowedError` itself is correct |
| [v1.1] Echo-fix approach (D-06) decided by research, not pre-committed | Genuine native-addon-vs-workaround uncertainty + a verification constraint (dev box is build 19045, below the assumed API minimum) — decide from evidence | ✓ Good — native exclude-tree addon chosen; user-side workaround rejected; shipped |
| [v1.1] Native exclude-tree path cannot be verified on the maintainer's box | Public process-loopback API was assumed to need build ≥ 20348; dev box is Win10 19045 | ✓ Resolved — the 20348 floor was over-stated; the API works on 19041/2004, so the 19045 dev box DID verify it (Windows CI + second device, viewer-side) |
| [v1.1] Delivery-path spike verdict = GO (Phase 3) | Prove PCM → renderer track → `getDisplayMedia` → viewer before any native investment | ✓ Good — `MediaStreamTrackGenerator` works on Chrome 146; renderer swap-seam delivery confirmed viewer-side on Windows CI; Phase 4 wired the real transport |
| [v1.1] Native-only scope; user-side separate-output-device workaround NOT a deliverable | User explicitly rejected the workaround for this milestone | ✓ Good — native fix shipped; no workaround needed |
| [v1.1] Ship the addon as a separate prebuilt-`.node` repo via one `optionalDependencies` line (venbind/patchcord pattern) | Keep the GoofCord-side diff surgical; match the existing native-module convention | ✓ Good — `thomas-quant/wasapi-loopback` (clean-room MIT) with its own windows-latest prebuild CI |
| [v1.1] Rebuild the WASAPI feeder/transport per share, not reuse it (post-PR fix) | 2nd-share-no-audio regression: a reused feeder went silent on the second share | ✓ Good — fixed (commit `68bfb05`); per-share rebuild restores audio on every share |
| [v1.2] Run the 4 candidate ideas as parallel investigate-only spikes (lean shell, no plan/execute loops) | User wanted viability triage with minimal ceremony; ideas are independent | ✓ Good — 4 verdicts landed in one parallel pass; surfaced 2 actionable upstream fixes + killed 2 non-starters cheaply |
| [v1.2/INV-02] Keybinds bug is GoofCord's `String.fromCharCode(domKeyCode)`, NOT venbind | Investigation traced the full path; venbind correctly Unicode-matches the physical key | ✓ Fix is a ~15-line pure-TS keyCode→char map in `preload/keybinds.ts` — most upstream-able item |
| [v1.2/INV-01] No encryption-hardening milestone | Secrets already safeStorage/DPAPI-encrypted at rest (verified on real config); crypto is correct | ✓ NO-GO; only `cloudToken`→`encrypted:true` is a defensible 1-line PR |
| [v1.2/INV-04] No general "optimize Electron" milestone | Thin shell over Discord web; renderer dominates; Windows un-throttles on purpose for streaming | ✓ DEFER; but found a real `main.ts:67` flag typo (silent no-op) worth a streaming-correctness fix |

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
*Last updated: 2026-06-07 — v1.2 investigations complete; opened **v1.3 Small Upstream-able Fixes** (build) from the GO/byproduct items: KEY-01 keybinds non-alphanumeric (`preload/keybinds.ts:53`), STREAM-05 occluded-window flag typo (`main.ts:67`), + optional SEC-01 `cloudToken`. v1.0 + v1.1 shipped (PRs #210/#211).*
