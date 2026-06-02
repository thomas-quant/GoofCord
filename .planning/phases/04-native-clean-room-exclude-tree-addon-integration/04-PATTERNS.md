# Phase 04: Native Clean-Room Exclude-Tree Addon + Integration - Pattern Map

**Mapped:** 2026-06-02
**Files analyzed:** 8 (1 new TS wrapper, 5 modified TS/preload/build, 1 modified CI, 1 new Rust crate)
**Analogs found:** 7 / 8 (the Rust crate has no in-repo analog — its JS-side consumption precedent is venbind/patchcord)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/modules/native/wasapiLoopback.ts` (NEW) | native-module wrapper (main) | streaming (PCM push) | `src/modules/native/venbind.ts` (`.node` load + threadsafe callback) + `src/modules/native/patchcord.ts` (`getAppMetrics()` PID, `start`/`stop`/`before-quit` lifecycle) | exact (composite) |
| `src/windows/screenshare/screenshare.ts` (MODIFY) | controller / dispatch gate (main) | request-response → branch | self (lines 90-100, existing 2-way gate) + `patchcord.ts` start fns | exact (in-place additive `else if`) |
| `src/windows/main/renderer/postVencord/screensharePatch.ts` (MODIFY) | renderer feature hook (main world) | streaming consume + event-driven (STREAM_CLOSE) | self (swap seam L79-84, STREAM_CLOSE L90-104) + `deliverySpike.ts` `buildSyntheticAudioTrack()` MSTG feeder | exact (Phase 3 KEEP seed) |
| `src/windows/main/preload/preload.mts` + `bridge.ts` (MODIFY) | preload bridge (isolated world) | streaming forward (hop-2) | self (`injectDeliverySpike()` L29-40, `webFrame.executeJavaScript`) + `bridge.ts` `stopPatchcord` L44 | exact / role-match |
| `build/build.ts` `copyNativeModules()` (MODIFY) | build config | file-I/O (copy) | self (lines 174-193 `modules[]`, env-override branch 204-218) | exact (add one `modules[]` entry) |
| `build/nativeImport.ts` `nativeModulePlugin` (NO EDIT — glob auto-matches) | build plugin | transform (resolve) | self (substring `win32`+`x64` match L37-40) | exact (matches by import path only) |
| `.github/workflows/testBuild.yml` (MODIFY) | CI config | batch | self (existing single-job win build) | role-match (add Rust build step + packaging assertion) |
| Rust crate `src/lib.rs` + `Cargo.toml` (NEW, sibling/in-repo) | native addon (Rust) | streaming (WASAPI capture loop) | NO in-repo analog (venbind/patchcord are consumed prebuilt, sources live elsewhere) | none — use RESEARCH §Code Examples + MS sample |

## Pattern Assignments

### `src/modules/native/wasapiLoopback.ts` (NEW — native-module wrapper, streaming)

**Primary analog:** `src/modules/native/venbind.ts` (whole file, 51 lines)
**Secondary analog:** `src/modules/native/patchcord.ts` (PID resolution L80; stop + before-quit L151-184)

**`.node` load pattern — copy from `venbind.ts:1-31`:**
```typescript
// @ts-nocheck Bun will not install <addon> on macOS/linux, so typescript won't compile with checks
import { createRequire } from "node:module";
// @ts-expect-error
import venbindPath from "native-module:../../../assets/native/venbind-*.node";
import pc from "picocolors";

const require = createRequire(import.meta.url);

let venbind: VenbindType | undefined;
let venbindLoadAttempted = false;

