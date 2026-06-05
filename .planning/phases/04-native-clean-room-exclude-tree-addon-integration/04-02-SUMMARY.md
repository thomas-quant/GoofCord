---
phase: 04-native-clean-room-exclude-tree-addon-integration
plan: 02
subsystem: infra
tags: [rust, napi-rs, windows-rs, wasapi, loopback, native-addon, audio, echo-fix]

# Dependency graph
requires:
  - phase: 04-01
    provides: "Proven main-process PCM transport (MessageChannelMain -> MSTG feeder); the 480-frame/3840-byte/48k-stereo-f32 chunk contract the addon must emit"
  - phase: 02
    provides: "Clean-room GO + EXCLUDE-tree mechanism (exclude the Electron/Audio-Service process tree); public WASAPI symbol surface; GetMixFormat -> E_NOTIMPL"
provides:
  - "Clean-room Rust napi-rs crate at native/wasapi-loopback/ performing WASAPI process-tree EXCLUDE loopback"
  - "Exported start(excludeRootPid, onChunk) -> bool and stop() — the contract Plan 04-03 wraps"
  - "Hardcoded 48k/stereo/f32 capture (AUTOCONVERTPCM, no Rust DSP) emitting 3840-byte f32 chunks over a bounded NonBlocking ThreadsafeFunction (drop-oldest)"
  - "Dynamic ActivateAudioInterfaceAsync resolution + try-activate-and-catch -> graceful 'unsupported' (false), no throw (ECHO-03 foundation)"
affects: [04-03, phase-5-upstream-pr, phase-5-addon-repo-extraction]

# Tech tracking
tech-stack:
  added: ["Rust crate windows 0.62.2", "windows-core 0.62.2", "napi 3.9.0", "napi-derive 3.5.6", "napi-build 2", "@napi-rs/cli 3.7.0 (crate build only)"]
  patterns: ["clean-room native addon authored from the MS ApplicationLoopback MIT sample", "dynamic-load entrypoint gate so the .node loads on every Windows build", "const-generic-bounded ThreadsafeFunction MaxQueueSize for drop-oldest at the FFI boundary", "COM-affine activation run on the capture thread"]

key-files:
  created:
    - native/wasapi-loopback/Cargo.toml
    - native/wasapi-loopback/Cargo.lock
    - native/wasapi-loopback/build.rs
    - native/wasapi-loopback/package.json
    - native/wasapi-loopback/src/lib.rs
    - native/wasapi-loopback/NOTICE
    - native/wasapi-loopback/README.md
    - native/wasapi-loopback/.gitignore
  modified: []

key-decisions:
  - "Hardcoded WAVEFORMATEXTENSIBLE (not plain WAVEFORMATEX) for the explicit 48k/stereo/f32 request; AUTOCONVERTPCM in the StreamFlags (2nd Initialize param) does the conversion — no Rust resampler."
  - "Run activation ON the capture thread (after CoInitializeEx MTA) and report the support verdict back over an mpsc channel, so the COM-apartment-affine IAudioClient never crosses a thread boundary."
  - "Bound the ThreadsafeFunction MaxQueueSize via a const-generic type alias (ChunkTsfn, MaxQueueSize=5) so NonBlocking .call() returns QueueFull under load -> drop-oldest (locked T4)."
  - "Compiled the crate here (cargo check + clippy, x86_64-pc-windows-msvc) — the toolchain WAS available — so Plan 04-03's CI build starts from known-good source, not source-assertion-only."

patterns-established:
  - "Clean-room native addon: solely from the public MS ApplicationLoopback MIT sample + windows-rs docs; MIT notice retained; zero Discord symbol layout (ECHO-04)."
  - "Graceful Windows-API fallback: dynamic LoadLibraryW/GetProcAddress gate + any non-S_OK activate result -> Unsupported (start resolves false), never throw."

requirements-completed: [ECHO-02, ECHO-03, ECHO-04]

# Metrics
duration: ~50min
completed: 2026-06-05
---

# Phase 4 Plan 02: Clean-Room WASAPI Process-Tree EXCLUDE Loopback Addon Summary

