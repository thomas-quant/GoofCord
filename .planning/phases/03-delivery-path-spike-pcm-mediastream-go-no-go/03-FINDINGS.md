# Phase 3 Findings — Delivery-Path Spike: PCM → renderer track → `getDisplayMedia` → viewer (GO/NO-GO)

**Headline verdict: GO.** ✅

A non-Discord audio track, reconstructed entirely in the renderer via **`MediaStreamTrackGenerator`** (Insertable Streams) and swapped into Discord's `getDisplayMedia` MediaStream at the existing `screensharePatch.ts:79-84` seam, was **heard by a remote second-device viewer** on a real Windows x64 CI artifact (run `26740748142`, Chrome 146). The make-or-break unknown for the milestone — *can audio originating outside Discord's own pipeline be driven through Electron 41.3.0 into the Discord web client's stream and reach a viewer?* — is **resolved YES**. Phase 4's native WASAPI capture (ECHO-01) has a proven renderer-side delivery path to wire into.

**What this phase delivers:** this document — the explicit, written, evidence-backed GO/NO-GO decision, proven on a real Windows x64 CI artifact (SC#3). The renderer-only spike (synthetic 48k/stereo/f32 source generated in-page, no native code, no IPC PCM) isolated the delivery path so the verdict turns on the one genuine architectural unknown, not on native code that does not exist yet.

> **Status of this document: FINALIZED (03-03 complete).** Task 1 authored the manual runbook (`03-SPIKE-RUNBOOK.md`); Task 2 was the developer's inherently-manual second-device audible test on the Windows CI artifact; this document (Task 3) records the verdict from the observed results.

> **Provenance of the runtime findings (disclosure):** the runtime evidence below was produced by **the developer running `03-SPIKE-RUNBOOK.md` on a real Windows box against the Windows x64 CI artifact** (run `26740748142`, branch `fix/windows-screenshare-cancel-restart`), launched with `GOOFCORD_DELIVERY_SPIKE=1`, with a **second device/account as the listener** (the streamer cannot self-verify — Electron mutes local echo). Every `runtime-observed` claim traces to a line in the userData `screenshare-debug.log` from the 2026-06-02 spike run (the earlier 2026-05-30 `[ScreenshareDebug][B]/[C]` lines are stale Bug-A data and are ignored). The binary-level packaging proof traces to the orchestrator's inspection of `resources/app.asar` inside the same CI artifact.

---

## Legends (apply to every substantive claim below)

> **Every substantive claim carries a Provenance tag and a Confidence tag** — the load-bearing convention inherited from `02-FINDINGS.md`. It separates "the viewer heard the beep on the artifact" from "this is what the API would imply."

### Provenance legend (where the claim came from)

| Tag | Meaning |
|-----|---------|
| `[runtime: log line / artifact]` | Observed at runtime on the Windows x64 CI artifact via `screenshare-debug.log` (run `26740748142`). |
| `[viewer: second device]` | Heard directly by the remote second-device viewer (the SC#1 ground truth). |
| `[binary: app.asar]` | Confirmed by inspecting the packaged `resources/app.asar` inside the CI artifact (packaging reachability). |
| `[desk/code]` | Established from public sources or a code read only — not observed at runtime. |
| `[inference]` | Reasoned from other facts, not directly observed. |

### Confidence legend (how strongly the claim is supported)

| Tag | Meaning |
|-----|---------|
| `runtime-observed on the CI artifact` | Seen in the artifact's `screenshare-debug.log` and/or heard by the second-device viewer. |
| `binary-confirmed in the artifact` | The symbol/marker was found inside the packaged `app.asar`. |
| `desk-research / code read` | Established from public sources or a source read, not confirmed at runtime. |
| `inference` | Reasoned, not directly observed. |

---

## Evidence (the raw `screenshare-debug.log` lines this verdict rests on)

The dispositive lines from the 2026-06-02 spike run (run `26740748142`, Chrome 146):

```
2026-06-02T01:39:50.835Z spike-loaded chrome=ua:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36
2026-06-02T01:39:50.839Z spike installed (getDisplayMedia + addTrack wrapped)
2026-06-02T01:40:59.723Z mechanism=MSTG present
2026-06-02T01:40:59.725Z mechanism=MSTG success kind=audio
2026-06-02T01:40:59.725Z swap-seam injected synthetic audio track
2026-06-02T01:41:01.738Z stats poll audioSenders=0
… (stats poll repeated every ~2s, audioSenders=0 THROUGHOUT, 01:41:01 → 01:43:17, ~64 polls)
```

Reported developer answers: (a) viewer-audible — **YES** (the distinctive injected 440→660 Hz beep/sweep, on the second device); (b) mechanism — **MSTG present AND success** on Chrome 146; (c) `packetsSent` climbing — **NOT OBSERVED** (`audioSenders=0` throughout); (d) log errors — **none**.

---

## SC#1 — Second-device viewer audibly hears the injected pattern

> Maps to **ROADMAP Phase 3 Success Criterion 1**: "On a Windows x64 CI build (`.github/workflows/testBuild.yml`), with a synthetic/stub audio source (not the real WASAPI capture), a second-device viewer **hears** the injected test audio in a live Discord screenshare — proving end-to-end PCM → renderer track → `getDisplayMedia` MediaStream → viewer works. (Manual, viewer-side; the streamer cannot self-verify because Electron mutes local echo.)"

**Verdict: GO.** The remote second-device viewer clearly heard the distinctive injected **440→660 Hz beep/sweep** — recognizably the spike's synthetic test tone, distinguishable from Discord audio, silence, and system sounds. The streamer could not self-verify (Electron mutes local echo, Pitfall 3) — the second-device listener is the dispositive ground truth, exactly as the runbook required.

The full delivery chain is proven by the log lines, in order:
- `spike-loaded …` → the spike code shipped and ran (packaging-reachability gate passed — Pitfall 1 cleared; see §Packaging reachability).
- `mechanism=MSTG present` → `mechanism=MSTG success kind=audio` → a live audio `MediaStreamTrack` was reconstructed in the renderer.
- `swap-seam injected synthetic audio track` → that track was swapped into Discord's `getDisplayMedia` MediaStream at `screensharePatch.ts:79-84`.
- `[viewer: second device]` → the viewer heard it on the far end.

`[runtime: spike-loaded / mechanism=MSTG success / swap-seam] + [viewer: second device]` — confidence: `runtime-observed on the CI artifact`. **Windows x64 CI artifact run `26740748142`, Chrome 146.**

This is the make-or-break result. On WebRTC there is **no path to a remote peer except `outbound-rtp`** — so a viewer audibly receiving the injected track is proof, by construction, that the track left the peer connection. Viewer-audible is strictly stronger than any local proxy signal. (See §Instrumentation caveat for why the `getStats` proxy did not separately corroborate it, and why that does not weaken this verdict.)

---

## SC#2 — Mechanism confirmed + transport named

> Maps to **ROADMAP Phase 3 Success Criterion 2**: "The spike records, in `screenshare-debug.log` … exactly which delivery mechanism succeeded in Electron 41.3.0's bundled Chromium: `MediaStreamTrackGenerator` (Insertable Streams) availability is confirmed or refuted, and the working transport … is named."

**Mechanism: `MediaStreamTrackGenerator` (MSTG / Insertable Streams) — CONFIRMED PRESENT and SUCCESSFUL on Chrome 146.** The runtime probe logged `mechanism=MSTG present` followed by `mechanism=MSTG success kind=audio` — the audio MSTG is constructible in Electron 41.3.0's bundled Chromium, the proprietary main-thread audio generator was used, and it produced the live track the viewer heard. The Web Audio `MediaStreamAudioDestinationNode` fallback was **not needed** but remains in the code as the known-good backup. `[runtime: mechanism=MSTG present / mechanism=MSTG success kind=audio]` — confidence: `runtime-observed on the CI artifact`.

**This resolves the spike's central runtime unknown (RESEARCH §Open Question 1 / Assumption A2):** the audio `MediaStreamTrackGenerator`, flagged "probable-present, unverified on artifact," **IS present in Chromium 146**. It also **resolves assumption A1** (Electron 41.3.0 bundles Chromium 146): the `spike-loaded` line carries `Chrome/146.0.0.0` in the userAgent fallback. `[runtime: spike-loaded chrome=ua:…Chrome/146.0.0.0…]` — confidence: `runtime-observed on the CI artifact`.

**The proven renderer-side delivery path (named for Phase 4):**

> in-renderer audio source → **`MediaStreamTrackGenerator({kind:"audio"})`** fed `AudioData` f32 frames → reconstructed live `MediaStreamTrack` → **swap seam at `screensharePatch.ts:79-84`** (`t.stop()` → `stream.removeTrack(t)` → `stream.addTrack(reconstructed)`) → Discord's `RTCPeerConnection` → `outbound-rtp` → remote viewer.

**Transport scope — explicit boundary:** this spike proved only the **renderer-side** half of the delivery path. The synthetic PCM source was generated **in the renderer** (no IPC), by locked design (CONTEXT §Transport scope), so the **main→renderer PCM transport half was intentionally OUT OF SCOPE** for this renderer-only spike. The transport Phase 4 must build (natively-captured WASAPI PCM shipped from the main process into the renderer) is **not proven here** and is the **named Phase 4 residual risk** (see §Residual risk for Phase 4). `[desk/code]` — confidence: `desk-research / code read`.

`process.versions.chrome` note: the spike logged `chrome=ua:…` (the userAgent fallback) rather than a bare `process.versions.chrome` value — confirming `process` was **undefined** in the injected context, i.e. the spike ran in the page **MAIN WORLD** (the sandboxed isolated-world preload could not reach page globals). This validates the `webFrame.executeJavaScript` injection choice (RESEARCH A3 / 03-02 decision) and the UA-fallback design worked as intended. `[runtime: spike-loaded chrome=ua:…]` — confidence: `runtime-observed on the CI artifact`.

### Instrumentation caveat — `audioSenders=0` / Pitfall 4 materialized (an OBSERVATION gap, NOT a delivery failure)

The `getStats` corroboration the runbook asked for (`outbound-rtp audio packetsSent/bytesSent` climbing) was **NOT captured**: every poll logged `audioSenders=0` for the whole run (~64 polls, 01:41:01 → 01:43:17), so no `outbound-rtp` line was ever emitted. This is **Pitfall 4 materializing exactly as RESEARCH predicted** — and it is an instrumentation blind spot, **not a delivery failure**:

- Discord does **NOT** call `RTCPeerConnection.addTrack` for the screenshare audio — it uses **`replaceTrack` on a pre-created transceiver**. The spike's `addTrack` wrap therefore captured nothing, and because the polled sender set is **only populated by that wrap**, the poll-time `getSenders()` scan also had nothing to report (`audioSenders=0`). The `getStats` poll was **blind to Discord's real sender**.
- The `getStats` instrumentation is a **THROWAWAY diagnostic** (per the scaffolding split). Its silence means "the spike could not *see* the sender," not "audio did not leave the peer connection."
- **The viewer-audible ground truth is dispositive and strictly stronger.** On WebRTC the only path to a remote peer is `outbound-rtp` — so `packetsSent` *was* climbing in reality (the viewer heard the beep); the spike merely failed to *observe* the sender it was climbing on. The proxy signal it was meant to corroborate was made redundant by the stronger primary signal.

Hence SC#2's mechanism + delivery-path requirement is satisfied (MSTG confirmed, path named, viewer-audible) and the missing `getStats` corroboration is recorded honestly as an observation-tooling limitation. `[runtime: stats poll audioSenders=0 (×64)] + [viewer: second device] + [desk/code: RESEARCH Pitfall 4 — replaceTrack on pre-created transceiver]` — confidence: `runtime-observed on the CI artifact`.

---

## SC#3 — Explicit GO/NO-GO decision

> Maps to **ROADMAP Phase 3 Success Criterion 3**: "An explicit, written **GO/NO-GO decision** is produced: GO = a viable, upstream-shaped delivery path is proven and named …; NO-GO = no path delivers audio without a kernel/virtual-audio driver, which would force a milestone re-scope (documented, not silently absorbed)."

**Verdict: GO — stated plainly.** A viable, upstream-shaped delivery path is proven and named (§SC#2): renderer `MediaStreamTrackGenerator` reconstruction → `getDisplayMedia` swap seam at `screensharePatch.ts:79-84` → Discord's `RTCPeerConnection` → remote viewer. This is the path Phase 4 wires the real WASAPI capture into. The milestone proceeds to Phase 4 (native clean-room exclude-tree addon + integration) on the original plan — **no re-scope.**

**Option A is NOT triggered (named only as the hypothetical re-scope avenue).** Per the locked fallback decision (CONTEXT §"Fallback if Option B fails"), a NO-GO — both MSTG *and* Web Audio failing to reach a viewer — would have made **Option A** (a GoofCord-created virtual capture device read via `getUserMedia`, no kernel driver) the first re-scope avenue to investigate. That condition did **not** occur (MSTG succeeded on the first mechanism), so Option A is recorded here only as the path-not-taken. **Do NOT build Option A.** `[viewer: second device] + [runtime: mechanism=MSTG success]` — confidence: `runtime-observed on the CI artifact`.

---

## SC#4 — Additive, env-gated, throwaway-where-possible; kept code marked for Phase 4

> Maps to **ROADMAP Phase 3 Success Criterion 4**: "The spike touches no Linux/macOS code path and leaves the existing Windows `"loopback"` behaviour intact behind the experiment — it is additive, throwaway-where-possible scaffolding, and any code kept is marked for the Phase 4 integration."

**Confirmed additive and env-gated.** The spike runs **only** when armed via `GOOFCORD_DELIVERY_SPIKE=1` (or `--delivery-spike`), read in the main process and forwarded over the `goofcord` contextBridge (the sandboxed renderer has no `process.env`). With the gate **off**, the injection never fires and the normal Windows `"loopback"` path is **byte-identical** to upstream — the runbook's launch step had to set the var explicitly to observe any spike line at all, and 03-02's verification confirmed `assets/postVencord.js` carries **zero** spike markers (the spike ships only from the packaged `ts-out/**` preload, never the downloaded renderer script). Linux (patchcord) and macOS audio paths were untouched. `[binary: app.asar] + [desk/code: 03-02-SUMMARY verification]` — confidence: `binary-confirmed in the artifact` / `desk-research / code read`.

**KEEP / THROWAWAY split (the Phase 4 scaffolding lifecycle, per CONTEXT §"Scaffolding lifecycle"):**

| Disposition | Code | Why |
|-------------|------|-----|
| **KEEP** (Phase 4 seed) | The **MSTG → Web-Audio reconstruction** of a live audio `MediaStreamTrack` (the proven renderer mechanism) | This is the validated delivery primitive Phase 4 feeds real WASAPI PCM into. MSTG-first with Web-Audio fallback is the confirmed-working shape. |
| **KEEP** (Phase 4 seed) | The **`getDisplayMedia` swap seam** (`screensharePatch.ts:79-84` shape: stop/remove existing audio track(s) → `addTrack` the reconstructed one) | This is the exact, proven integration point Phase 4 modifies. The seam works end-to-end to the viewer. |
| **THROW AWAY** | The **synthetic beep/sweep generator** (the 440→660 Hz `AudioData`/oscillator source) | A test fixture only; Phase 4 replaces it with real captured PCM. |
| **THROW AWAY** | The **`getStats` poll + `addTrack`-wrap sender capture** (the `audioSenders` instrumentation) | Throwaway diagnostic; it was blind to Discord's real sender anyway (§Instrumentation caveat). Must be stripped before any upstream PR (PITFALLS §logging-must-not-ship). |

`[desk/code]` — confidence: `desk-research / code read`.

---

## Residual risk for Phase 4 (mandatory)

1. **The main→renderer PCM transport is UNPROVEN by this renderer-only spike — Phase 4 MUST own it.** The spike generated the synthetic source *in the renderer* (no IPC), so it proved only the renderer-side half of the path. Phase 4 must build the half that ships natively-captured WASAPI PCM from the main process into the renderer's reconstruction. **Phase 4 MUST use chunked `ArrayBuffer`/transferable transport (MessagePort), NEVER per-frame `ipcRenderer.send` of raw PCM** — that is the named research anti-pattern (`ARCHITECTURE.md:250-253`); per-frame IPC of high-rate 48 kHz stereo f32 will not survive without unacceptable latency/GC pressure. This is the single carried-forward unknown for the native echo fix. `[desk/code: CONTEXT §Transport scope; ARCHITECTURE.md:250-253]` — confidence: `desk-research / code read`.

2. **Audio-Service separate-process PID resolution (carried forward from `02-FINDINGS.md` §2.2).** Chromium/Electron does not play audio from the main window process — call audio is routed through a separate, sandboxed **"Audio Service"** utility process. Phase 4's WASAPI exclude-tree target therefore must be the **GoofCord/Electron root process tree** (resolve the root PID via `app.getAppMetrics()`, not a single window PID) so the Audio-Service child is covered by `EXCLUDE_TARGET_PROCESS_TREE` semantics. The exact runtime PID layout on Electron 41.3.0 (which child actually renders call audio) is a Phase 4 implementation detail to confirm from logged metrics on the first CI artifact. `[desk/code: 02-FINDINGS §2.2; CONTEXT §canonical_refs]` — confidence: `desk-research / public report`.

3. **`getStats` sender-capture blind spot (instrumentation guidance for Phase 4).** If Phase 4 wants in-app sender telemetry, it must capture Discord's real audio sender via the **transceiver / `replaceTrack`** path (or by wrapping the **`RTCPeerConnection` constructor**), **not** the `addTrack` wrap this spike used — Discord attaches screenshare audio via `replaceTrack` on a pre-created transceiver, so an `addTrack` wrap sees nothing (§Instrumentation caveat). For end-to-end correctness, prefer the viewer-audible check (the ground truth) over in-app stats. `[runtime: audioSenders=0; desk/code: RESEARCH Pitfall 4]` — confidence: `runtime-observed on the CI artifact`.

---

## Handoff to Phase 4

Phase 4 wires the real clean-room WASAPI exclude-tree capture into the **exact delivery path proven GO here**:

> **native WASAPI process-tree EXCLUDE loopback (clean-room, Phase 4)** → *[the transport Phase 4 must build:* **chunked `ArrayBuffer`/transferable main→renderer transport (MessagePort), never per-frame `ipcRenderer.send`]* → **`MediaStreamTrackGenerator` (Insertable Streams) reconstruction** of a live audio track (Web-Audio fallback retained) → the **`getDisplayMedia` swap seam at `screensharePatch.ts:79-84`** (stop/remove the existing `"loopback"` audio track → `addTrack` the reconstructed one) → Discord's `RTCPeerConnection` → remote viewer hears desktop audio with **no call echo** (ECHO-01).

Concretely, Phase 4:
- **Keeps** the MSTG/Web-Audio reconstruction + the `getDisplayMedia` swap seam as the seed (§SC#4 KEEP rows); **throws away** the synthetic beep generator + the `getStats`/`addTrack`-wrap instrumentation.
- **Builds** the missing main→renderer PCM transport with chunked transferables (residual risk #1).
- **Resolves** the exclude target as the GoofCord/Electron root process tree via `app.getAppMetrics()` so the Audio-Service child is covered (residual risk #2).
- **Implements clean-room** from the public Microsoft `ApplicationLoopback` sample (MIT, notice retained), never from Discord symbols, with a fixed `WAVEFORMATEX` (no `GetMixFormat` on the loopback device) — per `02-FINDINGS.md §3` and the locked D-05 clean-room boundary.

---

## Packaging reachability (supporting evidence — proven at the binary level)

The packaging-reachability gate (RESEARCH §Pitfall 1) passed on **two** independent levels:

- **Runtime:** the artifact's `screenshare-debug.log` contained the `spike-loaded` line (an empty/absent log would have been a packaging gap, NOT a NO-GO). The spike code shipped and ran. `[runtime: spike-loaded]` — confidence: `runtime-observed on the CI artifact`.
- **Binary:** the spike markers (`spike-loaded`, `isDeliverySpikeEnabled`, `MediaStreamTrackGenerator`, `outbound-rtp`, `screenshare-debug.log`) were confirmed present **inside the packaged app's `resources/app.asar`** from the CI artifact — packaging reachability proven at the binary level, not just at runtime, and confirming the spike ships from `ts-out/**` (not the runtime-downloaded `postVencord.js`). `[binary: app.asar]` — confidence: `binary-confirmed in the artifact`.

---
*Phase: 03-delivery-path-spike-pcm-mediastream-go-no-go*
*Verdict: GO*
*Finalized: 2026-06-02*
