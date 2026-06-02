# Phase 4: Native Clean-Room Exclude-Tree Addon + Integration - Research

**Researched:** 2026-06-02
**Domain:** Windows WASAPI process-tree EXCLUDE loopback (clean-room Rust + napi-rs + `windows` crate `.node` addon) + main→renderer→main-world PCM transport over MessagePort, integrated into Electron 41.3.0's screenshare audio branch
**Confidence:** HIGH on transport (hop-2 resolved), HIGH on format contract, HIGH on stack/packaging, MEDIUM on exact activation-failure HRESULT (try-and-catch pattern is the robust answer regardless)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions (T1–T4 — FIXED, do NOT re-derive)

- **T1 — Transport sequencing:** Spike the transport FIRST with a **main-process synthetic PCM source** (a trivial tone — no WASAPI yet) shipped over the **real** chunked-transferable transport → main-world MSTG reconstruction → swap seam → second-device viewer-audible on a Windows x64 CI artifact. Only after that GO does the real WASAPI addon get built and swapped in behind the same transport. The synthetic tone is throwaway; the transport plumbing is the KEEP. Reuse the `GOOFCORD_DELIVERY_SPIKE`-style env gate + `screenshare-debug.log` pattern.
- **T2 — Hop-1 (main→renderer):** `MessageChannelMain` → transferred `MessagePortMain`. The addon's napi threadsafe callback batches ~10 ms chunks and delivers them with `port.postMessage(buf, [buf])` (transferable ArrayBuffer — zero-copy) on a **dedicated** channel, out-of-band of the busy `ipcMain` router. **NEVER** per-frame `ipcRenderer.send` of raw PCM (ARCHITECTURE.md:250-253). Batch at ~10 ms / 480-frame granularity. One-time port handshake at stream start; teardown on `STREAM_CLOSE`.
- **T3 — Hop-2 (preload isolated world → page MAIN world):** Default = forward the `MessagePort` from preload into the main world via `window.postMessage(msg, origin, [port])` (zero-copy port→port). Fallback = if Electron 41.3.0 won't transfer a `MessagePort` into the `executeJavaScript`-injected main world, land PCM in the preload and invoke a main-world callback via the existing `goofcord`/`GoofCord` contextBridge (structured-clones each chunk). The spike settles which mechanism worked, recorded in `screenshare-debug.log`.
- **T4 — Backpressure/buffering:** Bounded buffer, latency-first. Small fixed ring (~tens of ms): **drop-oldest** on overflow, **silence/last-frame fill** on underrun. Bounded latency wins over perfect fidelity. Ring depth & location (Rust-side or main-JS-side) are planner's call; the *policy* is fixed.

Plus carried-forward LOCKED inputs:
- **Native-only** (no user-side workaround as a deliverable).
- **Clean-room boundary (D-05):** implement solely from the public Microsoft `ApplicationLoopback` sample (MIT, retain copyright); never from Discord code/symbols. Hardcode fixed `WAVEFORMATEX` (no `GetMixFormat` — `E_NOTIMPL`). Dynamic `LoadLibrary`/`GetProcAddress` (not static link). (ECHO-04)
- **Mode = EXCLUDE process-tree**; exclude target = GoofCord/Electron **root PID** via `app.getAppMetrics()` so the Audio Service utility child is covered. (ECHO-02)
- **Toolchain = Rust + napi-rs + `windows` crate**, venbind-style prebuilt `.node`.
- **Delivery seam = MSTG reconstruction → `getDisplayMedia` swap at `screensharePatch.ts:79-84` → viewer** (Phase 3 GO).
- **Effective build floor ≈ Win10 2004 / 19041+** (NOT 20348). Sub-2004 graceful-fallback to `"loopback"`.
- **Verification is manual**, viewer-side (second device/account), non-call audio playing, diagnostics → `screenshare-debug.log` (no DevTools).

### Claude's Discretion (research recommendations within these)
- Hop-2 mechanism — default = forward the port; fallback = contextBridge callback. Settled by the spike. **[Resolved this research: default is supported — see Transport section.]**
- Buffer location & exact ring depth (within bounded/latency-first policy).
- Chunk batching size/cadence (start from Phase 3 ~10 ms / 480-frame).
- Addon→main-JS delivery shape (push via napi ThreadsafeFunction vs. pull/read), start/stop + format control channel.

