# Phase 4: Native Clean-Room Exclude-Tree Addon + Integration - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-02
**Phase:** 4-native-clean-room-exclude-tree-addon-integration
**Areas discussed:** Native→renderer transport (the one area the user selected from four surfaced)

---

## Gray-area selection

| Option | Description | Selected |
|--------|-------------|----------|
| Native→renderer transport | The named Phase 3 residual risk (#1); how PCM crosses main → preload → main world with chunked transferables | ✓ |
| Addon home & how it's built | Separate published repo + optionalDependencies now vs. in-repo crate + env override now, split in Phase 5 | |
| Capture↔renderer format contract | Addon emits 48k/stereo/f32 vs. 16-bit/native with resampling | |
| Build-support detection / fallback | Try-activate-and-catch vs. OS build-number gate | |

**User's choice:** Native→renderer transport only.
**Notes:** The three unpicked areas were deferred to research/planning with recommended defaults, recorded as Open Questions in CONTEXT.md.

---

## Native→renderer transport

### Q1 — Sequencing relative to building the real WASAPI addon

| Option | Description | Selected |
|--------|-------------|----------|
| Spike transport first | Main-process synthetic PCM over the REAL chunked-transferable transport → main-world MSTG → viewer-audible on CI, THEN wire the addon | ✓ |
| Build addon + transport together | One pass, verify end-to-end via normal CI loop | |
| You decide from research | Let research pick sequencing | |

**User's choice:** Spike transport first.
**Notes:** Mirrors the Phase 3 de-risk instinct; isolates the last unproven half (transport) before the native investment deepens, so a NO/GO turns on transport alone.

### Q2 — Hop-1: main process → renderer

| Option | Description | Selected |
|--------|-------------|----------|
| MessageChannelMain port | Dedicated MessagePortMain, threadsafe callback batches ~10ms chunks, port.postMessage(buf,[buf]) — zero-copy, out-of-band of ipcMain | ✓ |
| ipcRenderer.postMessage + transfer list | postMessage (not send) on a dedicated channel with transfer list — simpler, shares the IPC router | |
| You decide from research | Benchmark and pick | |

**User's choice:** MessageChannelMain port.
**Notes:** Canonical Electron high-throughput pattern; cleanest backpressure. Honors the locked "never per-frame ipcRenderer.send" rule (ARCHITECTURE.md:250-253).

### Q3 — Hop-2: preload (isolated world) → page MAIN WORLD

| Option | Description | Selected |
|--------|-------------|----------|
| Forward the port to main world | Re-transfer the MessagePort via window.postMessage(msg, origin, [port]); zero-copy port→port; Electron-docs pattern | (default) |
| contextBridge callback | PCM lands in preload, invokes a main-world callback via GoofCord bridge; structured-clones each chunk (~400 KB/s copy) | (fallback) |
| You decide from research | Confirm MessagePort transfer into the executeJavaScript-injected main world on Electron 41.3.0 | ✓ |

**User's choice:** You decide from research.
**Notes:** Recorded as a research question — prefer forwarding the port (zero-copy) if it works on Electron 41.3.0; fall back to the contextBridge callback if not. The transport spike (Q1) exercises the real path and settles it empirically; the chosen mechanism is logged to screenshare-debug.log.

### Q4 — Backpressure / buffering policy

| Option | Description | Selected |
|--------|-------------|----------|
| Bounded buffer, latency-first | Small fixed ring: drop-oldest on overflow, silence/last-frame fill on underrun — bounded latency + A/V drift | ✓ |
| Throughput-first, never drop | Unbounded queue, never discards — grows latency/memory under backpressure | |
| You decide from research | Pick sizing/policy from observed cadence | |

**User's choice:** Bounded buffer, latency-first.
**Notes:** Right trade for live screenshare audio; keeps A/V drift (otherwise deferred) bounded. Exact ring depth / buffer location left to the planner within this policy.

### Continue check

**User's choice:** Ready for context.
**Notes:** Declined more transport questions and the other gray areas; the three unpicked areas get research/planning defaults captured as Open Questions.

---

## Claude's Discretion

- Hop-2 mechanism (default = forward the port; fallback = contextBridge) — settled by the spike.
- Buffer location & exact ring depth within the bounded/latency-first policy.
- Chunk batching size/cadence (start from Phase 3's ~10ms/480-frame).
- Addon→main-JS delivery shape (napi ThreadsafeFunction push vs. pull) and the start/stop + format control channel.
- The three unpicked gray areas (addon home & build, format contract, build-support detection) — recommended defaults recorded in CONTEXT.md Open Questions for the researcher to validate or override.

## Deferred Ideas

- A/V sync polish beyond a bounded-latency best-effort.
- Separate published addon repo + optionalDependencies + per-platform prebuild CI (ROADMAP Phase 5 SC#4).
- In-app sender telemetry via replaceTrack/transceiver capture (residual risk #3) — only if in-app stats are wanted.
