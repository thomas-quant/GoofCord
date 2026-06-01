# Phase 3: Delivery-Path Spike — PCM → MediaStream (GO/NO-GO) - Pattern Map

**Mapped:** 2026-06-01
**Files analyzed:** 5 change sites (1 new main module, 2 preload edits, 1 new renderer spike module, 1 swap-seam reuse) + 1 build-time codegen rerun
**Analogs found:** 5 / 5 (all have a concrete in-repo precedent)

> This is a **renderer-only, env-gated, throwaway-where-possible SPIKE**. Every change site below has a real GoofCord analog to copy from — the spike is *wiring*, not invention. The one hard CI-packaging constraint (RESEARCH §Pitfall 1): the renderer spike code must ride in the **packaged main-preload bundle** (`ts-out/**`), NOT in `postVencord.js` (downloaded from upstream `main` at runtime — would silently not ship). The swap-seam at `screensharePatch.ts:79-84` is the *pattern to copy*, but the spike's copy of it must execute from preload-injected main-world code.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/modules/screenshareDebug.ts` (NEW) | service (main, fs writer) | file-I/O (append) | `src/utils.ts` `saveFileToGCFolder` (L116-120) | exact (role + flow) |
| env-gate getter — add to a main module (e.g. `screenshareDebug.ts` or `utils.ts`) | utility (main, `<IPCOn>` getter) | request-response (sync sendSync) | `src/utils.ts` `getVersion<IPCOn>` (L33-35) + `patchcord.ts` `--no-patchcord` (L42) | exact |
| `src/windows/main/preload/bridge.ts` (MODIFY) | preload (contextBridge) | request-response | existing `api` fields: `version` (L29), `stopPatchcord` (L44) | exact (same file) |
| Spike renderer module (NEW, preload-injected main-world script) | renderer (media reconstruction + injection + getStats) | streaming (in-renderer feed) + event-driven (STREAM_CLOSE) | `src/windows/main/renderer/postVencord/screensharePatch.ts` (whole file); `preVencord/domOptimizer.ts` (prototype monkeypatch) | role-match + pattern-match |
| swap-seam reuse (the spike's `addTrack` block) | renderer | transform (track swap) | `screensharePatch.ts:79-84` (stop/removeTrack/addTrack) | exact (the named seam) |
| `src/ipc/gen.ts` + `src/ipc/types.ts` (REGENERATED, never hand-edited) | codegen output | build | existing entries (e.g. `utils:saveFileToGCFolder`, `gen.ts:41`) | n/a — run `bun run build --onlyGenerators` |

**Injection-host decision the planner must lock (RESEARCH A3/Q2):** the spike's main-world renderer code ships via the preload. Two viable hosts, both already proven in-repo:
- **(preferred) `webFrame.executeJavaScript(content)`** — exactly how `assets.ts:loadScripts()` (L21-24, 33, 44, 51-55) already injects downloaded scripts into the page's main world from the sandboxed preload. The spike string can be a bundled `with { type: "text" }` import (like `discord.css` in `assets.ts:10`).
- inline preload module imported from `preload.mts` (L1-7) — but preload runs in an isolated world; reaching the page's `RTCPeerConnection`/`navigator.mediaDevices` from there is the unverified path (A3). `webFrame.executeJavaScript` is the de-risked choice.

---

## Pattern Assignments

### `src/modules/screenshareDebug.ts` (NEW — main, file-I/O append) + its IPC channel

**Analog:** `src/utils.ts` `saveFileToGCFolder<IPCHandle>` (L116-120) — the exact `<IPCHandle>` + `fs.promises` writer pattern. Channel naming is `module:functionName` (filename stem → channel prefix), so a file named `screenshareDebug.ts` yields channel `screenshareDebug:appendScreenshareDebug`.

**Writer pattern to copy** (`src/utils.ts:116-120`):
```typescript
export async function saveFileToGCFolder<IPCHandle>(filePath: string, content: string | Buffer<ArrayBuffer>) {
	const fullPath = path.join(getGoofCordFolderPath(), filePath);
	await fs.promises.writeFile(fullPath, content);
	return fullPath;
}
```

**Path root** — RESEARCH says use userData *root*, not the `GoofCord/` subfolder. `userDataPath` is already exported (`src/utils.ts:31`):
```typescript
export const userDataPath = app.getPath("userData");   // utils.ts:31  ← log root
// getGoofCordFolderPath() = path.join(userDataPath, "/GoofCord/")  (utils.ts:41-43) ← the subfolder saveFileToGCFolder uses; spike does NOT use this
```

**Concrete new module shape** (copy `saveFileToGCFolder`'s `<IPCHandle>` + `fs.promises` form; swap `writeFile`→`appendFile`, root→`userDataPath`):
```typescript
import fs from "node:fs";
import path from "node:path";
import { userDataPath } from "../utils.ts";          // utils.ts:31

const LOG = path.join(userDataPath, "screenshare-debug.log");

export async function appendScreenshareDebug<IPCHandle>(line: string) {
	await fs.promises.appendFile(LOG, `${new Date().toISOString()} ${line}\n`);
}
```
> Channel produced by codegen: `screenshareDebug:appendScreenshareDebug` (verify shape against `gen.ts:41` `utils:saveFileToGCFolder`). No `screenshare-debug.log` writer exists yet (grep empty) — the spike ADDS it; there is no Phase 1 channel to reuse.

**Error handling note:** the analog does not wrap in try/catch (lets the `<IPCHandle>` promise reject, surfacing over IPC). Match that — keep it minimal for throwaway code. If swallowing is wanted, mirror `patchcord.ts`'s `.catch(() => {})` idiom (L165).

---

### Env-gate getter (`<IPCOn>`) — main side

**Analog (gate VALUE channel):** `src/utils.ts` `getVersion<IPCOn>` (L33-35) — the exact sync getter shape that `bridge.ts` reads via `sendSync`.
```typescript
export function getVersion<IPCOn>() {        // utils.ts:33-35
	return packageVersion;
}
```
Codegen emits (`gen.ts:39`): `ipcMain.on("utils:getVersion", (event) => { event.returnValue = ___utils_getVersion(); });`

**Analog (env/flag READ precedent):** `--no-patchcord` (`patchcord.ts:42`) and `--no-venbind` (`venbind.ts:20`) — `process.argv.includes(...)`; plus `GOOFCORD_*_PATH` env vars in `build/build.ts:177,185`. Mirror BOTH an env var and an argv flag exactly like RESEARCH §Env-gate prescribes:
```typescript
// patchcord.ts:42 precedent — argv flag check in main:
if (patchbay || process.argv.includes("--no-patchcord")) return;
// venbind.ts:20 precedent:
... || process.argv.some((arg) => arg === "--no-venbind") || ...
// build.ts:177 precedent — env var read in main:
envPath: process.env.GOOFCORD_PATCHCORD_PATH,
```

**Concrete spike getter** (add to `screenshareDebug.ts` or `utils.ts`; `<IPCOn>` so the bridge can `sendSync` it like `version`):
```typescript
export function isDeliverySpikeEnabled<IPCOn>() {
	return process.env.GOOFCORD_DELIVERY_SPIKE === "1" || process.argv.includes("--delivery-spike");
}
```
> Use `<IPCOn>` (sync) NOT `<IPCHandle>` — the bridge reads it synchronously at module-eval time (`bridge.ts:29` `version: sendSync(...)`). `process.env` is readable ONLY in main; the sandboxed renderer has none (RESEARCH §anti-pattern). Channel will be `screenshareDebug:isDeliverySpikeEnabled` (or `utils:isDeliverySpikeEnabled` if placed in utils.ts).

---

### `src/windows/main/preload/bridge.ts` (MODIFY — add 2 fields)

**Analog:** the same file's existing `api` object. Two precedents in one file:
- a `sendSync` value field — `version` (L29) / `displayVersion` (L30)
- an `invoke` method field — `stopPatchcord` (L44)

```typescript
// bridge.ts:29-30 — sync value field precedent (read once at eval):
version: sendSync("utils:getVersion"),
displayVersion: sendSync("utils:getDisplayVersion"),
// bridge.ts:44 — invoke method precedent:
stopPatchcord: () => invoke("patchcord:stopPatchcord"),
```

**Concrete additions to the `api` object** (`bridge.ts:13-48`):
```typescript
deliverySpike: sendSync("screenshareDebug:isDeliverySpikeEnabled"),               // bool, like `version`
appendScreenshareDebug: (line: string) => invoke("screenshareDebug:appendScreenshareDebug", line),  // like `stopPatchcord`
```
> Imports already present in bridge.ts: `invoke, sendSync` from `../../../ipc/client.preload.ts` (L4). After editing, run `bun run build --onlyGenerators` so `types.ts` knows the new channels (otherwise `sendSync(...)`/`invoke(...)` are type errors). The renderer reaches these via `window.goofcord.deliverySpike` / `window.goofcord.appendScreenshareDebug(...)` — note `GoofCord` is aliased to `window.goofcord` in `postVencord.ts:11-13`, but preload-injected main-world code must reference `window.goofcord` directly unless that alias is guaranteed loaded.

---

### Spike renderer module (NEW — media reconstruction + injection + getStats poll)

**Primary analog (the seam + getDisplayMedia wrap + STREAM_CLOSE teardown):** `src/windows/main/renderer/postVencord/screensharePatch.ts` (whole file). This is the file whose seam the spike reuses, and whose `getDisplayMedia`-monkeypatch + teardown structure the spike mirrors.

**Secondary analog (prototype monkeypatch shape for `RTCPeerConnection.addTrack`):** `src/windows/main/renderer/preVencord/domOptimizer.ts:4-21` — the canonical "save orig, wrap, reassign prototype method" pattern in this codebase.

**(a) getDisplayMedia wrap to copy** (`screensharePatch.ts:1-2, 22-25, 87-88`):
```typescript
const original = navigator.mediaDevices.getDisplayMedia;            // L2
navigator.mediaDevices.getDisplayMedia = async function (opts) {    // L22
	let stream: MediaStream;
	try { stream = await original.call(this, opts); } catch { /* ... */ }
	// ... spike: if (window.goofcord.deliverySpike) swap in synthetic track ...
	return stream;                                                  // L87
};
```

**(b) SWAP SEAM — the exact block to reuse behind the spike flag** (`screensharePatch.ts:79-84`):
```typescript
for (const t of stream.getAudioTracks()) {
	t.stop();
	stream.removeTrack(t);
}
stream.addTrack(audio.getAudioTracks()[0]);   // spike replaces `audio.getAudioTracks()[0]` with the reconstructed synthetic track
```
> This is the SAME seam patchcord uses (L63-85). The spike's only change: source the added track from the synthetic MSTG/Web-Audio reconstruction instead of `getUserMedia`. Keep it behind `if (window.goofcord.deliverySpike)` so the normal `"loopback"` path (untouched in `screenshare.ts:98`) stays byte-identical when off.

**(c) STREAM_CLOSE teardown hook to copy** (`screensharePatch.ts:90-104`):
```typescript
Common.FluxDispatcher.subscribe("STREAM_CLOSE", ({ streamKey }: { streamKey: string }) => {
	const owner = streamKey.split(":").at(-1);
	if (owner !== Common.UserStore.getCurrentUser().id) return;
	// existing: void GoofCord.stopVenmic() / void GoofCord.stopPatchcord();
	// spike: stop oscillator / ctx.close() / writer.releaseLock() / clearInterval(feedTimer) / clearInterval(statsTimer)
});
```
> RESEARCH §Pitfall 5: the spike MUST clear BOTH its feed `setInterval` and its getStats `setInterval` here, and tear down the AudioContext/MSTG writer — mirror how this block already calls `stopVenmic`/`stopPatchcord`. NOTE: `Common.FluxDispatcher`/`Common.UserStore` come from Vencord's webpack (postVencord context). Preload-injected main-world code may not have `Common` — the planner should confirm availability or use a plainer teardown trigger (e.g. `track.onended`) in the injected variant.

**(d) `RTCPeerConnection.prototype.addTrack` monkeypatch — shape to copy** from `domOptimizer.ts:4-21` (save orig → wrap → reassign):
```typescript
// domOptimizer.ts:21 precedent:  Element.prototype.removeChild = optimize(Element.prototype.removeChild);
// spike (RESEARCH Pattern 2):
const audioSenders = new Set<RTCRtpSender>();
const origAddTrack = RTCPeerConnection.prototype.addTrack;
RTCPeerConnection.prototype.addTrack = function (track: MediaStreamTrack, ...streams: MediaStream[]) {
	const sender = origAddTrack.call(this, track, ...streams);
	if (track.kind === "audio") audioSenders.add(sender);
	return sender;
};
```

**(e) reconstruction (MSTG probe → Web Audio fallback) + getStats poll:** no in-repo analog — these are Chromium web APIs. Copy verbatim from RESEARCH §Pattern 1 (L164-215), §Pattern 3 (L239-254). The spike-specific logging goes through `window.goofcord.appendScreenshareDebug(...)` (the new bridge method above).

---

## Shared Patterns

### IPC handler registration (codegen, never hand-edit)
**Source:** `src/utils.ts` (`<IPCHandle>`/`<IPCOn>` annotations) → `src/ipc/gen.ts` (generated) → `src/ipc/registry.main.ts` (runtime registration).
**Apply to:** the new `appendScreenshareDebug<IPCHandle>` and `isDeliverySpikeEnabled<IPCOn>`.
**Mechanics:**
- Annotate the exported function with a phantom generic: `<IPCHandle>` → `ipcMain.handle` (async, `invoke`); `<IPCOn>` → `ipcMain.on` (sync, `event.returnValue`, `sendSync`).
- Channel name = `<fileStem>:<functionName>` (e.g. `screenshareDebug:appendScreenshareDebug`). Confirmed by every line in `gen.ts:19-43`.
- After adding/removing annotated functions, run **`bun run build --onlyGenerators`** to regenerate `gen.ts`+`types.ts`. NEVER hand-edit them (CLAUDE.md anti-pattern; RESEARCH §anti-pattern L263).
```typescript
// gen.ts:41 — what codegen will emit for the new handler (model):
ipcMain.handle("utils:saveFileToGCFolder", async (event, filePath, content) => { return await ___utils_saveFileToGCFolder(filePath, content); });
// gen.ts:39 — model for the new <IPCOn> getter:
ipcMain.on("utils:getVersion", (event) => { event.returnValue = ___utils_getVersion(); });
```

### Preload → renderer value/method bridge (`goofcord` contextBridge)
**Source:** `src/windows/main/preload/bridge.ts` (`contextBridge.exposeInMainWorld("goofcord", api)`, L50).
**Apply to:** both spike additions (gate bool + log method).
**Pattern:** sync values use `sendSync("<channel>")` evaluated once (L29); async actions use `() => invoke("<channel>", ...args)` (L44). The renderer reads `window.goofcord.<field>`.

### Main-world script injection from sandboxed preload
**Source:** `src/windows/main/preload/assets.ts` `loadScripts()` — `webFrame.executeJavaScript(content)` (L21-24, 33, 44, 51-55), with a `with { type: "text" }` bundled-string import precedent (`discord.css`, L10).
**Apply to:** shipping the spike renderer module into the page's main world (the CI-packaging fix — it lands in `ts-out/**` via the preload, not in the downloaded `postVencord.js`).

### Env/flag gate (off-by-default, `GOOFCORD_*` precedent)
**Source:** `patchcord.ts:42` (`process.argv.includes("--no-patchcord")`), `venbind.ts:20` (`--no-venbind`), `build.ts:177,185` (`process.env.GOOFCORD_*_PATH`).
**Apply to:** `isDeliverySpikeEnabled` — read env+argv in MAIN only, forward via bridge. Dormant by default so the artifact ships clean and toggles without rebuild (CONTEXT scaffolding decision).

### Exactly-once teardown / no-leak (process-isolation invariant)
**Source:** `screenshare.ts:24-34` `finishRequest` (do NOT disturb — Phase 1 invariant); `patchcord.ts:151-166` `stopPatchcord` (clearInterval/clearTimeout + dispose).
**Apply to:** the spike's STREAM_CLOSE teardown — clear both `setInterval`s, stop oscillator/close AudioContext/release MSTG writer.

---

## No Analog Found

| Concern | Role | Data Flow | Reason — use RESEARCH instead |
|---------|------|-----------|-------------------------------|
| `MediaStreamTrackGenerator` probe + `AudioData` feed | renderer | streaming | No web-media-reconstruction code in repo. Copy RESEARCH §Pattern 1 (L164-215) verbatim. |
| `AudioContext → OscillatorNode → MediaStreamAudioDestinationNode` fallback | renderer | streaming | No Web Audio usage in repo. Copy RESEARCH §Pattern 1 fallback (L202-214). |
| `RTCRtpSender.getStats()` outbound-rtp/audio poll | renderer | request-response (poll) | No WebRTC stats code in repo. Copy RESEARCH §Pattern 3 (L239-254). |
| main→renderer PCM transport | — | streaming | **OUT OF SCOPE** — renderer-only spike; named Phase 4 residual risk (CONTEXT L26-28). Do NOT build. |

> The `RTCPeerConnection.prototype.addTrack` monkeypatch DOES have a structural analog (`domOptimizer.ts:21`), even though `RTCPeerConnection` itself appears nowhere — copy the save-orig/wrap/reassign shape from there.

---

## Metadata

**Analog search scope:** `src/windows/main/renderer/{preVencord,postVencord}/`, `src/windows/main/preload/`, `src/windows/screenshare/`, `src/modules/native/`, `src/ipc/`, `src/utils.ts`, `build/build.ts`.
**Files scanned:** 12 read in full/targeted + 3 grep sweeps (monkeypatch precedents, env-override usage, IPC channel shapes).
**Pattern extraction date:** 2026-06-01

---

## PATTERN MAPPING COMPLETE

**Phase:** 3 - Delivery-Path Spike — PCM → MediaStream (GO/NO-GO)
**Files classified:** 5 change sites + 1 codegen rerun
**Analogs found:** 5 / 5

### Coverage
- Files with exact analog: 4 (log writer, env getter, bridge fields, swap-seam)
- Files with role-match / structural analog: 1 (spike renderer module — seam + STREAM_CLOSE + addTrack monkeypatch have analogs; the pure web-media APIs do not)
- Concerns with no analog (use RESEARCH): 3 (MSTG/AudioData, Web Audio fallback, getStats poll)

### Key Patterns Identified
- **IPC is codegen-driven:** annotate `<IPCHandle>`/`<IPCOn>`, channel = `<fileStem>:<fn>`, then `bun run build --onlyGenerators` — NEVER hand-edit `gen.ts`/`types.ts`. New log channel mirrors `utils.ts:saveFileToGCFolder` exactly (`gen.ts:41`).
- **Gate flows main→renderer via the `goofcord` bridge:** `process.env`/`process.argv` read in MAIN (mirror `--no-patchcord` `patchcord.ts:42`), exposed as a `sendSync` bool field on `bridge.ts`'s `api` (like `version` L29).
- **The spike code must ship in the packaged preload bundle and inject to main-world via `webFrame.executeJavaScript`** (`assets.ts:loadScripts`), NOT live in the runtime-downloaded `postVencord.js` (CI-packaging pitfall).
- **The swap seam is `screensharePatch.ts:79-84` verbatim** (stop/removeTrack/addTrack) and teardown is the `STREAM_CLOSE` subscribe at L90-104; the `RTCPeerConnection.prototype.addTrack` wrap copies the prototype-monkeypatch shape from `domOptimizer.ts:21`.
- **Off-by-default + exactly-once teardown** are existing invariants (`screenshare.ts:finishRequest`, `patchcord.ts:stopPatchcord`) the spike must preserve, not disturb.

### File Created
`.planning/phases/03-delivery-path-spike-pcm-mediastream-go-no-go/03-PATTERNS.md`

### Ready for Planning
Pattern mapping complete. The planner can name concrete identifiers in `<action>` blocks: `appendScreenshareDebug<IPCHandle>` / channel `screenshareDebug:appendScreenshareDebug`, `isDeliverySpikeEnabled<IPCOn>`, bridge fields `deliverySpike` + `appendScreenshareDebug`, the `screensharePatch.ts:79-84` swap block, the `STREAM_CLOSE` teardown at L90-104, the `domOptimizer.ts:21` monkeypatch shape, `webFrame.executeJavaScript` injection from `assets.ts`, and the `--no-patchcord`/`GOOFCORD_*_PATH` env-gate precedent — plus the mandatory `bun run build --onlyGenerators` step.