### Deferred Ideas (OUT OF SCOPE)
- End-to-end milestone verification, instrumentation stripping, upstream-PR shaping, separate published addon repo + `optionalDependencies` + per-platform prebuild CI — **Phase 5**.
- A/V sync polish beyond bounded-latency best-effort.
- Linux/macOS behaviour changes (must not regress).
- User-side separate-output-device workaround (explicitly rejected).
- In-app sender telemetry via `replaceTrack`/transceiver capture (residual risk #3) — only if Phase 4 wants in-app stats; viewer-audible is ground truth.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ECHO-01 | Viewers hear shared system/app audio but NOT the call echoed back | The full chain: EXCLUDE-tree capture (excludes GoofCord's own playback) → 48k/stereo/f32 PCM → MessagePort transport → MSTG reconstruction → swap seam → viewer. Transport hop-2 resolved (port-forward supported on Electron 41/Chromium 146). Format contract resolved (request 48k/stereo/float32 directly via `AUTOCONVERTPCM`). |
| ECHO-02 | Works on Win10 2004 (19041)+ and Win11 via in-OS WASAPI per-process-tree EXCLUDE; exclude target covers the Audio Service child | Exclude root = `process.pid` of Electron main; `app.getAppMetrics()` enumerates the tree incl. `Audio Service`; `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` covers the subtree. Log the excluded root PID + Audio Service PID for verification. |
| ECHO-03 | No regression on Linux (patchcord), macOS, and Windows where the API is unavailable (graceful fallback to `"loopback"`) | Additive 3-way gate; dynamic `LoadLibrary`/`GetProcAddress` so `.node` loads everywhere; try-activate-and-catch any non-`S_OK` activation result → fall through to `result.audio = "loopback"`. No hardcoded OS build gate. |
| ECHO-04 | Clean-room from public MS `ApplicationLoopback` sample (MIT, notice retained); no Discord code/symbol layout | `windows` crate exposes the exact public MS symbols (no Discord internals). Source authored from `LoopbackCapture.cpp` initialization path + MS Q&A 1125409, with MIT attribution header. |
</phase_requirements>

## Summary

Phase 4 is the make-or-break build. Two genuinely unproven halves remain after the Phase 3 renderer-only GO: (1) the **main→renderer→main-world PCM transport** (residual risk #1), and (2) the **clean-room WASAPI EXCLUDE-tree native capture**. The locked plan correctly front-loads a transport spike (T1) — a synthetic main-process tone over the *real* transport, verified viewer-side on a Windows x64 CI artifact — before any WASAPI code exists, so a NO/GO turns on the transport alone.

This research resolves all four CONTEXT.md Open Questions with version-accurate detail:

1. **Hop-2 transport (T3) is VIABLE by default.** Electron's official MessagePorts tutorial prescribes *exactly* the pattern needed: a `MessagePortMain` transferred via `webContents.postMessage` lands in the **preload isolated world**, and the preload forwards it to the **page main world** with `window.postMessage('...', '*', event.ports)` — zero-copy port→port. The one prerequisite is a readiness handshake (the main-world script must register its `message` listener before the preload posts the port). This is the blessed pattern, confirmed on Electron 41's Chromium 146. The contextBridge-callback fallback remains as backstop but is not expected to be needed. `[CITED: electronjs.org/docs/latest/tutorial/message-ports]`

2. **Format contract (Open Q2) — request 48 kHz / stereo / float32 DIRECTLY.** The process-loopback `IAudioClient` returns `E_NOTIMPL` from `GetMixFormat`/`IsFormatSupported`, so the format MUST be hardcoded. But the MS sample initializes with `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`, which inserts the audio engine's resampler + channel matrixer in shared mode — meaning the caller can hardcode an **arbitrary** uncompressed PCM/float format and the engine converts. So the addon hardcodes a 48000/2/IEEE-float32 `WAVEFORMATEXTENSIBLE`, matching the Phase 3 renderer contract exactly — **no Rust-side f32 conversion needed**. (The MS sample itself uses 44100/16-bit only as its demo default, not a device constraint.) `[CITED: MS Q&A 1125409; learn.microsoft.com audclnt-streamflags]`

3. **Build-support detection (Open Q3, ECHO-03) — try-activate-and-catch, no OS build gate.** There is no single documented HRESULT for "API absent on this build"; the robust pattern (and Discord's) is to dynamically resolve the entry point and attempt activation, then treat **any non-`S_OK` `activateResult` from `GetActivateResult` (or a failed `GetProcAddress`)** as "unsupported" → fall through to `"loopback"`. Avoid a hardcoded 20348/19041 gate (the documented 20348 is wrong — 02-FINDINGS §2.3 UPDATE).

4. **Addon home (Open Q1) — in-repo Rust crate, built on the existing `testBuild.yml` Windows runner, loaded via `GOOFCORD_WASAPI_LOOPBACK_PATH` env override.** N-API ABI stability means one prebuilt `.node` loads under Electron 41.3.0 (Node 24.14.0) without `electron-rebuild` — exactly as venbind does. Defer the separate published repo + `optionalDependencies` to Phase 5.

**Primary recommendation:** Build the spike as a near-exact structural echo of the Phase 3 spike with the synthetic source moved to the main process and shipped over `MessageChannelMain` → `webContents.postMessage` → preload `window.postMessage(port)` → main-world `MessagePort.onmessage` → existing MSTG feeder. Default to port-forwarding (proven-viable); record the working hop-2 mechanism in `screenshare-debug.log`. Then build the clean-room addon hardcoding a 48k/stereo/float32 `WAVEFORMATEXTENSIBLE` with `AUTOCONVERTPCM`, dynamic-loading `ActivateAudioInterfaceAsync`, excluding `process.pid` via `EXCLUDE_TARGET_PROCESS_TREE`, pushing 480-frame chunks over a napi `ThreadsafeFunction`, and swap it in behind the same transport.

## Project Constraints (from CLAUDE.md)

- **No new build tooling in GoofCord.** Native addons are consumed **prebuilt**; Rust/napi-rs/cargo live in the addon's own build, never in GoofCord's Bun build (`build/build.ts`). GoofCord only *copies* the `.node` via `copyNativeModules()`.
- **Surgical, upstream-PR-able diffs.** Minimize divergence; follow existing conventions (the venbind/patchcord native-module shape, the `screenshare.ts` branch shape, the `screensharePatch.ts` swap seam).
- **Windows-specific; must not regress Linux (patchcord) or macOS.** Gate everything behind `process.platform === "win32"`; the Linux branch stays byte-for-byte unchanged.
- **TypeScript strict, `noEmit`** (type-check via `bun run check`; Bun transpiles). Catch errors as `unknown`, use `getErrorMessage(e)`. Fire-and-forget async uses `void`.
- **Tabs for indentation; `oxfmt`/`oxlint`.** Channel names `module:functionName`; native module wrappers under `src/modules/native/`.
- **IPC codegen:** new `<IPCHandle>`/`<IPCOn>` functions require `bun run build --onlyGenerators`; never edit `src/ipc/gen.ts` / `types.ts` manually.
- **Diagnostics → userData `screenshare-debug.log`, never DevTools** (60% keyboard, no F12). All instrumentation is THROWAWAY (strip before Phase 5 PR).
- **Verification is manual** on a Windows x64 CI artifact (`testBuild.yml`), **viewer-side** (second device/account), non-call audio actively playing.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| WASAPI EXCLUDE-tree capture loop | Native addon (Rust, in-process worker thread) | — | WASAPI is a Win32 COM API unreachable from Electron/Chromium JS; runs in-process (venbind shape, not patchcord subprocess). |
| Exclude-target PID resolution | Main process (Electron) | Native addon (receives PID) | `app.getAppMetrics()` + `process.pid` are Electron-main APIs; the addon receives the resolved root PID. |
| PCM chunking / batching (~10 ms) | Native addon (Rust) | Main process (could re-batch) | Batching at the capture source minimizes IPC events; the napi ThreadsafeFunction pushes 480-frame buffers. |
| Bounded ring buffer (drop-oldest / silence-fill) | Native addon (Rust) OR Main process JS | — | Planner's call (T4). Rust-side keeps the JS heap clean; JS-side is simpler to reason about. Recommend Rust-side. |
| Hop-1 transport (main→renderer) | Main process (`MessageChannelMain`) + preload | — | Electron main owns `MessageChannelMain`; `webContents.postMessage` delivers the port to the preload. |
| Hop-2 transport (preload→main world) | Preload (isolated world) | Page main world (receiver) | Preload forwards the port via `window.postMessage(..., [port])`; main-world script receives it. |
| MSTG reconstruction (PCM→live MediaStreamTrack) | Page main world (renderer) | — | `MediaStreamTrackGenerator` + `AudioData` live in the page main world (Phase 3 KEEP seed). |
| `getDisplayMedia` track swap | Page main world (renderer) | — | The swap seam at `screensharePatch.ts:79-84` runs in the main world (proven Phase 3 injection point). |
| 3-way dispatch gate | Main process (`screenshare.ts:90-100`) | — | The `audioConfig.mode !== "none"` branch is the single decision point. |
| Capture lifecycle (start/stop) | Main process (wrapper) ↔ Native addon | Renderer (`STREAM_CLOSE` → stop) | `wasapiLoopback.ts` owns start/stop; `STREAM_CLOSE` in `screensharePatch.ts:90-104` triggers teardown. |

### System Architecture Diagram

```
                          [ Streamer machine — GoofCord (Electron 41.3.0) ]

  User clicks "Go Live" → picks source → audioConfig.mode !== "none"
        │
        ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ MAIN PROCESS                                                              │
  │  screenshare.ts: 3-way gate                                              │
  │   if (linux + pipewire) ─────────────► patchcord (UNCHANGED)             │
  │   else if (win32 + wasapiLoopback.tryStart(process.pid) succeeds)        │
  │        │                                                                  │
  │        ▼                                                                  │
  │   wasapiLoopback.ts (NEW, venbind-shaped)                               │
  │    • app.getAppMetrics() → root PID (process.pid) + Audio Service PID    │
  │    • require(.node) via createRequire; --no-wasapi guard; try/catch      │
  │    • new MessageChannelMain() → port1 (keep), port2 (transfer)           │
  │    • addon.start(excludeRootPid, threadsafe pushChunk callback)          │
  │        │                                  ▲                              │
  │        │ webContents.postMessage(         │ pushChunk(Float32Array)      │
  │        │   'pcm-port', null, [port2])     │ (~10ms / 480-frame chunks)   │
  │        ▼                                  │                              │
  │   else ───────────────► result.audio = "loopback" (UNCHANGED fallback)  │
  └────────┼──────────────────────────────────┼─────────────────────────────┘
           │                                   │
           │                  ┌────────────────┴──────────────────┐
           │                  │ NATIVE ADDON (.node, Rust)        │
           │                  │  WASAPI EXCLUDE-tree capture loop │
           │                  │  • ActivateAudioInterfaceAsync    │
           │                  │    (VIRTUAL_AUDIO_DEVICE_PROCESS_ │
           │                  │     LOOPBACK, EXCLUDE_TREE)       │
           │                  │  • hardcoded 48k/stereo/f32 fmt   │
           │                  │    + AUTOCONVERTPCM               │
           │                  │  • event-driven GetBuffer loop    │
           │                  │  • bounded ring (drop-oldest)     │
           │                  │  • ThreadsafeFunction push        │
           │                  └───────────────────────────────────┘
           ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ PRELOAD (isolated world)  preload.mts                                    │
  │  on 'pcm-port' message → window.postMessage('main-world-pcm-port',       │
  │                                   '*', [event.ports[0]])   (hop-2)        │
  │  [readiness handshake: wait until main world registered its listener]    │
  └────────┼──────────────────────────────────────────────────────────────┘
           │ window.postMessage(..., [MessagePort])  ← zero-copy port forward
           ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ PAGE MAIN WORLD (renderer)  screensharePatch.ts / injected via           │
  │                              webFrame.executeJavaScript                  │
  │  window.onmessage('main-world-pcm-port') → MessagePort.onmessage         │
  │      → ring → MediaStreamTrackGenerator feeder (AudioData f32 frames)    │
  │      → reconstructed live MediaStreamTrack                               │
  │  SWAP SEAM (screensharePatch.ts:79-84):                                  │
  │      stop()/removeTrack() existing "loopback" track → addTrack(recon)    │
  │      → Discord RTCPeerConnection → outbound-rtp                          │
  └────────┼──────────────────────────────────────────────────────────────┘
           │ WebRTC
           ▼
  [ Remote viewer (second device) ] hears desktop/app audio, NO call echo (ECHO-01)
```

## Standard Stack

### Core (addon repo — NOT GoofCord's build)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Rust (stable) | 1.82.0+ (MSRV of `windows`) | Addon implementation language | Matches both existing GoofCord native addons (venbind, patchcord are Rust). `[VERIFIED: crates.io windows 0.62.2 MSRV]` |
| `napi` crate | 3.9.0 | N-API runtime bindings (ThreadsafeFunction, Buffer/TypedArray) | Same as venbind; ABI-stable N-API → one prebuilt `.node` loads in Electron 41 without recompile. `[VERIFIED: crates.io]` |
| `napi-derive` crate | 3.5.6 | `#[napi]` proc-macros | Pairs with `napi` 3.x. `[VERIFIED: crates.io]` |
| `windows` crate | 0.62.2 | Safe Rust bindings to public WASAPI process-loopback API | Microsoft-published, metadata-generated (no libclang/bindgen — simpler than venbind); exposes the exact public symbols (no clean-room risk). `[VERIFIED: crates.io]` |
| `@napi-rs/cli` (npm, dev) | 3.7.0 | `napi build --release --target x86_64-pc-windows-msvc` + CI scaffold | venbind's build CLI; lives in the addon repo. No postinstall script (verified). `[VERIFIED: npm registry — but see Package Legitimacy Audit]` |

> **Feature-gate the `windows` crate** to keep build size/time down:
> `windows = { version = "0.62", features = ["Win32_Media_Audio", "Win32_System_Com", "Win32_Foundation", "Win32_System_Threading", "Win32_Media_KernelStreaming", "Win32_System_Com_StructuredStorage"] }`
> (`KernelStreaming` + `StructuredStorage` provide `WAVEFORMATEXTENSIBLE` / `KSDATAFORMAT_SUBTYPE_IEEE_FLOAT` and the `PROPVARIANT` used to pass `AUDIOCLIENT_ACTIVATION_PARAMS`.) `[ASSUMED — verify feature names compile against 0.62.2]`

### Supporting (all EXISTING in GoofCord — nothing new added to GoofCord's build)
| Library / Mechanism | Purpose | When to Use |
|---------------------|---------|-------------|
| `nativeModulePlugin` (`build/nativeImport.ts`) | Resolves `native-module:.../wasapi-loopback-*.node` to the platform/arch-matched prebuild; emits `export default null` on no match | Add `import wasapiPath from "native-module:../../../assets/native/wasapi-loopback-*.node"` in new `src/modules/native/wasapiLoopback.ts` (mirror venbind.ts:7). |
| `copyNativeModules()` (`build/build.ts:168`) | Copies the prebuilt `.node` into `assets/native/<name>-<platform>-<arch>.node` | Add one `modules[]` entry with `envPath: process.env.GOOFCORD_WASAPI_LOOPBACK_PATH` + a `prebuilds` entry. |
| `createRequire(import.meta.url)` + try/catch | Runtime load; swallow failure; expose `is*Loaded()` | Mirror `obtainVenbind()` (venbind.ts:19-31). |
| `MessageChannelMain` / `webContents.postMessage` | Hop-1 zero-copy port transfer | Electron main API; one port handshake per stream. `[CITED: electronjs.org message-ports]` |
| `app.getAppMetrics()` | Enumerate Electron process tree incl. `Audio Service` PID | Already used by `patchcord.ts:80`; resolve exclude root + log Audio Service PID. |
| `screenshareDebug.ts` (Phase 3 KEEP infra) | userData `screenshare-debug.log` writer + `isDeliverySpikeEnabled` gate | Reuse `appendScreenshareDebug` for spike + native-branch diagnostics. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Rust + napi-rs | C++ + node-addon-api + cmake-js | More direct 1:1 port of the C++ MS sample, but diverges from both existing GoofCord addons (Rust) and adds a different toolchain to the addon repo. Same prebuilt-`.node` outcome. Stick with Rust for repo consistency. |
| Raw `windows` crate | `wasapi` crate (henquist/wasapi-rs) | Friendlier wrapper, but the process-loopback activation path is niche and may not expose `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS` / EXCLUDE cleanly. Use raw `windows-rs` for full control. |
| ThreadsafeFunction push | Pull/`read` API (JS polls native) | Push fits an event-driven WASAPI capture loop naturally (the loop already wakes on the audio event). Pull adds a redundant JS timer + a native lock. Use push. |
| MessagePort port-forward (hop-2) | contextBridge structured-clone callback | Port-forward is zero-copy and Electron-blessed; the contextBridge fallback structured-clones each ~400 KB/s chunk (cheap but not zero-copy). Default to port-forward; keep contextBridge as the spike-recorded fallback. |

**Installation (addon repo only — NOT GoofCord):**
```bash
# In the addon's own repo:
cargo add windows --features Win32_Media_Audio,Win32_System_Com,Win32_Foundation,Win32_System_Threading,Win32_Media_KernelStreaming,Win32_System_Com_StructuredStorage
cargo add napi
cargo add napi-derive
npm install -D @napi-rs/cli@3.7.0
# Build the prebuilt .node:
napi build --release --target x86_64-pc-windows-msvc
```
GoofCord side (Phase 4): **no install** — Phase 4 obtains the `.node` via the `GOOFCORD_WASAPI_LOOPBACK_PATH` env override (see Open Q1 resolution). `optionalDependencies` + a published repo is deferred to Phase 5.

**Version verification (this session):**
- `windows` crate `0.62.2` — `[VERIFIED: cargo search]` (MSRV 1.82.0).
- `napi` crate `3.9.0`, `napi-derive` `3.5.6` — `[VERIFIED: cargo search]`.
- `@napi-rs/cli` `3.7.0` (npm) — `[VERIFIED: npm view]`, no `postinstall` script.
- Electron 41 bundles Chromium **146.0.7680.65**, V8 14.6, **Node 24.14.0** — `[CITED: electronjs.org/blog/electron-41-0]` (matches Phase 3's runtime-observed `Chrome/146.0.0.0`).

## Package Legitimacy Audit

> The native dependencies are **Rust crates** (crates.io), not npm packages. slopcheck 0.6.1 only checks the npm registry, which produced cross-ecosystem false positives (the documented ~9% confusion vector — a Rust crate name checked against npm). The authoritative registry for each is crates.io, verified via `cargo search`.

| Package | Registry | Age | Downloads | Source Repo | slopcheck verdict | Disposition |
|---------|----------|-----|-----------|-------------|-------------------|-------------|
| `windows` | crates.io (Rust) | 5+ yrs | very high (Microsoft-published) | github.com/microsoft/windows-rs | `[OK]` on npm (different pkg) — N/A; crates.io VERIFIED | Approved |
| `napi` | crates.io (Rust) | 4+ yrs | high | github.com/napi-rs/napi-rs | `[SUS]` on npm = FALSE POSITIVE (Rust crate, wrong registry); crates.io VERIFIED | Approved |
| `napi-derive` | crates.io (Rust) | 4+ yrs | high | github.com/napi-rs/napi-rs | `[SLOP]` on npm = FALSE POSITIVE ("does not exist on npm" — correct, it's a crate, not an npm pkg) | Approved (crates.io `3.5.6` VERIFIED via `cargo search`) |
| `@napi-rs/cli` | npm | 6+ yrs | high | github.com/napi-rs/napi-rs | not flagged | Approved (npm `3.7.0` VERIFIED, no postinstall) |

**Packages removed due to slopcheck [SLOP] verdict:** none (the one [SLOP] was a cross-ecosystem false positive — `napi-derive` is a real crates.io crate, confirmed by `cargo search napi-derive` → `napi-derive = "3.5.6"`).
**Packages flagged as suspicious [SUS]:** `napi` npm [SUS] is a false positive (Rust crate); the real crate is confirmed on crates.io. No action needed.

> **Important provenance note:** all four packages were discovered from prior-phase research (STACK.md) + official sources (napi.rs, crates.io, microsoft/windows-rs). The Rust crates are confirmed on crates.io via `cargo search` this session. The `@napi-rs/cli` npm package is confirmed via `npm view`. Per the slopcheck cross-ecosystem caveat, **the planner should still gate the first addon-repo `cargo`/`napi build` behind awareness that these are Rust crates verified on crates.io, not npm** — but no `checkpoint:human-verify` install gate is needed in GoofCord itself, because GoofCord installs **nothing** (it copies a prebuilt `.node`). The crates are installed only in the separate addon repo's CI.

## Architecture Patterns

### Recommended Project Structure
```
GoofCord (this repo) — additive changes only:
src/modules/native/
└── wasapiLoopback.ts      # NEW — venbind-shaped wrapper: .node load, capture
                           #       lifecycle, PID resolution, MessageChannelMain port
src/windows/screenshare/
└── screenshare.ts         # MODIFIED — 3-way gate at the audioConfig branch (L90-100)
src/windows/main/preload/
├── preload.mts            # MODIFIED — receive pcm-port, forward to main world (hop-2)
└── bridge.ts              # MODIFIED — add stopWasapiLoopback() (mirror stopPatchcord)
src/windows/main/renderer/postVencord/
└── screensharePatch.ts    # MODIFIED — MSTG feeder fed from MessagePort; swap seam reuse;
                           #            STREAM_CLOSE → stopWasapiLoopback (L90-104)
build/build.ts             # MODIFIED — copyNativeModules() third entry + env override
assets/native/
└── wasapi-loopback-win32-x64.node   # NEW (copied by build from env path / prebuild)

Addon repo (separate, Phase 5 publishes it; Phase 4 just consumes the .node):
src/lib.rs                 # WASAPI EXCLUDE-tree capture + napi ThreadsafeFunction
Cargo.toml                 # windows + napi + napi-derive
```

### Pattern 1: Hop-1 — MessageChannelMain → webContents.postMessage (main → preload)
**What:** Main process creates a channel, keeps one port, transfers the other to the renderer; the addon's threadsafe callback posts PCM chunks down the kept port.
**When to use:** Once per stream, at capture start.
```typescript
// Source: https://www.electronjs.org/docs/latest/tutorial/message-ports  [CITED]
// In wasapiLoopback.ts (main process):
import { MessageChannelMain } from "electron";

const { port1, port2 } = new MessageChannelMain();
// Transfer port2 to the renderer's preload (isolated world).
mainWindow.webContents.postMessage("wasapi:pcm-port", null, [port2]);
port1.start();

// The napi ThreadsafeFunction callback (called from the Rust capture thread)
// posts each ~10ms chunk as a transferable ArrayBuffer (zero-copy):
function onPcmChunk(buf: ArrayBuffer) {
  port1.postMessage(buf, [buf]); // [buf] = transfer list → zero-copy, NOT structured-clone
}
```

### Pattern 2: Hop-2 — preload forwards the port into the page MAIN WORLD (RESOLVES T3)
**What:** `webContents.postMessage` delivers the port to the **preload isolated world**. The preload re-transfers it to the page main world with `window.postMessage(msg, '*', [port])`. The main-world script (injected via `webFrame.executeJavaScript`) receives it. This is the exact pattern Electron's docs prescribe for high-throughput data that should skip the isolated-world heap.
**When to use:** Default hop-2 mechanism (proven viable on Electron 41 / Chromium 146).
```typescript
// Source: https://www.electronjs.org/docs/latest/tutorial/message-ports  [CITED]
// In preload.mts (isolated world):
import { ipcRenderer } from "electron";
// Electron delivers a webContents.postMessage with ports to the preload's ipcRenderer:
ipcRenderer.on("wasapi:pcm-port", (event) => {
  const [port] = event.ports; // native DOM MessagePort in the isolated world
  // Forward to the page main world. The transfer list moves the port (zero-copy).
  // Must wait until the main world has registered its listener (readiness handshake).
  window.postMessage("goofcord:wasapi-pcm-port", "*", [port]);
});
```
```javascript
// In the main-world injected script (webFrame.executeJavaScript string):
window.addEventListener("message", (e) => {
  if (e.data !== "goofcord:wasapi-pcm-port") return;
  const port = e.ports[0];
  port.onmessage = (msg) => feedRing(msg.data); // msg.data is the transferred ArrayBuffer
  port.start();
  // signal the preload that the main world is ready (handshake) BEFORE this, in practice:
  // the main world should post a "ready" marker that the preload waits on.
});
```
> **Race-condition prerequisite (CITED, load-bearing):** "We need to wait until the main world is ready to receive the message before sending the port." The Electron docs use a `windowLoaded` promise. In GoofCord's case the main-world script is injected by `webFrame.executeJavaScript` *after* the preload runs, so the **main world must post a `ready` message first**, and the preload must hold the port until it sees that ready signal, then forward it. The spike MUST exercise and log this ordering (`screenshare-debug.log`: `hop2=port-forward ready-handshake ok` vs. `hop2=contextBridge-fallback`).

### Pattern 3: napi ThreadsafeFunction push from the WASAPI capture thread
**What:** The Rust capture loop runs on its own thread (woken by the WASAPI event handle). Each ~10 ms it copies a 480-frame interleaved-stereo f32 buffer and pushes it to JS via a `ThreadsafeFunction`.
**When to use:** The addon→main-JS delivery shape (push, per CONTEXT discretion — natural fit for the event-driven loop).
```rust
// Source: https://napi.rs/docs/concepts/threadsafe-function + docs.rs/napi  [CITED]
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

#[napi]
pub fn start(exclude_root_pid: u32, on_chunk: ThreadsafeFunction<Vec<u8>>) -> napi::Result<()> {
    std::thread::spawn(move || {
        // ... ActivateAudioInterfaceAsync(EXCLUDE_TREE, exclude_root_pid) ...
        // ... event-driven GetBuffer loop, hardcoded 48k/stereo/f32 format ...
        loop {
            // wait_for_single_object(audio_event)
            // for each packet: GetBuffer → copy 480 frames (interleaved L,R f32) → Vec<u8>
            let chunk: Vec<u8> = /* 480 frames * 2ch * 4 bytes = 3840 bytes */ Vec::new();
            // NonBlocking + a bounded queue gives drop-on-overflow backpressure (T4):
            on_chunk.call(Ok(chunk), ThreadsafeFunctionCallMode::NonBlocking);
            // GetNextPacketSize / ReleaseBuffer ...
        }
    });
    Ok(())
}
```
- **CalleeHandled vs not:** default `ThreadsafeFunction` is callee-handled (first JS arg is an error); use `Result<T>` in `.call()`. A non-error variant exists if you want the buffer as the first arg directly.
- **Backpressure (T4):** with `NonBlocking` mode and a bounded `MaxQueueSize`, `.call()` returns `Status::QueueFull` when the JS side can't keep up — Rust then **drops the oldest** chunk (or skips), realizing the locked drop-oldest policy at the FFI boundary. (Note: docs warn `MaxQueueSize` has no effect in `Blocking` mode — use `NonBlocking`.) `[CITED: napi.rs threadsafe-function]`
- **Buffer type:** push as a `Vec<u8>` (napi `Buffer`, transfers ownership into V8) or a typed array; on the JS side reinterpret as `Float32Array`. The renderer's MSTG feeder consumes f32 directly.

### Pattern 4: 3-way additive gate in screenshare.ts (ECHO-03, no regression)
**What:** Add the Windows native branch as an explicit additive `else if`, preserving the Linux patchcord branch and the universal `"loopback"` fallback.
**Where:** `src/windows/screenshare/screenshare.ts:90-100` (the `audioConfig.mode !== "none"` branch).
```typescript
// MODIFIED (additive — Linux branch UNCHANGED, "loopback" stays universal fallback)
if (audioConfig.mode !== "none") {
  if (hasPipewirePulse && process.platform === "linux") {
    // UNCHANGED Linux patchcord branch
    try {
      await (audioConfig.mode === "system" ? patchcordStartSystem : patchcordStartApp)(audioConfig.pids);
    } catch (err) {
      console.error("[Screenshare] Failed to start patchcord node:", err);
    }
  } else if (process.platform === "win32" && (await tryStartWasapiLoopback())) {
    // NEW: native EXCLUDE-tree started; renderer will swap the track in. Do NOT set result.audio
    //      (no "loopback" track to remove — or set it so the renderer has a track to swap; see note).
  } else {
    result.audio = "loopback"; // UNCHANGED universal fallback (macOS, pre-2004 Win, load/activation failure)
  }
}
```
> **Note on whether to still set `result.audio = "loopback"` in the native branch:** Phase 3's swap seam removes the *existing* audio track and adds the reconstructed one. If `result.audio` is unset, there is no track to remove (fine — the renderer just `addTrack`s the reconstructed one). If set to `"loopback"`, the renderer removes the echoing loopback track and replaces it. **Recommendation:** still request `result.audio = "loopback"` in the native branch so the renderer's swap-seam shape (stop/remove → addTrack) is identical to Phase 3 and to the patchcord path — the loopback track is captured-then-discarded, the reconstructed exclude-tree track replaces it. This keeps the diff minimal and the swap seam unchanged. **The spike should confirm this is harmless** (the extra loopback track is removed before it streams). `[ASSUMED — confirm in spike that requesting+removing loopback adds no echo window]`

### Anti-Patterns to Avoid
- **Per-frame `ipcRenderer.send` of raw PCM** (ARCHITECTURE.md:250-253): 48 kHz stereo over JSON-serialized IPC is a latency/GC disaster. Use the MessagePort transferable path. (Locked by T2.)
- **Excluding the window/renderer PID instead of the process tree root** (PITFALLS V6): Chromium renders call audio from the separate **Audio Service** utility process. Pass `process.pid` (Electron main) with `EXCLUDE_TARGET_PROCESS_TREE` so the Audio Service child is covered. Confirm via logged `app.getAppMetrics()`.
- **Refactoring `patchcord.ts` / the Linux branch into a "shared" abstraction** (PITFALLS T4): risks regressing the validated Linux path and bloats the PR. Add a sibling `wasapiLoopback.ts`; keep the Linux branch byte-identical.
- **Calling `GetMixFormat`/`IsFormatSupported` on the loopback device** (PITFALLS T1): returns `E_NOTIMPL`. Hardcode the format.
- **Static-linking `ActivateAudioInterfaceAsync`** (PITFALLS T2): breaks `.node` load on pre-2004 builds. Dynamic `LoadLibrary`/`GetProcAddress`.
- **Hardcoding an OS build-number gate** (CONTEXT Open Q3): the documented 20348 is wrong (02-FINDINGS §2.3 UPDATE — works on 19041+). Try-activate-and-catch instead.
- **Treating activation as synchronous** (PITFALLS T5): `ActivateAudioInterfaceAsync` completes on an `IActivateAudioInterfaceCompletionHandler`; wait on the event before using the `IAudioClient`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| WASAPI process-loopback activation | A from-scratch COM activation flow | The MS `ApplicationLoopback` `LoopbackCapture.cpp` initialization path, re-expressed via `windows-rs` | The async-activation + completion-handler + `E_NOTIMPL`-format quirks are exactly the landmines the sample encodes; a generic WASAPI tutorial hits all of them. |
| PCM resampling/format conversion to 48k/stereo/f32 | A Rust resampler / channel matrixer | `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM` + `SRC_DEFAULT_QUALITY` on Initialize | The audio engine inserts the converter in shared mode — request 48k/stereo/f32 directly; no Rust DSP. `[CITED: learn.microsoft.com audclnt-streamflags]` |
| Main→renderer high-rate audio bridge | A custom IPC/shared-memory protocol | `MessageChannelMain` + transferable `ArrayBuffer` | Electron's blessed zero-copy path for exactly this case; ordered, backpressure-friendly, off the ipcMain router. |
| Port into the injected main world | A bespoke postMessage protocol | Electron's documented `window.postMessage(..., [port])` forward + readiness handshake | The exact pattern in the MessagePorts tutorial; proven for high-throughput renderer data. |
| N-API ABI compatibility with Electron | Per-Electron-version prebuilds | One napi-rs N-API `.node` per `{platform, arch}` | N-API is ABI-stable across Node/Electron; venbind ships one binary that loads in Electron 41 with no `electron-rebuild`. |
| Audio Service PID discovery | Parsing tasklist / WMIC | `app.getAppMetrics()` | Already used by `patchcord.ts:80`; lists every Electron process with its `type` (`Audio Service`). |
| `.node` packaging into the artifact | A custom copy step in CI | `copyNativeModules()` + the `native-module:` glob + electron-builder's existing `ts-out/native/*-win32-*.node` inclusion | The pipeline already ships venbind's `.node` this way; mirror the naming exactly. |

**Key insight:** Every hard problem in this phase already has a blessed, in-codebase or MS-documented solution. The only genuinely novel code is the ~few-hundred-line clean-room Rust capture loop in the addon repo — and even that is a mechanical re-expression of the MIT MS sample. GoofCord's own diff is a handful of additive edits.

## Runtime State Inventory

> This is a feature/integration phase, not a rename/refactor. No stored data, OS-registered state, or build-artifact migration is involved. The relevant "runtime state" is the new `.node` binary and the new env var, both covered below.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — no datastore keys/IDs change. | None. |
| Live service config | None — no external service config. | None. |
| OS-registered state | None — no Task Scheduler / service registration. The WASAPI capture is process-local, torn down on `STREAM_CLOSE`. | None. |
| Secrets/env vars | NEW dev/CI env var `GOOFCORD_WASAPI_LOOPBACK_PATH` (mirrors `GOOFCORD_VENBIND_PATH`/`GOOFCORD_PATCHCORD_PATH`) — points `copyNativeModules()` at the prebuilt `.node`. Also `--no-wasapi` opt-out arg (mirrors `--no-venbind`). | Document in `testBuild.yml` / build invocation; not a secret. |
| Build artifacts | NEW prebuilt `wasapi-loopback-win32-x64.node` copied to `assets/native/` then bundled into `ts-out/native/`. | Ensure the env override / prebuild path is set when the CI build runs (Open Q1). |

## Common Pitfalls

### Pitfall 1: Hop-2 readiness race — port forwarded before the main world listens
**What goes wrong:** The preload receives the `MessagePortMain` and immediately `window.postMessage`s it, but the `webFrame.executeJavaScript`-injected main-world script hasn't registered its `message` listener yet → the port (and its first chunks) are lost; capture appears to produce silence.
**Why it happens:** Injection order — the preload runs first; the main-world script is injected later. The Electron docs explicitly warn about this ("wait until the main world is ready").
**How to avoid:** Readiness handshake — the main-world script posts a `ready` marker (e.g. `window.postMessage("goofcord:wasapi-ready","*")`); the preload buffers the port until it sees `ready`, then forwards. Log the handshake in `screenshare-debug.log`.
**Warning signs:** Viewer hears silence despite `screenshare-debug.log` showing capture started and chunks pushed; `hop2` line missing a `ready ok`.

### Pitfall 2: AUTOCONVERTPCM flag passed to the wrong Initialize parameter (MS sample bug #196)
**What goes wrong:** The MS `ApplicationLoopback` sample has a known bug (microsoft/Windows-classic-samples#196) where `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM` was passed into the `hnsPeriodicity` argument instead of the `StreamFlags` argument. A 1:1 port inherits the bug → no conversion → format mismatch or init failure.
**Why it happens:** Copy-faithful porting of a sample that has the bug.
**How to avoid:** Pass `AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY` to the **`StreamFlags`** (2nd) parameter of `Initialize`; pass `0` for `hnsBufferDuration`/`hnsPeriodicity` as appropriate for event-driven shared mode. `[CITED: github.com/microsoft/Windows-classic-samples/issues/196]`
**Warning signs:** Initialize returns an error, or capture delivers the device's native format instead of the requested 48k/stereo/f32.

### Pitfall 3: `.node` not packaged / glob name mismatch → silent fallback (PITFALLS V4 / M3)
**What goes wrong:** If the `.node` filename doesn't contain both `win32` and `x64`, `nativeModulePlugin` emits `export default null` (no error), `require(null)` no-ops, and the code silently falls to `"loopback"` — looking like "the fix doesn't work" with no error.
**Why it happens:** Three independent pipeline stages (prebuild path → `copyNativeModules()` entry → glob substring match) must all align.
**How to avoid:** Name it exactly `wasapi-loopback-win32-x64.node`. Add a startup null-check log (`wasapiPath resolved? <bool>`). Add a CI packaging assertion (a `dir`/`ls` step asserting the `.node` is in the packaged output). electron-builder already includes `ts-out/native/*-win32-*.node` on Windows and excludes Linux ones — no `electron-builder.ts` change needed if the name matches.
**Warning signs:** Second-device test identical to pre-fix (still echoes), no errors; `screenshare-debug.log` shows the fallback branch on a Win11 box.

### Pitfall 4: Activation treated as synchronous; teardown races (PITFALLS T5)
**What goes wrong:** `ActivateAudioInterfaceAsync` returns immediately; using the `IAudioClient` before the completion handler signals yields a null/uninitialized client (silent capture). Tearing down the capture thread without coordinating with the async activation leaks the client or hangs on quit.
**Why it happens:** The "Async" is easy to overlook; FFI lifecycle coordination is fiddly.
**How to avoid:** Wait on the completion handler's event (`WaitForSingleObject`) before `GetActivateResult`. Expose a clean `start`/`stop` pair; wire `stop` into `STREAM_CLOSE` (`screensharePatch.ts:90-104`) and mirror `stopPatchcord`'s `Promise.race([dispose, timeout])` so a hung native stop can't wedge quit. Idempotent stop (composes with the Phase 1 single-owner `finishRequest` cleanup).
**Warning signs:** Intermittent silent capture; hang on app quit or stream stop; leaked capture threads across repeated start/stop.

### Pitfall 5: Verifying on the maintainer's 19045 box / streamer-side / silent desktop (PITFALLS V1-V3)
**What goes wrong:** The 19045 dev box may or may not activate (02-FINDINGS §2.3 UPDATE says 19041+ works — so it *should* on 19045, but this is the first time GoofCord's own addon runs there, not Discord's). Regardless, the **streamer cannot hear echo** (Electron `disable_local_echo=true`), and WASAPI loopback delivers silence when nothing plays.
**Why it happens:** Path of least resistance; "no echo when I listen" feels like proof but isn't.
**How to avoid:** Verify **viewer-side** (second device/account) with **non-call audio actively playing** outside the Discord tree. Confirm BOTH: (a) viewer hears desktop audio (capture works), (b) viewer does NOT hear call voices (exclude works). Log build number, excluded root PID, Audio Service PID, activation result, and chunk count to `screenshare-debug.log`.
**Warning signs:** A "pass" report with no build number, no second device, or no actively-playing audio.

### Pitfall 6: Clean-room contamination (PITFALLS C1, ECHO-04)
**What goes wrong:** Modeling the addon on Discord's symbol layout (`ActivateApplicationLoopbackForProcessTree`, `excludedSubtrees`) contaminates the clean-room boundary and poisons the upstream PR.
**How to avoid:** Author solely from the public MS `ApplicationLoopback` sample (MIT) + MS docs. Retain Microsoft's copyright + MIT permission notice in the Rust source. No Discord symbol names anywhere in source or PR.
**Warning signs:** A commit/PR citing a Discord internal symbol as a design basis.

## Code Examples

### Resolving the exclude-tree root PID + logging the Audio Service child (ECHO-02, V6)
```typescript
// Source: pattern from patchcord.ts:80 (app.getAppMetrics) + PITFALLS V6  [VERIFIED: codebase grep]
import { app } from "electron";

const rootPid = process.pid; // Electron MAIN process — the tree root
const metrics = app.getAppMetrics();
const audioService = metrics.find((p) => p.name === "Audio Service");
// EXCLUDE_TARGET_PROCESS_TREE on rootPid covers the Audio Service child.
void appendScreenshareDebug(
  `wasapi exclude-root=${rootPid} audioService=${audioService?.pid ?? "not-found"} ` +
  `procs=${metrics.map((p) => `${p.name}:${p.pid}`).join(",")}`,
);
// Pass rootPid to the addon as the EXCLUDE target.
```
> **Note:** `app.getAppMetrics()`'s `ProcessMetric` exposes `pid` and `name` (and `type`), but **not the parent PID** — so GoofCord cannot *programmatically* prove Audio Service is a descendant of `process.pid` from `getAppMetrics()` alone. The verification is: log the PIDs, and the **viewer-audible no-echo result** is the ground truth that the exclude covered the call audio. If echo persists despite "activated," the Audio Service may be a detached sibling (OBS #9669 pattern) — then exclude the broadest GoofCord ancestor or the Audio Service PID's own tree. `[ASSUMED — confirm subtree relationship via the viewer test on the first CI artifact]`

### Hardcoded 48k/stereo/float32 WAVEFORMATEXTENSIBLE (RESOLVES Open Q2)
```rust
// Source: MS Q&A 1125409 (E_NOTIMPL → hardcode) + audclnt-streamflags (AUTOCONVERTPCM
//         enables arbitrary uncompressed format in shared mode). Matches Phase 3 contract. [CITED]
// Request 48000 Hz / 2ch / 32-bit IEEE float directly — the engine converts via AUTOCONVERTPCM.
let mut wfx = WAVEFORMATEXTENSIBLE {
    Format: WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_EXTENSIBLE as u16,
        nChannels: 2,
        nSamplesPerSec: 48_000,
        wBitsPerSample: 32,
        nBlockAlign: 2 * 32 / 8,            // 8 bytes/frame
        nAvgBytesPerSec: 48_000 * 8,        // 384000
        cbSize: (size_of::<WAVEFORMATEXTENSIBLE>() - size_of::<WAVEFORMATEX>()) as u16,
    },
    Samples: WAVEFORMATEXTENSIBLE_0 { wValidBitsPerSample: 32 },
    dwChannelMask: SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT, // 0x3
    SubFormat: KSDATAFORMAT_SUBTYPE_IEEE_FLOAT,
};
// Initialize (note StreamFlags is the SECOND param — sample bug #196):
audio_client.Initialize(
    AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK
        | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    0,  // hnsBufferDuration
    0,  // hnsPeriodicity
    &wfx.Format,
    None,
)?;
```
> **If a plain `WAVE_FORMAT_IEEE_FLOAT` WAVEFORMATEX (not EXTENSIBLE) is simpler and accepted**, that is fine too — `AUTOCONVERTPCM` works for any uncompressed integer or float format. The EXTENSIBLE form is the safe, explicit choice. `[CITED: FlexASIO #32 / NAudio #819 confirm AUTOCONVERTPCM resamples integer+float in shared mode]`

### Dynamic load + try-activate-and-catch (RESOLVES Open Q3, ECHO-03)
```rust
// Source: PITFALLS T2 (dynamic load) + MS docs (no single "unsupported" HRESULT —
//         catch ANY non-S_OK activation result). Mirrors Discord's runtime fallback.  [CITED/ASSUMED]
// 1. Dynamic resolution (NOT static import) so the .node loads on every Windows build:
let h = LoadLibraryW(w!("mmdevapi.dll"));               // or audioses.dll
let proc = GetProcAddress(h, s!("ActivateAudioInterfaceAsync"));
if proc.is_none() {
    return Ok(ActivationResult::Unsupported); // → JS falls through to "loopback"
}
// 2. Activate; the completion handler signals an event. Catch ANY failure:
let activate_result: HRESULT = /* operation.GetActivateResult(&mut hr, &mut iface) */;
if activate_result != S_OK {
    // E_NOTIMPL (0x80004001), E_INVALIDARG (0x80070057), AUDCLNT_E_DEVICE_INVALIDATED
    // (0x88890004), or any other non-success → treat as "unsupported on this build".
    return Ok(ActivationResult::Unsupported);
}
```
```typescript
// Main-process wrapper (wasapiLoopback.ts) — the JS side of the fallback:
export async function tryStartWasapiLoopback(): Promise<boolean> {
  if (process.argv.includes("--no-wasapi") || process.platform !== "win32") return false;
  const addon = await obtainWasapiLoopback(); // require(.node) via createRequire, try/catch
  if (!addon) { void appendScreenshareDebug("wasapi unsupported: addon not loaded"); return false; }
  try {
    const ok = await addon.start(process.pid, onPcmChunk); // resolves false if activation != S_OK
    void appendScreenshareDebug(`wasapi activation=${ok ? "ok" : "unsupported"} exclude-root=${process.pid}`);
    return ok;
  } catch (e) {
    void appendScreenshareDebug(`wasapi start threw: ${getErrorMessage(e)}`);
    return false; // → "loopback" fallback, never crash (ECHO-03)
  }
}
```
> **`screenshare-debug.log` line content (ECHO-02 + ECHO-03), required for honest verification:**
> `wasapi exclude-root=<rootPid> audioService=<asPid> procs=<name:pid,...>`
> `wasapi activation=<ok|unsupported> hop1=messageport hop2=<port-forward|contextBridge> chunks=<n>`
> A verification report missing the activation result, excluded root PID, Audio Service PID, hop-2 mechanism, and chunk count is **not** a pass.

### Phase-3 KEEP seed — the MSTG feeder fed from a MessagePort (replaces synthetic generator)
```javascript
// Source: deliverySpike.ts buildSyntheticAudioTrack() (Phase 3 KEEP) — swap the synthetic
//         sample loop for MessagePort-delivered chunks. The MSTG + AudioData shape is unchanged. [VERIFIED: codebase]
const gen = new MediaStreamTrackGenerator({ kind: "audio" });
const writer = gen.writable.getWriter();
let tsUs = 0;
const SAMPLE_RATE = 48000, CHANNELS = 2, FRAMES = 480;
function feedRing(ab /* ArrayBuffer of 480*2 interleaved f32 */) {
  const data = new Float32Array(ab);
  const ad = new AudioData({
    format: "f32", sampleRate: SAMPLE_RATE, numberOfFrames: FRAMES,
    numberOfChannels: CHANNELS, timestamp: tsUs, data,
  });
  tsUs += Math.round((FRAMES / SAMPLE_RATE) * 1e6); // monotonic µs (else frames garble)
  void writer.write(ad);
}
// Then the existing swap seam (screensharePatch.ts:79-84): stop/removeTrack existing → addTrack(gen)
```
> **Bounded ring depth (T4 concrete guidance):** at 480-frame / ~10 ms chunks, a **3–5 chunk ring (~30–50 ms)** is the recommended starting depth — enough to absorb the inherent jitter between the WASAPI event cadence and the MSTG `writer.write()` consumption without accumulating latency. On overflow, drop the oldest chunk; on underrun, write a silence (zero-filled) `AudioData` frame of the same shape to keep the MSTG timeline monotonic. Tune from observed underrun/drift in the spike. `[ASSUMED — derived from the 10ms cadence; tune empirically]`

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| MS sample's 44100/16-bit hardcoded format | Request 48k/stereo/f32 directly via `AUTOCONVERTPCM` | Always available (shared-mode flag) | No Rust resampler; matches Phase 3 renderer contract exactly. |
| "Process loopback needs build 20348" (documented) | Works on Win10 2004 / 19041+ (runtime-confirmed) | 02-FINDINGS §2.3 UPDATE | No hardcoded build gate; try-activate-and-catch. |
| napi-rs v2 (Docker cross-compile) | napi-rs v3 (`napi` 3.x, native CLI cross-compile) | 2025 | Simpler addon-repo CI; `windows-latest` native MSVC build, no Docker. |
| MessagePort assumed isolated-world-only | Port-forward into main world via `window.postMessage(..., [port])` is documented + blessed | Electron docs (current) | Hop-2 default is viable; contextBridge fallback not expected to be needed. |

**Deprecated/outdated:**
- The research SUMMARY.md "workaround-first" recommendation — superseded by the native-only milestone decision (REQUIREMENTS Out of Scope).
- The "20348 minimum" build gate — superseded by 19041+ (02-FINDINGS §2.3 UPDATE). Do not gate on a build number.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `windows` crate feature set (`Win32_Media_KernelStreaming`, `Win32_System_Com_StructuredStorage`, etc.) provides `WAVEFORMATEXTENSIBLE` / `KSDATAFORMAT_SUBTYPE_IEEE_FLOAT` / `PROPVARIANT` on 0.62.2 | Standard Stack | Build error in addon repo; adjust feature flags (low risk — these are standard Win32 modules). |
| A2 | Requesting 48k/stereo/f32 with `AUTOCONVERTPCM` succeeds on the process-loopback device (not just real endpoints) | Code Examples / Open Q2 | If the loopback device rejects non-44100/16-bit even with AUTOCONVERTPCM, the addon must convert in Rust (f32 conversion lives in the addon, per CONTEXT default). The MS sample uses 44100/16-bit; AUTOCONVERTPCM is documented to work in shared mode but was not tested specifically on the loopback magic-device. **Spike/first-CI-artifact must confirm.** |
| A3 | Requesting `result.audio = "loopback"` in the native branch and removing that track in the renderer adds no audible echo window before the swap | Pattern 4 | If the brief loopback track streams before removal, a momentary echo could reach the viewer. Spike confirms; alternative is to not set `result.audio` at all. |
| A4 | Audio Service is a descendant of `process.pid` on Electron 41.3.0, so EXCLUDE_TARGET_PROCESS_TREE on the root covers it | Code Examples / ECHO-02 | If detached sibling, echo persists despite "activated" — fall back to excluding the broadest GoofCord ancestor or the Audio Service tree. Confirmed only by the viewer-audible test (getAppMetrics has no parent-PID field). |
| A5 | No single documented HRESULT marks "API unavailable on this build"; catching any non-`S_OK` activation result is the correct robust signal | Code Examples / Open Q3 | If a specific recoverable HRESULT (e.g. device-invalidated) should be retried rather than treated as unsupported, the catch-all might mask a transient error. Low risk — the fallback is still safe `"loopback"`. |
| A6 | Bounded ring depth ~3–5 chunks (~30–50 ms) absorbs jitter without latency creep | Code Examples / T4 | Too shallow → audible glitches under load; too deep → latency creep. Tunable empirically in the spike. |

## Open Questions

1. **Does the process-loopback magic device accept 48k/stereo/f32 with AUTOCONVERTPCM, or force 16-bit?** (Open Q2 / A2)
   - What we know: `AUTOCONVERTPCM` enables arbitrary uncompressed format conversion in **shared mode** on normal endpoints `[CITED]`; the MS sample applies it on the loopback device and uses 44100/16-bit as its *demo* default, not a documented constraint.
   - What's unclear: whether the loopback magic-device specifically honors a non-44100/16-bit request even with AUTOCONVERTPCM (it is backed by `CMixerClient`, a non-standard client).
   - Recommendation: request 48k/stereo/f32 first; if Initialize fails, fall back to the sample's 44100/16-bit and do the f32+resample conversion in Rust before transport (CONTEXT default). The spike's first real-WASAPI CI artifact resolves this; the **transport spike (synthetic source) does not depend on it** — it can emit 48k/stereo/f32 directly.

2. **Is Audio Service a descendant of `process.pid` on Electron 41.3.0?** (A4)
   - What we know: it runs as a separate sandboxed utility process (patchcord.ts confirms it exists via `getAppMetrics`); `EXCLUDE_TARGET_PROCESS_TREE` covers descendants.
   - What's unclear: `getAppMetrics()` exposes no parent PID, so the subtree relationship can't be proven programmatically.
   - Recommendation: log all PIDs; the viewer-audible no-echo result is the ground truth. If echo persists, exclude the broadest ancestor.

3. **Exact failure HRESULT on truly-old builds (< 19041).** (A5)
   - What we know: there is no single documented "unsupported on this build" HRESULT; failure can surface synchronously (GetProcAddress null) or asynchronously (non-`S_OK` activateResult).
   - Recommendation: try-and-catch any non-success; the maintainer's 19045 box (per 02-FINDINGS UPDATE) should *activate* — so the < 19041 path can only be exercised on an even older VM, which is acceptable to leave as best-effort graceful-fallback (ECHO-03 is satisfied as long as it doesn't crash).

## Environment Availability

> The addon's Rust/cargo toolchain is NOT required on the maintainer's box or in GoofCord's CI — it lives in the (Phase-5) addon repo's own CI. For Phase 4, the prebuilt `.node` is obtained via env override and copied. GoofCord's build needs only what it already has.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Bun | GoofCord build (`build/build.ts`) | ✓ (CI: `oven-sh/setup-bun@v2`, latest) | latest | — |
| Node.js | electron-builder, CI | ✓ (CI: `setup-node@v4` 24.x) | 24.x | — |
| electron-builder | Packaging | ✓ (CI: `bun add -g`) | 26.8.1 | — |
| Electron runtime (N-API host) | Loading the `.node` | ✓ | 41.3.0 (Chromium 146, Node 24.14.0) | — |
| `windows-latest` CI runner (≥ build 20348) | Building the `.node` (if built in `testBuild.yml`) AND running it (verification artifact host) | ✓ (GitHub runner) | ≥ 20348 | — |
| Rust / cargo / `@napi-rs/cli` | Building the `.node` | ✗ on maintainer box & GoofCord CI | — | Build in addon repo CI, or add a `windows-latest`-only Rust step to `testBuild.yml` for Phase 4 (Open Q1) |
| A Win10 2004+/Win11 device + second Discord account | Viewer-side verification | (maintainer-provided) | — | None — manual verification is unavoidable (no automated repro) |

**Missing dependencies with no fallback:** the second device + viewer-side manual test — inherent to the milestone (no automated screenshare repro).
**Missing dependencies with fallback:** Rust toolchain — not needed in GoofCord; the `.node` is produced in CI/addon-repo and consumed via `GOOFCORD_WASAPI_LOOPBACK_PATH`.

### Open Q1 resolution — how Phase 4 obtains a real `.node`

**Recommended: build the addon on the existing `testBuild.yml` Windows runner, behind the env override.** Concretely, for Phase 4 (before the Phase-5 published repo exists), the cleanest path that keeps GoofCord's diff additive and reversible is:

1. Keep the Rust crate **in a sibling directory or a temporary in-repo `native/wasapi-loopback/` folder** (deleted/extracted to its own repo in Phase 5).
2. Add a **`windows-latest`-only step** to `testBuild.yml` (or a separate workflow): install Rust (`dtolnay/rust-toolchain@stable`) + `@napi-rs/cli`, run `napi build --release --target x86_64-pc-windows-msvc`, then set `GOOFCORD_WASAPI_LOOPBACK_PATH` to the produced `.node` for the `bun run build` step. `copyNativeModules()` already honors the env override (`build/build.ts:205-218`) and renames it to `wasapi-loopback-win32-x64.node`.
3. **N-API loads under Electron 41.3.0 without `electron-rebuild`** — venbind (a napi-rs `.node`) already proves this; N-API is ABI-stable. The in-Electron smoke (SC#5) is a startup `require` + a no-op export call logged to `screenshare-debug.log` (catches an ABI mismatch as a build failure, not a wasted second-device round-trip — PITFALLS T3).

> This temporarily couples GoofCord's CI to Rust (the thing STACK.md warns against for the *final* state) — but it is the pragmatic Phase-4-only way to get a binary on CI without first standing up a published npm package, and it is removed in Phase 5 when the addon moves to its own repo + `optionalDependencies` (the STACK.md/venbind end state). The alternative — **committing a prebuilt `.node` to the repo** — also works and avoids the Rust CI step, but a committed binary is harder to review/trust in the eventual upstream PR. **Recommendation: the CI-build-behind-env-override approach for Phase 4**, transitioning to the published-repo model in Phase 5. `[ASSUMED — planner's call between CI-build vs. committed-prebuild; both satisfy "real .node on CI"]`

## Sources

### Primary (HIGH confidence)
- `.planning/phases/03-.../03-FINDINGS.md` + `03-CONTEXT.md` — proven delivery path, MSTG confirmed on Chromium 146, KEEP/THROWAWAY split, residual risks #1-3, PCM 48k/stereo/f32 contract. (codebase)
- `.planning/phases/02-.../02-FINDINGS.md` — EXCLUDE-vs-INCLUDE, exclude the Electron tree/Audio Service child, build floor 19041+, public WASAPI symbol surface, `GetMixFormat → E_NOTIMPL`, clean-room GO. (codebase)
- `.planning/research/{SUMMARY,STACK,PITFALLS,ARCHITECTURE}.md` — stack (Rust+napi-rs+windows crate), venbind template, packaging pipeline, anti-patterns, verification protocol. (codebase)
- GoofCord source (direct read): `screensharePatch.ts`, `screenshare.ts`, `venbind.ts`, `patchcord.ts`, `build/build.ts`, `build/nativeImport.ts`, `electron-builder.ts`, `screenshareDebug.ts`, `deliverySpike.ts`, `bridge.ts`, `testBuild.yml`. (codebase)
- [Electron MessagePorts tutorial](https://www.electronjs.org/docs/latest/tutorial/message-ports) — port delivered to preload isolated world; `window.postMessage(..., [port])` forward to main world; readiness handshake requirement. RESOLVES T3.
- [Electron 41 release](https://www.electronjs.org/blog/electron-41-0) — Chromium 146.0.7680.65, V8 14.6, Node 24.14.0.
- [MS Q&A 1125409](https://learn.microsoft.com/en-us/answers/questions/1125409/) — process-loopback `GetMixFormat`/`IsFormatSupported` → `E_NOTIMPL`; hardcode format.
- [MS audclnt-streamflags](https://github.com/MicrosoftDocs/win32/blob/docs/desktop-src/CoreAudio/audclnt-streamflags-xxx-constants.md) — `AUTOCONVERTPCM` (0x80000000) inserts resampler + channel matrixer for uncompressed int/float in shared mode; `SRC_DEFAULT_QUALITY` for human-audible.
- [MS ApplicationLoopback sample](https://github.com/microsoft/Windows-classic-samples/blob/main/Samples/ApplicationLoopback/cpp/LoopbackCapture.cpp) — clean-room source; activation + completion handler + event-driven GetBuffer loop + Initialize flags. (MIT — retain notice)
- crates.io / npm verified this session: `windows 0.62.2`, `napi 3.9.0`, `napi-derive 3.5.6`, `@napi-rs/cli 3.7.0`.

### Secondary (MEDIUM confidence)
- [napi.rs ThreadsafeFunction](https://napi.rs/docs/concepts/threadsafe-function) + [docs.rs napi](https://docs.rs/napi/latest/napi/threadsafe_function/) — push pattern, NonBlocking + MaxQueueSize backpressure.
- [Windows-classic-samples #196](https://github.com/microsoft/Windows-classic-samples/issues/196) — AUTOCONVERTPCM passed to wrong Initialize parameter (sample bug to avoid).
- [FlexASIO #32](https://github.com/dechamps/FlexASIO/issues/32) / [NAudio #819](https://github.com/naudio/NAudio/issues/819) / [Mark Heath WASAPI resampling](https://markheath.net/post/wasapi-sample-rate-conversion) — AUTOCONVERTPCM resamples int+float in shared mode.
- [windows-rs ActivateAudioInterfaceAsync](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/Media/Audio/fn.ActivateAudioInterfaceAsync.html) — Rust binding signature + completion handler.

### Tertiary (LOW confidence / needs validation)
- Exact activation-failure HRESULT on < 19041 builds — no single documented code; try-and-catch any non-`S_OK` (A5).
- slopcheck npm verdicts on Rust crates — cross-ecosystem false positives; authoritative check is crates.io.

## Metadata

**Confidence breakdown:**
- Transport (hop-1 + hop-2): HIGH — Electron docs prescribe the exact port-forward pattern; Chromium 146 confirmed; spike will empirically settle it.
- Format contract: HIGH on the mechanism (`E_NOTIMPL` → hardcode; AUTOCONVERTPCM converts), MEDIUM on whether the *loopback magic-device specifically* honors 48k/f32 (A2 — first CI artifact confirms).
- Stack/packaging: HIGH — versions verified on the correct registries; pipeline read from source; venbind precedent.
- WASAPI capture lifecycle: HIGH — MS sample + windows-rs; the async/teardown/dynamic-load gotchas are all documented.
- Activation-failure signature: MEDIUM — try-and-catch is robust regardless of the exact HRESULT.

**Research date:** 2026-06-02
**Valid until:** 2026-07-02 (stable APIs; re-verify crate/Electron versions if planning slips past a month)
