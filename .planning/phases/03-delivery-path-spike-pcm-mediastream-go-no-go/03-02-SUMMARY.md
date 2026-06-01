---
phase: 03-delivery-path-spike-pcm-mediastream-go-no-go
plan: 02
subsystem: screenshare
tags: [electron, webrtc, getDisplayMedia, MediaStreamTrackGenerator, webaudio, preload, webFrame]

# Dependency graph
requires:
  - phase: 03-01
    provides: "window.goofcord.deliverySpike gate bool + appendScreenshareDebug(line) bridge; screenshareDebug:isDeliverySpikeEnabled sync IPC channel + screenshare-debug.log writer"
provides:
  - "Packaged spike renderer module (deliverySpike.ts) shipping in ts-out/** preload bundle, NOT the downloaded postVencord.js"
  - "Gated main-world injection of the spike via webFrame.executeJavaScript from preload.mts"
  - "MSTG→WebAudio reconstruction of a distinctive 48k/stereo/f32 synthetic audio track + gated getDisplayMedia swap seam (Phase-4 KEEP seed)"
  - "RTCRtpSender capture (addTrack wrap + getSenders scan) and getStats poll logging outbound-rtp packetsSent/bytesSent (THROWAWAY corroboration)"
affects: [03-03, phase-04-native-addon]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Self-contained installDeliverySpike() serialized via .toString() and injected into the page main world as a string (spikeMainWorldSource)"
    - "Gated, additive preload injection: off ⇒ byte-identical startup"

key-files:
  created:
    - src/windows/main/preload/deliverySpike.ts
  modified:
    - src/windows/main/preload/preload.mts

key-decisions:
  - "Authored the entire spike as ONE self-contained function serialized with installDeliverySpike.toString() (spikeMainWorldSource) so all state (Sets/timers/monkeypatches) closes over the page's own globals when run in the main world — the sandboxed isolated-world preload cannot reach the page's RTCPeerConnection/navigator.mediaDevices (RESEARCH A3)."
  - "Gate read via sendSync(\"screenshareDebug:isDeliverySpikeEnabled\") in preload.mts (sandboxed preload has no process.env); injection happens only when true."
  - "Web Audio fallback uses ctx.createMediaStreamDestination() (functional form); plan accepted either that or the MediaStreamAudioDestinationNode constructor."

patterns-established:
  - "Packaged-preload main-world injection: webFrame.executeJavaScript(spikeMainWorldSource) mirroring assets.ts:loadScripts() — ships from ts-out/**, gated, additive."
  - "KEEP (reconstruction + swap seam) vs THROWAWAY (synthetic generator + getStats poll) demarcation for spike scaffolding lifecycle."

requirements-completed: []  # spike — no owned requirements; de-risks ECHO-01 (Phase 4)

# Metrics
duration: ~37min
completed: 2026-06-01
---

# Phase 03 / Plan 02: Packaged delivery-spike renderer + gated main-world injection

**A self-contained spike module shipping in the packaged `ts-out/` preload, gate-injected into the Discord page main world via `webFrame.executeJavaScript`, that reconstructs a distinctive synthetic audio track (MSTG→WebAudio), swaps it into `getDisplayMedia`, and logs reachability + outbound-rtp corroboration to `screenshare-debug.log`.**

## Performance

- **Duration:** ~37 min (across two sessions)
- **Started:** 2026-06-01T03:28:20+01:00 (initial Task 1 commit)
- **Completed:** 2026-06-01T08:04:42+01:00 (close-out commit)
- **Tasks:** 2
- **Files modified:** 2 (1 created, 1 modified)

