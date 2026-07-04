// @ts-nocheck Bun won't install the wasapi-loopback addon on macOS/linux, so typescript can't compile with checks (mirror venbind.ts:1)

// ─────────────────────────────────────────────────────────────────────────────
// Windows WASAPI EXCLUDE-tree echo fix (the #46 fix) — main-process capture wrapper.
//
// The clean-room addon (native/wasapi-loopback) captures the full endpoint mix EXCEPT
// GoofCord's own process tree (the Audio Service child is covered via EXCLUDE_TARGET_PROCESS_TREE),
// so the viewer hears shared desktop audio but NOT the Discord call echoed back. The captured PCM
// is forwarded over the canonical Electron MessageChannelMain transport (MessageChannelMain →
// webContents.postMessage → preload-injected MSTG feeder → viewer).
//
// Load model: the addon ships at ts-out/native/wasapi-loopback-<plat>-<arch>.node (placed there by
// build.ts via a HOST-AGNOSTIC fs copy — NOT Bun's `native-module:` file-loader, which silently
// fails to emit the .node when the BUILD HOST is Windows). createRequire + a --no-wasapi guard load
// it; the addon's `start(excludeRootPid, onChunk)` returns false (never throws) when the API is
// unavailable on this build → we fall through to Electron "loopback" (ECHO-03).
//
// On non-win32 / --no-wasapi / addon-not-loaded, tryStartWasapiLoopback returns false
// immediately so the normal "loopback" path stays byte-identical to upstream.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { app, MessageChannelMain, type MessagePortMain } from "electron";
import pc from "picocolors";

import { userDataPath } from "../../utils.ts";
import { mainWindow } from "../../windows/main/main.ts";

const require = createRequire(import.meta.url);

const LOG_PREFIX = pc.cyan("[Screenshare]");

// The render-endpoint descriptor surfaced to the picker's capture-source dropdown (Plan 04). Mirrors
// the Rust napi RenderEndpointInfo { id, name, isDefault } — `id` is the IMMDevice id, `name` the
// friendly name, `isDefault` flags the eConsole default render endpoint. Reused by screenshare.ts's
// payload and (structurally) by the preload dropdown.
export interface RenderEndpointInfo {
	id: string;
	name: string;
	isDefault: boolean;
}

