# Pitfalls Research — v1.1 Implementation Phase (Windows Screenshare ECHO Fix)

**Domain:** Adding a native Windows WASAPI process-loopback EXCLUDE-tree audio-capture path to GoofCord (Electron 41.3.0 + Bun build + electron-builder), to stop screenshare echo (Bug B / upstream #46) — and **verifying it without a capable local dev box.**
**Researched:** 2026-05-30
**Confidence:** HIGH on the WASAPI gotchas + the codebase integration model (verified against source + Microsoft docs); HIGH on the verification traps (locked decisions D-08/D-09 + Electron/MS docs); MEDIUM on the exact Electron 41.3.0 audio-process PID layout (architecture is public; the concrete runtime PIDs were not observed on-box — see 02-FINDINGS §2.2).

> **This file EXTENDS the v1.0 PITFALLS** (which covered the cancel/restart bug + the *diagnosis* of Bug B). v1.0 is archived in git; do not restate it. Where a v1.0 pitfall still binds, it is referenced by number, not repeated. v1.0's Bug-B pitfalls (P5 loopback-track-arrival, P6 `disable_local_echo` mirage, P7 don't-blame-Electron-regression) were *diagnostic*; this file is about **building and shipping the native fix** and **proving it works**.
>
> **The mechanism is already reconned — do not re-derive it.** Public WASAPI Application Loopback, `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`, min build 20348, dynamically loaded, clean-room GO conditional on build ≥ 20348 (02-FINDINGS §3.3). These pitfalls are about the *implementation and verification of that decided approach*, not the choice itself.

---

## The single biggest risk to this milestone (read first)

**The maintainer's dev box is Windows 10 build 19045 — below the 20348 API minimum (02-FINDINGS §2.3). The native exclude-tree path CANNOT execute on it, and there is no automated screenshare repro.** Every verification pitfall below (P-V1…P-V6) flows from this one fact. The dominant failure mode for this milestone is **not** a coding bug — it is *believing the fix works (or doesn't) based on a test that could never have exercised it.* On the 19045 box the code will always take the **fallback** branch, so "I tested locally and there was no echo" proves nothing about the native fix, and "I tested locally and it still echoed" also proves nothing. The only meaningful signal is a **Windows-11-CI-built artifact, run on a build-≥20348 machine, observed from a second-device viewer, with audio actively playing.** Structure the whole phase around that loop or the milestone cannot be honestly closed.

---

## Critical Pitfalls

### Pitfall V1: "It didn't echo on my box" — concluding the fix works from a test that never ran the native path (THE milestone-killer)

**What goes wrong:**
The maintainer builds, runs GoofCord on the 19045 dev box, screenshares, listens, hears no echo of *their own* call, and marks the fix done. But on 19045 (< 20348) the native exclude-tree activation is unavailable, so the code took the **fallback** branch (whole-mix `"loopback"` or no system audio) — exactly the path that *causes* echo. The "no echo" observation came from `disable_local_echo` muting local playback (v1.0 P6), not from the fix. The native code path was never executed; the test is structurally incapable of confirming or refuting it.