## Accomplishments
- `deliverySpike.ts` (287 lines) packaged in the main preload bundle, exporting `installDeliverySpike()` and `spikeMainWorldSource` (the function serialized via `.toString()` for main-world execution).
- `spike-loaded chrome=<ver|ua-fallback>` written as the FIRST observable signal — the packaging-reachability proof (RESEARCH §Pitfall 1): an empty/absent log at runtime means the code never shipped, NOT a delivery failure.
- MSTG probe with `mechanism=MSTG present/success/failed/absent` logging and a `createMediaStreamDestination()` Web Audio fallback (`mechanism=WebAudio success`) producing a distinctive 440→660 Hz beep/sweep, 48k/stereo/f32.
- Gated `getDisplayMedia` swap seam (`t.stop()` → `removeTrack` → `addTrack(synthetic)`) running ONLY inside `if (window.goofcord.deliverySpike)`; pass-through when off so the normal `"loopback"` path is untouched.
- `RTCPeerConnection.prototype.addTrack` wrap + poll-time `getSenders()` scan capture the audio sender; a ~2s `getStats()` poll logs `outbound-rtp` audio `packetsSent`/`bytesSent` (the viewer-independent GO corroboration).
- Leak-free teardown: clears both intervals, stops the oscillator, closes the AudioContext, releases the MSTG writer.
- `preload.mts` gated injection: `injectDeliverySpike()` reads `sendSync("screenshareDebug:isDeliverySpikeEnabled")` and only then runs `webFrame.executeJavaScript(spikeMainWorldSource)` with `.then/.catch` logging.

## Task Commits

1. **Task 1: Build the spike renderer module (reconstruction + swap seam + getStats)** — `b919f10` (feat), refined in `13eb179` (feat)
2. **Task 2: Inject the spike into the Discord page main-world from preload.mts, gated** — `13eb179` (feat)

**Plan metadata:** committed with this SUMMARY (docs).

_Note: Task 1's first version (`b919f10`, module-scope + getBridge() shape) was refactored during close-out into the single serializable `installDeliverySpike()` form required by Task 2's main-world injection; both landed in `13eb179`._

## Files Created/Modified
- `src/windows/main/preload/deliverySpike.ts` — packaged spike: gate check, `spike-loaded` reachability log, MSTG→WebAudio reconstruction, gated swap seam, RTCRtpSender capture, getStats poll, leak-free teardown; exports `installDeliverySpike()` + `spikeMainWorldSource`.
- `src/windows/main/preload/preload.mts` — gated `injectDeliverySpike()` via `webFrame.executeJavaScript`, behind `screenshareDebug:isDeliverySpikeEnabled`; additive to existing `loadScripts()`/`loadStyles()`/keybind/flashbar calls.

## Decisions Made
- Serialized the spike as a string (`spikeMainWorldSource = `(${installDeliverySpike.toString()})();``) for main-world injection rather than relying on the isolated-world preload reaching page globals (RESEARCH A3). This is the de-risked `webFrame.executeJavaScript` path from PATTERNS §File Classification.
- Read the gate in `preload.mts` via the existing `screenshareDebug:isDeliverySpikeEnabled` sync IPC channel (no `process.env` in the sandboxed preload).

## Deviations from Plan
None — plan executed as written. (Recovery note: this plan's implementation existed uncommitted in the working tree with no SUMMARY; closed out via the execute-phase safe-resume gate — committed `13eb179`, then verified.)

## Issues Encountered
None during planned work.

## Verification
- `bun run check` → exit 0.
- `bun run lint` → 0 warnings / 0 errors.
- `bun run build` → success; `ts-out/windows/main/preload/preload.js` contains `spike-loaded`, `MediaStreamTrackGenerator`, `outbound-rtp`, `isDeliverySpikeEnabled`, `executeJavaScript` — proving the spike ships in the PACKAGED bundle.
- `assets/postVencord.js` contains 0 spike markers — confirms the spike does NOT live in the runtime-downloaded script (RESEARCH §Pitfall 1).
- Linux/macOS audio paths (`patchcord.ts`, the Linux branch) untouched.

## User Setup Required
None — no external service configuration. (Runtime test is manual on a Windows x64 CI artifact with `GOOFCORD_DELIVERY_SPIKE=1`; that is Plan 03-03's deliverable.)

## Next Phase Readiness
- Ready for Plan 03-03: author the manual second-device test runbook and the GO/NO-GO verdict skeleton (`03-FINDINGS.md` / `03-SPIKE-RUNBOOK.md`), then run the inherently-manual audible test on a real CI artifact.
- RESIDUAL RISK carried to Phase 4 (per locked transport-scope decision): the main→renderer PCM transport is NOT proven by this renderer-only spike. Phase 4 MUST use chunked ArrayBuffer/transferable transport — never per-frame `ipcRenderer.send` of raw PCM.

---
*Phase: 03-delivery-path-spike-pcm-mediastream-go-no-go*
*Completed: 2026-06-01*
