// @ts-nocheck Bun won't install the wasapi-loopback addon on macOS/linux, so typescript can't compile with checks (mirror venbind.ts:1)

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — main-process wrapper for the Windows WASAPI EXCLUDE-tree echo fix (the #46 fix).
//
// Plan 04-03 (Slice 2, part 2): swap the Plan 01 SYNTHETIC tone for the REAL clean-room
// Plan 02 `.node` addon, KEEPING the exact MessageChannelMain transport proven GO in Plan 01
// (MessageChannelMain → webContents.postMessage → preload-injected MSTG feeder → viewer).
// The addon (native/wasapi-loopback) captures the full endpoint mix EXCEPT GoofCord's own
// process tree (the Audio Service child included via EXCLUDE_TARGET_PROCESS_TREE), so the
// viewer hears shared desktop audio but NOT the Discord call echoed back.
//
// Load model: the addon ships at ts-out/native/wasapi-loopback-<plat>-<arch>.node (placed there by
// build.ts via a HOST-AGNOSTIC fs copy — NOT Bun's `native-module:` file-loader, which silently
// fails to emit the .node when the BUILD HOST is Windows). createRequire + a --no-wasapi guard load
// it; the addon's `start(excludeRootPid, onChunk)` returns false (never throws) when the API is
// unavailable on this build → we fall through to Electron "loopback" (ECHO-03).
//
// Diagnostics → userData screenshare-debug.log (no DevTools on the Windows test box).
// On non-win32 / --no-wasapi / addon-not-loaded, tryStartWasapiLoopback returns false
// immediately so the normal "loopback" path stays byte-identical to upstream.
// ─────────────────────────────────────────────────────────────────────────────

import { appendFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { appendScreenshareDebug } from "@root/src/modules/screenshareDebug.ts";
import { getErrorMessage } from "@root/src/utils.ts";
import { app, MessageChannelMain, type MessagePortMain } from "electron";
import pc from "picocolors";

import { mainWindow } from "../../windows/main/main.ts";

const require = createRequire(import.meta.url);

const LOG_PREFIX = pc.cyan("[Screenshare]");

// The addon's contract (see native/wasapi-loopback/src/lib.rs + 04-02-SUMMARY):
//   start(excludeRootPid: number, onChunk: (chunk: Buffer) => void): boolean  // false = unsupported, never throws
//   stop(): void                                                              // idempotent, bounded join
interface WasapiAddon {
	// onChunk is a napi CalleeHandled ThreadsafeFunction → JS is invoked as (err, chunk):
	// the error slot is the FIRST arg (null on Ok), the audio Buffer is the SECOND.
	start(excludeRootPid: number, onChunk: (err: unknown, chunk: Buffer) => void): boolean;
	stop(): void;
}

// ── Addon load (mirror obtainVenbind: load-once flag + --no-wasapi guard + null-on-failure) ──
let addon: WasapiAddon | undefined;
let addonLoadAttempted = false;

// The addon is loaded from ts-out/native/ (placed there by build.ts's host-agnostic copy) via a
// runtime path anchored at the app root: app.getAppPath() is the project root in dev and the
// app.asar path when packaged (Electron's require() redirects the unpacked .node automatically).
// Computing the path here — instead of relying on Bun's `native-module:` file-loader — is what makes
// a Windows BUILD HOST work; the prior file-loader import emitted ZERO .node on windows-latest.
const wasapiPath = path.join(app.getAppPath(), "ts-out", "native", `wasapi-loopback-${process.platform}-${process.arch}.node`);
const wasapiPathExists = existsSync(wasapiPath);

// A missing .node is otherwise a SILENT "loopback" fallback (Pitfall 3); log resolution explicitly.
void appendScreenshareDebug(`wasapi wasapiPath resolved? ${wasapiPathExists} path=${wasapiPath}`);

// SYNCHRONOUS crash-resilient breadcrumb. appendScreenshareDebug uses fs.promises.appendFile (async),
// so any line issued microseconds before a NATIVE crash (e.g. WASAPI heap corruption inside the
// addon's start()) is lost unflushed. These appendFileSync writes survive the crash — the LAST [sync]
// line on disk pinpoints the exact failing call (require vs start()) without a debugger.
// (Diagnostic scaffolding — strip with the rest of screenshare-debug before the upstream PR.)
function syncCrumb(line: string): void {
	try {
		appendFileSync(path.join(app.getPath("userData"), "screenshare-debug.log"), `${new Date().toISOString()} [sync] ${line}\n`);
	} catch {
		// best-effort; never throw from diagnostics
	}
}

function obtainWasapiLoopback(): WasapiAddon | undefined {
	if (addon !== undefined || addonLoadAttempted || process.argv.includes("--no-wasapi") || !wasapiPathExists) return addon;
	addonLoadAttempted = true;
	try {
		syncCrumb(`addon require begin ${wasapiPath}`);
		addon = require(wasapiPath) as WasapiAddon;
		syncCrumb("addon require ok");
		if (!addon || typeof addon.start !== "function" || typeof addon.stop !== "function") {
			throw new Error("wasapi-loopback addon missing start/stop exports");
		}
		// In-Electron N-API smoke (SC#5 / Open Q1): a successful require + a typeof check of the
		// exports proves the .node's N-API ABI loads under Electron 41.3.0 (not just bare Node).
		// This surfaces an ABI mismatch at startup rather than as a wasted second-device round-trip.
		void appendScreenshareDebug("wasapi smoke: loaded under electron napi ok");
		console.log(pc.green("[WASAPI]"), "Loaded wasapi-loopback addon");
	} catch (e: unknown) {
		addon = undefined;
		void appendScreenshareDebug(`wasapi smoke: load failed: ${getErrorMessage(e)}`);
		console.error("Failed to import wasapi-loopback", e);
	}
	return addon;
}

// 48k / stereo / f32, 480-frame (~10ms) chunks — matches the Phase 3 renderer contract AND the
// addon's emitted chunk shape (3840 bytes); the renderer feeder consumes exactly this.
const CHUNK_BYTES = 480 * 2 * 4; // 3840

// ── State (nulled by stopWasapiLoopback; safe to call stop twice) ────────────────────────
let port1: MessagePortMain | undefined;
let chunkCount = 0;
let logCount = 0;

// The addon's onChunk delivers a napi Buffer; forward its bytes down the kept MessagePort.
// COPY into a fresh ArrayBuffer (the Buffer may share/reuse V8 backing memory) so the
// structured clone over the port is stable.
function toArrayBuffer(chunk: Buffer): ArrayBuffer {
	const out = new ArrayBuffer(chunk.byteLength);
	new Uint8Array(out).set(chunk);
	return out;
}

/**
 * Start the REAL WASAPI EXCLUDE-tree capture behind the proven Plan 01 transport.
 *
 * Returns false (never throws) on: non-win32, --no-wasapi, addon-not-loaded, addon activation
 * unsupported on this build, or any exception → the caller falls through to Electron "loopback"
 * (ECHO-03). On success, the addon's ThreadsafeFunction pushes 480-frame/3840-byte f32 buffers
 * which we forward zero-copy down `port1` to the renderer feeder.
 */
export async function tryStartWasapiLoopback(): Promise<boolean> {
	if (process.platform !== "win32" || process.argv.includes("--no-wasapi")) return false;

	const wasapi = obtainWasapiLoopback();
	if (!wasapi) {
		void appendScreenshareDebug("wasapi unsupported: addon not loaded");
		return false;
	}

	try {
		// PID discipline (ECHO-02): resolve the EXCLUDE-tree root (Electron main) and log the
		// Audio Service child so the CI artifact confirms the tree layout. The addon excludes the
		// whole tree rooted at rootPid via EXCLUDE_TARGET_PROCESS_TREE (covers the Audio Service
		// utility child — Plan 01 Assumption A4). RESEARCH §Code Examples L423-435.
		const rootPid = process.pid;
		const metrics = app.getAppMetrics();
		const audioService = metrics.find((p) => p.name === "Audio Service");
		void appendScreenshareDebug(`wasapi exclude-root=${rootPid} audioService=${audioService?.pid ?? "not-found"} procs=${metrics.map((p) => `${p.name}:${p.pid}`).join(",")}`);

		// Make start idempotent across re-clicks: tear down any prior session/port first.
		await stopWasapiLoopback();

		// Hop-1: create the channel, keep port1, transfer port2 to the renderer's preload
		// (isolated world). MessageChannelMain is the canonical Electron zero-copy audio path —
		// NEVER per-frame ipcRenderer.send of raw PCM (locked anti-pattern T2).
		const channel = new MessageChannelMain();
		port1 = channel.port1;
		mainWindow.webContents.postMessage("wasapi:pcm-port", null, [channel.port2]);
		port1.start();

		chunkCount = 0;
		logCount = 0;

		// Start the REAL addon. start() returns the activation verdict synchronously on the JS
		// side (false on non-S_OK / missing entrypoint — never throws). The ThreadsafeFunction
		// onChunk runs per ~10ms with a 3840-byte f32 Buffer.
		syncCrumb(`start() begin exclude-root=${rootPid}`);
		// CalleeHandled ThreadsafeFunction → invoked as (err, chunk): the chunk Buffer is the SECOND
		// arg (the first is the error slot, null on Ok). Reading the first arg as the chunk yielded
		// `null` → toArrayBuffer(null).byteLength threw on the first packet and tore the capture down
		// (viewer heard nothing). Guard on err/chunk so a stray error frame can't crash the callback.
		const ok = await wasapi.start(rootPid, (err: unknown, chunk: Buffer) => {
			const port = port1;
			if (!port || err || !chunk) return;
			try {
				// Electron's MAIN-process MessagePortMain.postMessage transfer list accepts ONLY
				// MessagePortMain instances — NOT ArrayBuffers (unlike the renderer/DOM MessagePort).
				// Passing a transfer list of [buf] throws "Port at index 0 is not a valid port" on
				// every chunk → uncaught main-process crash dialog (Plan 01 Deviation 3). Send the
				// buffer as the MESSAGE (structured-cloned, ~384 KB/s — negligible).
				port.postMessage(toArrayBuffer(chunk));
				chunkCount++;

				// Periodic auditable chunk-count line (every ~1s) — required for honest verification.
				if (chunkCount - logCount >= 100) {
					logCount = chunkCount;
					void appendScreenshareDebug(`wasapi activation=ok hop1=messageport hop2=port-forward chunks=${chunkCount}`);
				}
			} catch (e) {
				// A throw inside the threadsafe callback would be an uncaught main-process exception.
				// Never let the capture crash the app (ECHO-03 discipline): log once and stop cleanly.
				void appendScreenshareDebug(`wasapi onChunk threw, stopping: ${getErrorMessage(e)}`);
				void stopWasapiLoopback();
			}
		});
		syncCrumb(`start() returned ok=${ok}`);

		void appendScreenshareDebug(`wasapi activation=${ok ? "ok" : "unsupported"} hop1=messageport hop2=port-forward chunks=${chunkCount}`);

		if (!ok) {
			// Activation != S_OK (API unavailable on this build): close the port and fall through
			// to "loopback" — no crash (ECHO-03). The addon already cleaned up its own thread.
			await stopWasapiLoopback();
			return false;
		}

		console.log(LOG_PREFIX, "WASAPI EXCLUDE-tree capture streaming over MessageChannelMain");
		return true;
	} catch (e) {
		void appendScreenshareDebug(`wasapi start threw: ${getErrorMessage(e)}`);
		await stopWasapiLoopback();
		return false; // → "loopback" fallback, never crash (ECHO-03)
	}
}

/**
 * Idempotent teardown: stop the native capture, close the kept port, null state.
 * Safe to call twice (mirrors stopPatchcord; composes with the single-owner finishRequest).
 */
export async function stopWasapiLoopback<IPCHandle>() {
	// Stop the native capture FIRST so no more chunks arrive after we drop the port. The addon's
	// stop() is idempotent with a bounded internal join; obtain (cached) without re-loading.
	const wasapi = addon;
	if (wasapi) {
		try {
			wasapi.stop();
		} catch (e) {
			void appendScreenshareDebug(`wasapi stop threw: ${getErrorMessage(e)}`);
		}
	}

	const port = port1;
	port1 = undefined;
	if (port) {
		try {
			port.close();
		} catch {
			// already closed
		}
		void appendScreenshareDebug(`wasapi activation=ok hop1=messageport hop2=port-forward chunks=${chunkCount}`);
		console.log(LOG_PREFIX, "WASAPI EXCLUDE-tree capture stopped");
	}
}

// A hung native stop must not wedge quit (mirror patchcord.ts:168-184 Promise.race([dispose, timeout])).
app.on("before-quit", (event) => {
	if (!port1 && !addon) return;

	event.preventDefault();
	Promise.race([stopWasapiLoopback(), new Promise((resolve) => setTimeout(resolve, 1500))])
		.catch((err) => console.error(LOG_PREFIX, "WASAPI stop failed:", err))
		.finally(() => app.quit());
});
