# Architecture Research — Windows Screenshare Echo Fix (v1.1)

**Domain:** Integrating a Windows per-process-exclude audio capture into GoofCord's existing Electron screenshare/audio pipeline (the echo fix, Bug B / upstream #46)
**Researched:** 2026-05-30
**Confidence:** HIGH on the existing GoofCord audio data-flow (direct code read); HIGH on the patchcord analog (direct code + types read); MEDIUM on the native-PCM-to-MediaStream options (Electron/Chromium public mechanisms, verified across multiple sources). The WASAPI *mechanism* itself is settled in `02-FINDINGS.md` and not re-derived here.

> **Scope of this doc:** integration architecture + build order ONLY. The capture mechanism (public WASAPI Application Loopback, EXCLUDE process-tree, min build 20348, clean-room GO) is settled in `.planning/phases/02-fix-bug-b-windows-loopback-audio-captured/02-FINDINGS.md §3`. This answers: *where does the captured audio plug into GoofCord, what is new vs. modified, and in what order is it built.*
>
> **Supersedes** the prior v1.0 ARCHITECTURE (Phase 1 cancel/restart lifecycle), which is now closed and lives in the phase history.

---

## Standard Architecture

### Today's Windows audio data flow (the echo path)

```
┌──────────────────────────── RENDERER (Discord web app) ──────────────────────────────┐
│  Discord "Go Live" → calls navigator.mediaDevices.getDisplayMedia(opts)               │
│                          │                                                            │
│  screensharePatch.ts MONKEYPATCH (postVencord) wraps getDisplayMedia:                 │
│    stream = await original.call(this, opts)   ← triggers the main-process handler     │
│    ... applies video contentHint/constraints ...                                      │
│    audioTrack = stream.getAudioTracks()[0]; audioTrack.contentHint = "music"          │
│    getVirtmic() → returns NULL on Windows (no GoofCord-Virtual-Mic device)            │
│       ⇒ the patchcord track-swap block (lines 62-85) NEVER fires on Windows           │
│    return stream   ← stream carries Chromium's "loopback" audio track UNCHANGED       │
└──────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │ getDisplayMedia request crosses to main
                                            ▼
┌──────────────────────────── MAIN PROCESS (screenshare.ts) ─────────────────────────────┐
│  session.setDisplayMediaRequestHandler((request, callback) => { open picker window })   │
│  picker preload (preload.mts) collects audioConfig {mode, pids} → IPC                    │
│  ipcMain.handle("selectScreenshareSource", ...) :                                        │
│      if audioConfig.mode !== "none":                                                     │
│          if (hasPipewirePulse && platform === "linux")  → patchcordStartSystem/App(...)  │
│          else  → result.audio = "loopback"        ◀── WINDOWS TAKES THIS BRANCH (L98)    │
│      finishRequest(wcId, result)  → callback(result)                                     │
└──────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │ Electron honours result.audio = "loopback"
                                            ▼
┌──────────────────────────── CHROMIUM AUDIO SERVICE (utility process) ──────────────────┐
│  "loopback" = capture the WHOLE default-endpoint mix.                                    │
│  That mix INCLUDES GoofCord's own playback of the call → echo. (Bug B root cause.)       │
│  The resulting MediaStreamTrack is handed back up to the renderer as stream's audio.     │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

**Where the echo enters (file/function level):**

| Step | Location | What happens |
|------|----------|--------------|
| 1 | `src/windows/screenshare/screenshare.ts:98` | `result.audio = "loopback"` — Windows branch of the `audioConfig.mode !== "none"` block. This single line requests whole-endpoint-mix capture. |
| 2 | Electron / Chromium Audio Service utility process | `"loopback"` is whole-mix-only; no per-process exclusion exists in this API. GoofCord's own call playback is in that mix. |
| 3 | `src/windows/main/renderer/postVencord/screensharePatch.ts:59-60` | The returned stream's audio track is tagged `contentHint = "music"` and passed straight through to Discord (the patchcord swap at lines 62-85 is inert on Windows because `getVirtmic()` returns null). |
| 4 | Discord's WebRTC pipeline | The echoing track is published to viewers. |

**The fix must remove GoofCord's own playback from the captured audio** — which only `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` (native WASAPI) can do (`02-FINDINGS.md §2.1`). The integration question is purely: *how does that native-captured audio reach the stream Discord publishes, replacing or supplementing `result.audio = "loopback"`?*

### The patchcord analog (the closest existing integration shape)

This is the load-bearing precedent. Patchcord already solves "capture system audio while excluding GoofCord's own playback" on **Linux** — and it does so **without ever passing raw PCM into JS**. Understanding *how* answers the hardest Windows question.

```
┌──────────────── MAIN (patchcord.ts) ────────────────┐    ┌──────── RENDERER (screensharePatch.ts) ────────┐
│ patchcordStartSystem(excludePids):                   │    │ getDisplayMedia → stream (with loopback audio) │
│   patchbay.ensureVirtualSink()                       │    │ id = getVirtmic()  → finds the OS device by    │
│     → registers an OS PipeWire/Pulse VIRTUAL SINK    │    │      label "GoofCord-Virtual-Mic"              │
│       + a VIRTUAL MIC device "GoofCord-Virtual-Mic"  │    │ audio = await getUserMedia({deviceId: exact}) │
│   routeNodes(targetNodes)                            │    │ stream.removeTrack(old loopback audio tracks)  │
│     → routes desktop app audio into the sink,        │    │ stream.addTrack(audio.getAudioTracks()[0])     │
│       EXCLUDING GoofCord's Audio-Service node        │    │ return stream  ← now carries the virtual mic   │
│       (patchcordList() filters out the               │    └────────────────────────────────────────────────┘
│        "Audio Service" PID — patchcord.ts:80-84)     │
└──────────────────────────────────────────────────────┘
            │ the native side exposes audio as a normal OS CAPTURE DEVICE
            ▼
   Chromium reads that device through getUserMedia exactly like a microphone —
   no custom PCM bridge, no MediaStreamTrackGenerator, no WebRTC ADM patching.
