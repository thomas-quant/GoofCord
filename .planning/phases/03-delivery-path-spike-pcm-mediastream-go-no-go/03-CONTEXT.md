# Phase 3: Delivery-Path Spike — PCM → MediaStream (GO/NO-GO) - Context

<domain>
**What this phase delivers:** A written GO/NO-GO decision, proven on a real Windows x64 CI build, on whether audio originating outside Discord's own pipeline can be driven through Electron 41.3.0 into the Discord web client's `getDisplayMedia` MediaStream and heard by a remote viewer — using a synthetic/stub PCM source (no native WASAPI code yet) to isolate the delivery path.

**Boundary:**
- IN: a synthetic PCM source generated **in the renderer**; renderer reconstruction of a live `MediaStreamTrack`; injection at the real screenshare swap seam; viewer-side audible verification + logged corroboration; an explicit GO/NO-GO verdict.
- OUT: the main→renderer PCM transport (renderer-only spike — transport is a named residual risk for Phase 4); any clean-room native WASAPI capture code (Phase 4); the real exclude-tree PID resolution (Phase 4); A/V sync work (deferred to Phase 4); any Linux/macOS code path change; shipping the spike in normal builds.
- Owns no requirement — this is a de-risk gate that proves the delivery path for ECHO-01 (owned/delivered in Phase 4).
</domain>

<decisions>
## Decisions

### Renderer reconstruction mechanism
**Decision:** Feature-detect `MediaStreamTrackGenerator` (Insertable Streams) at runtime; use it if present, otherwise fall back to Web Audio `AudioContext → MediaStreamAudioDestinationNode`.
**Rationale:** Directly satisfies SC#2 ("`MediaStreamTrackGenerator` availability confirmed or refuted") and names the exact working path Phase 4 will wire. Web Audio is the known-good fallback if Insertable Streams are absent from Electron 41.3.0's bundled Chromium.
**Implications:** The spike must log which mechanism was attempted and which succeeded. Both code paths exist behind the runtime probe. The "working transport + mechanism" naming is a required spike output.

### Track injection point (swap seam)
**Decision:** Inject the reconstructed track behind a spike flag at the existing removeTrack/addTrack block in `src/windows/main/renderer/postVencord/screensharePatch.ts:79-84` — the same seam patchcord/venmic already use.
**Rationale:** Proves the real Phase 4 integration point, not an artificial standalone wrapper. De-risks the actual seam Phase 4 modifies.
**Implications:** Spike reuses the existing pattern: stop/remove the existing audio track(s), `addTrack` the reconstructed one. Keep it additive and behind the gate so the normal `"loopback"` behaviour is untouched when the spike is off.

### Transport scope (main → renderer)
**Decision:** **Renderer-only.** Generate the synthetic PCM in the renderer (no IPC) and prove only the make-or-break question: a non-Discord audio track reconstructed in the renderer reaches a remote viewer through the existing swap seam. The main→renderer PCM bridge (MessagePort / transferable `ArrayBuffer` chunks, and its IPC-throughput/GC risk) is an **explicit residual risk Phase 4 must own** — documented here, not proven by the spike.
**Rationale:** Fastest clean GO/NO-GO. The genuine make-or-break unknown is whether a non-Discord track can reach the viewer at all (reconstruction + injection), not the transport — isolating it fails faster and cleaner. (Tie-break: the user initially leaned "include transport," but when asked to resolve the conflict explicitly chose renderer-only + a residual-risk note.)
**Implications:** No main-process PCM generation and no IPC in the spike. The plan MUST carry the main→renderer transport as a NAMED residual risk for Phase 4 — and Phase 4 must use chunked transferables, never per-frame `ipcRenderer.send` (research anti-pattern, ARCHITECTURE.md:250-253).

### Synthetic source character
**Decision:** An obviously-synthetic, recognizable pattern (periodic beeps or a repeating frequency sweep) — not a flat tone, not noise, not a bundled clip.
**Rationale:** Verification is viewer-side on a second device with no DevTools; the viewer must be able to say with certainty "I hear MY injected test audio" (distinguishable from Discord audio, silence, or a system sound).
**Implications:** Generator produces a distinctive cadence; runs continuously for the stream's duration so the viewer has time to confirm.

### PCM format
**Decision:** 48 kHz, stereo, float32 — match the Phase 4 target exactly.
**Rationale:** Mirrors WebRTC/Opus, Web Audio, and the fixed `WAVEFORMATEX` the WASAPI process-loopback addon will emit in Phase 4 (the loopback device forces a fixed format; `GetMixFormat` → `E_NOTIMPL`). No format-conversion surprises deferred to Phase 4.
**Implications:** AudioData / Web Audio buffers are f32; if MSTG is used, frames are constructed at this format. Any int conversion the real addon needs is a Phase 4 concern only if the addon emits something other than f32.

