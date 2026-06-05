---
phase: 04-native-clean-room-exclude-tree-addon-integration
plan: 03
subsystem: screenshare
tags: [wasapi, electron, napi, rust, windows, loopback, audio, electron-builder, asar]

# Dependency graph
requires:
  - phase: 04-01
    provides: MessageChannelMain → preload-injected MSTG feeder → getDisplayMedia swap-seam transport (proven viewer-audible)
  - phase: 04-02
    provides: clean-room Rust WASAPI EXCLUDE-process-tree loopback addon (native/wasapi-loopback)
provides:
  - Real WASAPI EXCLUDE-tree capture wired behind the Plan 01 transport (wasapiLoopback.ts)
  - Additive 3-way screenshare.ts audio gate (Linux patchcord → win32 native exclude-tree → loopback fallback)
  - Host-agnostic native-addon packaging into the Windows artifact (ts-out/native + asarUnpack)
  - Verified end-to-end #46 echo fix on real Windows hardware (viewer hears desktop audio, no call echo)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Runtime native-addon load via app.getAppPath()/ts-out/native (host-agnostic) instead of Bun's `native-module:` file-loader, which emits zero .node on a Windows BUILD host"
    - "asarUnpack **/*.node so app-source native addons are dlopen-able from app.asar.unpacked"
    - "Synchronous (appendFileSync) breadcrumbs to survive a native hard-crash for post-mortem from the Windows Event Log"

key-files:
  created: []
  modified:
    - src/modules/native/wasapiLoopback.ts
    - src/windows/screenshare/screenshare.ts
    - build/build.ts
    - electron-builder.ts
    - native/wasapi-loopback/src/lib.rs
    - .github/workflows/testBuild.yml

key-decisions:
  - "On the win32 wasapi path do NOT request Chromium loopback (audio:none); the addon is the sole capturer — avoids two concurrent WASAPI loopback sessions AND is more correct (the seam discarded Chromium's track anyway)"
  - "Bypass Bun's `with { type: file }` file-loader for the wasapi addon (it silently emits zero .node on a Windows build host) via a deterministic fs copy into ts-out/native + a runtime app.getAppPath() load"

patterns-established:
  - "windows-rs PROPVARIANT is an OWNING type (Drop → PropVariantClear → CoTaskMemFree on VT_BLOB); wrap in ManuallyDrop when the blob borrows stack memory it does not own"
  - "napi CalleeHandled ThreadsafeFunction invokes JS as (err, value) — read data from the SECOND arg"

requirements-completed: [ECHO-01, ECHO-02, ECHO-03]

# Metrics
duration: multi-session
completed: 2026-06-06
---

# Phase 04 / Plan 03: Integration + packaging + on-hardware echo-fix verification

**The Windows WASAPI EXCLUDE-process-tree echo fix is wired behind the proven transport, packaged into the Windows artifact, and VERIFIED working on real hardware — a second-device viewer heard the shared desktop audio (Spotify) with no Discord-call echo.**

## Verification (the GO)

Manual two-device test on a real Windows build (CI run `27044504559`, commit `8078b20`, downloaded `win-artifacts`, run with NO transport-spike env):

- **(a) viewer hears desktop audio** — friend confirmed hearing the shared Spotify audio. ✅
- **(b) no call echo** — friend confirmed no echo of the call. ✅
- `screenshare-debug.log` signature (audited from WSL):
  - `wasapi smoke: loaded under electron napi ok` (N-API ABI loads under Electron 41.3.0)
  - `wasapi exclude-root=19632 audioService=2400 procs=…` — Audio Service PID present in the `app.getAppMetrics()` subtree (ECHO-02)
  - `[sync] start() returned ok=true` — activation succeeded, no crash
  - `audio=none path=win32-wasapi-exclude-tree (addon sole capturer, no chromium loopback)`
  - `wasapi activation=ok hop1=messageport hop2=port-forward chunks=31 → 100 → … → 6600` — ~66 s of continuous 480-frame f32 chunks delivered, no `onChunk threw`, no Event-Log crash.