```

**The critical architectural lesson:** patchcord's native module never hands audio samples to JavaScript. It registers an **OS-level virtual capture device**, and the renderer pulls audio from it with ordinary `getUserMedia({ deviceId })`. The MediaStream plumbing is 100% standard web API. **This sidesteps the entire "native PCM → MediaStream" problem.** (See "The hard problem" below.)

Patchcord also already handles the **Audio-Service-exclusion** concern that Windows shares: `patchcordList()` (`patchcord.ts:80-84`) reads `app.getAppMetrics().find(p => p.name === "Audio Service")?.pid` and filters that node out — *exactly* the "exclude the Electron audio utility process, not the window PID" requirement that `02-FINDINGS.md §2.2` flags for Windows.

---

## Component Responsibilities (existing + proposed)

| Component | Responsibility today | Change for the echo fix |
|-----------|----------------------|--------------------------|
| `src/windows/screenshare/screenshare.ts` | Display-media handler; picker window; `selectScreenshareSource` sets `result.audio = "loopback"` on Windows (L98) | **MODIFIED** — Windows audio branch gains a 3-way decision: native-exclude (build ≥ 20348) → start the WASAPI capture module; else fall back to existing `"loopback"`; below gate → `"loopback"` + optional guidance. |
| `src/windows/main/renderer/postVencord/screensharePatch.ts` | Renderer monkeypatch; video constraints; patchcord virtual-mic track swap (inert on Windows) | **MODIFIED only if** the chosen native path exposes a virtual device — then generalize `getVirtmic()` to also match the Windows device label (mirror the existing patchcord branch). If the native path injects audio another way, this file may stay unchanged. |
| `src/modules/native/patchcord.ts` | Linux PipeWire/Pulse virtual-sink routing | **UNCHANGED** — must not regress. The Windows module is a *sibling*, not a modification. |
| **`src/modules/native/wasapiLoopback.ts`** (proposed) | — | **NEW** — main-process wrapper for the Windows native addon, mirroring `patchcord.ts` shape: `init…()`, `hasWasapiLoopback`, `start/stop`, build-gate detection, process-tree resolution. |
| **`assets/native/wasapi-loopback-win32-{x64,arm64}.node`** (proposed) | — | **NEW** — the prebuilt native addon, loaded via the existing `native-module:` import + `nativeImport.ts` glob, copied by `build/build.ts:copyNativeModules()`. |
| `build/build.ts` (`copyNativeModules`) | Copies `patchcord` + `venbind` prebuilds into `assets/native/` | **MODIFIED** — add a third `modules[]` entry (name + prebuilds + `GOOFCORD_WASAPI_PATH` env override), mirroring venbind exactly. |
| `src/ipc/gen.ts` / `types.ts` | Auto-generated IPC contract | **REGENERATED** (not hand-edited) — a `stopWasapiLoopback<IPCHandler>` (mirror of `stopPatchcord`) and any `<IPCHandle>` on the new module get codegen'd by `bun run build --onlyGenerators`. |
| `src/windows/main/preload/bridge.ts` | Exposes `goofcord.stopPatchcord()` etc. | **MODIFIED only if** a renderer-driven stop is needed — add `stopWasapiLoopback: () => invoke("…")` mirroring L44. The `STREAM_CLOSE` handler in `screensharePatch.ts:90-104` is where it would be called. |
| `src/settingsSchema.ts` | Config keys/defaults | **MODIFIED** — add a Windows audio-mode toggle/guidance key (for the workaround path) and/or a "use native exclude capture" preference. |

---

## The hard problem: getting native-captured audio into the stream Discord publishes

This is the make-or-break of the native path. There are three candidate shapes; the patchcord analog strongly favours the first.

### Option A — Virtual capture device + `getUserMedia` (the patchcord shape) — preferred *if* a device can be created cheaply

**What:** The native addon registers (or drives) a Windows audio **capture endpoint** carrying the exclude-tree-filtered audio. The renderer reads it with `getUserMedia({ audio: { deviceId: { exact } } })` and swaps it into the stream — *exactly* the path `screensharePatch.ts:62-85` already implements for patchcord.

**Why it's the attractive shape:**
- Zero new MediaStream plumbing — Chromium consumes a device natively; no PCM ever crosses into JS.
- The renderer code already exists; generalizing `getVirtmic()` to also match a Windows device label is a few lines.
- Upstream-friendly: it reuses an established GoofCord pattern, keeping the diff surgical (a project constraint).

**The catch — and the honest hard part:** the public WASAPI Application Loopback API (`ActivateAudioInterfaceAsync` + `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`) does **not** create an OS capture device. It hands the *activating process* an `IAudioClient` that pulls the exclude-filtered samples in-process (`02-FINDINGS.md §3.1`). So to mirror patchcord on Windows you must **bridge those WASAPI samples to something `getUserMedia` can read.** Two sub-options:

  - **A1 — Native module owns a virtual device.** Register a virtual audio capture endpoint (e.g. an APO/virtual-driver style sink) and feed it the WASAPI loopback samples. This most faithfully mirrors patchcord, but **installing a virtual audio driver on Windows is heavy, needs signing, and is *not* cleanly upstreamable** — it's exactly the macOS-style driver approach `02-FINDINGS.md §3.2` calls out as the thing Windows is supposed to *avoid*. Likely a non-starter for a surgical upstream PR. Flag as HIGH-cost.
  - **A2 — Push WASAPI samples into the renderer, reconstruct a track there** — see Option B; this is the no-driver realization of "device-like" behaviour.

### Option B — Native PCM → renderer → `MediaStreamTrackGenerator` / Web Audio `MediaStreamDestination`

**What:** The native addon captures exclude-filtered PCM in the main process, ships frames over IPC to the renderer, and the renderer reconstructs a `MediaStreamTrack` via `MediaStreamTrackGenerator` (Insertable Streams) or a Web Audio `AudioContext` → `MediaStreamAudioDestinationNode`. The reconstructed track is swapped into the stream in `screensharePatch.ts` (reusing the existing removeTrack/addTrack block at lines 79-84).

**Why it's plausible:** these are real, documented Chromium/Electron mechanisms for turning app-supplied PCM into a MediaStream ([WebRTC.ventures](https://webrtc.ventures/2015/09/sending-generated-audio-through-webrtc-as-a-live-feed/), [electron/electron#17690](https://github.com/electron/electron/issues/17690), [discuss-webrtc thread](https://groups.google.com/g/discuss-webrtc/c/3H4vwWgNuQk)). Web Audio `MediaStreamDestination` works in current Electron; `MediaStreamTrackGenerator` requires Insertable-Streams availability in the bundled Chromium — **verify against Electron 41.3.0's Chromium before committing.**

**Why it's the hard road:**
- High-rate PCM over Electron IPC (48 kHz stereo) is a latency/throughput and GC-pressure risk; needs a shared-memory or chunked-transfer design, not naive `ipcRenderer.send` per frame.
- Clock drift / resampling between the WASAPI device clock and the WebRTC pipeline must be handled.
- The sandboxed-preload constraint (`sandbox: true`, no Node in renderer) means PCM must arrive via IPC, not a direct native import in the renderer — adding a serialization hop.
- More moving parts = larger, less-upstreamable diff.

### Option C — Patch Chromium's loopback source

**What:** intercept/replace the audio Chromium's `"loopback"` produces at the source. **Rejected** — requires Chromium-internal changes, not reachable from Electron's public API (`02-FINDINGS.md §2.1`), and impossible to upstream to GoofCord.

### Honest verdict on tractability (input to D-06)

- **The exclude-tree *capture* is tractable and clean-room** (settled, `02-FINDINGS.md §3.3`).
- **The *delivery* of that audio into the MediaStream is the genuine architectural risk.** Patchcord makes it look easy *because Linux's PipeWire gives it a free virtual-device primitive*; Windows does **not** give the public WASAPI API an equivalent device, so GoofCord must either (A1) ship a virtual-audio driver (heavy, not upstreamable) or (B) build a PCM-to-track bridge (more code, IPC-throughput risk). **Neither is as cheap as the Linux path.** This is the cost D-06 must weigh against the zero-code workaround.
- **Recommended de-risking spike (before committing to native):** a tiny prototype that proves *one* delivery path end-to-end on a build-≥20348 Windows CI artifact — capture a few seconds of exclude-tree audio and get it audible in a real stream, viewer-side — before building the full module. Given the no-local-verification constraint, this is the single highest-leverage thing to validate.

---

## The workaround path (minimal integration)

If D-06 chooses the user-side separate-output-device workaround (route Discord's output to a separate device, e.g. VB-Cable / SteelSeries Sonar, so the captured mix excludes the call — `02-FINDINGS.md §2.3`):

- **Code needed: near-zero.** The existing `result.audio = "loopback"` path already works; the workaround is purely *user configuration of their OS audio routing*, outside GoofCord.
- **Minimal integration:** a documentation entry + (optionally) a settings toggle/notice in `settingsSchema.ts` surfacing guidance ("On Windows, to avoid echo, route Discord's audio to a separate output device"). This is the only honest in-code footprint.
- **This is the mandatory fallback below build 20348 regardless** of the native decision, since the exclude-tree API simply does not exist there.

---

## Process-tree exclusion (the runtime resolution detail)

The exclude target is the **GoofCord/Electron process tree**, not a single window PID, because Chromium renders audio from a separate sandboxed **"Audio Service" utility process** (`02-FINDINGS.md §2.2`; verified pattern, Chromium services/audio).

**How to resolve it at runtime — reuse the patchcord precedent:**
- `patchcord.ts:80` already does `app.getAppMetrics().find(p => p.name === "Audio Service")?.pid` to find that process. The Windows module can use the same `app.getAppMetrics()` enumeration.
- However, `EXCLUDE_TARGET_PROCESS_TREE` takes a **single root PID and excludes its whole subtree** — so the clean target is GoofCord's **own root process PID** (`process.pid`), which is the parent of the Audio Service child. Excluding the root tree covers the Audio Service utility automatically — *this is precisely why the API's tree semantics matter*, and why a single-PID exclude would be wrong.
- **Open detail (flagged for impl):** confirm on Electron 41.3.0 that the Audio Service utility process is actually a *descendant* of `process.pid` (not a detached sibling). If detached, the exclude root must be chosen accordingly. This is the one runtime fact recon could not observe (Discord wasn't running; `02-FINDINGS.md §2.2`) and should be verified on a build-≥20348 CI artifact via `app.getAppMetrics()` parent/child inspection logged to the userData file (no DevTools — per MEMORY).

---

## New vs. Modified — summary

**NEW components:**
- `src/modules/native/wasapiLoopback.ts` — main-process wrapper (mirror of `patchcord.ts`: init/has/start/stop, build-gate, PID resolution).
- `assets/native/wasapi-loopback-win32-{x64,arm64}.node` — prebuilt addon (clean-room, from the public Microsoft ApplicationLoopback sample only — D-05).
- A documentation entry + (optional) `settingsSchema.ts` key for the workaround/guidance.

**MODIFIED components:**
- `src/windows/screenshare/screenshare.ts` — the Windows audio branch (currently the single line `result.audio = "loopback"` at L98) becomes a gated decision.
- `src/windows/main/renderer/postVencord/screensharePatch.ts` — only if delivery is via a device label (generalize `getVirtmic()`) or a reconstructed track (add the MediaStreamTrackGenerator/Web Audio path).
- `build/build.ts:copyNativeModules()` — add the third native module entry.
- `src/windows/main/preload/bridge.ts` — only if a renderer-driven stop is needed (mirror `stopPatchcord`).
- `src/ipc/gen.ts` / `types.ts` — regenerated, never hand-edited.

**MUST NOT regress (non-regression boundaries):**
- **Linux patchcord path** — `screenshare.ts:91-96` `hasPipewirePulse && platform === "linux"` branch and `patchcord.ts` stay byte-for-byte unchanged. The Windows module is a sibling; the dispatch must keep Linux taking the patchcord branch first.
- **macOS** — no Windows-only code may run on darwin; gate everything behind `process.platform === "win32"`. (macOS has no in-OS loopback API and ships its own driver — out of scope, `02-FINDINGS.md §3.2`.)
- **Existing Windows `"loopback"` when the native fix is unavailable** — on builds < 20348, on load failure of the `.node`, or with an opt-out flag, the code must fall through to the current `result.audio = "loopback"` so audio is not *worse* than today (it echoes, but it works). Degrade gracefully exactly as Discord does (`audioses is too old…`, `02-FINDINGS.md §2.3`).
- **`--no-patchcord` / `GOOFCORD_*_PATH` precedent** — provide a matching `--no-wasapi` arg + `GOOFCORD_WASAPI_PATH` env override for parity (mirrors `venbind.ts:20` / `build.ts` env handling).

---

## Suggested build order (phases)

Ordered by dependency and by the unverifiable-locally constraint (everything that touches WASAPI must be validated on a build-≥20348 Windows CI artifact, never the maintainer's 19045 box).

1. **D-06 decision + delivery-path spike (de-risk first).**
   Decide native-vs-workaround-vs-hybrid. If native is on the table, run the smallest possible end-to-end spike proving *one* delivery path (Option A1 driver, or Option B PCM→`MediaStreamTrackGenerator`/Web Audio) gets exclude-tree audio audible in a real stream on a CI ≥20348 artifact. **Gate the whole native investment on this spike succeeding** — it is the biggest unknown and the cheapest place to fail fast.
   - *Avoids:* committing to a native module whose audio can't actually reach the stream.

2. **Build-gate + graceful-fallback scaffolding (no capture yet).**
   Add `wasapiLoopback.ts` with build detection (`≥ 20348`), an opt-out flag, and the gated dispatch in `screenshare.ts` that *still returns `"loopback"`* in every fallback case. Wire `copyNativeModules()` and the `native-module:` import with a stub/null addon.
   - *Avoids:* regressing the existing Windows loopback; proves the integration seams before the hard native work.
   - *Verifiable on CI without the native addon* (it just confirms the fallback still works).

3. **The native capture module (clean-room) + chosen delivery path.**
   Build the `.node` from the public Microsoft ApplicationLoopback sample (EXCLUDE process-tree), resolve the GoofCord root PID, and implement whichever delivery path the spike proved. Generalize `screensharePatch.ts` (`getVirtmic()` or a reconstructed track) accordingly.
   - *Verifiable only on a ≥20348 CI artifact + second device, viewer-side, audio actively playing* (D-08).

4. **Workaround + docs (parallel, low-risk, ships regardless).**
   Documentation entry + optional settings guidance for the separate-output-device workaround — the mandatory fallback for < 20348 and a useful escape hatch if the native path slips. Can land independently of phases 1-3.

5. **Verification + upstream-PR shaping.**
   Manual viewer-side test on the CI artifact; confirm Linux/macOS/<20348 non-regression; minimize the diff for the upstream PR.

---

## Data-flow changes (target Windows path)

```
selectScreenshareSource (screenshare.ts) — Windows, audioConfig.mode !== "none":
    if (isWindows && wasapiLoopback.isAvailable())          ← NEW gate (build ≥ 20348 + addon loaded)
        wasapiLoopback.start(excludeRootPid = process.pid)  ← NEW: exclude GoofCord tree (covers Audio Service)
        // delivery depends on D-06:
        //   Option A → result.audio left to a device the renderer reads via getUserMedia
        //   Option B → result.audio = "loopback" replaced in-renderer by a reconstructed track
    else
        result.audio = "loopback"                           ← UNCHANGED fallback (echoes, but works)