**A clean-room Rust napi-rs `.node` addon that captures the full Windows endpoint mix EXCEPT a caller-supplied process tree (the #46 echo fix), emits hardcoded 48k/stereo/f32 PCM via AUTOCONVERTPCM, and pushes 480-frame (3840-byte) chunks over a bounded NonBlocking ThreadsafeFunction — exporting `start(excludeRootPid, onChunk)` / `stop()` for Plan 04-03 to wrap. It compiles clean (cargo check + clippy) against the windows-latest MSVC target.**

## Performance

- **Duration:** ~50 min
- **Started:** 2026-06-05T00:25Z (approx)
- **Completed:** 2026-06-05T01:15Z
- **Tasks:** 2 (both `type="auto"`, autonomous — no checkpoints)
- **Files created:** 8 (in `native/wasapi-loopback/`)

## Accomplishments
- Scaffolded the clean-room crate and implemented the full WASAPI process-loopback **EXCLUDE-tree** activation path: hardcoded 48k/stereo/f32 `WAVEFORMATEXTENSIBLE`, `AUDIOCLIENT_ACTIVATION_PARAMS` with `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` on the caller PID, PROPVARIANT(VT_BLOB) carry, against `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`.
- Dynamic `ActivateAudioInterfaceAsync` resolution (`LoadLibraryW`/`GetProcAddress` on `mmdevapi.dll`) so the `.node` **loads** on every Windows build; async-completion handler + `WaitForSingleObject`; any non-`S_OK` activate result (or missing entrypoint) collapses to **Unsupported** -> `start` resolves `false`, no panic/throw (ECHO-03 foundation; no hardcoded OS build gate).
- Event-driven capture loop on a dedicated thread (CoInitializeEx MTA -> SetEventHandle -> `IAudioCaptureClient` via GetService -> Start -> `GetNextPacketSize`/`GetBuffer`/`ReleaseBuffer`), re-chunked to exactly **480 frames * 2ch * 4 bytes = 3840 bytes** f32, pushed via `ThreadsafeFunction` **NonBlocking** with a bounded `MaxQueueSize` (drop-oldest at the FFI boundary; locked T4). Silent packets zero-filled to keep the renderer timeline monotonic.
- Idempotent `stop()` signals the capture thread and joins with a **1500 ms bounded timeout** (composes with the JS wrapper's `before-quit` `Promise.race`); CoUninitialize on thread exit.
- **Clean-room (ECHO-04):** authored solely from the MS `ApplicationLoopback` MIT sample + windows-rs docs; MIT notice retained in `NOTICE`; **zero** Discord symbol layout (`ActivateApplicationLoopbackForProcessTree` / `excludedSubtrees`) in source.

## Build command & output (for Plan 04-03)

- **Crate location:** `native/wasapi-loopback/`
- **Build (on a `windows-latest` runner — Plan 04-03 wires the CI step):**
  ```
  napi build --release --target x86_64-pc-windows-msvc
  ```
- **Expected output filename:** `wasapi-loopback-win32-x64.node` (the napi name is `wasapi-loopback`; on win32/x64 `copyNativeModules()` renames the env-override target to this, which contains both `win32` and `x64` substrings so `nativeModulePlugin` matches it — Pitfall 3).
- GoofCord consumes it prebuilt via `GOOFCORD_WASAPI_LOOPBACK_PATH`; GoofCord's Bun build does **not** compile Rust.

## Exported API (the contract Plan 04-03 wraps)

```ts
// excludeRootPid: pass the Electron MAIN process PID (process.pid). EXCLUDE_TARGET_PROCESS_TREE
//   covers the whole tree incl. the separate "Audio Service" utility child (ECHO-02 / A4).
// onChunk: a napi ThreadsafeFunction; called with a 3840-byte (480 frames * 2ch * 4 bytes)
//   f32 Buffer per ~10 ms. Bounded queue (MaxQueueSize=5) -> drop-oldest under backpressure.
// returns false (NOT an error) when the API is unavailable on this build OR activation fails
//   for any reason -> caller falls back to Electron "loopback" (ECHO-03).
function start(excludeRootPid: number, onChunk: (chunk: Buffer) => void): boolean;

// idempotent; signals the capture thread and joins with a 1500 ms bounded timeout.
function stop(): void;
```

> **04-03 JS-side reminder (from Plan 04-01):** each chunk is forwarded down the main-process MessagePort with `port1.postMessage(buf)` — **NO transfer list** (Electron main-process `MessagePortMain.postMessage` transfer lists accept only `MessagePortMain`, not ArrayBuffers). The addon just emits the 3840-byte f32 buffers; the JS wrapper owns transport.

## Task Commits

Each task was committed atomically:

1. **Task 1: Crate scaffold + clean-room EXCLUDE-tree activation (hardcoded 48k/stereo/f32, dynamic load, try-activate-and-catch)** — `0124535` (feat)
2. **Task 2: Event-driven capture loop + napi ThreadsafeFunction push (480-frame f32, drop-oldest) + stop** — `b2c72ea` (feat)

_(No separate metadata commit by this executor — the orchestrator owns STATE.md/ROADMAP.md tracking writes after the wave, per the plan's instruction.)_

## Files Created
- `native/wasapi-loopback/Cargo.toml` — crate manifest: `cdylib`; `windows 0.62` (nine features), `windows-core 0.62`, `napi 3.9.0`, `napi-derive 3.5.6`, `napi-build 2`.
- `native/wasapi-loopback/Cargo.lock` — pinned dependency graph (committed for reproducible CI builds).
- `native/wasapi-loopback/build.rs` — `napi_build::setup()`.
- `native/wasapi-loopback/package.json` — napi descriptor (`"napi": { "name": "wasapi-loopback" }`), build script, `@napi-rs/cli@3.7.0` devDep.
- `native/wasapi-loopback/src/lib.rs` — the addon: format, dynamic-load gate, async activation + completion handler, EXCLUDE-tree params, capture loop, ThreadsafeFunction push, start/stop.
- `native/wasapi-loopback/NOTICE` — Microsoft MIT copyright/permission notice (ECHO-04 attribution).
- `native/wasapi-loopback/README.md` — clean-room provenance, API, build command, Phase-5 extraction note.
- `native/wasapi-loopback/.gitignore` — ignores `target/` (198 MB cargo cache), `*.node`, `node_modules/`.

## Decisions Made
- **Hardcoded `WAVEFORMATEXTENSIBLE`** (explicit 48k/stereo/f32) over a plain `WAVEFORMATEX`; `AUTOCONVERTPCM | SRC_DEFAULT_QUALITY` in the **StreamFlags** (2nd `Initialize` param — NOT periodicity; avoids MS sample bug #196) does the conversion in shared mode, so no Rust DSP.
- **Activation runs on the capture thread.** The process-loopback `IAudioClient` is COM-apartment-affine, so the thread does `CoInitializeEx(MTA)` -> activate -> report the support verdict back via `mpsc`, then enters the capture loop. `start()` blocks only on the verdict, then returns the real `bool`. This avoids moving a COM object across threads.
- **Drop-oldest realized via a const-generic type alias** `ChunkTsfn` (= `ThreadsafeFunction<Buffer, (), Buffer, Status, true, false, 5>`). `MaxQueueSize=5` (~50 ms) + `NonBlocking` => `QueueFull` drops under load (locked T4). `MaxQueueSize` has no effect in Blocking mode, so NonBlocking is required.
- **Compiled the crate here.** The orchestrator's prompt said no Rust toolchain, but the box actually has `rustc`/`cargo` 1.94 + the `x86_64-pc-windows-msvc` target + Windows SDK headers. `cargo check` and `cargo clippy` both pass with **zero errors/warnings**. This is strictly stronger than source-assertion-only and de-risks Plan 04-03's CI build.

## Deviations from Plan

The plan listed `src/lib.rs` as Task 2's only file and said `napi build`/`cargo build` would NOT run here (no toolchain). Both assumptions shifted slightly during execution; all changes are in-scope and necessary for a correct, compilable addon.

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added missing `windows` crate features + `windows-core` dep so the source compiles**
- **Found during:** Task 1/Task 2 (running `cargo check` against the real `windows 0.62.2` API)
- **Issue:** The plan's six-feature list was insufficient against the real 0.62.2 module layout: `CreateEventW` needs `Win32_Security`; `LoadLibraryW`/`GetProcAddress` need `Win32_System_LibraryLoader`; `KSDATAFORMAT_SUBTYPE_IEEE_FLOAT` lives in `Win32_Media_Multimedia` (not KernelStreaming); `VT_BLOB` lives in `Win32_System_Variant`; and the `#[implement]` completion handler expands to absolute `::windows_core::` paths, requiring `windows-core` as a direct dependency.
- **Fix:** Added features `Win32_Security`, `Win32_System_LibraryLoader`, `Win32_Media_Multimedia`, `Win32_System_Variant` (now nine total; the plan's six are all retained) and a direct `windows-core = "0.62"` dep. Corrected import module paths accordingly; `WAVE_FORMAT_EXTENSIBLE` stays in `KernelStreaming`.
- **Verification:** `cargo check --target x86_64-pc-windows-msvc` -> 0 errors; `cargo clippy` -> 0 warnings.
- **Committed in:** `0124535` (Task 1 feature set) + `b2c72ea` (Task 2 finalized features/dep)

**2. [Rule 1 - Bug] Corrected windows-rs API call shapes to the real 0.62.2 signatures**
- **Found during:** Task 2 (capture loop compile)
- **Issue:** `CreateEventW` takes `bool` (not `BOOL`); `IAudioCaptureClient::GetNextPacketSize()` returns `Result<u32>` (no out-param); and Rust 2021 disjoint closure capture grabbed the non-`Send` `HANDLE` field instead of the `SendHandle` wrapper, failing `thread::spawn`'s `Send` bound.
- **Fix:** Used `bool` args for `CreateEventW`; switched `GetNextPacketSize` to its `Result<u32>` return; added a `SendHandle(HANDLE)` newtype with `unsafe impl Send` and bound the whole wrapper inside the closure before reading `.0`.
- **Verification:** Compiles clean.
- **Committed in:** `b2c72ea` (Task 2 commit)

**3. [Rule 2 - Missing Critical] Committed `Cargo.lock` + added `.gitignore` for build hygiene**
- **Found during:** Task 2 (after the local `cargo check` generated a 198 MB `target/` and a `Cargo.lock`)
- **Issue:** Without a `.gitignore`, `target/` could be accidentally staged; for a binary-producing (`cdylib`/`.node`) crate, an un-committed `Cargo.lock` makes CI builds non-reproducible.
- **Fix:** Added `native/wasapi-loopback/.gitignore` (ignores `target/`, `*.node`, `node_modules/`) and committed `Cargo.lock`. The `ci-artifacts/` and `image.webp` working-tree cruft were never staged (precise per-file `git add` throughout).
- **Verification:** `git diff --cached --name-only` showed no `target/`/cruft on either commit.
- **Committed in:** `b2c72ea` (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (1 blocking, 1 bug, 1 missing-critical). All necessary to produce a correct, compilable, reproducibly-buildable clean-room addon. No scope creep — the addon still does exactly what the plan specifies; `build.rs` was already required by the plan's `Cargo.toml` action.
**Impact on plan:** The crate compiles and lints clean, so Plan 04-03's first CI artifact starts from known-good Rust rather than discovering compile errors at the expensive second-device round-trip.

## Format-deviation flag for Plan 04-03's first CI artifact (Assumption A2)

The addon **requests** 48000/2/32-bit IEEE-float and relies on `AUTOCONVERTPCM` to deliver exactly that. Per RESEARCH Assumption A2, whether the process-loopback magic-device honors a non-44100/16-bit request even with AUTOCONVERTPCM is confirmed only on a real device. **No Rust-side deviation from 48k/stereo/f32 was made.** If Plan 04-03's first CI/second-device test shows wrong pitch/garbled audio, the most likely cause is the device forcing 16-bit — in which case the f32 conversion would move into the addon (the format is hardcoded in `build_wave_format()` + the chunk constants `FRAMES_PER_CHUNK`/`BYTES_PER_FRAME`/`CHUNK_BYTES`). Flag to confirm on the first real-WASAPI artifact.

## Issues Encountered
- The `windows 0.62.2` module layout differs from the RESEARCH code-example sketch in several spots (feature gates, `bool` vs `BOOL`, `Result`-returning getters, `#[implement]` needing `windows-core`). Resolved by reading the installed crate source directly and verifying with `cargo check`/`cargo clippy`.

## Next Phase Readiness
- **Plan 04-03 (integration)** can now: add the `windows-latest` Rust build step (`napi build --release --target x86_64-pc-windows-msvc`) producing `wasapi-loopback-win32-x64.node`; add the `copyNativeModules()` entry + `GOOFCORD_WASAPI_LOOPBACK_PATH`; build the `src/modules/native/wasapiLoopback.ts` wrapper (venbind-shaped) calling `start(process.pid, onChunk)` / `stop()`; and swap the synthetic spike source for this addon behind the proven 04-01 transport. The exclude-root is `process.pid`; watch the Audio-Service-as-sibling risk (PID logged in 04-01; A4).
- **Phase 5** extracts this crate to its own published, venbind-style prebuilt-`.node` repo + `optionalDependencies`.

## Self-Check: PASSED

- All 8 crate files + the SUMMARY exist on disk (verified).
- Both task commits exist in git history: `0124535` (Task 1), `b2c72ea` (Task 2).
- All plan `<verify>` grep blocks pass: SCAFFOLD_OK, ACTIVATION_OK, CLEANROOM_OK, CAPTURE_OK, CHUNK_SHAPE_OK; `GetMixFormat` count = 0; zero Discord symbols in non-comment source.
- Crate compiles clean: `cargo check` + `cargo clippy` (`x86_64-pc-windows-msvc`) -> 0 errors, 0 warnings.

---
*Phase: 04-native-clean-room-exclude-tree-addon-integration*
*Completed: 2026-06-05*
