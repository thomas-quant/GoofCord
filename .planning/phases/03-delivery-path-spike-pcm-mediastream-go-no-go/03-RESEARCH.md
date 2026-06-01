# Phase 3: Delivery-Path Spike — PCM → MediaStream (GO/NO-GO) - Research

**Researched:** 2026-06-01
**Domain:** Electron 41 / Chromium 146 renderer media APIs (Insertable Streams / Web Audio), WebRTC `getStats()`, GoofCord asset + IPC + env-gate plumbing
**Confidence:** HIGH on the renderer API surface and GoofCord integration seams; the ONE genuine runtime unknown (audio `MediaStreamTrackGenerator` actually constructible in Electron 41.3.0's Chromium 146) is exactly what the spike's runtime probe resolves on the artifact.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **Renderer reconstruction mechanism:** Feature-detect `MediaStreamTrackGenerator` (Insertable Streams) at runtime; use it if present, else fall back to Web Audio `AudioContext → MediaStreamAudioDestinationNode`. Spike MUST log which mechanism was attempted and which succeeded. Both paths exist behind the runtime probe. "Working transport + mechanism" naming is a required output.
- **Track injection point (swap seam):** Inject the reconstructed track behind a spike flag at the existing removeTrack/addTrack block in `src/windows/main/renderer/postVencord/screensharePatch.ts:79-84` — the same seam patchcord/venmic use. Additive; the normal `"loopback"` behaviour untouched when the spike is off.
- **Transport scope:** **Renderer-only.** Generate synthetic PCM in the renderer (no IPC). The main→renderer PCM bridge is an **explicit residual risk Phase 4 must own** — documented here, NOT proven by the spike. Phase 4 must use chunked transferables, never per-frame `ipcRenderer.send`.
- **Synthetic source character:** An obviously-synthetic, recognizable pattern (periodic beeps or a repeating frequency sweep) — not a flat tone, not noise, not a clip. Runs continuously for the stream's duration.
- **PCM format:** 48 kHz, stereo, float32 — match the Phase 4 target exactly.
- **Generation/feed cadence:** Feed the reconstruction at ~10 ms / 480-frame buffers (~100 chunks/sec) for the stream's duration. In-renderer feeding, not main→renderer shipping.
- **GO/NO-GO bar:** GO requires BOTH (a) a second-device viewer audibly confirming the injected pattern in a live stream AND (b) `screenshare-debug.log` recording corroborating signals — chiefly `RTCRtpSender.getStats()` outbound-rtp **audio** `packetsSent`/`bytesSent` climbing, plus mechanism chosen/succeeded, `track.readyState`/`muted`, and that an audio track is attached to a sender.
- **Fallback if Option B fails:** If BOTH MSTG and Web Audio fail to reach a viewer, declare NO-GO immediately and stop coding — but the written verdict MUST name Option A (GoofCord-created virtual capture device read via `getUserMedia`, no kernel driver) as the first re-scope avenue. Do NOT build Option A in this spike.
- **Scaffolding lifecycle:** Dedicated throwaway branch; gated behind an env var / flag following the `GOOFCORD_*` precedent (e.g. `GOOFCORD_DELIVERY_SPIKE=1`), dormant by default. **Keep** the proven renderer reconstruction (MSTG/Web Audio) + main→renderer transport wiring as marked Phase 4 seed code; **throw away** the synthetic PCM generator + beep + getStats spike logging.

### Claude's Discretion
- Exact chunk size / beep cadence / env-var name / `screenshare-debug.log` line format are implementation details for the planner/executor to settle.

### Deferred Ideas (OUT OF SCOPE)
- **Main→renderer PCM transport** — renderer-only spike; transport (MessagePort / transferable `ArrayBuffer` chunks) and its IPC-throughput/GC risk are a named Phase 4 residual risk.
- **A/V sync** between injected audio and screenshare video — Phase 4.
- **Option A (virtual capture device, no kernel driver)** — not built in this spike; named in the NO-GO verdict only.
- **Real exclude-tree WASAPI capture + PID resolution** — Phase 4.
</user_constraints>

<phase_requirements>
## Phase Requirements

This phase **owns no requirement** — it is a de-risk gate that proves the delivery path for **ECHO-01** (owned/delivered in Phase 4). Its deliverable is a written GO/NO-GO verdict satisfying ROADMAP Success Criteria SC#1–SC#4.

| SC | Behavior | Research Support |
|----|----------|------------------|
| SC#1 | Second-device viewer audibly confirms injected pattern in a live stream | Web Audio / MSTG track reconstruction (§Standard Stack) injected at swap seam (§Swap Seam); viewer-side protocol (§Verification) |
| SC#2 | `MediaStreamTrackGenerator` availability confirmed-or-refuted; corroborating `screenshare-debug.log` | Runtime feature-probe (§MSTG); `getStats()` parsing (§getStats) → renderer log path (§Log Path) |
| SC#3 | A NO-GO is a documented milestone-re-scope trigger naming Option A | Fallback decision (§GO/NO-GO Logic) |
| SC#4 | Additive, env-gated, throwaway-where-possible; kept code marked for Phase 4 | Env-gate plumbing (§Env Gate); keep/throw split (§Scaffolding) |
</phase_requirements>

---

## Summary

This spike proves one architectural unknown: that a non-Discord audio track, reconstructed entirely in the renderer, can be swapped into Discord's `getDisplayMedia` MediaStream and reach a remote viewer. All the moving parts are renderer-side web APIs plus three small GoofCord plumbing additions (an env gate, a renderer→userData log channel, and the swap-seam injection).

**The single load-bearing runtime question** is whether the **audio** `MediaStreamTrackGenerator` (Insertable Streams) is constructible in Electron 41.3.0's bundled **Chromium 146**. Research finding: the audio MSTG is Chrome's *proprietary, main-thread* variant (shipped since 2021, accepts `AudioData`, feature-detectable as a global constructor). It is **not standardized** and is flagged "non-standard/experimental" on MDN, and the standards track replaced it with a *video-only, worker-only* `VideoTrackGenerator` — but the proprietary audio path has **not been removed** from Chrome as of recent versions and is very likely present in 146. This is HIGH-confidence-present but cannot be 100% confirmed without running on the artifact — which is precisely the spike's job (SC#2). The locked feature-detect-then-fallback design is exactly correct: probe `typeof MediaStreamTrackGenerator !== "undefined"`, use it if present, else use the **known-good Web Audio fallback** (`AudioContext` → `OscillatorNode` → `MediaStreamAudioDestinationNode` → `.stream.getAudioTracks()[0]`), which works in every Chromium and needs no Insertable Streams.

**One CI-packaging finding is planner-critical and changes the plan:** GoofCord's renderer scripts (`postVencord.js`) are **NOT bundled into the packaged app** — they are downloaded at runtime from `https://raw.githubusercontent.com/Milkshiift/GoofCord/refs/heads/main/assets/postVencord.js` (hardcoded default in `settingsSchema.ts:217`). A fresh install of the CI artifact will fetch **upstream `main`'s** `postVencord.js`, not the spike code built into the artifact. **Putting the spike logic only in `postVencord.ts` would silently NOT ship.** The spike must place its code somewhere that *is* packaged and runs at launch — the **main preload** (`src/windows/main/preload/`, compiled into `ts-out/` which electron-builder *does* package) — or otherwise force the local asset. See §CI Packaging Pitfall for the concrete options.

**Primary recommendation:** Gate the spike on `GOOFCORD_DELIVERY_SPIKE` read in the main process and forwarded to the renderer via the existing `goofcord` contextBridge. Put the spike's renderer reconstruction + injection in **main-preload-loaded code** (not the downloaded `postVencord.js`) so it actually ships in the artifact. Probe MSTG, fall back to Web Audio, generate a continuous distinctive beep/sweep at 48 kHz/stereo/f32 in ~480-frame chunks, swap the track at `screensharePatch.ts:79-84`, locate the active `RTCRtpSender` by monkeypatching `RTCPeerConnection.prototype.addTrack`, poll `getStats()` every 2 s for outbound-rtp audio `packetsSent`/`bytesSent`, and append structured lines to `screenshare-debug.log` in userData via a new `<IPCHandle>` log channel.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Synthetic PCM generation | Renderer (Discord web context) | — | Locked renderer-only; no IPC PCM. Generated in-page via Web Audio / typed arrays. |
| Track reconstruction (MSTG / Web Audio) | Renderer | — | These are DOM/web APIs only available in the Discord renderer context where `getDisplayMedia` runs. |
| Track injection (swap seam) | Renderer (postVencord-class code) | — | `navigator.mediaDevices.getDisplayMedia` is monkeypatched in the renderer; the MediaStream object lives there. |
| `RTCRtpSender` discovery + `getStats()` | Renderer | — | The live `RTCPeerConnection` exists only in Discord's renderer; not visible to main. |
| Env-gate decision (`GOOFCORD_DELIVERY_SPIKE`) | Main process | Preload (forwarding) | `process.env` is only readable in main (sandboxed renderer has no `process.env`); forwarded over the bridge. |
| `screenshare-debug.log` file write | Main process | Preload (IPC client) | Sandboxed renderer has no Node `fs`; the write must cross IPC to main. |
| Shipping spike code in the artifact | Build / Preload | — | Only `ts-out/**` (preloads + main) is packaged; downloaded `postVencord.js` is fetched from upstream `main` at runtime (CI pitfall). |

---

## Standard Stack

This is a throwaway spike: prefer the simplest robust primitive at every choice. No new dependencies are needed — every API below is built into Electron 41.3.0 / Chromium 146 or already present in GoofCord.

### Core (renderer reconstruction)

| API | Availability in Electron 41 / Chromium 146 | Purpose | Notes |
|-----|--------------------------------------------|---------|-------|
| `MediaStreamTrackGenerator({ kind: "audio" })` | **Probable-present, UNVERIFIED on artifact** `[CITED: MDN]` `[ASSUMED for Electron 41 specifically]` | Reconstruct a live audio `MediaStreamTrack` fed by `AudioData` frames written to `.writable` | Chrome-proprietary, main-thread, non-standard. The spike's probe is the verification (SC#2). |
| `AudioData({ format, sampleRate, numberOfFrames, numberOfChannels, timestamp, data })` | Present (WebCodecs, Chromium) `[CITED: MDN]` | The frame object written to the MSTG writable | `format: "f32"` (interleaved) or `"f32-planar"`; `timestamp` in **microseconds**, monotonic. |
| `AudioContext({ sampleRate: 48000 })` | Present (Web Audio, all Chromium) `[CITED: MDN]` | Fallback engine; also the simplest distinctive-tone generator | Known-good; no Insertable Streams needed. |
| `OscillatorNode` | Present `[CITED: MDN]` | Generate a distinctive beep/sweep cadence | Simplest robust primitive — favor over AudioWorklet/ScriptProcessor for the fallback tone. |
| `MediaStreamAudioDestinationNode` (`AudioContext.createMediaStreamDestination()`) | Present `[CITED: MDN]` | Turn Web Audio output into a `MediaStream`; pull `.stream.getAudioTracks()[0]` | This is the **known-good fallback delivery primitive**. |

### Supporting (signal + verification)

| API | Purpose | When to Use |
|-----|---------|-------------|
| `RTCPeerConnection.prototype.addTrack` (monkeypatch) | Capture the `RTCRtpSender` returned when Discord (or the spike) attaches the audio track | Wrap before Discord creates its PC; record senders globally. |
| `RTCRtpSender.getStats()` → `RTCStatsReport` | Read outbound-rtp **audio** `packetsSent` / `bytesSent` | Poll every ~2 s; the independent "audio is leaving the PC" signal. |
| `MediaStreamTrack.readyState` / `.muted` / `.kind` | Cheap corroboration signals to log | Log once after injection and on each poll. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `OscillatorNode` (fallback tone) | `AudioWorkletNode` | AudioWorklet requires loading a separate module via `audioWorklet.addModule(url)` — extra packaging + async complexity for throwaway code. Avoid. |
| `OscillatorNode` (fallback tone) | `ScriptProcessorNode` | Deprecated, runs on main thread with glitches, but trivially simple. Acceptable only if you need to hand-write samples; for a beep/sweep, `OscillatorNode` is cleaner. |
| MSTG-first | Web-Audio-only | The locked decision requires probing MSTG (SC#2 names it explicitly). Do not skip the probe. |
| Generating `AudioData` by hand for MSTG | Feeding the **same** Web Audio tone into both paths | For the MSTG path you must produce `AudioData` frames yourself (a generated sine table is fine — 480 frames/chunk). The two paths necessarily diverge in how the buffer is produced. |

**Installation:** None. No packages added. (Spike adds only GoofCord source: a log IPC channel, an env-gate bridge field, and renderer reconstruction/injection code.)

---

## Package Legitimacy Audit

**Not applicable — this phase installs no external packages.** All APIs used are built into Electron 41.3.0 / Chromium 146 or already vendored in GoofCord (`electron`, `picocolors`). slopcheck gate is therefore a no-op for this phase.

---

## Architecture Patterns

### System Architecture Diagram (spike data flow)

```
                          MAIN PROCESS                              RENDERER (Discord web context)
                          ────────────                              ──────────────────────────────
  process.env.GOOFCORD_DELIVERY_SPIKE
        │ (read at startup — only main can see process.env)
        ▼
  bridge.ts: api.deliverySpike = <bool>      ──contextBridge──▶  window.goofcord.deliverySpike (bool)
                                                                          │
                                                                          ▼  (gate check)
                                                          ┌────────── spike ON? ──────────┐
                                                          │ no → existing "loopback" path  │  (UNCHANGED)
                                                          ▼ yes
                                          ┌─────────────────────────────────────────────────┐
                                          │ probe: typeof MediaStreamTrackGenerator !== undef │
                                          └───────────────┬───────────────────┬─────────────┘
                                              present      │                   │  absent
                                                           ▼                   ▼
                                   ┌──────────────────────────┐   ┌──────────────────────────────────┐
                                   │ MSTG({kind:"audio"})      │   │ AudioContext(48k) → OscillatorNode │
                                   │ AudioData f32 480-frame   │   │ → MediaStreamAudioDestinationNode  │
                                   │ chunks → .writable @100Hz │   │ → .stream.getAudioTracks()[0]      │
                                   └────────────┬─────────────┘   └────────────────┬─────────────────┘
                                                └──────────┬──────────────────────┘
                                                           ▼
                              getDisplayMedia monkeypatch (screensharePatch.ts:79-84):
                                  for (t of stream.getAudioTracks()) { t.stop(); stream.removeTrack(t) }
                                  stream.addTrack(reconstructedTrack)        ← SWAP SEAM (reused)
                                                           │
                                                           ▼
                              Discord attaches track → RTCPeerConnection ──▶ remote viewer hears beep (SC#1)
                                                           │
        screenshare-debug.log  ◀──IPC(<IPCHandle>)── poll RTCRtpSender.getStats() every 2s:
        (userData, via main fs)                       outbound-rtp/audio packetsSent,bytesSent (SC#2)
                                                      + mechanism, track.readyState/muted

  STREAM_CLOSE (screensharePatch.ts:90-104): stop oscillator / close AudioContext / stop generator + clear poll
```

A reader can trace the primary use case: env var → bridge → renderer gate → reconstruct → swap → viewer + log.

### Pattern 1: Feature-detect-then-fallback reconstruction (LOCKED mechanism)

**What:** Probe the proprietary audio MSTG; if absent, use Web Audio. Log which was attempted and which succeeded.
**When to use:** Always in this spike — the probe IS the SC#2 deliverable.
**Example:**
```typescript
// Source: pattern — CITED MDN MediaStreamTrackGenerator / AudioData / MediaStreamAudioDestinationNode
function buildSyntheticAudioTrack(log: (line: string) => void): MediaStreamTrack {
  const SAMPLE_RATE = 48000, CHANNELS = 2, FRAMES = 480; // 10ms @ 48k

  if (typeof (globalThis as any).MediaStreamTrackGenerator !== "undefined") {
    log("mechanism=MSTG attempt");
    try {
      const gen = new (globalThis as any).MediaStreamTrackGenerator({ kind: "audio" });
      const writer = gen.writable.getWriter();
      let tsUs = 0;            // timestamp MUST be microseconds, monotonic
      let phase = 0;
      const dataFloats = CHANNELS * FRAMES;
      const intervalMs = (FRAMES / SAMPLE_RATE) * 1000; // ≈10ms
      setInterval(async () => {
        const buf = new Float32Array(dataFloats);       // interleaved L,R,L,R for format "f32"
        // distinctive: 440Hz beep 200ms on / 200ms off (compute from a running sample counter)
        for (let i = 0; i < FRAMES; i++) {
          const s = makeDistinctiveSample(phase++);     // beep/sweep, NOT a flat tone
          buf[i * 2] = s; buf[i * 2 + 1] = s;
        }
        const ad = new (globalThis as any).AudioData({
          format: "f32", sampleRate: SAMPLE_RATE,
          numberOfFrames: FRAMES, numberOfChannels: CHANNELS,
          timestamp: tsUs, data: buf,
        });
        tsUs += Math.round((FRAMES / SAMPLE_RATE) * 1e6); // advance ~10000us
        await writer.write(ad);
      }, intervalMs);
      log("mechanism=MSTG success kind=audio");
      return gen as MediaStreamTrack;          // MSTG IS itself a MediaStreamTrack
    } catch (e) {
      log(`mechanism=MSTG failed err=${(e as Error).message}; falling back`);
    }
  } else {
    log("mechanism=MSTG absent (typeof undefined)");
  }

  // Fallback: Web Audio — known-good in every Chromium, no Insertable Streams.
  log("mechanism=WebAudio attempt");
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const dest = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator();
  osc.frequency.value = 440;
  // distinctive cadence: ramp/sweep the frequency so the viewer clearly hears "my test tone"
  osc.frequency.setValueCurveAtTime(makeSweepCurve(), ctx.currentTime, 2);
  osc.connect(dest);
  osc.start();
  log("mechanism=WebAudio success");
  return dest.stream.getAudioTracks()[0];
}
```
> NOTE for the planner: the MSTG `setInterval` feeder is the "~480-frame / ~100 chunks/sec" cadence the decision calls for. The Web Audio path is continuous by nature (the oscillator runs free) — the cadence requirement is satisfied trivially there. Both produce a *continuous distinctive* sound for the stream's duration.

### Pattern 2: Capture the live `RTCRtpSender` by wrapping `addTrack`

**What:** Monkeypatch `RTCPeerConnection.prototype.addTrack` to record the returned sender for any **audio** track.
**When to use:** Install once, early, before Discord creates its peer connection (postVencord/main-preload timing is before any call starts).
**Example:**
```typescript
// Source: pattern — CITED MDN RTCPeerConnection.addTrack / RTCRtpSender
const audioSenders = new Set<RTCRtpSender>();
const origAddTrack = RTCPeerConnection.prototype.addTrack;
RTCPeerConnection.prototype.addTrack = function (track: MediaStreamTrack, ...streams: MediaStream[]) {
  const sender = origAddTrack.call(this, track, ...streams);
  if (track.kind === "audio") audioSenders.add(sender);
  return sender;
};
```
**Why this seam (least-invasive):** Discord calls `addTrack` for every track it sends; this catches the spike's injected audio track without needing to walk Discord's internals or hook the constructor. If `addTrack` proves insufficient (e.g., Discord uses `replaceTrack` on a pre-created transceiver), the fallback is to also wrap `RTCPeerConnection.prototype.getSenders()` and filter `s.track?.kind === "audio"` at poll time. Document both; lead with `addTrack`.

### Pattern 3: Poll `getStats()` for outbound-rtp audio

**What:** Every ~2 s, for each captured audio sender, read the stats report and find the audio outbound-rtp entry.
**Example:**
```typescript
// Source: CITED MDN RTCRtpSender.getStats / RTCOutboundRtpStreamStats / RTCStatsReport
async function pollStats(log: (line: string) => void) {
  for (const sender of audioSenders) {
    const report = await sender.getStats();          // RTCStatsReport is a Map-like
    for (const s of report.values()) {
      if (s.type === "outbound-rtp" && s.kind === "audio") {
        log(`stats outbound-rtp audio packetsSent=${s.packetsSent} bytesSent=${s.bytesSent} ssrc=${s.ssrc}`);
      }
    }
    const t = sender.track;
    if (t) log(`track kind=${t.kind} readyState=${t.readyState} muted=${t.muted}`);
  }
}
setInterval(() => void pollStats(logLine), 2000);
```
> `kind` is guaranteed on every `RTCRtpStreamStats` subclass `[CITED: w3c webrtc-stats]`. `packetsSent`/`bytesSent` are mandatory members of `RTCOutboundRtpStreamStats` `[CITED: MDN]`. A **climbing** `packetsSent` is the GO corroboration independent of the viewer.

### Anti-Patterns to Avoid

- **Putting spike logic only in `postVencord.ts`:** it is downloaded from upstream `main` at runtime and will NOT contain the spike code in the CI artifact (§CI Packaging Pitfall). Use main-preload-loaded code.
- **Reading `process.env` in the renderer:** the sandboxed renderer has no `process.env`. The gate must come from main via the bridge.
- **Per-frame `ipcRenderer.send` of PCM:** not relevant to this renderer-only spike, but the planner MUST carry it as the Phase 4 anti-pattern (ARCHITECTURE.md:250-253).
- **`AudioData` timestamp in milliseconds or non-monotonic:** the MSTG writable expects **microseconds**, monotonically increasing; getting this wrong silently drops/garbles frames.
- **Editing `src/ipc/gen.ts` / `types.ts` by hand:** they are codegen output. Add the new log handler as an `<IPCHandle>`-annotated function and run `bun run build --onlyGenerators`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Turn generated audio into a `MediaStream` | A custom track shim | `MediaStreamAudioDestinationNode` (fallback) / `MediaStreamTrackGenerator` (probe) | These are the two sanctioned Chromium primitives for app-generated audio tracks. |
| Distinctive continuous tone | A hand-written sample loop in `ScriptProcessorNode` | `OscillatorNode` with a frequency sweep | One node, no deprecation, no worklet module loading. |
| Read "is audio leaving the PC" | Parsing SDP or counting frames | `RTCRtpSender.getStats()` outbound-rtp/audio | Standard, viewer-independent, exactly the SC#2 signal. |
| Renderer → file logging | A renderer-side fs shim | New `<IPCHandle>` channel → `fs.appendFile` in main (mirror `saveFileToGCFolder`) | Sandboxed renderer has no fs; IPC codegen already exists. |
| Main→renderer flag delivery | Reading env in renderer | Add a boolean field to the `goofcord` contextBridge `api` | The bridge is the established main→renderer value channel (e.g. `version`, `getConfig`). |

**Key insight:** every capability this spike needs already has a first-class API in Chromium or an established GoofCord plumbing pattern. The spike is wiring, not invention.

---

## Common Pitfalls

### Pitfall 1: Spike renderer code never ships (CI packaging) — HIGH SEVERITY
**What goes wrong:** The second-device test shows no injected audio, with no errors, because the spike code was placed in `postVencord.ts`. The packaged app downloads `postVencord.js` from `raw.githubusercontent.com/Milkshiift/GoofCord/refs/heads/main` (`settingsSchema.ts:217`) — i.e. **upstream `main`, not the spike branch** — so the spike code is simply absent at runtime.
**Why it happens:** GoofCord's renderer scripts are *downloaded assets*, not bundled. electron-builder's `files` (`electron-builder.ts:5`) packages only `ts-out`, `package.json`, `LICENSE` — `assets/postVencord.js` is built to `assets/` (`build.ts:112`) but never packaged; at runtime `assetLoader` reads from `userData/GoofCord/assets/`, populated by `assetDownloader` from the config URLs.
**How to avoid (planner must choose one, recommend the first):**
  1. **Place spike code in the main preload bundle** (`src/windows/main/preload/`, compiled into `ts-out/**` which *is* packaged). The preload runs at window load, before assets download. It can install the `getDisplayMedia` monkeypatch + reconstruction + stats logging itself (it already has the bridge and `ipcRenderer`). This is the surest "it ships and runs" path. Note: the preload is sandboxed (`sandbox: true`) — it CAN patch `navigator.mediaDevices` and `RTCPeerConnection` on the page's `window`? **VERIFY:** preload runs in an isolated world by default; confirm whether it can reach the page's `RTCPeerConnection`/`navigator.mediaDevices` or must inject via `webFrame.executeJavaScript` (the mechanism `assets.ts` already uses to run downloaded scripts in the main world). The existing `loadScripts()` proves main-world injection is available from the preload.
  2. **Have the spike (main-side, gated) overwrite the local `postVencord.js`** with a spike-augmented copy before the asset loader reads it — brittle; not recommended.
  3. **Point the PostVencord asset URL at the spike branch** (`refs/heads/<spike-branch>`) for the duration of the spike — requires network + a config change baked into the artifact; fragile.
**Warning signs:** viewer hears nothing AND `screenshare-debug.log` is empty/absent (the spike code never executed) — distinguish from "code ran but track didn't reach viewer" (log present, stats flat).
**Verification task the plan MUST include:** before the first second-device round-trip, confirm the spike code is reachable in the artifact — e.g. it writes a `spike-loaded` line to `screenshare-debug.log` at startup when gated on. An empty log ⇒ packaging gap, not a delivery failure.

### Pitfall 2: Audio MSTG absent in Chromium 146 — the spike's whole point
**What goes wrong:** `MediaStreamTrackGenerator` is `undefined` (proprietary API pulled, or never exposed in this Electron build).
**Why it happens:** It is non-standard; the standards-track replacement (`VideoTrackGenerator`) is video-only/worker-only and does NOT handle audio. Chrome has signaled long-term intent to unbundle/move these APIs.
**How to avoid:** The locked feature-detect-then-fallback IS the mitigation. If absent, log it (satisfies SC#2's "refuted") and proceed on Web Audio. This is **not a failure of the spike** — it's a recorded finding. Only if Web Audio ALSO fails to reach the viewer is it a NO-GO.
**Warning signs:** log line `mechanism=MSTG absent` followed by `mechanism=WebAudio success` and a climbing `packetsSent` ⇒ GO via Web Audio, MSTG refuted — a perfectly good outcome.

### Pitfall 3: Streamer self-verification gives a false NO-GO
**What goes wrong:** The developer streams, listens on the *same* machine, hears nothing, concludes NO-GO.
**Why it happens:** Electron/Discord mutes local echo of your own stream. Verification MUST be on a SECOND device/account (PITFALLS.md V2/V3). The synthetic source is always playing, so the D-08 "silence" pitfall does not apply — but the *listener* must be remote.
**How to avoid:** Bake the second-device viewer step into the verification runbook; treat `getStats()` `packetsSent` climbing as the objective tie-breaker if the human result is ambiguous.

### Pitfall 4: Sender captured before injection / wrong sender
**What goes wrong:** `getStats()` reports a flat `packetsSent`, or no audio outbound-rtp entry, because the captured sender isn't the one carrying the injected track, or stats were read before negotiation completed.
**Why it happens:** Discord may attach audio via `replaceTrack` on a pre-existing transceiver rather than `addTrack`; or the poll started before ICE/DTLS connected.
**How to avoid:** Capture senders via `addTrack` AND, at poll time, also scan `pc.getSenders().filter(s => s.track?.kind === "audio")`. Keep polling for the stream's duration (stats climb only after the connection is live). Log the count of audio senders found each poll.

### Pitfall 5: Teardown leak on STREAM_CLOSE
**What goes wrong:** The oscillator / `AudioContext` / MSTG feeder `setInterval` and the stats `setInterval` keep running after the stream ends.
**Why it happens:** The spike adds timers/nodes but doesn't hook the existing teardown.
**How to avoid:** Hook the existing `STREAM_CLOSE` subscription (`screensharePatch.ts:90-104`) — stop the oscillator, `close()` the AudioContext, `releaseLock()`/close the MSTG writer, and `clearInterval` both timers. Mirror how that block already calls `stopVenmic`/`stopPatchcord`.

---

## Code Examples

### Renderer → userData log channel (new IPC handler, mirrors `saveFileToGCFolder`)
```typescript
// Source: GoofCord pattern — src/utils.ts:116 saveFileToGCFolder + registry codegen
// Add to a main-process module (e.g. a new src/modules/screenshareDebug.ts), then
// run `bun run build --onlyGenerators` so gen.ts/types.ts pick it up.
import fs from "node:fs";
import path from "node:path";
import { userDataPath } from "../utils.ts";

const LOG = path.join(userDataPath, "screenshare-debug.log");
export async function appendScreenshareDebug<IPCHandle>(line: string) {
  await fs.promises.appendFile(LOG, `${new Date().toISOString()} ${line}\n`);
}
```
```typescript
// bridge.ts addition (preload) — mirror existing api methods:
//   appendDebug: (line: string) => invoke("screenshareDebug:appendScreenshareDebug", line),
//   deliverySpike: <boolean from main>,
```
> Path choice: ROADMAP/CONTEXT say `screenshare-debug.log` in **userData**. `userDataPath` (utils.ts:31) is the correct root (`app.getPath("userData")`), NOT the `GoofCord/` subfolder used by `saveFileToGCFolder`. Confirm with the planner which exact directory Phase 1 used — note **no `screenshare-debug.log` writer exists in the codebase yet** (grep returned nothing), so the spike ADDS it; there is no pre-existing Phase 1 channel to reuse.

### Env-gate plumbing (main → renderer)
```typescript
// MAIN: read once at startup (only main sees process.env). Mirror --no-patchcord / GOOFCORD_*_PATH precedent.
export const deliverySpikeEnabled =
  process.env.GOOFCORD_DELIVERY_SPIKE === "1" || process.argv.includes("--delivery-spike");

// PRELOAD bridge.ts: expose it on the contextBridge `api` object (like `version`/`displayVersion`):
//   deliverySpike: sendSync("spike:isDeliverySpikeEnabled"),   // new <IPCOn> getter
// RENDERER: if (GoofCord.deliverySpike) { ...install spike... }
```
> Why a `sendSync` `<IPCOn>` getter (like `getVersion`) rather than reading `process.argv` in the preload: the spike code may live in injected main-world code that has no `process` at all. A bridge field is the uniform, sandbox-safe channel. The `--no-patchcord`/`GOOFCORD_PATCHCORD_PATH` precedent (patchcord.ts:42, build.ts:177) is the model for the env/flag shape.

---

## Runtime State Inventory

This is a greenfield-additive spike (new gated code, no rename/migration). The categories are answered explicitly:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — spike stores nothing persistent. `screenshare-debug.log` is a new append-only diagnostic file in userData. | None |
| Live service config | None — no external service config touched. | None |
| OS-registered state | None — no tasks/services/devices registered. | None |
| Secrets/env vars | New env var `GOOFCORD_DELIVERY_SPIKE` (read-only in main). No secret keys. | Document the var in the spike runbook |
| Build artifacts | The spike's renderer code must land in `ts-out/**` (packaged) — NOT only `assets/postVencord.js` (downloaded from upstream `main`, not packaged). See Pitfall 1. | Place spike code in main preload bundle so it ships |

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `MediaStreamTrackGenerator({kind:"audio"})` (Chrome proprietary, main-thread, handles audio) | Standards-track `VideoTrackGenerator` (video-only, worker-only) | ~2022–2023 (spec unbundling) | The standard path does **not** cover audio. The audio MSTG remains the only no-worker, audio-capable generator — and it remains in Chrome (not removed) but is non-standard. The spike must feature-detect it. `[CITED: MDN / Mozilla WebRTC blog]` |
| Audio via generator | Audio via `AudioWorkletNode` (the "blessed" future) | ongoing | For a throwaway spike, the Web Audio `OscillatorNode → MediaStreamAudioDestinationNode` fallback is far simpler than a worklet and is the robust known-good path. |

**Deprecated/outdated:**
- `ScriptProcessorNode`: deprecated; avoid for new code (acceptable only as a last-resort sample writer — not needed here).
- The audio `MediaStreamTrackGenerator` is non-standard and *could* be removed in a future Chromium; the spike's probe is what confirms its presence on Electron 41.3.0 specifically.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Electron 41.3.0 bundles Chromium 146 (146.0.768x line). | Summary / Standard Stack | Low — only affects which exact Chromium feature-set; the runtime probe is authoritative regardless. Verify via `process.versions.chrome` logged by the spike at startup. |
| A2 | The proprietary audio `MediaStreamTrackGenerator` is present in Chromium 146. | Standard Stack / Pitfall 2 | Medium — this is the spike's central unknown; if absent, the spike falls back to Web Audio and records "MSTG refuted." Not a blocker. |
| A3 | The main preload can install the `getDisplayMedia`/`RTCPeerConnection` patches into the page's main world (directly or via `webFrame.executeJavaScript`, as `loadScripts()` already does). | Pitfall 1 option 1 | Medium — if the preload's isolated world cannot reach page globals directly, the spike must inject via `webFrame.executeJavaScript` (proven available in `assets.ts`). Either way it ships; verify the injection mechanism during planning. |
| A4 | Discord attaches the screenshare audio track via `addTrack` (so wrapping `addTrack` captures the sender). | Pattern 2 / Pitfall 4 | Medium — mitigated by also scanning `getSenders()` at poll time. |
| A5 | `screenshare-debug.log` lives under `app.getPath("userData")` (root), and Phase 1 established no reusable writer (none found in codebase). | Code Examples / Log Path | Low — the spike adds the writer; only the exact directory needs confirming against the Phase 1 convention if one exists. |
| A6 | `MediaStreamTrackGenerator` instance is itself a `MediaStreamTrack` (so it can be passed to `stream.addTrack` directly). | Pattern 1 | Low — per MDN the generator *is* a track; if a build exposes only `VideoTrackGenerator`-style `.track`, adapt by reading `.track`. The probe/try-catch covers this. |

---

## Open Questions

1. **Is the audio `MediaStreamTrackGenerator` constructible in Electron 41.3.0's Chromium 146?**
   - What we know: it is Chrome's proprietary, main-thread, audio-capable generator, shipped since 2021 and not known to be removed; flagged non-standard.
   - What's unclear: presence in this exact Electron build — *this is the spike's reason to exist (SC#2)*.
   - Recommendation: probe at runtime; log `process.versions.chrome` + the probe result; fall back to Web Audio if absent.

2. **Where does the spike's renderer code execute so it ships in the artifact?**
   - What we know: `postVencord.js` is downloaded from upstream `main`, not packaged; `ts-out/**` (main + preloads) IS packaged.
   - What's unclear: whether the main preload patches page globals directly or must use `webFrame.executeJavaScript`.
   - Recommendation: plan for main-preload-hosted spike code; verify the main-world injection path early (option 1, Pitfall 1).

3. **(Residual risk — Phase 4, NOT resolved here):** does high-rate 48 kHz stereo f32 PCM survive the main→renderer MessagePort/transferable transport without unacceptable latency/GC? Renderer-only spike defers this; carry it forward.

4. **Exact chunk size / beep cadence / env-var name / log line format** — implementation details for the planner.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Electron / Chromium runtime | All renderer APIs | ✓ (in the artifact) | Electron 41.3.0 / Chromium ~146 | — |
| `MediaStreamTrackGenerator` (audio) | MSTG path | **UNKNOWN until artifact** | — | Web Audio `MediaStreamAudioDestinationNode` (always present) |
| Web Audio API | Fallback path | ✓ | Chromium | — |
| WebRTC `getStats()` | Corroboration | ✓ | Chromium | track.readyState/muted (weaker) |
| Windows x64 CI artifact (`testBuild.yml`) | The only verification vehicle | ✓ (workflow exists) | `windows-latest`, zip target | none — CI is the sole delivery vehicle (no local Windows native verification) |
| Second device/account | Viewer-side audible confirmation | Manual | — | `getStats()` packetsSent as objective backstop |

**Missing dependencies with no fallback:** none that block the spike (the CI artifact + a second device are the verification setup, assumed available per milestone constraints).
**Missing dependencies with fallback:** audio MSTG → Web Audio (the entire point of the dual-path design).

---

## Validation Architecture

> `.planning/config.json` workflow.nyquist_validation status was not located as an explicit `false`; however this is a **spike whose validation is inherently manual** (viewer-side, on a CI artifact, no DevTools, no automated screenshare repro — per CLAUDE.md and PITFALLS.md). There is no unit/integration test surface for "a remote human hears a beep." The validation architecture is therefore the manual runbook below, plus the machine-readable `screenshare-debug.log` corroboration.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | None automated — manual viewer-side verification on Windows x64 CI artifact |
| Config file | none |
| Quick run command | n/a (build + launch artifact with `GOOFCORD_DELIVERY_SPIKE=1`) |
| Full suite command | n/a |

### Phase Requirements → Test Map
| SC | Behavior | Test Type | "Command" / Procedure | Exists? |
|----|----------|-----------|------------------------|---------|
| SC#1 | Viewer hears injected pattern | manual (second device) | Launch artifact gated on; start screenshare with audio; second account/device listens | ❌ build-and-test |
| SC#2 | MSTG confirmed/refuted + log corroboration | semi-automated | Inspect `screenshare-debug.log` for `mechanism=…` and climbing `packetsSent` | ❌ log writer is Wave 0 |
| SC#3 | NO-GO names Option A | doc | Verdict document review | ❌ |
| SC#4 | Additive + env-gated + throwaway split | code review | Diff review: spike-off ⇒ `"loopback"` unchanged | ❌ |

### Sampling Rate
- **Per task commit:** `bun run check` (tsgo type-check) + `bun run lint` (oxlint) must pass — the only automated gates.
- **Phase gate:** Windows x64 CI artifact builds; gated launch writes `spike-loaded` + `mechanism=…` + climbing `packetsSent`; second-device viewer confirms audio; verdict written.

### Wave 0 Gaps
- [ ] `src/modules/screenshareDebug.ts` (or equivalent) — `appendScreenshareDebug<IPCHandle>` + run `--onlyGenerators` (the `screenshare-debug.log` writer does not exist yet)
- [ ] Env-gate getter (`<IPCOn>`) + `goofcord` bridge field
- [ ] Startup `spike-loaded` log line (the packaging-reachability assertion — Pitfall 1)
- [ ] `bun run check` / `bun run lint` clean (no test framework to install)

---

## Security Domain

> `security_enforcement` status not located as explicit `false`; assessed as effectively N/A for this throwaway, gated, local diagnostic spike. Recorded for completeness.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | spike adds no auth surface |
| V3 Session Management | no | — |
| V4 Access Control | no | — |
| V5 Input Validation | minimal | the only "input" is an env var (`GOOFCORD_DELIVERY_SPIKE`) and a self-generated log line; no untrusted external input |
| V6 Cryptography | no | hand-rolls no crypto |
| V7 Error Handling / Logging | yes (mild) | `screenshare-debug.log` is dev diagnostics; per PITFALLS.md it MUST NOT ship upstream (throwaway). Avoid logging anything sensitive (it logs only stats counters + mechanism names). |

### Known Threat Patterns for this stack
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Monkeypatching `RTCPeerConnection`/`navigator.mediaDevices` left active in normal builds | Tampering | Strictly gate behind `GOOFCORD_DELIVERY_SPIKE`; throwaway branch; off-by-default so production behaviour is byte-identical |
| Diagnostic log leaking into upstream PR | Information disclosure / PR hygiene | Keep getStats spike logging in the throwaway set (CONTEXT scaffolding decision); strip before any upstream PR (PITFALLS.md §logging-must-not-ship) |

---

## Sources

### Primary (HIGH confidence)
- GoofCord source (direct read): `screensharePatch.ts` (swap seam L79-84, `getVirtmic` L4-20, STREAM_CLOSE L90-104), `screenshare.ts` (`result.audio="loopback"` L98, `finishRequest` L24-34), `patchcord.ts` (env-override `--no-patchcord` L42, `getAppMetrics` Audio-Service L80), `utils.ts` (`userDataPath` L31, `saveFileToGCFolder` L116), `bridge.ts` (contextBridge `api` exposure), `assets.ts` (`webFrame.executeJavaScript` main-world injection), `assetLoader.ts` (`ASSETS_FOLDER` in userData), `assetDownloader.ts` (URL-driven asset fetch), `settingsSchema.ts:216-223` (PostVencord URL = upstream `main`), `electron-builder.ts:5` (packaged `files`), `build/build.ts` (renderer scripts → `assets/`, env-override precedent), `.github/workflows/testBuild.yml` (win x64 zip artifact), `ipc/gen.ts`/`registry.main.ts`/`client.preload.ts` (codegen IPC), `02-FINDINGS.md` (fixed WAVEFORMATEX / f32 target / Audio-Service separate process).
- [MDN: MediaStreamTrackGenerator](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrackGenerator) — constructor `{kind:"audio"}`, writable expects `AudioData`, non-standard/experimental note.
- [MDN: AudioData()](https://developer.mozilla.org/en-US/docs/Web/API/AudioData/AudioData) — format values (`f32`/`f32-planar`/…), `timestamp` in microseconds, init shape.
- [MDN: RTCOutboundRtpStreamStats](https://developer.mozilla.org/en-US/docs/Web/API/RTCOutboundRtpStreamStats) — `packetsSent`/`bytesSent` mandatory; `kind`/`ssrc` present.
- [W3C WebRTC Stats](https://www.w3.org/TR/webrtc-stats/) — `outbound-rtp` type, `kind` on every RtpStreamStats.

### Secondary (MEDIUM confidence)
- [Chrome for Developers: Insertable streams for MediaStreamTrack](https://developer.chrome.com/docs/capabilities/web-apis/mediastreamtrack-insertable-media-processing) — MSTG audio is main-thread, accepts AudioData.
- [Mozilla WebRTC blog: Unbundling MediaStreamTrackProcessor and VideoTrackGenerator](https://blog.mozilla.org/webrtc/unbundling-mediastreamtrackprocessor-and-videotrackgenerator/) — audio MSTG is Chrome-proprietary; standard `VideoTrackGenerator` is video-only/worker-only.
- [Electron Releases v41.x](https://releases.electronjs.org/release) — v41.x line on Chromium 146 (146.0.768x); v41.3.0 exact Chromium not isolated in search (verify via `process.versions.chrome` at runtime — A1).

### Tertiary (LOW confidence — resolved by the spike itself)
- Exact presence of audio MSTG in Electron 41.3.0's Chromium 146 — the runtime probe is the authority (SC#2).

## Metadata

**Confidence breakdown:**
- Renderer API surface (MSTG/AudioData/Web Audio/getStats): HIGH — cited from MDN/W3C; only the *presence* of audio MSTG in this build is the named unknown.
- GoofCord integration seams (swap seam, IPC, bridge, env gate, CI packaging): HIGH — read directly from source.
- CI-packaging pitfall (postVencord downloaded from upstream `main`): HIGH — confirmed in `settingsSchema.ts`, `electron-builder.ts`, `assetDownloader.ts`, `build.ts`.
- The central unknown (audio MSTG in Electron 41): MEDIUM-present — the spike resolves it.

**Research date:** 2026-06-01
**Valid until:** ~2026-07-01 (renderer APIs stable; re-check if Electron/Chromium major bumps).

---

## RESEARCH COMPLETE

**Phase:** 3 — Delivery-Path Spike — PCM → MediaStream (GO/NO-GO)
**Confidence:** HIGH on integration + API surface; the one runtime unknown (audio MSTG in Electron 41) is by-design resolved by the spike's probe.

### Key Findings
- **Audio `MediaStreamTrackGenerator` is Chrome-proprietary, main-thread, non-standard, and not known to be removed** — likely present in Chromium 146 (Electron 41) but unconfirmed on this exact build; the locked feature-detect-then-fallback design is correct and the probe IS the SC#2 deliverable.
- **Web Audio fallback is unambiguously known-good:** `AudioContext(48000)` → `OscillatorNode` (frequency sweep for a distinctive cadence) → `MediaStreamAudioDestinationNode` → `.stream.getAudioTracks()[0]`. Favor `OscillatorNode` over AudioWorklet/ScriptProcessor for throwaway simplicity.
- **CI-PACKAGING PITFALL (planner-critical):** GoofCord's `postVencord.js` is **downloaded from upstream `main` at runtime**, not packaged — spike code placed only in `postVencord.ts` will silently NOT ship in the CI artifact. Put spike code in the **main preload bundle** (`ts-out/**`, which *is* packaged) and add a startup `spike-loaded` log line as a packaging-reachability assertion.
- **All plumbing has precedent:** swap seam at `screensharePatch.ts:79-84`; env gate mirrors `--no-patchcord`/`GOOFCORD_*_PATH`; renderer→userData log is a new `<IPCHandle>` mirroring `saveFileToGCFolder` (no `screenshare-debug.log` writer exists yet — the spike adds it); gate forwarded via the `goofcord` contextBridge.
- **Sender discovery:** wrap `RTCPeerConnection.prototype.addTrack` to capture the audio `RTCRtpSender`, and also scan `getSenders()` at poll time; read `getStats()` for `outbound-rtp`/`audio` `packetsSent`/`bytesSent` every ~2 s as the viewer-independent GO corroboration.

### Confidence Assessment
| Area | Level | Reason |
|------|-------|--------|
| Standard Stack | HIGH | MDN/W3C cited; only audio-MSTG presence is the named unknown |
| Architecture / integration seams | HIGH | read directly from GoofCord source |
| Pitfalls (esp. CI packaging) | HIGH | confirmed across settingsSchema/electron-builder/assetDownloader/build |
| Audio MSTG presence in Electron 41 | MEDIUM | resolved by the spike's runtime probe (SC#2) |

### Open Questions (carried)
- Audio MSTG constructible in Electron 41.3.0's Chromium 146? (spike resolves)
- Does the main preload patch page globals directly or via `webFrame.executeJavaScript`? (verify in planning; `loadScripts()` proves injection is available)
- Phase 4 residual risk: main→renderer high-rate PCM transport (NOT proven here).

### Ready for Planning
Research complete. The planner can specify: env-gate plumbing, a packaged (preload-hosted) spike injection, the feature-detect/fallback reconstruction, the swap-seam injection + STREAM_CLOSE teardown, the `getStats()` poll, the new `screenshare-debug.log` IPC writer, and a packaging-reachability assertion task before the first second-device round-trip.
