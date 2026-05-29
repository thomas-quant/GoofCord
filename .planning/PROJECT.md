# GoofCord — Windows Streaming Fixes (Fork)

## What This Is

A fork of GoofCord (an Electron-based custom Discord client that wraps Vencord) whose purpose is to fix **Windows screenshare/streaming bugs** that affect the upstream project. Fixes are intended to be clean and minimal so they can be **submitted back upstream** to the main GoofCord repo. This milestone targets one in-flight bug plus a closely-related Windows audio issue — it is a focused bug-fix fork, not a feature fork.

## Core Value

On Windows, a user can start a screenshare, cancel the source picker, and start again — and the stream works — without the app getting stuck or requiring a restart. If everything else fails, restarting a stream after cancelling must work.

## Requirements

### Validated

<!-- Inferred from the existing codebase (see .planning/codebase/). These already work and are relied upon. -->

- ✓ Electron-based Discord client wrapping Vencord (main / preload / renderer model) — existing
- ✓ Custom screenshare source picker window via `session.setDisplayMediaRequestHandler` (`src/windows/screenshare/screenshare.ts`) — existing
- ✓ Renderer-side `getDisplayMedia` patch applying resolution / framerate / content-hint settings (`src/windows/main/renderer/postVencord/screensharePatch.ts`) — existing
- ✓ Cancelling the picker no longer throws an uncaught error — translated to `NotAllowedError` DOMException (`710cfde`, Closes #196) — existing
- ✓ Screenshare audio routing: PipeWire/PulseAudio (`patchcord`) on Linux, Electron `"loopback"` on Windows — existing
- ✓ Windows x64 distribution + a CI workflow that builds a Windows x64 artifact for verification (`d606bc0`) — existing

### Active

<!-- This fork's goals for this milestone. Hypotheses until shipped and verified on Windows. -->

- [ ] After cancelling the source picker, clicking "start stream" again re-opens the picker and starts a stream normally (currently the second click does nothing — no picker window appears)
- [ ] Identify what state is not being reset on cancel (Discord renderer-side stream-start state vs. main-process `activeRequests` / `setDisplayMediaRequestHandler` lifecycle) and reset it cleanly
- [ ] Windows system/app audio (the `result.audio = "loopback"` path) is captured correctly during screenshare
- [ ] All fixes are kept minimal and conventional enough to submit as upstream PRs

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
*Last updated: 2026-05-29 after initialization*