// The addon's contract (see native/wasapi-loopback/src/lib.rs):
//   start(excludeRootPid: number, onChunk: (err, chunk) => void): boolean  // false = unsupported, never throws
//   stop(): void                                                           // idempotent, bounded join
interface WasapiAddon {
	// onChunk is a napi CalleeHandled ThreadsafeFunction → JS is invoked as (err, chunk):
	// the error slot is the FIRST arg (null on Ok), the audio Buffer is the SECOND.
	start(excludeRootPid: number, onChunk: (err: unknown, chunk: Buffer) => void): boolean;
	stop(): void;
	// Plan 01 additions (per-app INCLUDE + audio-session enumerator). Optional at the load guard
	// (graceful null-on-failure) — these are documentation-grade typings under @ts-nocheck.
	//   INCLUDE variant of start(): false = unsupported on this build, never throws.
	//   enumerator returns a per-PID audio-session list (deduped, system-sounds + own-PID dropped).
	startIncludeProcessTree(targetPid: number, onChunk: (err: unknown, chunk: Buffer) => void): boolean;
	listAudioApps(): { processId: number; displayName: string; binary: string }[];
	// Plan 03 additions (render-endpoint enumeration + endpoint loopback). Optional at the load guard
	// (graceful null-on-failure; a pre-endpoint .node simply lacks these) — documentation-grade under @ts-nocheck.
	//   startRenderEndpoint: loopback of a chosen render device by IMMDevice id; false = unsupported /
	//     unresolved id (fail-closed), never throws.
	//   startDefaultRenderEndpoint: loopback of the eConsole default render device; false = unsupported.
	//   listRenderEndpoints: active eRender endpoints ({ id, name, isDefault }); [] fail-closed.
	startRenderEndpoint(deviceId: string, onChunk: (err: unknown, chunk: Buffer) => void): boolean;
	startDefaultRenderEndpoint(onChunk: (err: unknown, chunk: Buffer) => void): boolean;
	listRenderEndpoints(): RenderEndpointInfo[];
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

function obtainWasapiLoopback(): WasapiAddon | undefined {
	if (addon !== undefined || addonLoadAttempted || process.argv.includes("--no-wasapi") || !wasapiPathExists) return addon;
	addonLoadAttempted = true;
	try {
		addon = require(wasapiPath) as WasapiAddon;
		if (!addon || typeof addon.start !== "function" || typeof addon.stop !== "function") {
			throw new Error("wasapi-loopback addon missing start/stop exports");
		}
		console.log(pc.green("[WASAPI]"), "Loaded wasapi-loopback addon");
	} catch (e: unknown) {
		addon = undefined;
		console.error("Failed to import wasapi-loopback", e);
	}
	return addon;
}

// Whether preload.mts should inject the MSTG feeder + getDisplayMedia swap seam into the Discord
// page main world. The feeder must be present whenever the addon can run (win32, not --no-wasapi)
// so the addon's chunks have somewhere to land; otherwise capture silently falls through to the
// echoing "loopback" path. Read from main via sendSync (the sandboxed preload has no process.argv /
// authoritative platform). Off-Windows or --no-wasapi ⇒ false ⇒ no injection ⇒ byte-identical to upstream.
export function shouldInjectWasapiTransport<IPCOn>() {
	return process.platform === "win32" && !process.argv.includes("--no-wasapi");
}

// Whether the win32 advanced audio UI (app checklist + mode control) should be shown for a share: the
// addon must be able to run (win32, not --no-wasapi, prebuilt .node present). Off ⇒ the picker shows
// only the legacy system checkbox and app mode is unreachable. Drives the ScreensharePayload
// `isWasapiAudio` flag consumed by the preload advanced-UI gate.
export function canRunWasapiCapture(): boolean {
	return process.platform === "win32" && !process.argv.includes("--no-wasapi") && wasapiPathExists;
}

// Thin accessor over the addon's audio-session enumerator, used by fetchScreenshareData to populate the
// win32 app checklist. Returns [] fail-closed off-win32 / --no-wasapi / addon-missing / on any throw,
// so the picker simply shows no apps rather than erroring. Keeps screenshare.ts from importing the raw
// addon. Shape matches the renderer's ShareableNode contract ({ processId, displayName, binary }).
export function listWasapiAudioApps(): { processId: number; displayName: string; binary: string }[] {
	if (process.platform !== "win32" || process.argv.includes("--no-wasapi")) return [];
	const wasapi = obtainWasapiLoopback();
	if (!wasapi || typeof wasapi.listAudioApps !== "function") return [];
	try {
		return wasapi.listAudioApps() ?? [];
	} catch (e: unknown) {
		console.error(LOG_PREFIX, "listAudioApps failed:", e);
		return [];
	}
}

// Thin accessor over the addon's render-endpoint enumerator, used by fetchScreenshareData to populate the
// win32 capture-source dropdown. Returns [] fail-closed off-win32 / --no-wasapi / addon-missing / on any
// throw (or when the prebuilt .node predates the endpoint exports), so the picker simply offers "Default"
// only rather than erroring. Keeps screenshare.ts from importing the raw addon; shape is RenderEndpointInfo.
export function listRenderEndpoints(): RenderEndpointInfo[] {
	if (process.platform !== "win32" || process.argv.includes("--no-wasapi")) return [];
	const wasapi = obtainWasapiLoopback();
	if (!wasapi || typeof wasapi.listRenderEndpoints !== "function") return [];
	try {
		return wasapi.listRenderEndpoints() ?? [];
	} catch (e: unknown) {
		console.error(LOG_PREFIX, "listRenderEndpoints failed:", e);
		return [];
	}
}

// ── State (nulled by stopWasapiLoopback; safe to call stop twice) ────────────────────────
let port1: MessagePortMain | undefined;

// The addon's onChunk delivers a napi Buffer (480-frame / stereo / f32 = 3840 bytes); forward its
// bytes down the kept MessagePort. COPY into a fresh ArrayBuffer (the Buffer may share/reuse V8
// backing memory) so the structured clone over the port is stable.
function toArrayBuffer(chunk: Buffer): ArrayBuffer {
	const out = new ArrayBuffer(chunk.byteLength);
	new Uint8Array(out).set(chunk);
	return out;
}

// The activation verdict returned to the screenshare audio gate. This is the fail-closed contract:
//   started               → a native WASAPI capture is running; the caller MUST leave result.audio
//                            UNSET (never co-run Chromium "loopback" — CoreMessaging hard-crash).
//   unsupported-fallback-ok → nothing native started AND the mode legitimately tolerates the Chromium
//                            "loopback" fallback (system + process-exclude only — the shipped #211
//                            dynamic-OS-floor behavior). The caller may set result.audio = "loopback".
//   failed-no-fallback     → nothing native started for a mode that MUST fail closed (app mode, or
//                            explicit-endpoint mode). The caller MUST leave result.audio UNSET —
//                            NEVER Chromium "loopback" (privacy inversion: user asked for ONE app /
//                            ONE device; a broad fallback would capture everything they did not share).
export type WasapiVerdict = "started" | "unsupported-fallback-ok" | "failed-no-fallback";

// A minimal structural view of the persisted AudioConfig (the real type lives in preload.mts; this
// file is @ts-nocheck so this annotation is documentation-grade). Only the fields the dispatch reads.
interface WasapiAudioConfig {
	mode: "none" | "system" | "app";
	pids: number[];
	captureSource: "process-exclude" | "endpoint";
	endpointId: "default" | string;
}

// No-DevTools diagnostic (the Windows test box has no F12): append one line per share attempt to a
// userData log recording the resolved capture kind + verdict. Best-effort — write errors are swallowed
// so a failed log never affects capture.
const CAPTURE_LOG_PATH = path.join(userDataPath, "wasapi-capture.log");
async function logCapture(kind: string, verdict: WasapiVerdict): Promise<void> {
	try {
		await appendFile(CAPTURE_LOG_PATH, `${new Date().toISOString()} kind=${kind} verdict=${verdict}\n`);
	} catch {
		// diagnostics are best-effort — never let a log write failure affect capture
	}
}

/**
 * Start the REAL WASAPI capture behind the proven MessageChannelMain transport, dispatching on the
 * persisted AudioConfig. The transport hop (MessageChannelMain → port1 → renderer feeder) is IDENTICAL
 * for every mode; only the native start call varies:
 *   mode:"system" + captureSource:"process-exclude" → start(process.pid)          — EXCLUDE-self (#211)
 *   mode:"app"                                        → startIncludeProcessTree(pid) — per-app INCLUDE
 *   mode:"system" + captureSource:"endpoint"          → startRenderEndpoint(id) / startDefaultRenderEndpoint()
 *                                                       — render-endpoint loopback (the VAC/Sonar fix)
 *
 * Returns a WasapiVerdict (never throws). App mode + explicit-endpoint mode FAIL CLOSED: on any
 * non-support / failure / exception they return "failed-no-fallback" so the caller leaves result.audio
 * unset (never Chromium "loopback"). Only system+process-exclude tolerates the fallback.
 */
export async function tryStartWasapiLoopback(audioConfig: WasapiAudioConfig): Promise<WasapiVerdict> {
	// system+process-exclude is the ONLY mode that legitimately tolerates the Chromium "loopback"
	// fallback (dynamic OS floor — the shipped #211 behavior). Every other mode maps a non-start to
	// "failed-no-fallback" so the share stays silent rather than broadening the capture.
	const toleratesFallback = audioConfig.mode === "system" && audioConfig.captureSource === "process-exclude";
	const closedVerdict: WasapiVerdict = toleratesFallback ? "unsupported-fallback-ok" : "failed-no-fallback";

	if (process.platform !== "win32" || process.argv.includes("--no-wasapi")) {
		await logCapture("unsupported", closedVerdict);
		return closedVerdict;
	}

	const wasapi = obtainWasapiLoopback();
	if (!wasapi) {
		await logCapture("addon-missing", closedVerdict);
		return closedVerdict;
	}

	try {
		// Make start idempotent across re-clicks: tear down any prior session/port first.
		await stopWasapiLoopback();

		// Hop-1: create the channel, keep port1, transfer port2 to the renderer's preload
		// (isolated world). MessageChannelMain is the canonical Electron zero-copy audio path —
		// NEVER per-frame ipcRenderer.send of raw PCM (locked anti-pattern T2). Identical for every mode.
		const channel = new MessageChannelMain();
		port1 = channel.port1;
		mainWindow.webContents.postMessage("wasapi:pcm-port", null, [channel.port2]);
		port1.start();

		// The ThreadsafeFunction onChunk runs per ~10ms with a 3840-byte f32 Buffer, delivered
		// CalleeHandled as (err, chunk): the chunk is the SECOND arg (the first is the error slot,
		// null on Ok). Guard on err/chunk so a stray error frame can't crash the callback. Shared
		// verbatim across every capture mode — only the native start call below differs.
		const onChunk = (err: unknown, chunk: Buffer) => {
			const port = port1;
			if (!port || err || !chunk) return;
			try {
				// Electron's MAIN-process MessagePortMain.postMessage transfer list accepts ONLY
				// MessagePortMain instances — NOT ArrayBuffers (unlike the renderer/DOM MessagePort).
				// Send the buffer as the MESSAGE (structured-cloned, ~384 KB/s — negligible).
				port.postMessage(toArrayBuffer(chunk));
			} catch {
				// A throw inside the threadsafe callback would be an uncaught main-process exception.
				// Never let the capture crash the app (ECHO-03 discipline): stop cleanly.
				void stopWasapiLoopback();
			}
		};

		// Dispatch the native start on the resolved mode. start()/startIncludeProcessTree() return the
		// activation verdict synchronously on the JS side (false on non-S_OK / missing entrypoint —
		// never throws). The transport hop above is unchanged; only this call varies.
		let ok: boolean;
		let kind: string;
		if (audioConfig.mode === "system" && audioConfig.captureSource === "endpoint") {
			// Explicit render-endpoint loopback (the VAC/Sonar power-user fix): point GoofCord at a chosen
			// clean render bus. "default" resolves to the eConsole default render endpoint; any other id is
			// the chosen IMMDevice. FAILS CLOSED: a false verdict (activation failure / unresolved-or-forged
			// id / a prebuilt .node that predates the endpoint exports) maps to failed-no-fallback below
			// (closedVerdict is failed-no-fallback for endpoint mode), so an explicit-endpoint request never
			// degrades to a broad Chromium "loopback" (privacy inversion) or the EXCLUDE-self scope.
			if (audioConfig.endpointId === "default") {
				kind = "endpoint-default";
				ok = await wasapi.startDefaultRenderEndpoint(onChunk);
			} else {
				kind = `endpoint:${audioConfig.endpointId}`;
				ok = await wasapi.startRenderEndpoint(audioConfig.endpointId, onChunk);
			}
		} else if (audioConfig.mode === "app") {
			// Per-app INCLUDE: capture ONLY the chosen app's process tree (N=1 for now; pids[0]).
			// Self-free by construction (engine-side filter) — patchcord parity.
			// Guard the PID EXPLICITLY before the native call: if the user picked "app" mode but
			// checked no app, getFormSettings yields pids: [] so pids[0] is undefined. Handing that
			// to the napi u32 parameter would rely on napi's argument validation throwing (caught
			// below as an exception) rather than a deterministic decision here — and any coercion to
			// 0 would root the INCLUDE tree at PID 0 (System Idle, unspecified capture). Fail closed
			// deterministically instead (closedVerdict is failed-no-fallback for app mode), so a
			// missing selection is a clean silent share, not an implementation-detail-dependent one.
			const targetPid = audioConfig.pids[0];
			if (typeof targetPid !== "number" || !Number.isInteger(targetPid) || targetPid <= 0) {
				await stopWasapiLoopback();
				await logCapture("app-no-pid", closedVerdict);
				return closedVerdict;
			}
			kind = "include-pid";
			ok = await wasapi.startIncludeProcessTree(targetPid, onChunk);
		} else {
			// mode:"system" + captureSource:"process-exclude" — today's EXCLUDE-self path (#211).
			// PID discipline (ECHO-02): the EXCLUDE-tree root is the Electron main PID; the addon
			// excludes the whole tree (covering the Audio Service utility child) so GoofCord's own
			// call playback never re-enters the captured mix.
			kind = "exclude-self";
			ok = await wasapi.start(process.pid, onChunk);
		}

		if (!ok) {
			// Activation != S_OK: close the port. For system+process-exclude the Chromium "loopback"
			// fallback is acceptable (unsupported-fallback-ok); for app mode it fails closed. The addon
			// already cleaned up its own thread.
			await stopWasapiLoopback();
			await logCapture(kind, closedVerdict);
			return closedVerdict;
		}

		console.log(LOG_PREFIX, `WASAPI ${kind} capture streaming over MessageChannelMain`);
		await logCapture(kind, "started");
		return "started";
	} catch {
		await stopWasapiLoopback();
		await logCapture("exception", closedVerdict);
		return closedVerdict; // fail closed unless system+process-exclude, never crash (ECHO-03)
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
		} catch {
			// best-effort; stop() is idempotent and a throw here is non-fatal
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
