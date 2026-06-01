---
phase: 03-delivery-path-spike-pcm-mediastream-go-no-go
plan: 01
subsystem: ipc-bridge
tags: [spike, ipc, preload, screenshare, delivery-path, throwaway]
requires:
  - "src/utils.ts: userDataPath, saveFileToGCFolder<IPCHandle>, getVersion<IPCOn> (analog shapes)"
  - "src/windows/main/preload/bridge.ts: goofcord contextBridge api object"
  - "build/genIpcHandlers.ts: <IPCHandle>/<IPCOn> codegen"
provides:
  - "channel screenshareDebug:appendScreenshareDebug (ipcMain.handle) — append a timestamped line to userData screenshare-debug.log"
  - "channel screenshareDebug:isDeliverySpikeEnabled (ipcMain.on) — env/argv gate boolean"
  - "window.goofcord.deliverySpike (bool) + window.goofcord.appendScreenshareDebug(line) bridge fields"
affects:
  - "Plan 02 (renderer spike) consumes both bridge fields"
  - "Phase 4 ECHO-01 delivery wiring (de-risked, not delivered here)"
tech-stack:
  added: []
  patterns:
    - "IPC codegen: annotate <IPCHandle>/<IPCOn>, channel = <fileStem>:<fn>, regenerate via `bun run build --onlyGenerators`"
    - "Off-by-default env/argv gate read in MAIN only (GOOFCORD_DELIVERY_SPIKE / --delivery-spike), forwarded via goofcord bridge"
key-files:
  created:
    - "src/modules/screenshareDebug.ts"
  modified:
    - "src/windows/main/preload/bridge.ts"
    - "src/ipc/gen.ts (regenerated)"
    - "src/ipc/types.ts (regenerated)"
decisions:
  - "Log writer targets userDataPath root (app.getPath('userData')), NOT getGoofCordFolderPath() subfolder, and uses fs.promises.appendFile (not writeFile)"
  - "Gate getter uses <IPCOn> (sync sendSync at bridge eval), mirroring getVersion — not <IPCHandle>"
  - "Both new files/fields marked THROWAWAY for strip-before-upstream-PR (Phase 3 spike scaffolding)"
metrics:
  duration: "~6 min"
  completed: "2026-06-01"
  tasks: 2
  files-changed: 4
  commits: 2
---

# Phase 3 Plan 01: Delivery-Spike IPC Plumbing Summary

Main-process plumbing for the renderer delivery spike: a userData `screenshare-debug.log` append channel and an off-by-default `GOOFCORD_DELIVERY_SPIKE` gate boolean, both exposed to the renderer through the existing `goofcord` contextBridge — the interface Plan 02's spike injection calls.

## What Was Built

- **`src/modules/screenshareDebug.ts` (new):**
  - `appendScreenshareDebug<IPCHandle>(line)` — appends `<ISO-timestamp> <line>\n` to `path.join(userDataPath, "screenshare-debug.log")` via `fs.promises.appendFile`. Mirrors `saveFileToGCFolder`'s `<IPCHandle>` + `fs.promises` shape but uses the userData root (not the `GoofCord/` subfolder) and `appendFile` (not `writeFile`). No try/catch — lets the promise reject and surface over IPC, matching the analog.
  - `isDeliverySpikeEnabled<IPCOn>()` — returns `process.env.GOOFCORD_DELIVERY_SPIKE === "1" || process.argv.includes("--delivery-spike")`. `<IPCOn>` (sync) so the bridge reads it once via `sendSync`, mirroring `getVersion`. Read in MAIN only (sandboxed renderer has no `process.env`).
  - File header marks it throwaway Phase 3 scaffolding to strip before any upstream PR.
- **IPC contract regenerated** via `bun run build --onlyGenerators` — `gen.ts` now registers `ipcMain.handle("screenshareDebug:appendScreenshareDebug", ...)` and `ipcMain.on("screenshareDebug:isDeliverySpikeEnabled", (event) => { event.returnValue = ... })`; `types.ts` carries both channel types. Not hand-edited.
- **`bridge.ts` `api` object** gained two fields (with a throwaway marker comment):
  - `deliverySpike: sendSync("screenshareDebug:isDeliverySpikeEnabled")` — sync bool, like `version`.
  - `appendScreenshareDebug: (line: string) => invoke("screenshareDebug:appendScreenshareDebug", line)` — invoke method, like `stopPatchcord`.

## How It Works

Renderer code (Plan 02) reads `window.goofcord.deliverySpike` (gate) and calls `window.goofcord.appendScreenshareDebug(line)` to write diagnostics. The gate value and the file write both originate in main and cross IPC because the sandboxed renderer has neither `process.env` nor Node `fs`. With the gate OFF (default), `deliverySpike` is `false` and no spike behaviour is reachable.

## Verification

- `bun run check` (tsgo) exits 0 — the new channel literals resolve against the regenerated types.
- `bun run lint` (oxlint, type-aware): 0 warnings, 0 errors.
- `grep` confirms both annotated functions in `screenshareDebug.ts`, both regenerated channels in `gen.ts`/`types.ts`, and both bridge fields in `bridge.ts`.
- **Off-by-default invariant:** with `GOOFCORD_DELIVERY_SPIKE` unset and `--delivery-spike` absent, the boolean expression evaluates to `false`. `src/windows/screenshare/screenshare.ts:98` (`result.audio = "loopback"`) is byte-identical (file not in the diff). Linux/macOS paths untouched.

## Deviations from Plan

None — plan executed exactly as written. Both tasks' automated verify checks passed on the first attempt; no auto-fixes (Rules 1–3) or architectural pauses (Rule 4) were needed.

## Known Stubs

None that block the plan's goal. The two new functions are intentionally throwaway spike scaffolding (gated, off by default) per the CONTEXT "Scaffolding lifecycle" decision — they are the interface Plan 02 consumes, not dead stubs. Both the module and the bridge fields are marked for strip-before-upstream-PR.

## Notes for Phase 4 / Residual Risk

- This plan de-risks ECHO-01 (owned/delivered in Phase 4) but owns no requirement.
- The kept delivery wiring (bridge fields + channels) is the Phase 4 starting seam; the synthetic generator + spike logging are throwaway.
- Named residual risk (per CONTEXT, NOT proven here): the main→renderer PCM transport (MessagePort / transferable `ArrayBuffer` chunks) — Phase 4 must use chunked transferables, never per-frame `ipcRenderer.send`.

## Commits

- `0708ee7` feat(03-01): add screenshare-debug.log writer + delivery-spike gate getter
- `6aa4b37` feat(03-01): expose deliverySpike gate + appendScreenshareDebug over goofcord bridge

## Self-Check: PASSED

- FOUND: src/modules/screenshareDebug.ts
- FOUND: src/windows/main/preload/bridge.ts (deliverySpike + appendScreenshareDebug fields)
- FOUND: src/ipc/gen.ts (both channels), src/ipc/types.ts (both channels)
- FOUND commit: 0708ee7
- FOUND commit: 6aa4b37
