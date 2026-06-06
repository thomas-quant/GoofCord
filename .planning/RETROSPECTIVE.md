# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.1 — Windows Screenshare Echo Fix

**Shipped:** 2026-06-06
**Phases:** 3 (Phases 3-5) | **Plans:** 13 | **Sessions:** not precisely tracked (~spanning 2026-06-02 → 2026-06-06)

### What Was Built
- A clean-room Rust + napi-rs WASAPI EXCLUDE-process-tree `.node` addon (capture the whole endpoint mix except GoofCord's own Electron tree), built from the public Microsoft `ApplicationLoopback` sample — the #46 echo fix.
- The PCM → renderer `MediaStreamTrackGenerator` → `getDisplayMedia` swap-seam delivery path, fed by a per-share `MessageChannelMain` transport — the GoofCord-specific bridge that Discord's native client never had to solve (GoofCord wraps the *web* client).
- An additive 3-way `screenshare.ts` audio gate (Linux patchcord → win32 native exclude-tree → `"loopback"` fallback) with graceful degradation, plus the addon shipped as a separate prebuilt-`.node` repo (`thomas-quant/wasapi-loopback`) via one `optionalDependencies` line. Upstream PR #211 (Closes #46).

### What Worked
- **Spike-first gate (Phase 3) was the decisive call.** Proving the delivery path with a *synthetic* audio source — before writing any native WASAPI code — isolated the "can PCM reach a viewer?" question from the "can we capture without echo?" question. The GO verdict de-risked the entire native investment.
- **Verification-as-a-deliverable.** The streamer cannot self-verify (Electron mutes local echo), so a second-device viewer + audio-playing protocol was mandatory. The `--no-wasapi` A/B control is what made the echo suppression *dispositively* attributable to the EXCLUDE-tree path rather than some other audio-stack change.
- **Diagnostics to a userData `screenshare-debug.log`, not DevTools.** Given the dev box's 60% keyboard (no F12), routing evidence to a WSL-readable log file let checkpoint claims be audited by log signature + timeline instead of recollection.
- **Separate prebuilt-`.node` repo via `optionalDependency`** (venbind/patchcord pattern) kept the GoofCord-side diff surgical and upstream-friendly.

### What Was Inefficient
- **Windows-host build portability fought back.** Several CI round-trips to localize packaging gaps: `Bun.Glob` → `fs.readdir`, app.asar `asarUnpack` for the `.node`, and a host-agnostic `ts-out/native` copy. Native-module packaging on a Windows *build host* behaved differently from the Linux assumptions baked into the build script.
- **The renderer-bundle-fetched-from-upstream gotcha cost a detour.** `postVencord.js`/`screensharePatch.ts` are downloaded from upstream at runtime — fork edits to them silently don't run. Spike/transport code had to ship via preload-injected `ts-out` scripts (`webFrame.executeJavaScript`). Discovering this consumed time before the spike could even execute.
- **Native FFI debugging.** Real C-interop bugs surfaced: a `PROPVARIANT` Drop freeing the stack activation-params blob (heap corruption), dual capture (addon + Chromium `"loopback"`) crashing system-audio shares, and a CalleeHandled ThreadsafeFunction passing `(err, chunk)` so the chunk was in the *second* arg. Inherent to clean-room native work, but each needed a hardware round-trip.
- **No automated repro.** Every verification was a manual two-device Windows-CI loop — slow, but inherent to the domain.

### Patterns Established
- **Verification-first phase for un-self-verifiable fixes:** second-device protocol + an A/B control flag (`--no-wasapi`) to attribute the effect.
- **Spike-gates-native-investment** for GoofCord-specific unknowns that arise from wrapping the *web* client.
- **Native capability via a separate prebuilt-`.node` repo + `optionalDependency`** (mirroring venbind/patchcord) to keep upstream diffs surgical.
- **Diagnostics to a userData log file, stripped before PR via relocate-then-delete,** with a runtime strip-proof (0 new log lines on the shipping build).
- **Challenge inherited version-gate assumptions with evidence:** the "build 20348 minimum" was over-stated — the WASAPI Application-Loopback API works on 19041/2004, so the 19045 dev box could verify after all (official Discord ran echo-free there).

### Key Lessons
1. When the product wraps someone else's client, the *integration seam* (here: foreign PCM → web `getDisplayMedia`) is usually the real risk — gate it with a synthetic-source spike before building the hard part.
2. For a fix the author physically cannot observe, design the verification protocol (who's the observer, what control distinguishes the effect) as a first-class phase deliverable, not an afterthought.
3. Audit "human-only on-box" assumptions: a WSL2 box *is* the Windows machine — Windows binaries, the debug log, and `powershell.exe` were all directly inspectable, making much "manual" recon AI-doable.
4. In a fork, confirm which code actually ships (downloaded-at-runtime vs packaged) before assuming an edit runs — grep the built asar for your marker.
5. Inherited build scripts encode host assumptions; native-module packaging needs to be exercised on the *actual* build host early.

### Cost Observations
- Model mix: not tracked (no per-turn telemetry captured for this milestone).
- Sessions: not precisely tracked; work spanned 2026-06-02 → 2026-06-06.
- Notable: the bulk of wall-clock cost was hardware CI round-trips (Windows artifact + two-device manual test), not planning or codegen. Front-loading the delivery-path spike avoided the far costlier failure mode of debugging native capture and delivery simultaneously.

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change |
|-----------|----------|--------|------------|
| v1.0 | not tracked | 2 | Diagnose-then-fix with revertable instrumentation; recon-only phase for an unknown mechanism |
| v1.1 | not tracked | 3 | Added a spike GO/NO-GO gate before native investment; verification promoted to a first-class phase |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-Dep Additions |
|-----------|-------|----------|-------------------|
| v1.0 | manual (Windows CI) | N/A — no automated screenshare repro | 0 new deps |
| v1.1 | manual (Windows CI, two-device viewer-side) | N/A | 1 deliberate native dep (`wasapi-loopback`, via `optionalDependencies`, upstream-justified) |

### Top Lessons (Verified Across Milestones)

1. For Windows screenshare, **manual two-device CI verification is the ground truth** — there is no automated repro; design every fix's verification around that constraint.
2. **Surgical, upstream-shaped diffs win** — both milestones kept GoofCord-side changes minimal (exactly-once teardown; additive audio gate + one dep line) so they could be PR'd back rather than diverging the fork.