### Generation/feed cadence
**Decision:** Feed the reconstruction (MSTG / Web Audio) at a realistic streaming cadence (~10 ms / 480-frame buffers, ~100 chunks/sec) for the stream's duration.
**Rationale:** Exercises the reconstruction + live track at a real-time rate and surfaces underrun/drift/latency in the renderer path now (rather than a single one-shot buffer that proves little).
**Implications:** This is **in-renderer feeding**, not main→renderer shipping (transport is renderer-only per the decision above; the IPC-throughput aspect is the deferred residual risk). Exact chunk size/cadence is a tunable implementation detail.

### GO/NO-GO success bar + verification rigor
**Decision:** GO requires BOTH (a) a second-device viewer audibly confirming the injected pattern in a live stream AND (b) `screenshare-debug.log` recording corroborating signals. The key corroboration is `RTCRtpSender.getStats()` outbound-rtp **audio** `packetsSent`/`bytesSent` climbing (proves audio is actually leaving the peer connection, independent of the viewer), plus cheap signals: which mechanism was chosen/succeeded, `track.readyState`/`muted`, and that an audio track is attached to a sender.
**Rationale:** The viewer's ear is the truth (SC#1); the log makes the verdict auditable and lets a NO-GO be diagnosed (path broken vs. test setup wrong) without DevTools (SC#2, 60%-keyboard constraint).
**Implications:** The spike must locate the active `RTCPeerConnection`/`RTCRtpSender` to call `getStats()` and write a structured line to the userData `screenshare-debug.log`.