export async function obtainVenbind() {
	if (venbind !== undefined || process.argv.some((arg) => arg === "--no-venbind") || venbindLoadAttempted || !venbindPath) return venbind;
	try {
		venbind = require(venbindPath);
		if (!venbind) throw new Error("Venbind is undefined");
		await startVenbind(venbind);
		console.log(pc.green("[Venbind]"), "Loaded venbind");
	} catch (e: unknown) {
		console.error("Failed to import venbind", e);
	}
	venbindLoadAttempted = true;
	return venbind;
}
```
**Divergences the new code MUST introduce (vs. venbind):**
- Import glob becomes `native-module:../../../assets/native/wasapi-loopback-*.node` (the `*` is what the glob plugin matches on `win32`+`x64` — name must contain BOTH substrings; see `nativeImport.ts` below).
- Guard arg `--no-wasapi` (mirrors `--no-venbind`); env override `GOOFCORD_WASAPI_LOOPBACK_PATH` (mirrors `GOOFCORD_VENBIND_PATH`, consumed by `build.ts`, NOT read at runtime here — the glob resolves the copied file).
- LOG_PREFIX `pc.green("[WASAPI]")` or `pc.cyan("[Screenshare]")` (match `patchcord.ts`'s `pc.cyan("[Screenshare]")` since this is a screenshare feature).
- The threadsafe callback ships PCM over a `MessagePortMain`, NOT `mainWindow.webContents.send(...)` (venbind's `startKeybinds` callback at L37-40 sends over a named IPC channel — this is the locked anti-pattern for PCM; T2). See Hop-1 below.

**PID resolution — copy from `patchcord.ts:80`:**
```typescript
const audioPid = app.getAppMetrics().find((p) => p.name === "Audio Service")?.pid;
```
**Divergence:** new code resolves the EXCLUDE-tree ROOT (`process.pid` — the Electron main process) and passes THAT to the addon; the Audio Service PID is logged (not passed) for verification (ECHO-02). Per RESEARCH §Code Examples (L423-435):
```typescript
const rootPid = process.pid; // Electron MAIN process — the tree root
const metrics = app.getAppMetrics();
const audioService = metrics.find((p) => p.name === "Audio Service");
void appendScreenshareDebug(
	`wasapi exclude-root=${rootPid} audioService=${audioService?.pid ?? "not-found"} ` +
	`procs=${metrics.map((p) => `${p.name}:${p.pid}`).join(",")}`,
);
```

**Hop-1 transport — `MessageChannelMain` + `webContents.postMessage` (NEW, no in-repo analog; from RESEARCH §Pattern 1 L251-266):**
```typescript
import { MessageChannelMain } from "electron";
import { mainWindow } from "../../windows/main/main.ts"; // same import venbind.ts:12 uses

const { port1, port2 } = new MessageChannelMain();
mainWindow.webContents.postMessage("wasapi:pcm-port", null, [port2]);
port1.start();

function onPcmChunk(buf: ArrayBuffer) {
	port1.postMessage(buf, [buf]); // [buf] = transfer list → zero-copy
}
```
> Note: `mainWindow` is a module-level export from `src/windows/main/main.ts` (undefined until `createMainWindow()` resolves — ARCHITECTURE anti-pattern). venbind.ts:12,39 already imports + uses it this way; safe at stream-start time.

**stop / teardown lifecycle — copy from `patchcord.ts:151-184`:**
```typescript
export async function stopPatchcord<IPCHandler>() {
	const pb = patchbay;
	if (!pb) return;
	// ... null-out state, clear timers ...
	await pb.dispose().catch(() => {});
}

