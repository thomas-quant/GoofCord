---
phase: 04-native-clean-room-exclude-tree-addon-integration
plan: 01
title: "Transport spike — main-process PCM over MessageChannelMain to a viewer"
status: complete
verdict: GO
requirements: [ECHO-01]
completed: 2026-06-04
---

# Plan 04-01 SUMMARY — Transport spike (GO)

## Verdict: GO ✅

The main → renderer → main-world PCM transport (Phase 3 Residual Risk #1) is **proven end-to-end
on a Windows x64 CI artifact**. A second-device viewer heard the synthetic 440→660 Hz sweep tone,
generated in the MAIN process and delivered over the real `MessageChannelMain` + `window.postMessage(..., [port])`
transport. The transport plumbing is the KEEP that Plan 02/03's real WASAPI addon swaps behind.

## Evidence (screenshare-debug.log, artifact run 26901370055)

```
feeder + swap seam installed; posting ready
wasapi exclude-root=1488 audioService=14208 procs=...,Network Service:15532,...,Audio Service:14208,Video Capture:4608,...
screenshare wcId=2 audio=loopback path=win32-transport-spike (host started)
hop2=port-forward ready-handshake ok
wasapi swap-seam injected reconstructed audio track
wasapi activation=spike-synthetic hop1=messageport chunks=10000   (climbing ~100/s, no crash)
```
- Viewer (second device) **heard the sweep** — audible GO.
- **chunks=10000 and climbing**, no `synth-interval threw` / main-process crash.

## T3 resolved (CONTEXT open question)

**hop-2 mechanism = zero-copy port-forward** (`window.postMessage("goofcord:wasapi-pcm-port", "*", [port])`).
`hop2=port-forward ready-handshake ok` confirms the DEFAULT mechanism works on **Electron 41 / Chromium 146** —
the contextBridge structured-clone fallback was **not** needed. The readiness handshake (feeder posts
`goofcord:wasapi-ready` before the port is forwarded) is load-bearing and worked as designed (Pitfall 1 avoided).

## PIDs (ECHO-02 discipline, exercised early)

- exclude-root (Electron main) = **1488**
- Audio Service = **14208** — note it appears as a **separate** entry in `getAppMetrics()`, not obviously
  inside the 1488 tree. ⚠ **Flag for Plan 04-03 / ECHO-01 (Assumption A4):** if echo persists with the real
  addon despite `activation=ok`, the Audio Service may be a detached sibling needing a broader-ancestor exclude.
- Several helper procs report `name=undefined` in `getAppMetrics()` — cosmetic for the spike; the named
  "Audio Service" entry is what matters for 04-03's exclude-target resolution.

## What shipped (KEEP)

- `src/modules/native/wasapiLoopback.ts` — main-process transport host: `MessageChannelMain` + synthetic
  tone (THROWAWAY) + idempotent `stopWasapiLoopback` + before-quit teardown.
- `src/windows/main/preload/wasapiTransport.ts` — preload-injected main-world feeder: MessagePort → bounded
  ring (depth 4, drop-oldest, zero-fill underrun) → `MediaStreamTrackGenerator`, **plus the getDisplayMedia
  swap seam + track-"ended" teardown** (moved here — see Deviation 2).
- `src/windows/main/preload/preload.mts` + `bridge.ts` — hop-2 port-forward with readiness handshake +
  recorded contextBridge fallback.
- `src/windows/screenshare/screenshare.ts` — spike-gated win32 transport-host trigger (see Deviation 1).

## Deviations from plan (4 fix commits at the checkpoint — the spike caught real bugs)

The first two CI artifacts produced **echo, no tone**. Root-causing at the blocking checkpoint surfaced three
defects the plan-as-written would have carried into the expensive native work:

1. **Missing trigger** (`ebc5859`). `tryStartWasapiLoopback()` had **zero call sites** — the plan moved the
   audio source to the main process (vs Phase 3's in-page source) but never wired a trigger. Added it to
   `screenshare.ts` `selectScreenshareSource` as the spike-gated win32 branch — the **exact call site Plan 04-03
   will use** for the real addon (additive 3-way gate, `result.audio="loopback"` so the renderer swap seam runs).

2. **Swap seam never shipped** (`539816b`). The seam was placed in `screensharePatch.ts` → `postVencord.js`,
   which is **downloaded at runtime from upstream Milkshiift/GoofCord `main`** (settingsSchema PostVencord URL);
   electron-builder packages only `ts-out`. So the fork's renderer change silently didn't ship — the artifact ran
   upstream's seam-less bundle → raw loopback → echo. **Moved the getDisplayMedia hook + swap + teardown into the
   preload-injected `wasapiTransport.ts`** (ships via ts-out → app.asar), mirroring `deliverySpike.ts`; reverted
   `screensharePatch.ts` to upstream-aligned original. **→ Key constraint for 04-03 and the Phase-5 upstream PR:
   any renderer/main-world behavior in the fork must be preload-injected, not placed in postVencord.**

3. **Main-process MessagePortMain crash** (`2d0f378`). `port.postMessage(buf, [buf])` put an ArrayBuffer in the
   TRANSFER LIST; Electron's **main-process** `MessagePortMain.postMessage` transfer list accepts **only
   `MessagePortMain` instances** (ArrayBuffer transfer is a renderer/DOM-only feature). It threw
   "Port at index 0 is not a valid port" every tick → uncaught main-process error dialog, chunks stuck at 0.
   Fixed to `port.postMessage(buf)` (structured-cloned, ~384 KB/s — negligible) and wrapped the timer in
   try/catch so the spike can never crash the main process (ECHO-03 discipline).

## Verification status

- Automatable: `bun run check` + `bun run build` pass; IPC regenerated (`wasapiLoopback:stopWasapiLoopback`,
  `screenshareDebug:isTransportSpikeEnabled`); gate-off path is byte-identical (all spike code behind
  `isTransportSpikeEnabled` / only-injected-when-on); Linux/macOS branches untouched.
- Manual (this checkpoint): viewer-side GO confirmed on Windows x64 CI artifact.

## Follow-ups for Wave 2/3

- **04-02 (Rust addon):** emit exactly the chunk shape this transport consumes — 480-frame interleaved-stereo
  f32 ArrayBuffer (3840 bytes), pushed via ThreadsafeFunction; the JS `onChunk` forwards it down `port1` with
  `port1.postMessage(buf)` (NO transfer list — main-process constraint above).
- **04-03 (integration):** the `screenshare.ts` trigger call site already exists (spike-gated); swap the synthetic
  source for the real addon. Keep the swap seam in the preload-injected script (Deviation 2). Resolve the
  exclude-target root via `app.getAppMetrics()` and watch the Audio-Service-as-sibling risk (PID 14208 / Assumption A4).
- Re-start robustness (feeder rebuild on a second screenshare in one app session) is deferred to 04-03 — the spike
  tears the feeder down on stream-end; a second attempt currently needs an app relaunch.

## Commits
- `2b6db61` feat(04-01): main-process transport host — wasapiLoopback.ts
- `73cefb1` feat(04-01): hop-2 port-forward + MessagePort-fed MSTG feeder
- `ebc5859` fix(04-01): wire transport-host trigger (Deviation 1)
- `539816b` fix(04-01): move getDisplayMedia swap seam into preload-injected wasapiTransport (Deviation 2)
- `2d0f378` fix(04-01): send PCM chunk as message, not transfer list (Deviation 3)