## Accomplishments
- Real Plan 02 addon swapped in behind the Plan 01 transport (synthetic tone retired); additive 3-way `screenshare.ts` gate.
- Native addon reliably packaged into the Windows artifact on a Windows CI host (the original blocker), with a CI assertion + app.asar grep proving the fork code + loadable `.node` ship.
- Four real bugs found and fixed via an instrument → CI → on-hardware loop (see below).

## Task Commits
1. **Real addon behind transport + 3-way gate** — `3e732a9` (feat)
2. **Package the .node (copyNativeModules + CI Rust build + assertion)** — `e66201c` (feat)
3. **Windows-host packaging fix — host-agnostic ts-out/native copy** — `df35852` (fix)
4. **asarUnpack so the .node is dlopen-able from app.asar.unpacked** — `ffe49b9` (fix)
5. **Drop redundant Chromium loopback on the wasapi path (+ sync breadcrumbs)** — `6e44ebd` (fix)
6. **PROPVARIANT ManuallyDrop — heap-corruption crash in addon start()** — `afd7e30` (fix, 04-02 crate)
7. **Read WASAPI chunk from the 2nd callback arg (CalleeHandled tsfn)** — `8078b20` (fix)

(Earlier in-flight attempts on the packaging blocker: `221a696`, `0946dc4`, `86bb396`, `2e545c6`.)

## The debugging chain (each layer unmasked the next)
1. **Addon wouldn't bundle on a Windows build host** — Bun's `native-module:` `with { type: "file" }` loader emits zero `.node` on win hosts (venbind too). Fixed with a host-agnostic `fs` copy into `ts-out/native/` + a runtime `app.getAppPath()` load.
2. **`.node` packed unloadable inside app.asar** — electron-builder doesn't auto-unpack app-source `.node`. Fixed with `asarUnpack: ["**/*.node"]`.
3. **Hard crash on system-audio share (CoreMessaging.dll / heap corruption)** — first suspected dual WASAPI capture (addon + Chromium); removed Chromium's loopback on the wasapi path (correct, but not the root cause).
4. **Heap corruption inside `start()` (ntdll 0xc0000374)** — sync breadcrumbs localized it: windows-rs `PROPVARIANT` Drop `CoTaskMemFree`s the VT_BLOB blob, which pointed at a **stack** local → freeing a stack pointer. Fixed with `ManuallyDrop`.
5. **No audio reached the viewer (`onChunk threw: …byteLength of null`)** — the napi CalleeHandled tsfn passes `(err, chunk)`; the JS read the chunk from arg 0 (the null error slot) and threw on packet #1. Fixed by reading arg 1.

## Diagnostic technique that made remote native debugging possible
- **Windows Event Log read from WSL** (`powershell.exe Get-WinEvent … 'Application Error'`) → faulting module + exception code without a debugger.
- **Synchronous `appendFileSync` breadcrumbs** around `require`/`start()` survive a hard crash (the async `appendScreenshareDebug` loses unflushed lines), pinpointing the exact failing call.

## Follow-ups (Phase 5 — upstream PR prep; NOT blockers)
- **Strip diagnostic scaffolding**: the `[sync]` breadcrumbs in `wasapiLoopback.ts`, the whole `screenshare-debug.log` path, and the temp CI diagnostics + `Assert` step in `testBuild.yml`. Re-home the addon to its own published repo + optionalDependencies (drops `GOOFCORD_WASAPI_LOOPBACK_PATH` + the CI Rust build).
- **ECHO-03 fallback gap**: when the addon is UNSUPPORTED, the injected feeder still swaps its SILENT `gen` track in → viewer hears silence instead of the "loopback" fallback. Gate the swap on capture being active / port open.
- **`electron-builder.ts` `getPlatformString` → "unknown"** in `beforePack` (`context.packager.platform` doesn't `===` `Platform.WINDOWS`), which ships a harmless misnamed `wasapi-loopback-linux-x64.node` in the Windows package and makes venbind's build-time loader mis-resolve. Resolve via `context.electronPlatformName`.