app.on("before-quit", (event) => {
	const pb = patchbay;
	if (!pb) return;
	event.preventDefault();
	patchbay = undefined;
	Promise.race([
		pb.dispose(),
		new Promise((resolve) => setTimeout(resolve, 1500))
	]).catch(/*...*/).finally(() => app.quit());
});
```
**Divergence:** `stopWasapiLoopback()` calls `addon.stop()` + closes `port1`; mirror the `Promise.race([dispose, timeout])` so a hung native stop can't wedge quit (RESEARCH Pitfall 4). Make stop idempotent (composes with `screenshare.ts`'s single-owner `finishRequest`).

**IPC handle marker:** export functions intended as IPC handlers with the `<IPCHandle>` / `<IPCHandler>` generic param marker (e.g. `export async function stopWasapiLoopback<IPCHandle>()` — channel becomes `wasapiLoopback:stopWasapiLoopback`). After adding/removing such functions, run `bun run build --onlyGenerators`; NEVER hand-edit `src/ipc/gen.ts` / `types.ts`. Precedent: `patchcord.ts:151` `stopPatchcord<IPCHandler>` → wired in `gen.ts:32`.

---

### `src/windows/screenshare/screenshare.ts` (MODIFY — dispatch gate, request-response)

**Analog:** self — the existing 2-way gate at lines 90-100. Add a Windows `else if` between the Linux and `"loopback"` branches.

**Current code (lines 90-100):**
```typescript
if (audioConfig.mode !== "none") {
	if (hasPipewirePulse && process.platform === "linux") {
		try {
			await (audioConfig.mode === "system" ? patchcordStartSystem : patchcordStartApp)(audioConfig.pids);
		} catch (err) {
			console.error("[Screenshare] Failed to start patchcord node:", err);
		}
	} else {
		result.audio = "loopback";
	}
}
```

**Target shape (RESEARCH §Pattern 4 L330-344) — additive `else if`, Linux branch BYTE-IDENTICAL:**
```typescript
if (audioConfig.mode !== "none") {
	if (hasPipewirePulse && process.platform === "linux") {
		// UNCHANGED Linux patchcord branch
		try {
			await (audioConfig.mode === "system" ? patchcordStartSystem : patchcordStartApp)(audioConfig.pids);
		} catch (err) {
			console.error("[Screenshare] Failed to start patchcord node:", err);
		}
	} else if (process.platform === "win32" && (await tryStartWasapiLoopback())) {
		// NEW: native EXCLUDE-tree started; renderer swaps the track in.
		result.audio = "loopback"; // RECOMMENDED: still request loopback so the renderer's swap seam
		                           // (stop/remove → addTrack) is identical to Phase 3 / patchcord (A3 — confirm in spike)
	} else {
		result.audio = "loopback"; // UNCHANGED universal fallback (macOS, pre-2004 Win, load/activation failure)
	}
}
```
**Import to add:** `import { tryStartWasapiLoopback } from "@root/src/modules/native/wasapiLoopback.ts";` (mirror the `patchcord.ts` import at L3, `.ts` extension required, `@root/*` alias).
**Constraint:** the Linux branch and the universal `"loopback"` fallback must remain unchanged (ECHO-03, RESEARCH anti-pattern: do not refactor into a "shared" abstraction).

---

### `src/windows/main/renderer/postVencord/screensharePatch.ts` (MODIFY — renderer hook, streaming + event-driven)

**Analogs:** self (swap seam L79-84, STREAM_CLOSE L90-104) + `deliverySpike.ts:78-129` (the KEEP MSTG feeder — replace synthetic samples with MessagePort-delivered chunks).

**Swap-seam pattern — copy from `screensharePatch.ts:79-84` (the existing patchcord path):**
```typescript
for (const t of stream.getAudioTracks()) {
	t.stop();
	stream.removeTrack(t);
}
stream.addTrack(audio.getAudioTracks()[0]); // ← replace with the MSTG-reconstructed track
```

**MSTG feeder fed from a MessagePort — adapt `deliverySpike.ts:93-129` (Phase 3 KEEP seed); RESEARCH L513-528:**
```javascript
const gen = new MediaStreamTrackGenerator({ kind: "audio" });
const writer = gen.writable.getWriter();
let tsUs = 0;
const SAMPLE_RATE = 48000, CHANNELS = 2, FRAMES = 480;
function feedRing(ab /* ArrayBuffer of 480*2 interleaved f32 */) {
	const data = new Float32Array(ab);
	const ad = new AudioData({ format: "f32", sampleRate: SAMPLE_RATE, numberOfFrames: FRAMES,
		numberOfChannels: CHANNELS, timestamp: tsUs, data });
	tsUs += Math.round((FRAMES / SAMPLE_RATE) * 1e6); // monotonic µs — else frames garble
	void writer.write(ad);
}
```
**Divergences:** the synthetic `makeDistinctiveSample()` loop (deliverySpike.ts:85-126) is THROWAWAY — feed real PCM from the hop-2 `MessagePort.onmessage`. Add the bounded ring (T4: ~3-5 chunk / ~30-50ms depth, drop-oldest on overflow, zero-filled `AudioData` on underrun — RESEARCH L531). The MSTG/AudioData/monotonic-µs shape is IDENTICAL to the spike.

**STREAM_CLOSE teardown — copy from `screensharePatch.ts:90-104`:**
```typescript
Common.FluxDispatcher.subscribe("STREAM_CLOSE", ({ streamKey }: { streamKey: string }) => {
	const owner = streamKey.split(":").at(-1);
	if (owner !== Common.UserStore.getCurrentUser().id) return;
	if (GoofCord.stopVenmic) { void GoofCord.stopVenmic(); }
	else { void GoofCord.stopPatchcord(); }
});
```
**Divergence:** add a `void GoofCord.stopWasapiLoopback();` arm (Windows native path) alongside the patchcord arm; tear down the MSTG writer + port. NOTE: this file runs in the page MAIN WORLD where `Common`/`Vencord` exist — but the port arrives via the preload→main-world forward (hop-2), so the feeder/port wiring may live in the injected main-world script (see preload below), with this file owning the swap + STREAM_CLOSE.

---

### `src/windows/main/preload/preload.mts` + `bridge.ts` (MODIFY — preload bridge, hop-2 forward)

**Analog:** self — `injectDeliverySpike()` (preload.mts:29-40) shows the gated `webFrame.executeJavaScript(mainWorldSourceString)` injection; `bridge.ts:44-47` shows adding a `goofcord` API method + the spike's debug bridge.

**Main-world injection pattern — copy from `preload.mts:32-40`:**
```typescript
function injectDeliverySpike() {
	if (!sendSync("screenshareDebug:isDeliverySpikeEnabled")) return; // gate
	webFrame.executeJavaScript(spikeMainWorldSource)
		.then(() => log("Loaded Delivery Spike"))
		.catch((err) => error(`Failed Delivery Spike: ${err}`));
}
```

**Hop-2 port-forward — NEW (RESEARCH §Pattern 2 L271-294), DEFAULT mechanism:**
```typescript
// In preload.mts (isolated world):
import { ipcRenderer } from "electron";
ipcRenderer.on("wasapi:pcm-port", (event) => {
	const [port] = event.ports; // native DOM MessagePort in the isolated world
	// MUST hold until the main world signals ready (readiness handshake — Pitfall 1), then:
	window.postMessage("goofcord:wasapi-pcm-port", "*", [port]); // zero-copy port→port forward
});
```
```javascript
// In the main-world injected script (webFrame.executeJavaScript string — mirrors deliverySpike's spikeMainWorldSource):
window.addEventListener("message", (e) => {
	if (e.data !== "goofcord:wasapi-pcm-port") return;
	const port = e.ports[0];
	port.onmessage = (msg) => feedRing(msg.data);
	port.start();
});
// main world must FIRST post: window.postMessage("goofcord:wasapi-ready","*"); preload waits on it.
```
**Critical (Pitfall 1, load-bearing):** the `executeJavaScript`-injected main world registers its listener AFTER the preload runs → readiness handshake required. Main world posts `goofcord:wasapi-ready`; preload buffers the port until it sees that, then forwards. Log the outcome to `screenshare-debug.log` (`hop2=port-forward ready-handshake ok` vs `hop2=contextBridge-fallback`).

**Fallback hop-2 — contextBridge callback (use `bridge.ts` shape):** if MessagePort transfer into the injected main world fails on Electron 41.3.0, land PCM in the preload and invoke a main-world callback via the `goofcord` contextBridge (structured-clone each chunk). Add the method on the `api` object in `bridge.ts:13-51` (mirror `appendScreenshareDebug` L47).

**bridge.ts addition — mirror `stopPatchcord` (bridge.ts:44):**
```typescript
stopPatchcord: () => invoke("patchcord:stopPatchcord"),
// ADD:
stopWasapiLoopback: () => invoke("wasapiLoopback:stopWasapiLoopback"),
```
> `GoofCord.stopWasapiLoopback()` is then callable from the main-world `screensharePatch.ts` STREAM_CLOSE handler (same way `GoofCord.stopPatchcord()` is, screensharePatch.ts:102).

---

### `build/build.ts` `copyNativeModules()` (MODIFY — build config, file-I/O)

**Analog:** self — the `modules[]` array (L174-193) and the `envPath` override branch (L204-218).

**Add a third `modules[]` entry — mirror `venbind` (build.ts:183-192):**
```typescript
{
	name: "wasapi-loopback",                                    // → dest `wasapi-loopback-<platform>-<arch>.node`
	envPath: process.env.GOOFCORD_WASAPI_LOOPBACK_PATH,         // mirrors GOOFCORD_VENBIND_PATH (L185)
	prebuilds: [
		{ src: ["wasapi-loopback", "prebuilds", "windows-x86_64", "wasapi-loopback-win32-x64.node"], platform: "win32", arch: "x64" },
	],
},
```
**Critical naming (Pitfall 3):** the env-override branch (L207) builds the dest filename as `${mod.name}-${platform}-${TARGET_ARCH}${ext}` → with `name: "wasapi-loopback"` on a win32/x64 build the output is `wasapi-loopback-win32-x64.node`, which contains BOTH `win32` AND `x64` substrings — exactly what `nativeModulePlugin` (nativeImport.ts:37-40) matches on. A name mismatch silently emits `export default null` → silent `"loopback"` fallback. Phase 4 uses the `envPath` branch (the `prebuilds` entry is for the eventual published-package path; harmless to include or omit for Phase 4).

---

### `build/nativeImport.ts` `nativeModulePlugin` (NO EDIT — auto-matches)

**Analog:** self. The plugin (L37-40) matches any file in the glob dir whose lowercased name contains BOTH `targetPlatform` and `targetArch`:
```typescript
const matchedFile = files.find((file) => {
	const lower = file.toLowerCase();
	return lower.includes(targetPlatform.toLowerCase()) && lower.includes(targetArch.toLowerCase());
});
```
**No code change required** — the new import `native-module:.../wasapi-loopback-*.node` in `wasapiLoopback.ts` resolves automatically once `copyNativeModules()` produces `wasapi-loopback-win32-x64.node`. (Listed here so the planner knows this stage is satisfied by naming alone.)

---

### `.github/workflows/testBuild.yml` (MODIFY — CI config, batch)

**Analog:** self — single `windows-latest` job (currently: checkout → setup-bun → setup-node 24.x → `bun install` → `bun add electron-builder -g` → `bun run build` → `electron-builder` → upload). No `.node` build step exists yet.

**Additions (RESEARCH Open Q1 resolution L592-598):**
1. Before `bun run build`: a `windows-latest`-only step installing Rust (`dtolnay/rust-toolchain@stable`) + `@napi-rs/cli`, running `napi build --release --target x86_64-pc-windows-msvc` in the addon crate dir.
2. Set `GOOFCORD_WASAPI_LOOPBACK_PATH` (env on the `bun run build` step) → the produced `.node`. `copyNativeModules()` honors it (build.ts:205-218).
3. Packaging assertion (Pitfall 3): a step asserting `wasapi-loopback-win32-x64.node` exists in the packaged output (e.g. a PowerShell/`dir` check on `ts-out/native/` or inside the unpacked `.zip`).
> electron-builder needs NO change: the `win` config `files: [...files, "!ts-out/native/*-linux-*.node"]` (electron-builder.ts:45) EXCLUDES Linux `.node`s only — win32 `.node`s in `ts-out/native/` are kept on Windows builds (the base `files` array includes `ts-out/**`). The `*-win32-*.node` name matches what's NOT excluded.

---

### Rust crate `src/lib.rs` + `Cargo.toml` (NEW — native addon, streaming) — NO in-repo analog

**No GoofCord source analog** — venbind/patchcord ship as prebuilt `.node`s; their Rust sources live in separate repos. Use RESEARCH §Code Examples directly:
- napi `ThreadsafeFunction` push loop (RESEARCH §Pattern 3 L299-323) — `NonBlocking` mode + bounded `MaxQueueSize` realizes the T4 drop-oldest policy at the FFI boundary.
- Hardcoded 48k/stereo/f32 `WAVEFORMATEXTENSIBLE` + `AUTOCONVERTPCM` (RESEARCH §Code Examples L439-471). Pass StreamFlags as the SECOND `Initialize` param (Pitfall 2 — MS sample bug #196).
- Dynamic `LoadLibrary`/`GetProcAddress` + try-activate-and-catch any non-`S_OK` (RESEARCH §Code Examples L474-489; no OS build gate — Pitfall: documented 20348 is wrong).
- Clean-room from MS `ApplicationLoopback` sample (MIT, retain notice) — NO Discord symbols (ECHO-04, Pitfall 6).
- Crate deps: `windows 0.62.2`, `napi 3.9.0`, `napi-derive 3.5.6`, `@napi-rs/cli 3.7.0` (RESEARCH Standard Stack L161-169). Built in the addon's own build, NOT GoofCord's Bun build.

## Shared Patterns

### Diagnostics → `screenshare-debug.log` (NEVER DevTools)
**Source:** `src/modules/screenshareDebug.ts` (whole file) — already wired as IPC (`gen.ts:34-35`, `types.ts:30,45`).
**Apply to:** `wasapiLoopback.ts` (activation result, excluded root PID, Audio Service PID, chunk count), the transport spike (hop-2 mechanism), the renderer feeder.
```typescript
export async function appendScreenshareDebug<IPCHandle>(line: string) {
	await fs.promises.appendFile(LOG, `${new Date().toISOString()} ${line}\n`);
}
export function isDeliverySpikeEnabled<IPCOn>() {
	return process.env.GOOFCORD_DELIVERY_SPIKE === "1" || process.argv.includes("--delivery-spike");
}
```
**Reuse:** main-side `import { appendScreenshareDebug } from "@root/src/modules/screenshareDebug.ts"`; renderer/main-world via `GoofCord.appendScreenshareDebug(line)` (bridge.ts:47). The env gate (`GOOFCORD_DELIVERY_SPIKE` / `--delivery-spike`) is the precedent for the transport-spike gate (T1). All of this is THROWAWAY (strip before the Phase 5 PR — file header L1-3 says so).
**Required log lines (ECHO-02/03):** `wasapi exclude-root=<pid> audioService=<pid> procs=<name:pid,...>` and `wasapi activation=<ok|unsupported> hop1=messageport hop2=<port-forward|contextBridge> chunks=<n>`.

### Error handling (catch `unknown` → `getErrorMessage`)
**Source:** `src/utils.ts:108` `getErrorMessage(error: unknown): string`.
**Apply to:** `wasapiLoopback.ts` start/stop try/catch — never crash, fall through to `"loopback"` (ECHO-03). Pattern (RESEARCH L501-504):
```typescript
} catch (e) {
	void appendScreenshareDebug(`wasapi start threw: ${getErrorMessage(e)}`);
	return false; // → "loopback" fallback
}
```
Fire-and-forget async uses `void` (per CLAUDE.md; see `void appendScreenshareDebug(...)`).

### `.node` consume pipeline (3-stage, name-matched)
**Sources:** `venbind.ts:7` (import glob) → `build.ts:174-218` (`copyNativeModules()` entry + env override) → `nativeImport.ts:37-40` (glob substring match) → `electron-builder.ts:45` (win build keeps win32 `.node`).
**Apply to:** all four must align on the EXACT name `wasapi-loopback-win32-x64.node`; add a startup null-check log (`wasapiPath resolved? <bool>`) and a CI packaging assertion (Pitfall 3 — a name mismatch is a SILENT failure).

### Native lifecycle (load-once flag, idempotent stop, before-quit race)
**Source:** `venbind.ts:16-31` (`loadAttempted` flag + `--no-` guard) + `patchcord.ts:151-184` (stop nulls state; `before-quit` `Promise.race([dispose, timeout])`).
**Apply to:** `wasapiLoopback.ts` — load-once + `--no-wasapi`; idempotent `stopWasapiLoopback()` that closes `port1` and calls `addon.stop()`; `before-quit` with a timeout race so a hung native stop can't wedge quit (Pitfall 4). Composes with `screenshare.ts:24-34` `finishRequest` single-owner teardown.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| Rust crate `src/lib.rs` + `Cargo.toml` | native addon (Rust) | streaming (WASAPI capture) | GoofCord consumes native addons as prebuilt `.node`s; venbind/patchcord Rust sources live in separate repos. Use RESEARCH §Code Examples (Patterns 3, format, dynamic-load) + the MS `ApplicationLoopback` MIT sample. |

Partial-analog files (no exact precedent for one sub-pattern, in-repo precedent for the surrounding shape):
- **Hop-1 `MessageChannelMain` / `webContents.postMessage`** — no existing GoofCord use of `MessageChannelMain`; closest is the `webFrame.executeJavaScript` main-world injection (preload.mts:36) and the `ipcRenderer.on(...)` event wiring (bridge.ts:26-27). Use RESEARCH §Pattern 1/2.
- **Hop-2 `window.postMessage(..., [port])` port forward** — no existing port-forward; the injection mechanism (preload.mts `injectDeliverySpike`) and the self-contained main-world source string (`deliverySpike.ts:287` `spikeMainWorldSource`) are the structural precedent.

## Metadata

**Analog search scope:** `src/modules/native/`, `src/windows/screenshare/`, `src/windows/main/renderer/postVencord/`, `src/windows/main/preload/`, `src/modules/`, `build/`, `.github/workflows/`, `src/ipc/`, `src/utils.ts`, `electron-builder.ts`.
**Files scanned (read in full or targeted):** `venbind.ts`, `patchcord.ts`, `screenshare.ts`, `screensharePatch.ts`, `preload.mts`, `bridge.ts`, `deliverySpike.ts`, `screenshareDebug.ts`, `build/build.ts` (L160-232), `build/nativeImport.ts`, `electron-builder.ts` (L20-99), `testBuild.yml`, plus `gen.ts`/`types.ts`/`utils.ts` greps.
**Pattern extraction date:** 2026-06-02