screensharePatch.ts (renderer):
    getVirtmic() generalized to also find the Windows capture device (Option A)   ← MODIFIED
       OR a MediaStreamTrackGenerator/Web Audio track is built from native PCM    ← MODIFIED (Option B)
    the echoing "loopback" track is removed and replaced (reusing the existing
    removeTrack/addTrack block at lines 79-84)                                     ← REUSED

STREAM_CLOSE handler (screensharePatch.ts:90-104):
    add `void GoofCord.stopWasapiLoopback()` alongside stopPatchcord/stopVenmic   ← MODIFIED
```

---

## Anti-Patterns (specific to this integration)

### Excluding the GoofCord window PID instead of the process tree
**What people do:** pass the main window's renderer PID to `EXCLUDE`.
**Why it's wrong:** Chromium plays call audio from the separate Audio Service utility process, not the window — excluding only the window still captures the echo.
**Do this instead:** exclude the GoofCord **root** PID (`process.pid`) using `EXCLUDE_TARGET_PROCESS_TREE` so the Audio Service descendant is covered; verify the parent/child relationship on Electron 41.3.0 via `app.getAppMetrics()`.

### Modifying `patchcord.ts` or the Linux branch to "share" code with Windows
**What people do:** refactor the audio dispatch into a shared abstraction.
**Why it's wrong:** it risks regressing the validated Linux path and enlarges the diff beyond what's upstreamable.
**Do this instead:** add a sibling `wasapiLoopback.ts`; keep the `platform === "linux"` patchcord branch untouched and dispatch by platform.

### Streaming raw PCM over `ipcRenderer.send` per frame
**What people do:** naively forward every WASAPI buffer to the renderer over standard IPC.
**Why it's wrong:** 48 kHz stereo over JSON-serialized IPC is a latency/GC disaster.
**Do this instead:** if Option B is chosen, use chunked transfers / `ArrayBuffer` transferables / shared memory, and handle clock drift — or prefer Option A (device-based) to avoid the bridge entirely.

### Treating `"loopback"` as removable on Windows < 20348
**What people do:** delete the loopback fallback once the native path lands.
**Why it's wrong:** below build 20348 the exclude API doesn't exist; removing the fallback means *no* system audio at all on a large chunk of Windows 10.
**Do this instead:** keep `result.audio = "loopback"` as the universal fallback; only the gated, available case diverges.

---

## Integration Points (file/function index)

| Integration point | File:line (today) | Role in the fix |
|--------------------|-------------------|-----------------|
| Windows audio branch | `src/windows/screenshare/screenshare.ts:90-100` (`result.audio = "loopback"` at L98) | Primary modification site — gated dispatch. |
| Linux exclude precedent | `src/modules/native/patchcord.ts:80-84` (`getAppMetrics` Audio-Service filter) | Reuse the Audio-Service PID resolution idea. |
| Native module shape | `src/modules/native/patchcord.ts` / `venbind.ts` | Template for `wasapiLoopback.ts`. |
| Native bundling | `build/build.ts:168-232` (`copyNativeModules`) + `build/nativeImport.ts` | Add the third module + prebuild glob + env override. |
| Renderer track swap | `src/windows/main/renderer/postVencord/screensharePatch.ts:59-88` (incl. `getVirtmic` 4-20, removeTrack/addTrack 79-84) | Where native-captured audio replaces the loopback track. |
| Stream-close cleanup | `src/windows/main/renderer/postVencord/screensharePatch.ts:90-104` | Add `stopWasapiLoopback`. |
| Renderer API bridge | `src/windows/main/preload/bridge.ts:44` (`stopPatchcord`) | Add `stopWasapiLoopback` (mirror). |
| IPC contract | `src/ipc/gen.ts` / `types.ts` (auto-gen) | Regenerated via `bun run build --onlyGenerators`. |
| Settings/guidance | `src/settingsSchema.ts:420` (`screensharePreviousSettings`) | Add Windows audio-mode/guidance key for the workaround. |
| Chromium loopback flag | `src/main.ts:47` (`PulseaudioLoopbackForScreenShare`, Linux-only) | Confirms loopback flags are platform-gated today; Windows uses Electron's default `"loopback"` honouring. |

## Sources

- **Settled mechanism (not re-derived):** `.planning/phases/02-fix-bug-b-windows-loopback-audio-captured/02-FINDINGS.md` (§2 exclude-tree + Audio-Service, §3 clean-room GO) and `02-RESEARCH.md`. — HIGH.
- **GoofCord code (direct read):** `src/windows/screenshare/screenshare.ts`, `src/windows/main/renderer/postVencord/screensharePatch.ts`, `src/modules/native/patchcord.ts`, `src/modules/native/venbind.ts`, `src/windows/screenshare/preload/preload.mts`, `src/windows/main/preload/bridge.ts`, `build/build.ts`, `build/nativeImport.ts`, `src/main.ts`, `node_modules/patchcord/node/patchcord.d.ts`. — HIGH.
- **Existing codebase map:** `.planning/codebase/ARCHITECTURE.md`. — HIGH.
- Native-PCM-to-MediaStream options (Option B viability): [Sending Generated Audio Through WebRTC (WebRTC.ventures)](https://webrtc.ventures/2015/09/sending-generated-audio-through-webrtc-as-a-live-feed/), [Support Custom Media Stream Tracks · electron/electron#17690](https://github.com/electron/electron/issues/17690), [Custom audio source (discuss-webrtc)](https://groups.google.com/g/discuss-webrtc/c/3H4vwWgNuQk), [desktopCapturer | Electron](https://www.electronjs.org/docs/api/desktop-capturer). — MEDIUM (mechanisms exist; availability on Electron 41.3.0's Chromium must be verified before committing).

---
*Architecture research for: GoofCord Windows screenshare echo fix (v1.1) — integration + build order*
*Researched: 2026-05-30*
