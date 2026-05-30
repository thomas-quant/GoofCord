# Project Research Summary

**Project:** GoofCord — Windows Screenshare Echo Fix (v1.1, upstream #46)
**Domain:** Windows WASAPI process-loopback (exclude-tree) audio capture; native Electron addon integration; screenshare audio delivery pipeline
**Researched:** 2026-05-30
**Confidence:** HIGH

## Executive Summary

This milestone fixes the system-audio echo bug in GoofCord's Windows screenshare (#46): when a user shares system audio, viewers hear the call voices echoed back because Chromium's `"loopback"` mode captures the whole default-endpoint mix, including GoofCord's own call playback. The fix mechanism is already reconned and settled — the public WASAPI Application Loopback API (`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`, minimum Windows build 20348) is the correct and clean-room-viable approach, matching what Discord itself uses. The research in this round answers how to implement and ship that fix, and frames the D-06 delivery-path decision.

The recommended delivery shape is workaround-first, native-second (hybrid). The minimum shippable fix — a documented separate-output-device workaround (VB-Cable / SteelSeries Sonar / VoiceMeeter) — is near-zero code, works on all Windows builds, and is fully upstream-able today. The native WASAPI exclude-tree addon (the only approach that is invisible to the user on the common case) should be scoped as a consciously-gated P2 addition, built as a Rust + napi-rs N-API `.node` addon following the venbind template exactly. A delivery-path spike — proving that captured PCM reaches a real stream viewer-side — must gate the native investment, because the genuine architectural risk is not the capture itself but bridging native-captured audio into the renderer MediaStream. The zero-code workaround lands regardless of the spike outcome.

The dominant milestone risk is verification, not implementation. The maintainer's dev box is Windows 10 build 19045, which is below the 20348 API floor, meaning the native path is locally unverifiable. Every "it works" or "it doesn't work" signal from that machine is meaningless for the native fix. Verification requires: a Windows 11 CI-built artifact, installed on a build-≥20348 machine, with a second-device viewer present and non-call audio actively playing (WASAPI loopback yields no samples on silence). This loop must be designed into the phase plan from the start, not treated as an afterthought.

---

## Key Findings

### Recommended Stack

The integration template is venbind, not patchcord. venbind is a Rust + napi-rs N-API `.node` addon distributed as prebuilt per-platform binaries inside its npm package; GoofCord never compiles it — `copyNativeModules()` in `build/build.ts` simply copies the matching prebuild to `assets/native/`. The WASAPI addon should follow this model identically: built in its own repo's CI on `windows-latest` (no cross-compile needed), shipped prebuilt, consumed prebuilt. GoofCord's build adds nothing except a new `modules[]` entry in `copyNativeModules()` and an `optionalDependencies` line. patchcord (a subprocess binary over stdio) is the wrong shape — on Linux the OS handles the audio routing; on Windows the native module must run the WASAPI capture loop in-process.

For the native addon itself: Rust (stable, MSRV 1.82.0) + `napi` 3.x + `@napi-rs/cli` 3.6.2 + the `windows` crate (0.62.2, feature-gated to `Win32_Media_Audio / Win32_System_Com / Win32_Foundation`). The windows crate is simpler to build than venbind (no bindgen/libclang — it is metadata-generated). The workaround path needs no new stack at all: one entry in `src/settingsSchema.ts` plus a localization string.

**Core technologies:**
- **Rust + napi-rs** (addon repo only): implementation language + N-API bridge — matches both existing addons; one prebuilt `.node` per platform/arch loads in Electron 41 without `electron-rebuild` (N-API ABI stability)
- **`windows` crate 0.62.2**: safe Rust bindings to the public WASAPI process-loopback API — Microsoft-published, no clean-room risk, exact symbols from `02-FINDINGS.md §3.1`
- **Existing GoofCord pipeline** (`nativeModulePlugin`, `copyNativeModules`, `createRequire` + try/catch, `app.getAppMetrics()`): all reused verbatim; GoofCord adds zero new build tooling

**What NOT to use:**
- patchcord's subprocess model (wrong shape for in-process PCM capture on Windows)
- static linking of `ActivateAudioInterfaceAsync` (breaks load on < 20348; must use `LoadLibrary`/`GetProcAddress` dynamic resolution, mirroring Discord)
- node-gyp/cmake-js inside GoofCord's Bun build (violates "no new build tooling" constraint)
- per-Electron-version prebuilds (unnecessary — N-API is ABI-stable)

### Expected Features

**Must have (table stakes) — required to close #46:**
- Viewer no longer hears the call echoed when sharing system audio — this is the bug itself
- Desktop/game/app audio still reaches the viewer — a fix that kills all audio is a regression
- Streamer enables audio share exactly as today — no new ritual for the common case
- Graceful behavior on builds < 20348 — must not crash or silently echo; mirrors Discord's `"audioses is too old…"` fallback; required the moment any native code ships
- No regression on Linux / macOS / Phase-1 cancel→restart fix

**Should have (differentiators):**
- Native fix that is invisible (no user config) on supported builds ≥ 20348 — the only approach satisfying all four "Definition of Fixed" behaviors; parity with Discord and OBS
- A surfaced one-line sub-floor hint (log line to userData file, not a new settings screen) pointing at the workaround — cheap, actionable
- Hybrid coverage: native ≥ 20348 + documented workaround below — no user population left uncovered

**Defer (v2+) or do not build:**
- Per-app INCLUDE-capture or capture picker UI — a separate feature, maintainer-flagged out of scope
- Audio quality / bitrate / format options — the process-loopback device forces a fixed format (`GetMixFormat` → `E_NOTIMPL`); anti-feature
- Settings toggle to enable/disable the fix — implies the buggy mode is a supported choice; anti-feature
- Bundling or auto-installing a virtual-audio driver — heavy, admin-required, not upstreamable; anti-feature
- The #185 missing-audio and #204 Linux no-sound bugs — separate issues, separate phases

**Minimum shippable:** The documented separate-output-device workaround alone closes #46 with zero scope risk (surgical, all-builds, upstream-able, matching upstream's current stance). The native addon is the better fix but is consciously P2.

### Architecture Approach

The echo enters at a single line: `src/windows/screenshare/screenshare.ts:98` where `result.audio = "loopback"` captures the whole endpoint mix. The fix modifies this one branch into a 3-way gate (native exclude-tree ≥ 20348 → workaround/loopback fallback < 20348 → existing loopback on non-Windows). The patchcord analog is the load-bearing precedent for integration shape: patchcord solves the same problem on Linux by routing audio through an OS-level virtual capture device that `getUserMedia` reads as a normal microphone, never passing raw PCM into JS. The Windows API does not provide an equivalent OS-level virtual device, so the bridge from native-captured PCM to a renderer MediaStream is the genuine architectural risk — either a virtual-driver (heavy, not upstreamable) or a PCM-to-`MediaStreamTrackGenerator`/Web-Audio bridge (IPC throughput risk, more moving parts). This delivery-path question must be resolved in a spike before building the full native module.

**Major components:**
1. `src/windows/screenshare/screenshare.ts` (MODIFIED) — the gated Windows audio dispatch; gains the 3-way decision
2. `src/modules/native/wasapiLoopback.ts` (NEW) — main-process wrapper; mirrors `patchcord.ts` shape (`init`, `hasWasapiLoopback`, `start`/`stop`, build-gate detection via `LoadLibrary`/`GetProcAddress`, process-tree PID resolution via `app.getAppMetrics()`)
3. `assets/native/wasapi-loopback-win32-{x64,arm64}.node` (NEW) — prebuilt N-API addon; clean-room from Microsoft `ApplicationLoopback` sample (MIT); hardcoded fixed format (no `GetMixFormat`)
4. `src/windows/main/renderer/postVencord/screensharePatch.ts` (MODIFIED, conditionally) — only if delivery is via a virtual-device label (generalize `getVirtmic()`) or a reconstructed MediaStream track
5. `build/build.ts` `copyNativeModules()` (MODIFIED) — add third module entry; mirror venbind exactly

**Process-tree exclusion target:** GoofCord/Electron root PID (`process.pid`), not the window PID. The Audio Service utility process is a Chromium-sandboxed child; `EXCLUDE_TARGET_PROCESS_TREE` covers it when the root is excluded. `app.getAppMetrics()` (already used by `patchcord.ts:80`) resolves this at runtime. The parent/child relationship on Electron 41.3.0 is an open implementation detail that must be confirmed via logged `getAppMetrics()` output on a ≥ 20348 CI artifact.

**Non-regression boundaries (must not touch):**
- Linux patchcord branch in `screenshare.ts:91-96` — sibling dispatch, not a shared abstraction
- Existing Windows `"loopback"` fallback — must remain the universal fallback for < 20348, macOS, and load failures
- Phase-1 cancel→restart fix — unrelated code path, must stay intact

### Critical Pitfalls

1. **"No echo on my box" false pass (V1 — milestone-killer):** The 19045 dev box silently takes the fallback branch (native path never runs); Electron hardcodes `disable_local_echo` so the streamer never hears echo anyway. "Tested locally, no echo" is structurally incapable of confirming the fix. Prevention: add a build-number + branch-taken log line to `screenshare-debug.log` (userData file, no DevTools) at activation; treat the dev box as fallback-tester only; require a Win11 machine for every native-path verification claim.

2. **Wrong verification setup — streamer-side or silent desktop (V2, V3):** The bug manifests viewer-side; the streamer cannot hear echo (Electron mutes local playback). Verifying from the streaming machine produces a guaranteed false pass regardless of code state. Additionally, WASAPI loopback delivers no samples when nothing is playing — silence cannot distinguish a working exclude from a broken capture. Prevention: all echo-fix verification is viewer-side (second Discord account, separate device); keep non-call audio actively playing during the test; confirm both (a) viewer hears desktop audio and (b) viewer does not hear echoed call voices.

3. **`.node` not packaged / silently falls back (V4, M3):** The native-module pipeline has three independent stages (prebuild in `node_modules`, `copyNativeModules()` entry, `nativeModulePlugin` glob name match); a miss in any one degrades silently to the fallback with no error. Prevention: mirror venbind naming exactly (`<name>-win32-x64.node`); add a CI packaging assertion after build; add a startup null-check log.

4. **Excluding the wrong process — single PID instead of tree (V6):** Passing the main window PID still captures the call because the Audio Service runs in a separate sandboxed child process. Only `EXCLUDE_TARGET_PROCESS_TREE` on the root PID covers it. Prevention: pass `process.pid` (Electron main process) as the exclude root; confirm Audio Service is in its subtree via logged `app.getAppMetrics()` output on a ≥ 20348 run; do not use the window/renderer PID.

5. **`GetMixFormat`/`IsFormatSupported` return `E_NOTIMPL` (T1):** The process-loopback "magic device" (`VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`) does not support format negotiation. A copy-pasted generic WASAPI capture loop bails immediately at the HRESULT check, looking like a build-gate or packaging failure. Prevention: hardcode a fixed `WAVEFORMATEX` (CD-quality 2ch/16-bit/44100 Hz per Microsoft Q&A 1125409); follow the `ApplicationLoopback` sample's initialization path, not a generic WASAPI tutorial; never call `GetMixFormat` on this device.

6. **Static-linking the loopback API breaks load on < 20348 (T2):** Statically importing `ActivateAudioInterfaceAsync` binds the symbol at load time, causing the `.node` to fail to `require()` on the dev box (19045) rather than loading and reporting "unsupported." Prevention: dynamically load via `LoadLibrary`/`GetProcAddress` (mirrors Discord's own approach); gate activation on both `process.platform === "win32"` and detected build ≥ 20348; confirm the `.node` loads and reports "unsupported" on the 19045 box.

7. **Clean-room contamination from Discord's DLL (C1):** The recon read `discord_voice.node` to determine which API; using Discord's internal symbol layout as an implementation recipe contaminates the clean-room boundary and poisons the upstream PR. Prevention: implement solely from the public Microsoft `ApplicationLoopback` sample (MIT — retain Microsoft's copyright notice); cite only public MS documentation; no Discord symbol names in source or PR description.

---

## Implications for Roadmap

Based on combined research, the recommended phase structure is four phases with a clear dependency order driven by the unverifiable-locally constraint and the delivery-path uncertainty.

### Phase 1: Workaround + Scaffolding (minimum shippable, all builds)

**Rationale:** The workaround (documented separate-output-device routing) is the only fix that works on all builds, is near-zero code, and is upstream-able immediately. Shipping it first closes #46 in the minimal, surgical sense that upstream already endorses — and it is the mandatory < 20348 fallback that must exist regardless of the native decision. The scaffolding (build-gate detection, 3-way dispatch structure in `screenshare.ts`, stub `wasapiLoopback.ts` with build-number logging to `screenshare-debug.log`) can land in the same phase without any native code and verifies that the fallback path still works on the dev box.

**Delivers:** Documented workaround (docs + optional settings hint); gated dispatch in `screenshare.ts` that falls through to existing `"loopback"` in all cases (no behavior change yet); build-gate detection logging to `screenshare-debug.log`; CI packaging assertion for the (stubbed) native module slot.

**Addresses:** Table-stakes features — graceful behavior < 20348, no regression on Linux/macOS, workaround documentation.

**Avoids:** Pitfalls V1 (scaffolds the branch-taken log), V4 (establishes the packaging assertion), T2 (establishes dynamic-load pattern from the start), T4 (establishes the additive 3-way dispatch before native code exists).

**Research flag:** Standard patterns — no research phase needed. All integration points are fully documented; workaround is zero-code.

### Phase 2: Delivery-Path Spike (de-risk gate for native investment)

**Rationale:** The genuine architectural risk is not the WASAPI capture (settled) but getting captured PCM into the renderer MediaStream. patchcord's virtual-device approach (Option A) is the clean shape but requires bridging — either a virtual audio driver (heavy, not upstreamable) or a PCM-to-`MediaStreamTrackGenerator`/Web Audio path (IPC throughput risk). Neither is as cheap as Linux's PipeWire virtual sink. Spending engineering effort on the full native module before knowing which delivery path works is the highest-leverage mistake to avoid. This phase is a minimal end-to-end prototype: capture a few seconds of exclude-tree audio on a build-≥20348 CI artifact and get it audible viewer-side in a real stream.

**Delivers:** Go/no-go decision on the native path; if go, a proven delivery path (Option A virtual-device or Option B PCM bridge); identification of which renderer-side code changes are actually needed.

**Uses:** Rust + napi-rs + windows crate (addon repo only); existing `copyNativeModules()` + `nativeModulePlugin` + `native-module:` import pipeline; `app.getAppMetrics()` for PID resolution; `screenshare-debug.log` for delivery-path diagnostics.

**Avoids:** Pitfall V5 (batches all unknowns into the minimal number of CI round-trips); architectural dead-end of committing to a PCM bridge whose IPC throughput is later found inadequate.

**Research flag:** Needs spike. `MediaStreamTrackGenerator` availability in Electron 41.3.0's specific Chromium build must be confirmed before choosing Option B. Option A virtual-device feasibility without a kernel driver must be prototyped, not assumed.

### Phase 3: Native Addon (full implementation, ≥ 20348)

**Rationale:** Only after the delivery-path spike confirms a viable end-to-end route should the full native module be built. This phase implements the clean-room WASAPI exclude-tree capture (from the Microsoft `ApplicationLoopback` sample, MIT), wires the chosen delivery path, resolves the process-tree PID correctly, and completes the integration (IPC codegen, `STREAM_CLOSE` teardown, `stopWasapiLoopback`, bridge.ts, electron-builder packaging).

**Delivers:** The `wasapi-loopback-win32-x64.node` addon (clean-room); `src/modules/native/wasapiLoopback.ts` (full implementation); renderer-side delivery path; complete teardown wiring; Electron-ABI smoke test in CI.

**Implements:** `wasapiLoopback.ts` (mirrors patchcord.ts shape); updated `screensharePatch.ts` (delivery-path dependent); `copyNativeModules()` third entry; IPC codegen regeneration.

**Key implementation constraints:**
- Fixed `WAVEFORMATEX` hardcoded (no `GetMixFormat` — T1)
- Dynamic `LoadLibrary`/`GetProcAddress` load (not static link — T2)
- N-API / napi-rs build (ABI-stable, one binary per platform/arch — T3)
- Exclude root = `process.pid`, tree confirmed via logged `app.getAppMetrics()` output (V6)
- MS `ApplicationLoopback` sample only; Microsoft copyright notice retained (C1)
- Async activation — wait on completion handler; idempotent `stop` with dispose-timeout (T5)

**Research flag:** Standard patterns for the capture side (settled from recon). Delivery path resolved in Phase 2. No additional research phase needed.

### Phase 4: Verification + Upstream PR Prep

**Rationale:** Because local verification cannot exercise the native path, a structured verification loop is a first-class phase deliverable — not optional cleanup. It must use the Windows 11 CI artifact on a ≥ 20348 machine, a second-device viewer, and actively-playing non-call audio.

**Delivers:** Verified fix (both viewer-hears-desktop-audio and viewer-does-not-hear-echo confirmed); fallback-path verification on dev box (19045 graceful-degradation); non-regression confirmation (Linux patchcord, macOS, pre-Win11 Windows); instrumentation stripped; upstream-PR-shaped diff (surgical, no Discord symbols cited, MS copyright retained, workaround documented as < 20348 fallback).

**Verification checklist (all must pass):**
- `screenshare-debug.log` on Win11 shows `native exclude-tree activated` + build ≥ 20348 (not fallback) — V1
- Excluded root PID's subtree contains Audio Service PID from `app.getAppMetrics()` — V6
- Second-device viewer hears desktop audio AND no call echo, with non-call audio actively playing — V2, V3
- `.node` present in packaged artifact (CI assertion); resolved non-null at runtime — V4, M3
- `.node` `require()`s on 19045 and reports "unsupported" — T2
- In-Electron smoke call passes (not just bare Node) — T3
- Linux patchcord and macOS still work — T4

**Avoids:** M2 (instrumentation stripped before PR), W1 (workaround documented as fallback, not promoted as the fix).

**Research flag:** Standard — verification protocol is fully specified across PITFALLS.md and ARCHITECTURE.md. No research phase needed.

---

### Phase Ordering Rationale

- Phase 1 ships value immediately regardless of the native decision; it also establishes the structural integration seams (3-way dispatch, logging, packaging assertion) that make every subsequent CI round-trip informative rather than a round-trip to debug packaging.
- Phase 2 gates the expensive native investment on a known-viable delivery path. The spike is cheap to fail fast; the full module is not.
- Phase 3 can only land after Phase 2 resolves the delivery-path question. It is the only phase that requires a ≥ 20348 machine to develop against.
- Phase 4 is necessarily last but is a required deliverable — the milestone cannot be honestly closed without it.
- The workaround from Phase 1 serves double duty: it is the standalone P1 deliverable AND the < 20348 fallback that Phase 3's native code degrades to.

### Research Flags

**Needs deeper research / spike before committing:**
- **Phase 2 (delivery-path spike):** `MediaStreamTrackGenerator` availability in Electron 41.3.0's Chromium must be confirmed against the specific Chromium build bundled in Electron 41.3.0 before choosing Option B. Option A (virtual device without a kernel driver) feasibility must also be prototyped.

**Standard patterns (skip research-phase):**
- **Phase 1 (workaround + scaffolding):** all integration points fully documented; additive 3-way dispatch; packaging assertion mirrors existing venbind CI patterns.
- **Phase 3 (native addon):** WASAPI capture settled from recon; napi-rs build + distribution follows venbind 1:1; async lifecycle follows the MS sample. Only the delivery path (resolved in Phase 2) was unknown.
- **Phase 4 (verification + PR):** verification protocol fully specified; PR prep follows Phase-1 D-04/UPST-01 precedent.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | venbind/patchcord read directly from `node_modules`; `copyNativeModules` read directly from `build/build.ts`; napi-rs v3 + windows 0.62.2 verified on crates.io + npm; N-API ABI stability verified against Electron docs |
| Features | HIGH | User-facing behavior + peer analysis (Vesktop, upstream GoofCord, OBS) cross-confirmed from public issues; build-coverage facts carried from locked recon (`02-FINDINGS.md`) |
| Architecture | HIGH (capture) / MEDIUM (delivery) | Existing GoofCord audio data-flow read directly from source; patchcord analog verified; PCM-to-MediaStream delivery options (Option A/B) are based on documented mechanisms but their specific availability/cost in this Electron version is the open gap |
| Pitfalls | HIGH | WASAPI `E_NOTIMPL` + static-link + async-lifecycle gotchas verified against Microsoft docs; process-tree exclusion verified against patchcord.ts + OBS #9669; verification traps follow from locked decisions D-08/D-09 |

**Overall confidence:** HIGH on what to build and how to integrate it; MEDIUM on the single open question of which PCM delivery path is viable in Electron 41.3.0.

### Gaps to Address

- **Delivery path (Phase 2 spike — the only genuine unknown):** Whether Option A (virtual capture device without a kernel driver) or Option B (`MediaStreamTrackGenerator` / Web Audio bridge) is viable in Electron 41.3.0 is the make-or-break question for the native addon. The spike resolves it cheaply before committing to the full module. If neither path is viable without a kernel driver, the recommendation falls back to workaround-only.
- **Audio Service PID parent/child relationship on Electron 41.3.0:** `02-FINDINGS.md §2.2` flags this as an open detail — the Audio Service process is known to exist (patchcord.ts confirms it) but whether it is a descendant of `process.pid` or a detached sibling was not observed on-box. Must be confirmed via logged `app.getAppMetrics()` output on the first ≥ 20348 CI artifact. If detached, the exclude root must be chosen accordingly or the Audio Service PID excluded separately.
- **`MediaStreamTrackGenerator` in Electron 41.3.0 Chromium:** Only relevant if Option B is chosen. Verify against Electron 41.3.0's bundled Chromium version before using it; Web Audio `MediaStreamDestinationNode` is the fallback if Insertable Streams are unavailable.

---

## Sources

### Primary (HIGH confidence)
- `node_modules/venbind/` + `build/build.ts:168-232` (direct read) — venbind distribution model, `copyNativeModules()` pipeline, `nativeModulePlugin` glob matching
- `src/modules/native/{venbind,patchcord}.ts`, `src/windows/screenshare/screenshare.ts`, `src/windows/main/renderer/postVencord/screensharePatch.ts`, `src/windows/main/preload/bridge.ts` (direct read) — current audio data-flow, patchcord integration shape, track-swap renderer path
- `.planning/phases/02-fix-bug-b-windows-loopback-audio-captured/02-FINDINGS.md` — settled mechanism (public WASAPI API, EXCLUDE-tree, build ≥ 20348, clean-room GO)
- [crates.io: windows 0.62.2](https://crates.io/crates/windows) + [windows-docs-rs ActivateAudioInterfaceAsync](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/Media/Audio/fn.ActivateAudioInterfaceAsync.html) — Rust windows crate, MSRV 1.82.0
- [@napi-rs/cli npm 3.6.2](https://www.npmjs.com/package/@napi-rs/cli) + [napi-rs v3 announcement](https://napi.rs/blog/announce-v3) — napi-rs v3 stable, cross-compile, prebuilt distribution
- [Electron native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules) + [Node-API](https://nodejs.org/api/n-api.html) — N-API ABI stability across Node/Electron
- [MS PROCESS_LOOPBACK_MODE Requirements](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-process_loopback_mode) — minimum build 20348
- [MS ApplicationLoopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/) + [microsoft/Windows-classic-samples LICENSE](https://github.com/microsoft/Windows-classic-samples/blob/main/LICENSE) — clean-room source (MIT); hardcoded format; `E_NOTIMPL` quirk
- [Microsoft Q&A 1125409](https://learn.microsoft.com/en-us/answers/questions/1125409/) — `GetMixFormat`/`IsFormatSupported` return `E_NOTIMPL` on process-loopback device; hardcode CD-quality 2ch/16-bit/44100
- [electron/electron#37293](https://github.com/electron/electron/issues/37293) — `disable_local_echo=true` hardcoded; streamer-side mirage
- [obsproject/obs-studio#9669](https://github.com/obsproject/obs-studio/issues/9669) — process-tree exclusion gotcha (captured OBS's own tree when launched as child)
- [GoofCord #46](https://github.com/Milkshiift/GoofCord/issues/46) — upstream bug; maintainer quote; workaround documented

### Secondary (MEDIUM confidence)
- [Vesktop #789, #657, #569, #772, #918](https://github.com/Vencord/Vesktop/issues/) — closest peer; echo bug closed wontfix/upstream across multiple issues; confirms native is non-trivial
- [PortAudio #935](https://github.com/PortAudio/portaudio/issues/935) / [Audacity #2356](https://github.com/audacity/audacity/issues/2356) — WASAPI loopback yields no samples when nothing is playing; verify-with-audio-playing requirement
- [SteelSeries Sonar "Stream with Discord Without Echo" guide](https://support.steelseries.com/hc/en-us/articles/35145998503181) — vendor-documented separate-output-device workaround; confirms workaround is real and works on all builds
- [WebRTC.ventures: Sending Generated Audio Through WebRTC](https://webrtc.ventures/2015/09/sending-generated-audio-through-webrtc-as-a-live-feed/) + [electron/electron#17690](https://github.com/electron/electron/issues/17690) — Option B (PCM-to-MediaStream) mechanisms; present in Chromium/Electron but availability on Electron 41.3.0 must be confirmed

### Tertiary (LOW confidence / backstop)
- [napi-rs cross-build docs](https://napi.rs/docs/cross-build.en) — Linux to Windows cross-compile; backstop only (CI is on `windows-latest`, making this unnecessary)

---
*Research completed: 2026-05-30*
*Ready for roadmap: yes*