### Fallback if Option B fails
**Decision:** If BOTH `MediaStreamTrackGenerator` and Web Audio fail to reach a viewer, declare NO-GO immediately and stop coding — but the written verdict MUST name Option A (a GoofCord-created virtual capture device read via `getUserMedia`, no kernel driver) as the first re-scope avenue to investigate. Do NOT build Option A in this spike.
**Rationale:** Keeps the spike tight while not silently dead-ending the milestone. Option A's no-kernel-driver feasibility is itself unproven (research flagged it must be prototyped), so it doesn't belong in this phase's scope.
**Implications:** A NO-GO is a real, documented milestone-re-scope trigger (SC#3), not silently absorbed. The verdict document points Phase 4/re-scope at Option A next.

### Scaffolding lifecycle
**Decision:** Spike lives on a dedicated throwaway branch and is gated behind an env var / flag following the existing `GOOFCORD_*` precedent (e.g. `GOOFCORD_DELIVERY_SPIKE=1`), dormant by default so it rides the CI artifact without polluting normal builds and can be toggled on the artifact without a rebuild. **Keep** the proven renderer reconstruction (MSTG/Web Audio path) + the main→renderer transport wiring as clearly-marked Phase 4 seed code; **throw away** the synthetic PCM generator + beep + getStats spike logging.
**Rationale:** Satisfies SC#4 (additive, throwaway-where-possible, any kept code marked for Phase 4 integration). Mirrors the `--no-patchcord` / `GOOFCORD_*_PATH` env-override precedent.
**Implications:** Env gate ensures the existing Windows `"loopback"` path is untouched when off. The diff stays additive and easy to strip; the kept delivery code is annotated as the Phase 4 starting point.
</decisions>

<specifics>
## Specific References

**Injection / delivery path:**
- Renderer swap seam to reuse (behind spike flag): `src/windows/main/renderer/postVencord/screensharePatch.ts:79-84` (stop/removeTrack/addTrack block); `getVirtmic()` precedent at lines 4-20.
- `STREAM_CLOSE` teardown hook (for stopping the spike source): `src/windows/main/renderer/postVencord/screensharePatch.ts:90-104`.
- Windows audio branch the fix ultimately targets: `src/windows/screenshare/screenshare.ts:90-100` (`result.audio = "loopback"` at L98) — UNCHANGED by the spike; spike replaces the track in-renderer.

**Transport / format:**
- **Residual risk for Phase 4 (NOT proven by this spike):** the main→renderer PCM bridge. Phase 4 must use chunked transfers / `ArrayBuffer` transferables — never per-frame `ipcRenderer.send` of raw PCM (research anti-pattern, ARCHITECTURE.md:250-253).
- PCM format 48 kHz / stereo / float32 — matches Phase 4 fixed `WAVEFORMATEX` (research SUMMARY.md:53, FINDINGS `GetMixFormat → E_NOTIMPL`).

**Verification (no DevTools):**
- All diagnostics → userData `screenshare-debug.log` (established Phase 1 pattern; 60%-keyboard / no-F12 constraint).
- Echo/audio checks are viewer-side on a SECOND device/account; streamer cannot self-verify (Electron mutes local echo). Keep audio actively playing (here the synthetic source is always playing, so the D-08 "silence" pitfall does not apply to the spike).
- GO corroboration signal: `RTCRtpSender.getStats()` outbound-rtp audio `packetsSent`/`bytesSent`.

**Activation:**
- Env-var gate following `GOOFCORD_*` precedent (e.g. `GOOFCORD_DELIVERY_SPIKE`); mirrors `--no-patchcord` / `GOOFCORD_*_PATH` (research ARCHITECTURE.md:185).
</specifics>

<canonical_refs>
## Canonical References

- `.planning/ROADMAP.md` — Phase 3 goal + Success Criteria (SC#1–SC#4) and the spike's GO/NO-GO framing.
- `.planning/research/ARCHITECTURE.md` — Option A / Option B / Option C delivery paths (§Options, lines 108-142), the delivery-path spike recommendation (lines 142, 193-195), the renderer track-swap integration index (lines 226-234, 262-273), and the IPC-throughput anti-pattern (lines 250-253).
- `.planning/research/SUMMARY.md` — delivery-path framing (lines 10-12, 62), the Phase 2/delivery-path-spike rationale (lines 112-122), and the `MediaStreamTrackGenerator`-availability research flag (lines 122, 174, 196-198).
- `.planning/research/PITFALLS.md` — viewer-side verification protocol (V2/V3, lines 59-62, 314+) and the CI-packaging pitfall.
- `.planning/research/STACK.md` — verification-via-CI-artifact constraint (line 96); maintainer's box is Win10 19045.
- `.planning/phases/02-fix-bug-b-windows-loopback-audio-captured/02-FINDINGS.md` — clean-room GO verdict, fixed `WAVEFORMATEX`, Electron Audio-Service separate-process complication (informs Phase 4, not the spike itself).
- `.github/workflows/testBuild.yml` — the Windows x64 CI build the spike is verified on.
</canonical_refs>

<code_context>
## Code Context

- **`src/windows/main/renderer/postVencord/screensharePatch.ts`** — monkeypatches `navigator.mediaDevices.getDisplayMedia`; the removeTrack/addTrack block (L79-84) is the exact swap seam the spike reuses behind its flag. `getVirtmic()` (L4-20) and the patchcord branch are the existing "replace the audio track" precedent. `STREAM_CLOSE` subscription (L90-104) is where stop/cleanup hooks live.
- **`src/windows/screenshare/screenshare.ts`** — main-process display-media handler; `result.audio = "loopback"` (L98) is the Windows audio branch (untouched by the spike; replaced in-renderer). `finishRequest()` exactly-once teardown (L24-34) is the Phase 1 invariant — do not disturb.
- **`src/modules/native/patchcord.ts`** — native-module wrapper shape + `app.getAppMetrics()` Audio-Service PID precedent (Phase 4 concern, not the spike).
- **Native module / env-override precedent:** `GOOFCORD_PATCHCORD_PATH` / `GOOFCORD_VENBIND_PATH` and `--no-patchcord` (build.ts / venbind.ts) — the model for the spike's `GOOFCORD_*` activation gate.
- **Diagnostics:** userData `screenshare-debug.log` pattern established in Phase 1 instrumentation.
</code_context>

<deferred>
## Deferred Ideas

- **Main→renderer PCM transport** — the spike is renderer-only; the real transport (MessagePort / transferable `ArrayBuffer` chunks) and its IPC-throughput/GC risk are a named residual risk Phase 4 must own and prove.
- **A/V sync** between injected audio and the screenshare video — explicitly out of scope for the spike; defer all sync concerns to Phase 4. The spike only proves "audio reaches the viewer at all."
- **Option A (virtual capture device, no kernel driver)** — not built in this spike; named in the NO-GO verdict as the first re-scope avenue if Option B fails both APIs.
- **Real exclude-tree WASAPI capture + PID resolution** — Phase 4.
</deferred>

<open_questions>
## Open Questions

- Is `MediaStreamTrackGenerator` (Insertable Streams) available in Electron 41.3.0's bundled Chromium? (The spike resolves this — it is the point of the runtime probe.)
- **(Residual risk — deferred to Phase 4, NOT resolved by this spike):** Does high-rate 48 kHz stereo float32 PCM survive the main→renderer MessagePort/transferable transport without unacceptable latency/GC pressure? The spike is renderer-only, so this is carried forward as a named Phase 4 risk.
- Exact chunk size / beep cadence / env-var name / `screenshare-debug.log` line format — implementation details for the planner/executor to settle.
</open_questions>