**Why it happens:**
The dev box is the path of least resistance, and "no echo when I listen" feels like proof. Two design facts conspire: (1) build-gating means the native branch silently no-ops below 20348 (correct behavior — see P3), and (2) Electron hardcodes `disable_local_echo=true`, so the *streamer* never hears their own captured audio regardless (v1.0 P6, electron #37293). Both make a local "pass" look real.

**How to prevent:**
- **Treat the 19045 box as a fallback-path tester only.** It can verify the *graceful-degradation* branch (app doesn't crash, audio either off or whole-mix as before, no regression) — and nothing about the native fix. Write this into the verification plan as an explicit scope line.
- **The fix's success criterion is only satisfiable on a build-≥20348 machine** (effectively Windows 11). Make that machine (the second device, or any Win11 box) the *named* verification environment in the phase plan, not an afterthought.
- **Add a build-number log line** at activation: log the detected Windows build and which branch was taken (`native exclude-tree activated` vs `build <20348, using fallback`) to the userData `screenshare-debug.log` (Phase 1 D-02; D-09 — no DevTools). Then a test report can state *which path actually ran*. A "pass" report that doesn't name the build number and branch is not a pass.

**Warning sign:** A verification note that says "tested, no echo" without stating the Windows build number and which code branch executed. Any verification done *only* on the 19045 box.

**Phase to address:** Verification phase (highest priority); the activation-logging is a small task in the implementation phase that enables honest verification.

---

### Pitfall V2: Verifying echo from the streamer's machine instead of a second-device viewer

**What goes wrong:**
The whole point of Bug B is that *viewers* hear themselves; the streamer, by design, cannot hear the echo locally (Electron hardcodes `disable_local_echo=true`, electron #37293 — v1.0 P6, locked as D-08). Listening on the streaming box gives a guaranteed false "no echo" no matter what the code does. This compounds V1: even on a Win11 box, a local-only listen still proves nothing.

**Why it happens:**
It's the obvious thing to do and requires no second device. v1.0 already flagged this for diagnosis; it bites *twice as hard* now because the fix's entire payoff is viewer-side.

**How to prevent:**
- **Verification is viewer-side, period (D-08).** Use the second Discord account on a separate device, join the call/stream, and listen *there*. The streamer machine's audio output is irrelevant to the test.
- The "fixed" criterion is concrete: with the streamer screensharing system audio while a call is live, the viewer hears the *desktop/app audio* (e.g. music, a game) but does **not** hear the call participants' voices fed back. Before the fix the viewer hears the call echoed; after, they don't.
- Script the two-device protocol once and reuse it every CI round-trip (CI round-trips are scarce — Phase 1 D-01).

**Warning sign:** A test report whose audio observations were made on the streaming machine. No mention of a second device/account in the verification steps.

**Phase to address:** Verification phase.

---

### Pitfall V3: Verifying with nothing playing — WASAPI loopback delivers silence, misread as "broken" or "fixed"

**What goes wrong:**
WASAPI loopback (and process-loopback specifically) delivers **no audio samples when nothing is playing** on the endpoint (PortAudio #935, Audacity #2356; locked as D-08). If the tester screenshares with a silent desktop, the viewer hears nothing — which can be misread either as "the capture is broken" (false negative) or, worse, "the echo is fixed!" (false positive — there was simply no audio to echo). Either way the test is void.

**Why it happens:**
Loopback-capture-yields-silence-on-idle is non-obvious; testers naturally start a stream and *then* go looking for audio. The exclude-tree path makes it sneakier: with the call client excluded, the *only* audio left to capture is whatever else is playing — so if nothing else plays, the captured stream is correctly silent and indistinguishable from a broken capture.

**How to prevent:**
- **Keep non-call audio actively playing during the entire test** — a music track, a YouTube video, a game (something *other* than the Discord call), so there's a positive signal the viewer should hear.
- The verification matrix has two checks that must *both* hold: (a) viewer **hears** the desktop/app audio (proves capture works), and (b) viewer does **not** hear the call voices echoed (proves the exclude worked). Silence fails (a); echo fails (b).
- Note in the protocol: test audio must be a source *outside* the excluded Discord/Electron process tree, or it'll be excluded too.

**Warning sign:** A test where the only audio source was the Discord call itself. A "fixed — viewer hears nothing" conclusion (that's the silence trap, not a fix).

**Phase to address:** Verification phase (bake into the two-device protocol).

---

### Pitfall V4: No CI matrix entry / no packaged native binary — the artifact can't even exercise the fix

**What goes wrong:**
`testBuild.yml` currently builds a Windows x64 `zip` only, with `bun install --frozen-lockfile` + `bun run build` + `electron-builder`. If the new native `.node` addon isn't (a) present as a committed/installable prebuild, (b) copied into `assets/native/` by `copyNativeModules()` in `build/build.ts`, and (c) packaged by electron-builder, then the CI artifact ships *without the fix* and every download "fails to fix echo" — not because the code is wrong but because the binary isn't there. Since the dev box can't test natively (V1), CI *is* the only delivery vehicle, so a packaging gap is invisible until the second-device test mysteriously shows no change.

**Why it happens:**
The native-module pipeline has three independent stages that must all be updated together (see Integration Gotchas table), and a miss in any one degrades silently to the fallback path (P3 makes the fallback *quiet by design*, which hides the gap). The current `copyNativeModules()` hardcodes only `patchcord` and `venbind`; a new module won't be copied unless explicitly added.

**How to prevent:**
- **Mirror the venbind model exactly** (it's the right template — a real `.node` N-API addon, unlike patchcord which is a subprocess binary shipped via `extraResources`):
  1. Add the prebuilt `.node` to the module's `prebuilds` (committed, like `node_modules/venbind/prebuilds/windows-x86_64/`), and add a new entry to the `modules` array in `copyNativeModules()` so it lands in `assets/native/<name>-win32-x64.node`.
  2. Import it via `native-module:../../../assets/native/<name>-*.node` (the `nativeModulePlugin` glob matches by `process.platform` + `process.arch` substrings — so the file MUST be named with `win32` and `x64` in it, e.g. `goofcord-audio-win32-x64.node`).
  3. `require()` it at runtime via `createRequire(import.meta.url)` exactly like `venbind.ts`.
  4. Confirm electron-builder includes it: the win config is `files: [...files, "!ts-out/native/*-linux-*.node"]` — it *excludes* Linux `.node` but *includes* win32 ones bundled under `ts-out/native/`. Verify the new file lands in `ts-out/native/` (the bundler copies `with { type: "file" }` outputs there) and is NOT excluded.
- **Add a CI smoke check**: after build, assert the `.node` exists in the packaged output (a one-line `dir`/`ls` step) so a packaging regression fails the build loudly instead of silently degrading.
- The dev box can't build the native addon for Win11 either (it's 19045) — so the prebuild must be produced by CI or committed, not built on the maintainer's machine.

**Warning sign:** Second-device test shows *identical* behavior to before the fix (still echoes) with no errors — classic "binary not shipped, silently fell back." `screenshare-debug.log` showing the fallback branch on a Win11 box.

**Phase to address:** Implementation phase (build wiring) + a CI-packaging-assertion task before the first verification round-trip.

---

### Pitfall V5: Spending a CI round-trip per trivial mistake — the feedback loop is the scarcest resource

**What goes wrong:**
With no local native test, every "does it work?" question costs a full `workflow_dispatch` → build → download → install on a Win11 box → set up two-device call → test cycle. Burning a whole round-trip to discover a typo, a missing log line, or a packaging miss (V4) is the practical tax that stalls this milestone. Phase 1 already learned this (D-01: one combined build per round-trip; instrumentation + change as distinct commits).

**Why it happens:**
The reflex from a normal dev loop is "change, run, see." Here "run" is ~10+ minutes of CI + manual setup, often on someone else's schedule (second device/person).

**How to prevent:**
- **Batch everything into each CI build** (Phase 1 D-01): land the activation/build-number logging (V1), the packaging assertion (V4), and the code change together so one artifact answers multiple questions.
- **Front-load all locally-checkable correctness** before spending a round-trip: type-check (`bun run check`), lint, and a local build on the 19045 box to confirm the *fallback* path and that the bundle includes the `.node` (you can verify packaging locally even though you can't run the native path).
- **Make the log file answer the questions a round-trip would otherwise re-ask**: build number, branch taken, excluded PID(s), activation success/failure, sample-count > 0. A rich `screenshare-debug.log` turns one round-trip into a full diagnostic instead of a single yes/no.
- Strip all instrumentation before the upstream PR (Phase 1 D-04 / UPST-01) — but keep it through verification.

**Warning sign:** A sequence of CI builds each changing one tiny thing. A test that comes back "didn't work" with no log to say *why*, forcing another round-trip just to add logging.

**Phase to address:** Implementation phase (instrumentation design) + verification planning.

---

### Pitfall V6: Excluding the wrong process — single window PID instead of the Electron process TREE (echo persists)

**What goes wrong:**
The fix calls the WASAPI activation with a `TargetProcessId` + `EXCLUDE_TARGET_PROCESS_TREE` mode. If the implementation excludes only the GoofCord **main/window PID**, it will *still capture the call audio*, because Chromium/Electron renders audio in a **separate, sandboxed "Audio Service" utility process** — a *child* of the main process, with a different PID (02-FINDINGS §2.2). Excluding only the window PID misses where the call audio actually plays → the viewer still hears the echo, and it looks like the fix "doesn't work" when really it excluded the wrong process.

**Why it happens:**
Intuition treats "the app" as one process. The exclude-*tree* semantics are specifically designed to cover this (parent + all children), but only if you pass the **root/parent PID of the tree that contains the Audio Service**, not the Audio Service's own PID and not just the renderer. The existing Linux code already knows this pattern — `patchcord.ts` does `app.getAppMetrics().find((p) => p.name === "Audio Service")?.pid` and *excludes that node* — so the audio-service-runs-separately reality is already proven in this codebase.

**How to prevent:**
- **Pass the Electron process-*tree* root** to `EXCLUDE_TARGET_PROCESS_TREE` — i.e. the main GoofCord process PID (`process.pid` of the main process), so its child Audio Service utility process is covered by the tree semantics. Verify against `app.getAppMetrics()` which lists every Electron process and its type (`Audio Service` appears there, as patchcord.ts relies on).
- **Log the excluded root PID and the full `app.getAppMetrics()` process list** to `screenshare-debug.log` during a verification run, so you can confirm the Audio Service PID is a descendant of the excluded root. This is the one detail 02-FINDINGS explicitly left as a "future-impl open detail" (the exact PID layout on Electron 41.3.0 was not observed on-box) — so it *must* be confirmed during implementation, not assumed.
- Don't hardcode an assumption that audio renders from the main process; on some Electron configs the Audio Service may be a top-level sibling under the launcher rather than a child. Confirm the tree relationship from `getAppMetrics()` output, and if the Audio Service is *not* under the excluded root, exclude its tree too (or fall back to excluding the broadest GoofCord ancestor).

**Warning sign:** Echo persists on a Win11 box even though `screenshare-debug.log` shows "native exclude-tree activated." A logged excluded-PID that doesn't contain the Audio Service PID in its subtree.

**Phase to address:** Implementation phase (PID resolution is core to the fix); confirm via the first verification round-trip's log.

---

### Pitfall T1: Treating the process-loopback device like a normal endpoint — `GetMixFormat()`/`IsFormatSupported()` return `E_NOTIMPL`

**What goes wrong:**
The natural WASAPI capture flow is `Activate → GetMixFormat → Initialize(with that format)`. On the process-loopback "magic device" (`VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`), the returned `IAudioClient` is backed by `AudioSes!CMixerClient`, whose `GetMixFormat()` and `IsFormatSupported()` **return `E_NOTIMPL`** (Microsoft Q&A 1125409, verified). A copy-pasted "normal" capture loop will bail at the first HRESULT check, the activation will appear to "fail," and the code will fall to the no-audio branch — looking like a build-gate or packaging problem when it's actually a format-negotiation bug.

**Why it happens:**
Process-loopback isn't tied to a real endpoint, so there's no mix format to query. This is *the* documented quirk of this API and the Microsoft `ApplicationLoopback` sample handles it by **hardcoding** a format. Developers porting a generic WASAPI loopback example (which *does* call `GetMixFormat`) hit `E_NOTIMPL` immediately.

**How to prevent:**
- **Hardcode a fixed `WAVEFORMATEX`** — the Microsoft sample uses CD-quality 2ch / 16-bit / 44100 Hz (the safe, popular default per MS Q&A 1125409). Do not call `GetMixFormat()`/`IsFormatSupported()` on this device.
- Follow the Microsoft `ApplicationLoopback` `LoopbackCapture.cpp` initialization path specifically (it is the clean-room source — D-05), not a generic WASAPI-loopback tutorial, precisely because the sample encodes this quirk.
- Match the hardcoded format to what the consuming side expects (Discord's RTC pipeline / the format you hand back to the renderer track), so no implicit resampling surprises arise.

**Warning sign:** Activation completes but `Initialize`/format calls return `0x80004001` (`E_NOTIMPL`) in the log; capture "fails" only on the loopback device path while a real-endpoint capture would succeed.

**Phase to address:** Implementation phase (native addon core).

---

### Pitfall T2: Static-linking / static-importing the loopback API — breaks load on older Windows instead of degrading gracefully

**What goes wrong:**
If the native addon **statically imports** `ActivateAudioInterfaceAsync` and the `audioclientactivationparams.h` symbols, the `.node` may fail to load *at all* on Windows builds < 20348 (missing-export / module-load failure), taking the whole module — and possibly the screenshare feature — down on every pre-Win11 machine, instead of cleanly degrading to the fallback. Recall the maintainer's own box is 19045: a static-link mistake would make the module unloadable on the *only* machine available for the fallback-path test.

**Why it happens:**
`ActivateAudioInterfaceAsync` is exported from `mmdevapi.dll`/`audioses.dll`; the activation params type is gated to build 20348. Linking against the import library binds the symbol at load time. Discord itself avoids this — recon found it **resolves the API dynamically** via `LoadLibrary`/`GetProcAddress` (02-FINDINGS §1), exactly so the binary loads everywhere and only *activates* the path where supported, with the fallback string `audioses is too old for application loopback capture`.

**How to prevent:**
- **Dynamically load** the loopback entry points (`LoadLibrary("mmdevapi.dll")` / `GetProcAddress`) and **version-gate** before activating: check the OS build (≥ 20348) and that `GetProcAddress` succeeded; if either fails, return a "not supported on this build" status to JS and take the fallback branch. This is the pattern Discord uses and the recon endorses.
- Gate at the JS layer too: only even *attempt* to load/call the native module on `process.platform === "win32"` and a detected build ≥ 20348; otherwise skip straight to fallback (mirrors how `venbind.ts` guards with `--no-venbind` and a try/catch around `require`).
- Ensure the addon's *load* (the `require`) succeeds on 19045 even though *activation* won't — verify on the dev box that `require()` returns a usable object and the gate reports "unsupported," not that the `.node` throws on import.

**Warning sign:** The screenshare feature breaks or the module fails to `require` on the 19045 dev box (it should load and report "unsupported," not throw). DLL-load errors in `screenshare-debug.log` on pre-Win11.

**Phase to address:** Implementation phase (native addon load/gate design).

---

### Pitfall T3: Wrong N-API / ABI build of the addon — loads under plain Node but not under Electron 41

**What goes wrong:**
A `.node` addon built against the wrong N-API version or a non-context-aware/non-N-API ABI can `require()` fine in a bare Node smoke test but fail to load inside Electron 41.3.0 (Electron ships its own Node/V8 ABI), or load but crash. Because the dev box can't run the native path anyway (V1), an ABI mismatch would only surface on the Win11 CI-built artifact — a wasted round-trip (V5) to discover a build-config problem.

**Why it happens:**
Electron's runtime ABI differs from stock Node. N-API/Node-API is the stable-ABI escape hatch (it's why venbind uses napi-rs/N-API and ships a single prebuilt `.node` that works across Node *and* Electron without `electron-rebuild`). A non-N-API addon, or one built against an N-API version higher than Electron 41's Node supports, breaks.

**How to prevent:**
- **Build the addon as a Node-API (N-API) addon** (napi-rs in Rust, like venbind, or node-addon-api in C++), targeting an N-API version Electron 41's Node (Node 24-era) supports. This gives one prebuilt `.node` that loads in both Node and Electron with no `electron-rebuild` step — matching the existing build (which has no rebuild step in `testBuild.yml`).
- **Add a require + smoke-call test inside an Electron context** (not bare Node) to CI, so an ABI mismatch fails the build instead of the second-device test. Even a headless "load module, call a no-op export, log success" in the packaged app's startup (to `screenshare-debug.log`) catches it.
- Verify the chosen N-API version against Electron 41.3.0's bundled Node before committing the prebuild.

**Warning sign:** `require()` of the `.node` throws `Module did not self-register` / `NODE_MODULE_VERSION` / "was compiled against a different Node.js version" *only* inside Electron. Works in `node -e require(...)` but not in the app.

**Phase to address:** Implementation phase (addon toolchain choice) + CI smoke-test task.

---

### Pitfall C1: Lifting Discord's symbol layout (or any Discord DLL detail) into the implementation — clean-room + upstream-PR contamination

**What goes wrong:**
Having read `discord_voice.node` during recon (symbols like `ActivateApplicationLoopbackForProcessTree`, `excludedSubtrees`), it's tempting to model the GoofCord implementation on Discord's *internal arrangement* — wrapper names, call order, struct layout. That contaminates the clean-room boundary (D-05, LOCKED) and poisons a future upstream PR with code derived from a proprietary binary.

**Why it happens:**
The recon answered "*which* approach" by inspecting Discord; the line between "which" (allowed) and "how" (forbidden) is easy to blur once you're already in the DLL.

**How to prevent:**
- **Build only from the public Microsoft `ApplicationLoopback` sample** (`LoopbackCapture.cpp/.h`) — it is the LOCKED clean-room source of truth (D-05, 02-FINDINGS §3.1). Discord's symbols told us *exclude-tree is the right mode*; the *recipe* comes solely from the MS sample.
- The MS sample is **MIT-licensed** (verified — `microsoft/Windows-classic-samples` LICENSE: permits use/copy/modify/merge/distribute). So adapting its code is legally clean **provided you retain Microsoft's copyright notice + the MIT permission notice** in the derived source. Add the attribution header to the native addon's source files — this both satisfies MIT and visibly documents the clean-room provenance for the upstream reviewer.
- Do **not** reference Discord's symbol names anywhere in the GoofCord source or PR description as a how-to. They appear only in the recon doc as evidence of *which* approach.

**Warning sign:** A PR diff or commit message citing a Discord internal symbol as a design basis. Native source that mirrors Discord's wrapper naming rather than the MS sample's.

**Phase to address:** Implementation phase (source authoring) + the upstream-PR-prep phase (D-07).

---

## Moderate Pitfalls

### Pitfall T4: Regressing Linux/macOS or the existing Windows whole-mix path while adding the Windows native branch

**What goes wrong:**
The new Windows exclude-tree path hangs off the same `audioConfig.mode !== "none"` branch in `screenshare.ts:90` that currently does `if (hasPipewirePulse && process.platform === "linux") { patchcord… } else { result.audio = "loopback"; }`. A careless edit to that branch can: break the Linux patchcord path, change the `result.audio = "loopback"` fallback that non-Win11 Windows + macOS still rely on, or run the new native code on a platform it wasn't built for.

**Why it happens:**
It's a single shared decision point; adding a third case is easy to get subtly wrong (e.g. an `else` that now swallows macOS).

**How to prevent:**
- Add the Windows native branch as an **explicit, additive case**: `if (linux + pipewire) → patchcord; else if (win32 + build≥20348 + module loaded) → native exclude-tree; else → result.audio = "loopback"`. The final `else` must still produce the old `"loopback"` behavior for macOS and pre-Win11 Windows (no regression, graceful degradation per D-06).
- The native module load is `win32`-gated and try/caught (P-T2); a load failure must fall through to the `"loopback"` else, never throw.
- electron-builder already excludes the other platform's `.node` from each package (`!ts-out/native/*-linux-*.node` on win, etc.) — keep the new module consistent with that naming so Linux/mac packages don't ship a Windows audio binary.

**Warning sign:** Linux patchcord audio stops working after the change; macOS or Windows-10 builds lose system audio entirely instead of falling back to whole-mix `"loopback"`.

**Phase to address:** Implementation phase (the `screenshare.ts` branch edit) — guard with the existing platform-gating convention.

---

### Pitfall T5: Activation is async + completes on a callback — treating it as synchronous loses the audio client or races teardown

**What goes wrong:**
`ActivateAudioInterfaceAsync` is *asynchronous*: it returns immediately and signals completion via an `IActivateAudioInterfaceCompletionHandler`. Code that assumes a synchronous return, or that doesn't wait on the completion event before using the `IAudioClient`, gets a null/uninitialized client (silent capture). On teardown (stream stop / cancel), tearing down the capture thread without coordinating with the async activation or the capture loop can leak the client or crash — and this must compose with the existing `STREAM_CLOSE` teardown + the v1.0 single-owner `finishRequest()` cleanup.

**Why it happens:**
The "Async" in the name is easy to overlook when adapting a sample; lifecycle coordination across an FFI boundary (native capture thread ↔ JS stream lifecycle) is fiddly.

**How to prevent:**
- Wait on the completion handler's event before calling `GetActivateResult` / using the client (the MS sample does this with an event + `WaitForSingleObject`).
- Expose a clean `start`/`stop` pair across the N-API boundary and wire `stop` into the existing screenshare teardown (`STREAM_CLOSE` FluxDispatcher cleanup in `screensharePatch.ts`, and the main-side `finishRequest`/stop bridge that the Linux `stopPatchcord` path already models). Mirror `stopPatchcord`'s dispose-with-timeout pattern (`Promise.race([dispose, timeout])`) so a hung native stop can't wedge quit.
- Ensure stop is idempotent and safe to call after the window/frame is destroyed (composes with v1.0 Pitfall 3 single-owner cleanup).

**Warning sign:** Intermittent silent capture (client used before activation completed); a hang on app quit or stream stop; leaked capture threads across repeated start/stop.

**Phase to address:** Implementation phase (native lifecycle + teardown wiring).

---

### Pitfall W1: Treating the user-side workaround (virtual cable) as the *primary* fix — fragility + partial coverage

**What goes wrong:**
The deferred fallback for build < 20348 is the *user-side separate-output-device* workaround (route Discord's output to VB-Cable / SteelSeries Sonar so the captured mix excludes the call — D-06, 02-FINDINGS §2.3, #46 comments). If this gets promoted to the main fix (because it needs no native code), it inherits real problems: it depends on a **third-party virtual audio driver the user must install and configure**, breaks if Windows audio device defaults change, only covers users willing to do the setup, and isn't something GoofCord can ship or guarantee. It also can't capture *non-Discord* app audio cleanly without more routing.

**Why it happens:**
It's tempting as a "zero-code" win and as the only option below 20348.

**How to prevent:**
- Keep the workaround as a **documented fallback for sub-20348 users only**, not the shipped fix. The native exclude-tree path is the fix for the supported (≥20348 / Win11) majority; the workaround is the escape hatch below it.
- If documenting it, be explicit about the fragility (third-party driver, manual setup, may need re-doing after audio device changes) so users aren't surprised — and so an upstream reviewer sees it's a stopgap, not the solution.
- Don't bundle or auto-install any virtual-cable driver (heavier than the in-OS API the whole recon recommended against — 02-RESEARCH "Don't Hand-Roll").

**Warning sign:** A plan where the deliverable is "document VB-Cable setup" rather than "ship the native exclude-tree addon, document the workaround as the <20348 fallback."

**Phase to address:** Verification/documentation phase (scope the workaround correctly); implementation phase (don't let it displace the native fix).

---

## Minor Pitfalls

### Pitfall M1: Forgetting that exclude-tree captures *all other* system audio (notifications, other apps) into the stream

**What goes wrong:** EXCLUDE-tree captures everything *except* the Discord/Electron tree — which by design includes unrelated apps, OS notification sounds, other media. A user expecting "only the game" gets all desktop audio minus the call. This is the documented behavior of system/exclude capture (v1.0 Security table noted whole-mix capture), not a bug, but it can surprise users and generate "why does my stream have my notification sounds" reports.
**How to prevent:** Document the behavior. True per-app capture (INCLUDE a chosen app's tree) is a *different* mode and a larger feature — out of scope for the echo fix. Keep the fix to exclude-tree (the echo fix) and note the scope in the PR.
**Phase to address:** Documentation/PR phase.

### Pitfall M2: Leaving build-number/branch instrumentation in the upstream PR

**What goes wrong:** The activation logging (V1), excluded-PID dumps (V6), and smoke-test logs are essential for verification but must not ship upstream (Phase 1 D-04 / UPST-01). Forgetting to strip them bloats the PR and leaks dev-only logging.
**How to prevent:** Tag instrumentation commits distinctly (Phase 1 D-01) and strip them in a dedicated pre-PR commit. Keep a minimal, intentional log line (e.g. one "process-loopback unsupported on this build, using fallback" `console.log`) only if it's genuinely user-useful and matches the codebase's logging conventions.
**Phase to address:** Upstream-PR-prep phase.

### Pitfall M3: The `nativeModulePlugin` glob silently resolves to `null` on a name mismatch

**What goes wrong:** If the `.node` filename doesn't contain both the `process.platform` (`win32`) and `process.arch` (`x64`) substrings, `nativeModulePlugin` returns `export default null` (build/nativeImport.ts:42-47) — no error. The `require(modulePath)` then no-ops (like venbind's `!venbindPath` guard), and the module silently isn't there → silent fallback (compounds V4).
**How to prevent:** Name the prebuilt exactly per the existing convention (`<name>-win32-x64.node`), and assert the import resolved non-null at startup (log it). The build won't warn you; only a runtime null-check or the CI packaging assertion (V4) will.
**Phase to address:** Implementation phase (build wiring).

---

## Integration Gotchas (native `.node` addon → this Electron/Bun/electron-builder system)

| Stage | Common Mistake | Correct Approach (this codebase) |
|-------|----------------|----------------------------------|
| Prebuild availability | Expecting to build the `.node` on the maintainer's box | Box is 19045; produce the prebuild in CI or commit it like `venbind/prebuilds/`. Build as N-API so no `electron-rebuild` (P-T3) |
| `copyNativeModules()` (`build/build.ts:168`) | Adding the import but not the module entry | Add a new entry to the `modules` array so the `.node` is copied to `assets/native/<name>-win32-x64.node` (renamed from the prebuild name) |
| `native-module:` glob (`nativeImport.ts`) | Filename missing `win32`/`x64` | Glob matches by platform+arch substring; mismatch → silent `null` (M3). Name `<name>-win32-x64.node` |
| Runtime load | `import` the `.node` directly | `require()` via `createRequire(import.meta.url)` like `venbind.ts`; guard with platform + build gate + try/catch, fall through to `"loopback"` |
| electron-builder `files` | Assuming the `.node` is auto-included | win config includes win32 `.node` under `ts-out/native/` and excludes linux ones; confirm the new file lands there and isn't excluded (electron-builder.ts:37-46) |
| electron-builder packaging model | Copying patchcord's `extraResources` model | patchcord is a *subprocess binary* (extraResources → `resourcesPath`); a `.node` addon follows the **venbind** model (bundled file + `require`), NOT extraResources |
| Electron audio process | Excluding the window PID | Exclude the Electron process *tree* root; confirm Audio Service PID is in the subtree via `app.getAppMetrics()` (V6) |
| Async activation | Using the client before completion | Wait on the completion handler event; wire stop into `STREAM_CLOSE`/`finishRequest` teardown with a dispose timeout (P-T5) |

---

## Verification Protocol (the actionable two-device + CI loop)

This is the load-bearing deliverable for the milestone. Every "fixed" claim must satisfy **all** of these or it's not verified:

1. **Build:** trigger `testBuild.yml` (`workflow_dispatch`, Windows x64). Confirm CI's post-build assertion shows the new `.node` is packaged (V4). Batch all instrumentation into this one build (V5).
2. **Environment:** install + run the artifact on a **Windows build ≥ 20348 (Win11)** machine — NOT the 19045 dev box (V1). Confirm `screenshare-debug.log` reports the detected build and `native exclude-tree activated` (not the fallback).
3. **Excluded-PID check:** in the same log, confirm the excluded root PID and that the Audio Service PID (from `app.getAppMetrics()`) is within its subtree (V6).
4. **Audio playing:** during the test, keep a **non-Discord** audio source playing (music/game) so there's a positive signal (V3).
5. **Viewer-side observation:** a **second Discord account on a separate device** joins and listens. Confirm BOTH: (a) viewer **hears** the desktop/app audio (capture works, not silence), and (b) viewer does **NOT** hear the call voices echoed (exclude works) (V2, V3).
6. **Fallback check (dev box):** on the 19045 box, confirm the app loads, the module reports "unsupported," no crash, and audio either off or whole-mix `"loopback"` as before — i.e. graceful degradation, no regression (V1 scope line, P-T2).
7. **Non-regression:** Linux patchcord audio and macOS still work (T4).

A verification report missing the build number, the branch-taken log, the second device, or actively-playing audio is **not** a pass.

---

## "Looks Done But Isn't" Checklist (v1.1 implementation)

- [ ] **Native path actually ran:** `screenshare-debug.log` on a Win11 box shows `native exclude-tree activated` with the detected build ≥ 20348 (not the fallback) — V1.
- [ ] **Right process excluded:** excluded root PID's subtree contains the Audio Service PID (`getAppMetrics()`) — V6.
- [ ] **Viewer-side, audio-playing:** echo absence confirmed from a *second device* with *non-call audio playing* — V2, V3.
- [ ] **Capture positive control:** the viewer *can* hear the desktop/app audio (not silent) — V3.
- [ ] **Binary shipped:** the `.node` is present in the packaged artifact (CI assertion) and resolved non-null at runtime — V4, M3.
- [ ] **Loads everywhere, activates selectively:** `.node` `require()`s successfully on the 19045 box and reports "unsupported," does not throw (dynamic load, not static import) — P-T2.
- [ ] **Electron ABI:** addon loads inside Electron 41 (N-API), verified by an in-app smoke call, not just bare Node — P-T3.
- [ ] **Format hardcoded:** no `GetMixFormat`/`IsFormatSupported` calls on the loopback device; fixed format used — P-T1.
- [ ] **Graceful fallback:** macOS + Windows < 20348 still get the old `"loopback"` behavior; Linux patchcord untouched — T4.
- [ ] **Clean teardown:** stop wired into `STREAM_CLOSE`/`finishRequest`, idempotent, dispose-with-timeout; no hang on quit — P-T5.
- [ ] **Clean-room + license:** source built only from the MIT MS sample with Microsoft's copyright notice retained; no Discord symbol layout referenced — C1.
- [ ] **Instrumentation stripped** before the upstream PR — M2, UPST-01.

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| V1 — "no echo on my box" false pass | Verification (impl: add build/branch log) | Log shows build ≥20348 + native branch on a Win11 box |
| V2 — streamer-side listening | Verification | Echo observed/absent from a second device, not the streamer |
| V3 — nothing playing / silence trap | Verification | Viewer hears desktop audio AND no call echo, with audio playing |
| V4 — `.node` not packaged | Implementation (build wiring) + CI assertion | CI asserts `.node` in artifact; runtime resolves non-null |
| V5 — wasting CI round-trips | Implementation (instrumentation) + planning | One batched build answers multiple questions via rich log |
| V6 — wrong PID (not the tree) | Implementation (PID resolution) | Excluded root's subtree contains Audio Service PID |
| T1 — `E_NOTIMPL` / hardcode format | Implementation (addon core) | No `GetMixFormat` calls; fixed format; activation succeeds |
| T2 — static link breaks <20348 load | Implementation (load/gate) | `.node` loads on 19045 and reports "unsupported" |
| T3 — wrong N-API/ABI for Electron | Implementation (toolchain) + CI smoke | In-Electron require + smoke call passes |
| C1 — clean-room/license contamination | Implementation + PR-prep | MS-sample-only; MS copyright retained; no Discord symbols |
| T4 — Linux/macOS/whole-mix regression | Implementation (branch edit) | Patchcord + macOS + pre-Win11 fallback still work |
| T5 — async activation / teardown | Implementation (lifecycle) | No silent capture, no quit hang, idempotent stop |
| W1 — workaround as primary fix | Verification/docs + impl | Native is the fix; workaround documented as <20348 fallback |
| M1 — captures all other audio | Docs/PR | Behavior documented; scope limited to exclude-tree |
| M2 — instrumentation left in PR | PR-prep | Instrumentation stripped (UPST-01) |
| M3 — glob resolves null silently | Implementation (build wiring) | Startup null-check + CI packaging assertion |

---

## Sources

- **02-FINDINGS.md** (this milestone, recon deliverable) — mechanism verdict (public WASAPI process-loopback, dynamically loaded, EXCLUDE-tree, build 19045 < 20348 on dev box), clean-room GO conditional on ≥20348, Electron Audio-Service separate-process complication, the public symbol surface + `GetMixFormat`/`IsFormatSupported` `E_NOTIMPL` quirk. — HIGH (hands-on + desk-research)
- **02-CONTEXT.md** D-05 (clean-room LOCKED), D-06 (impl path), D-08 (viewer-side + audio-playing verification), D-09 (no DevTools → userData log); Phase 1 D-01/D-02/D-04 (CI round-trips, log file, strip instrumentation). — HIGH (locked decisions)
- **GoofCord source (direct read):** `build/build.ts` (`copyNativeModules` modules array, `assets/native/<name>-<platform>-<arch>`), `build/nativeImport.ts` (`native-module:` glob, platform+arch substring match, silent `null` on miss), `src/modules/native/venbind.ts` (N-API `.node` `require` via `createRequire`, `--no-venbind` + try/catch gate — the addon template), `src/modules/native/patchcord.ts` (`app.getAppMetrics().find(p => p.name === "Audio Service")?.pid` exclusion — proves the audio-service-runs-separately reality in-codebase; dispose-with-timeout teardown), `src/windows/screenshare/screenshare.ts:90-102` (the `audioConfig.mode !== "none"` branch the fix hangs off), `electron-builder.ts` (win/linux/mac `files` `.node` include/exclude; patchcord via `extraResources` vs venbind bundled-file model), `.github/workflows/testBuild.yml` (win-x64 `zip`, `bun install --frozen-lockfile` + `bun run build` + electron-builder; no `electron-rebuild` step). — HIGH
- **Microsoft Q&A 1125409** — `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK` device backed by `AudioSes!CMixerClient`; `GetMixFormat()`/`IsFormatSupported()` return `E_NOTIMPL`; hardcode CD-quality 2ch/16-bit/44100: https://learn.microsoft.com/en-us/answers/questions/1125409/ — HIGH
- **Microsoft `ApplicationLoopback` sample** — clean-room reference (`LoopbackCapture.cpp/.h`); `includetree`/`excludetree`; requires build 20348+: https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/ — HIGH
- **microsoft/Windows-classic-samples LICENSE** — MIT (permits use/copy/modify/merge/distribute; requires retaining the copyright + permission notice) → adapting the sample is legally clean *with attribution*: https://github.com/microsoft/Windows-classic-samples/blob/main/LICENSE — HIGH
- **electron #37293** — `disable_local_echo=true` hardcoded; local playback muted during capture (streamer-side mirage): https://github.com/electron/electron/issues/37293 — HIGH
- **PortAudio #935 / Audacity #2356** — WASAPI loopback yields no samples when nothing is playing (keep audio playing during verification): https://github.com/PortAudio/portaudio/issues/935 , https://github.com/audacity/audacity/issues/2356 — MEDIUM
- **napi-rs / Node-API + Electron native modules** — N-API gives a stable ABI across Node and Electron (single prebuilt `.node`, no `electron-rebuild`); venbind uses napi-rs (Rust) — the addon template: https://github.com/napi-rs/napi-rs , https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules — HIGH (template) / MEDIUM (exact N-API version vs Electron 41 — verify before committing the prebuild)
- **Electron `app.getAppMetrics()`** — lists all Electron processes incl. type `Audio Service`; used by patchcord.ts and the basis for V6 PID resolution: https://www.electronjs.org/docs/latest/api/app — HIGH

---
*Pitfalls research (v1.1 implementation) for: native Windows WASAPI exclude-tree echo fix in GoofCord. EXTENDS v1.0 PITFALLS (cancel/restart + Bug-B diagnosis). Verification pitfalls (V1–V6) are front-and-center: no local native test + sub-20348 dev box is the milestone's dominant risk.*
*Researched: 2026-05-30*
