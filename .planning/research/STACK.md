# Stack Research

**Domain:** Windows WASAPI process-loopback (exclude-tree) audio-capture native addon for an Electron/Bun app (GoofCord), following the existing `venbind`/`patchcord` native-addon precedent — milestone v1.1 echo fix (Bug B / upstream #46).
**Researched:** 2026-05-30
**Confidence:** HIGH on the venbind/patchcord build+distribution mechanism (read directly from the installed packages), HIGH on the public WASAPI API surface and toolchain versions (Context7 + crates.io/npm verified), MEDIUM on the cross-compile-from-CI specifics (verified the capability exists; the exact `windows-latest` runner recipe is straightforward but unproven on this repo).

> **Supersedes** the prior milestone's STACK.md (v1.0 — Electron capture-API semantics for the cancel/re-click fix). This pass is scoped to the v1.1 echo fix only: the stack/build choices needed to ship a Windows exclude-tree loopback capability, and the near-zero-stack workaround alternative, so the D-06 decision can weigh them.

---

## TL;DR for the D-06 decision

Two paths, very different stack cost:

- **Native addon path** (the real echo fix): add **one** new optional dependency — a small **Rust + napi-rs** `.node` addon wrapping the public WASAPI process-loopback API, built **on the existing `windows-latest` CI runner** (no cross-compile needed — CI already runs on Windows), and wired into the **existing** `native-module:` + `assets/native/*.node` + `copyNativeModules()` pipeline. **Zero new build tooling in GoofCord itself** (Rust/napi-rs live in the addon's own repo, exactly like venbind). This is the venbind clone, not a new pattern.
- **User-side workaround path** (the < 20348 fallback / do-nothing-native option): **near-zero stack** — one settings-schema entry + a localization string + documentation. No native code, no new deps, trivially upstreamable.

A **hybrid** (native where build ≥ 20348, documented workaround below it) costs exactly the native path's stack plus the workaround's near-zero stack, and is the recommendation the recon's "GO — conditional on build ≥ 20348" verdict points at.

**The single most important precedent fact:** venbind is **already** a Rust + napi-rs `.node` addon distributed as **prebuilt per-platform binaries inside its npm package** — GoofCord never compiles it; `copyNativeModules()` in `build/build.ts` just copies `node_modules/venbind/prebuilds/windows-x86_64/venbind-windows-x86_64.node` to `assets/native/venbind-win32-x64.node`. A new WASAPI addon should follow this **identically**: ship prebuilt, consume prebuilt.

---

## How venbind & patchcord are ACTUALLY built and distributed (the precedent, verified)

Read directly from `node_modules/venbind/` and `node_modules/patchcord/` + the build script. **Not guessed.**

| | **venbind** (the right precedent) | **patchcord** (the wrong shape for audio capture) |
|---|---|---|
| What it is | A true N-API `.node` addon, `require()`d in-process | A standalone Rust **CLI binary**, `spawn()`ed as a **subprocess** over stdio |
| Language / toolchain | **Rust + napi-rs**; also bindgen (needs libclang/LLVM) for its `uiohook-sys` submodule | **Rust** (`cargo build --release`), `miniserde`; no Node addon at all |
| How GoofCord loads it | `require(venbindPath)` where `venbindPath` resolves a `.node` (`src/modules/native/venbind.ts:22`) | `new AudioSharePatchbay({ command: …path to binary })` → `child_process.spawn` (`node_modules/patchcord/node/patchcord.js:44`) |
| Distribution | **Prebuilt per-platform `.node` shipped INSIDE the npm package**: `prebuilds/{windows-x86_64,windows-aarch64,linux-x86_64,linux-aarch64}/venbind-*.node`. Declared `"os":["linux","win32"]`,`"cpu":["x64","arm64"]` so npm/Bun only resolves on supported platforms. npm version `0.1.7` (pinned, not git). | **Prebuilt standalone binaries shipped inside the package**: `dist/patchcord-linux-{x64,arm64}`. `"os":["linux"]`. Consumed via `github:Milkshiift/patchcord` (git dep, pinned commit `f261163` in `bun.lock`). Built upstream via `build-rs.sh` (cargo + `-Z build-std`, nightly). |
| GoofCord's role at build time | `copyNativeModules()` (`build/build.ts:168-232`) copies the matching prebuilt binary into `assets/native/`. **GoofCord does NOT compile it.** | Same — `copyNativeModules()` copies `dist/patchcord-linux-*` into `assets/native/`. |
| Declared in `package.json` | `optionalDependencies: { "venbind": "0.1.7" }` | `optionalDependencies: { "patchcord": "github:Milkshiift/patchcord" }` |
| Runtime gate | `--no-venbind` flag + try/catch; `venbindPath` is `null` on unsupported platforms (the `nativeModulePlugin` emits `export default null` when no file matches the target platform/arch) | `--no-patchcord` flag + `hasPipewirePulse` probe; Linux-only |

**Decisive takeaways for the new addon:**

1. **It's an N-API addon, distributed prebuilt.** Because napi-rs targets the **ABI-stable Node-API**, venbind ships **one** `.node` per platform/arch and it loads in Electron 41 **without recompilation** — N-API decouples the binary from `NODE_MODULE_VERSION`. This is *the* reason the prebuilt-binary model works and is the property the new addon must preserve. (Verified: venbind ships a single `venbind-windows-x86_64.node`, no per-Electron-version variants; Node-API is ABI-stable across Node/Electron — [Electron native modules docs](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules), [Node-API docs](https://nodejs.org/api/n-api.html).)
2. **The build toolchain lives in the addon's OWN repo, not GoofCord.** GoofCord's build (`build/build.ts`, Bun) only ever **copies** a prebuilt binary. So adding a WASAPI addon adds **no Rust/cargo/cmake to GoofCord's build** — it adds a new prebuilt artifact to copy. This directly satisfies the "no new build tooling" constraint *for GoofCord*.
3. **patchcord's subprocess model is the wrong shape here.** patchcord works as a subprocess because on Linux the *OS* (PipeWire) does the actual audio routing — patchcord just orchestrates the graph and Discord reads the virtual sink. On Windows there is no equivalent OS routing; the addon itself must run the WASAPI capture loop and stream PCM frames with low latency. That is an **in-process `.node` addon** job (venbind shape), not a stdio subprocess. **Follow venbind, not patchcord.**

---

## Recommended Stack

### Core Technologies (NATIVE ADDON PATH)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Rust** (stable) | 1.82.0+ (windows-rs MSRV) | Implementation language of the new WASAPI addon | Matches **both** existing native addons (venbind & patchcord are Rust). Reuses the maintainer's existing Rust addon muscle memory and lets the addon repo mirror venbind's structure 1:1. C++ is a viable alternative (see Alternatives) but diverges from precedent. |
| **napi-rs** (`napi` crate + `@napi-rs/cli`) | `napi` 3.x / `@napi-rs/cli` **3.6.2** | Build the Rust code into an ABI-stable N-API `.node` addon + generate the JS/TS loader | **This is exactly what venbind uses.** napi-rs v3 (stable, 2025) targets the ABI-stable Node-API, so one prebuilt `.node` per platform loads in Electron 41 with no recompilation; v3 also dropped the old Docker cross-compile images in favour of native CLI cross-compilation. ([Announcing NAPI-RS v3](https://napi.rs/blog/announce-v3), [@napi-rs/cli npm](https://www.npmjs.com/package/@napi-rs/cli)) |
| **windows** crate (windows-rs) | **0.62.2** | Safe Rust bindings to the WASAPI process-loopback API (`ActivateAudioInterfaceAsync`, `AUDIOCLIENT_ACTIVATION_PARAMS`, `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS`, `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`, `IAudioClient`/`IAudioCaptureClient`) | Microsoft-published, generated from Windows metadata; exposes **the exact public symbols** the recon named (`02-FINDINGS.md §3.1`) with **no clean-room risk** — these are the public MS API, not Discord internals. `ActivateAudioInterfaceAsync` confirmed present in `windows::Win32::Media::Audio`. ([windows crate on crates.io](https://crates.io/crates/windows), [windows-docs-rs ActivateAudioInterfaceAsync](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/Media/Audio/fn.ActivateAudioInterfaceAsync.html)) |

> **Feature-gate the windows crate** to keep build time/size down: `windows = { version = "0.62", features = ["Win32_Media_Audio", "Win32_System_Com", "Win32_Foundation"] }`. Do NOT pull the whole crate.

### Core Technologies (USER-SIDE WORKAROUND PATH)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **(none — existing stack only)** | — | A settings toggle/help entry + docs telling the user to route GoofCord output to a separate audio device (VB-Cable / SteelSeries Sonar / Voicemeeter) so the captured default-endpoint mix excludes the call | Zero new dependency, zero native code, instantly upstreamable. Uses the **existing** `src/settingsSchema.ts` builder (`setting()`/`button()`) + `src/stores/localization/` strings. This is the only viable path for builds < 20348 regardless. |

### Supporting Libraries / Glue (NATIVE ADDON PATH — all EXISTING, nothing new in GoofCord)

| Library / Mechanism | Version | Purpose | When to Use |
|---------------------|---------|---------|-------------|
| `nativeModulePlugin` (`build/nativeImport.ts`) | existing | Resolves `native-module:../../../assets/native/wasapi-loopback-*.node` to the platform/arch-matched prebuilt at build time; emits `export default null` when no match (the graceful-degradation hook) | Reuse verbatim — add an `import wasapiPath from "native-module:.../wasapi-loopback-*.node"` in a new `src/modules/native/windowsLoopback.ts`, mirroring `venbind.ts`. |
| `copyNativeModules()` (`build/build.ts`) | existing | Copies the prebuilt `.node` from `node_modules/<dep>/prebuilds/...` into `assets/native/<name>-<platform>-<arch>.node` | **Add one entry** to the `modules` array (alongside venbind/patchcord) pointing at the new addon's prebuild path + a `GOOFCORD_WASAPI_LOOPBACK_PATH` env override (mirrors `GOOFCORD_VENBIND_PATH`). |
| `createRequire` + try/catch load | existing pattern | Load the addon at runtime, swallow failure, expose `is*Loaded()` | Mirror `obtainVenbind()` in `src/modules/native/venbind.ts:19-31`. |
| Electron `app.getAppMetrics()` | Electron 41.3.0 (existing) | Enumerate GoofCord's own process tree / Audio Service PID to pass as the exclude target | patchcord already uses this (`patchcord.ts:80`) to find the `"Audio Service"` PID — reuse the same approach to resolve the exclude-tree root (resolves `02-FINDINGS.md §2.2` Electron multi-process concern). |
| `src/settingsSchema.ts` `hidden()`/`setting()` | existing | Build-gate flag + optional user toggle; persisted via electron-sync-store | For the build-≥20348 detection result and any user opt-out. |

### Development Tools (live in the ADDON's repo, not GoofCord)

| Tool | Purpose | Notes |
|------|---------|-------|
| `@napi-rs/cli` 3.6.2 | `napi build --platform --release --target x86_64-pc-windows-msvc` produces the `.node` + scaffolds the CI publish workflow | Run **in the addon repo's own CI**, exactly like venbind. `napi new` scaffolds a GitHub Actions matrix that builds + publishes prebuilds. ([napi build docs](https://napi.rs/docs/cli/build)) |
| Rust toolchain (`rustup`, stable) | `cargo` builds the crate | windows crate MSRV 1.82.0. No bindgen/libclang needed (windows-rs is pure metadata-generated — **simpler than venbind**, which needs libclang for `uiohook-sys`). |
| GitHub Actions `windows-latest` | Build the `x86_64-pc-windows-msvc` `.node` natively | The addon's CI uses a Windows runner → **MSVC native build, no cross-compile gymnastics.** Same runner GoofCord's `testBuild.yml` already uses. |

---

## CI changes (GoofCord side) — what `testBuild.yml` needs

Crucially, **GoofCord's CI does not need to compile anything.** The build/distribution split is:

1. **Addon repo CI** (new, owned alongside venbind) — builds + publishes the prebuilt `.node`. Native MSVC build on `windows-latest`; **no cross-compile needed** (the recon's "maintainer can't compile on 19045" constraint is irrelevant to CI — CI runs on a modern Windows runner that is ≥ build 20348). napi-rs v3 cross-compile exists as a backstop but isn't required here.
2. **GoofCord CI** (`testBuild.yml`) — already runs on `windows-latest`, already runs `bun install --frozen-lockfile` then `bun run build`. Because `copyNativeModules()` copies the prebuilt addon out of `node_modules`, **the only change needed is making sure the new optional dependency is in `package.json` + `bun.lock`.** No new build step, no toolchain install (no Rust on the GoofCord runner).

**Concrete `testBuild.yml` deltas (minimal):**
- **None to the workflow YAML itself** if the addon ships prebuilds via npm/git like venbind — `bun install` pulls it, `copyNativeModules()` copies it.
- The artifact upload already globs `dist/**/*.zip`; the `.node` ends up inside the packaged app via electron-builder's normal `assets/` inclusion (verify the new file matches existing `assets/native/*.node` packaging — it will, since it lands in the same dir).
- **If** the addon is *not* published with prebuilds and must be built in CI (NOT recommended), then add a `windows-latest`-only step: install Rust (`dtolnay/rust-toolchain@stable`), `napi build --release --target x86_64-pc-windows-msvc`, copy to `assets/native/`. This couples GoofCord's build to Rust and is the path to avoid — keep the build in the addon repo.

**Verification note (from PROJECT.md / MEMORY):** the maintainer's box is Win10 19045 (< 20348), so the native path **cannot be exercised locally**. Verification = the `windows-latest` CI artifact (CI runners are ≥ 20348) + a second physical device on Windows 11, viewer-side, with audio actively playing (WASAPI loopback delivers no samples on silence — D-08).

---

## Installation (what actually gets added)

```bash
# NATIVE ADDON PATH — added to GoofCord's package.json optionalDependencies,
# mirroring venbind. The addon itself is built/published from its own repo.
#   "optionalDependencies": {
#     "patchcord": "github:Milkshiift/patchcord",
#     "venbind": "0.1.7",
#     "<wasapi-loopback-addon>": "github:Milkshiift/<addon>"   // or pinned npm version
#   }
bun add -O github:Milkshiift/<wasapi-loopback-addon>   # optional dep, prebuilt .node inside

# In the ADDON's own repo (NOT GoofCord) — the build toolchain:
cargo add windows --features Win32_Media_Audio,Win32_System_Com,Win32_Foundation
cargo add napi --features napi8        # napi-rs runtime
cargo add napi-derive
npm install -D @napi-rs/cli@3.6.2      # build CLI + CI scaffold

# USER-SIDE WORKAROUND PATH — nothing installed. Edit src/settingsSchema.ts + a lang JSON.
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| **Rust + napi-rs** addon | **C++ + node-addon-api + cmake-js / node-gyp** | Choose C++ only if you want the implementation to map 1:1 onto the Microsoft `ApplicationLoopback` C++ sample (the clean-room source) with the least translation. It's a legitimate, even *more direct* clean-room port. **But** it diverges from both existing addons (Rust), needs its own cmake-js/node-gyp toolchain, and `node-addon-api`/`prebuildify` binaries are still N-API ABI-stable so the distribution model is identical. Net: same prebuilt-`.node` outcome, less consistent with the repo. The recon's clean-room reference is C++; napi-rs requires re-expressing it in Rust via windows-rs (mechanical, well-trodden). |
| **`windows` crate (windows-rs)** | **`wasapi` crate** (henquist/wasapi-rs) | The `wasapi` crate is a friendlier high-level wrapper, but the **process-loopback activation path is niche** and may not expose `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS` / `EXCLUDE_TARGET_PROCESS_TREE` cleanly. Use raw `windows-rs` for full control over the activation params; consider `wasapi` only if it demonstrably covers the exclude-tree activation. |
| **windows-latest native CI build** | **napi-rs v3 Linux→Windows cross-compile** | Only if you ever want to build the addon without a Windows runner. Unnecessary here — GoofCord's CI is already on `windows-latest` and the addon's CI can be too. ([napi-rs cross-build](https://napi.rs/docs/cross-build.en)) |
| **Prebuilt-in-package distribution** (venbind model) | **Build-in-GoofCord-CI** | Avoid. Building the addon inside GoofCord's CI couples GoofCord's build to Rust and violates the spirit of "no new build tooling." Keep the toolchain in the addon repo; GoofCord only copies the artifact. |
| **Hybrid (native ≥ 20348 + workaround below)** | **Workaround-only** | Workaround-only is the right *interim* milestone if shipping a new native binary + CI is judged too heavy for an upstream PR right now — it's the only thing that works < 20348 anyway, and it's a near-zero-diff change. The recon's GO verdict supports building native eventually; the hybrid captures both. |

---

## What NOT to Use / NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **Any copied Discord code / Discord's symbol layout** (`ActivateApplicationLoopbackForProcessTree`, `excludedSubtrees`) as an implementation recipe | Breaks the LOCKED clean-room boundary (D-05); poisons the upstream PR and creates licensing exposure | The **public Microsoft `ApplicationLoopback` sample** + windows-rs bindings only. The recon read Discord's DLL **only** to learn *which* API — never *how*. |
| **A virtual audio cable / kernel driver** (the macOS-style approach) | Heavy, requires install/admin, not cleanly upstreamable, unnecessary — Windows has the in-OS API since build 20348 | In-OS WASAPI process-loopback (no device install). |
| **Chromium `audio: "loopback"` / `"loopbackWithMute"`** for the echo fix | Captures the **whole** endpoint mix including Discord's own playback — this is the *cause* of Bug B, not a fix | Native exclude-tree capture (the addon). Keep `"loopback"` only as the pre-existing whole-mix behaviour for users who don't hit echo. |
| **node-gyp/cmake-js inside GoofCord's Bun build** | Adds a second build system to a repo whose constraint is explicitly "no new build tooling"; would force Rust/C++ toolchains onto every GoofCord build/CI | Keep the compile in the addon's own repo; GoofCord's `copyNativeModules()` only copies a prebuilt `.node`. |
| **Per-Electron-version / per-Node-version prebuilds (`prebuild`/`node-pre-gyp`-style ABI matrix)** | Unnecessary churn — N-API addons are ABI-stable across Node/Electron; venbind ships **one** binary per platform and it works in Electron 41 | A single N-API `.node` per `{platform, arch}` (napi-rs default), exactly like venbind. |
| **bindgen / libclang dependency** (venbind needs it for `uiohook-sys`) | The WASAPI addon has no C header to bind — windows-rs is metadata-generated | Pure `windows` crate; **simpler build than venbind**, no libclang. |
| **A heavyweight audio framework (CPAL, miniaudio, ffmpeg)** | Overkill; the capability is a direct WASAPI activation + a capture loop — a few hundred lines against `windows-rs`, matching the MS sample | Raw `windows-rs` WASAPI, modelled on the MS `ApplicationLoopback` sample. |

---

## Stack Patterns by Variant

**If the chosen D-06 path is NATIVE (or HYBRID):**
- New optional dependency = a **Rust + napi-rs `.node` addon** (venbind clone), built in its **own** repo on `windows-latest`, shipping a prebuilt `x86_64-pc-windows-msvc` `.node`.
- GoofCord integration is **three small files / edits**: `src/modules/native/windowsLoopback.ts` (mirror `venbind.ts`), one entry in `copyNativeModules()` (`build/build.ts`), one `optionalDependencies` line. Plus the runtime build-≥20348 gate + graceful fallback (the `nativeModulePlugin` already emits `null` for unsupported platforms; add a `winver`/build check before activating).
- Exclude target = GoofCord/Electron **process tree** (via `app.getAppMetrics()` to find the Audio Service PID), not a single window PID (`02-FINDINGS.md §2.2`).

**If the chosen D-06 path is WORKAROUND-ONLY:**
- **No new dependency, no native code.** One `setting()`/`hidden()` entry in `src/settingsSchema.ts` + a localization string + a docs/help blurb describing the separate-output-device routing. Fully upstreamable, near-zero diff.

**If build < 20348 (always, regardless of path):**
- The native exclude-tree API is unavailable → degrade gracefully to the workaround/no-system-audio. The addon must detect the build (`02-FINDINGS.md §2.3`) and not hard-fail — mirror Discord's own `"audioses is too old…"` fallback behaviour.

---

## Version Compatibility

| Component | Compatible With | Notes |
|-----------|-----------------|-------|
| napi-rs N-API `.node` | Electron 41.3.0 / Node 24.x | N-API is ABI-stable — one prebuilt binary works across Node/Electron without `NODE_MODULE_VERSION` recompilation. This is why venbind 0.1.7 (built once) loads in Electron 41. ([Electron native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)) |
| `windows` 0.62.2 | Rust 1.82.0+ (MSRV) | windows-rs MSRV is 1.82.0; use stable Rust in the addon repo. ([crates.io/windows](https://crates.io/crates/windows)) |
| `@napi-rs/cli` 3.6.2 | `napi` 3.x crate | Use matching v3 CLI + runtime; v3 is the current stable line (2025+). |
| WASAPI process-loopback API | **Windows build ≥ 20348 only** (effectively Windows 11) | Hard runtime precondition; the addon must build-gate. Header `audioclientactivationparams.h`. Win10 retail (incl. 19045) is below it. ([MS Requirements table](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-process_loopback_mode)) |
| `assets/native/*.node` glob | `nativeImport.ts` matcher | Matcher lowercases and checks the filename `includes(platform) && includes(arch)`. Name the prebuild so `win32`/`x64` (or the `copyNativeModules()` output name `wasapi-loopback-win32-x64.node`) match — follow venbind's `venbind-win32-x64.node` output naming. |

---

## Sources

- **`node_modules/venbind/` + `node_modules/patchcord/` (read directly)** — HIGH. Established the build/distribution mechanism factually: venbind = Rust+napi-rs prebuilt `.node` in `prebuilds/`; patchcord = Rust CLI prebuilt binary in `dist/`, run as a subprocess. `package.json` `os`/`cpu` gating, version pins (`venbind@0.1.7`, `patchcord@github#f261163`).
- **`build/build.ts:168-232` (`copyNativeModules`), `build/nativeImport.ts`, `src/modules/native/{venbind,patchcord}.ts` (read directly)** — HIGH. Confirmed GoofCord only *copies* prebuilt binaries; no compile in GoofCord's build; the `native-module:` resolution + `null` fallback for unsupported platforms.
- **`.planning/phases/02-.../02-FINDINGS.md` & `02-RESEARCH.md`** — HIGH (the reconned mechanism; not re-derived). Public WASAPI symbol surface, EXCLUDE-tree = echo fix, build ≥ 20348, Electron multi-process exclude-tree target.
- [/napi-rs/website via Context7] — HIGH — `napi build` CLI, cross-compile, prebuilt distribution model.
- [Announcing NAPI-RS v3](https://napi.rs/blog/announce-v3) + [@napi-rs/cli npm](https://www.npmjs.com/package/@napi-rs/cli) — HIGH — `@napi-rs/cli` latest **3.6.2**; v3 native cross-compile (Docker images dropped).
- [crates.io: windows](https://crates.io/crates/windows) + [windows-docs-rs ActivateAudioInterfaceAsync](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/Media/Audio/fn.ActivateAudioInterfaceAsync.html) — HIGH — `windows` crate **0.62.2**, MSRV 1.82.0, exposes `ActivateAudioInterfaceAsync` + WASAPI process-loopback types in `Win32::Media::Audio`.
- [Electron native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules) + [Node-API](https://nodejs.org/api/n-api.html) — HIGH — N-API ABI stability across Node/Electron (one prebuilt binary, no per-version recompilation).
- [MS PROCESS_LOOPBACK_MODE Requirements](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-process_loopback_mode) — HIGH — minimum build 20348.
- [napi-rs cross-build](https://napi.rs/docs/cross-build.en) — MEDIUM — cross-compile capability (backstop, not needed since CI is on `windows-latest`).

---
*Stack research for: Windows WASAPI process-loopback (exclude-tree) native addon for GoofCord — milestone v1.1 echo fix*
*Researched: 2026-05-30*
