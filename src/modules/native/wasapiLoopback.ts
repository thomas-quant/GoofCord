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
// it. Endpoint-bound capture returns a raw HRESULT so the default endpoint can fall back through
// the existing process-exclude path while an explicitly selected endpoint fails closed.
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
	startRenderEndpointExcludeProcessTree(deviceId: string, excludeRootPid: number, onChunk: (err: unknown, chunk: Buffer) => void): number;
	startDefaultRenderEndpointExcludeProcessTree(excludeRootPid: number, onChunk: (err: unknown, chunk: Buffer) => void): number;
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

export function canRunWasapiCapture(): boolean {
	return process.platform === "win32" && !process.argv.includes("--no-wasapi") && wasapiPathExists;
}

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

export type WasapiVerdict = "started" | "unsupported-fallback-ok" | "failed-no-fallback";

interface WasapiAudioConfig {
	mode: "none" | "system" | "app";
	pids: number[];
	captureSource: "process-exclude" | "endpoint-exclude-self";
	endpointId: string;
}

const CAPTURE_LOG_PATH = path.join(userDataPath, "wasapi-capture.log");

async function logCapture(kind: string, verdict: WasapiVerdict, hr?: number): Promise<void> {
	try {
		const hresult = hr === undefined ? "" : ` hr=0x${(hr >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
		await appendFile(CAPTURE_LOG_PATH, `${new Date().toISOString()} kind=${kind} verdict=${verdict}${hresult}\n`);
	} catch {
		// Diagnostics are best-effort and must never affect capture.
	}
}

/**
 * Start native Windows capture over the existing MessageChannel transport.
 * Explicit endpoints fail closed. The default endpoint falls back to the #211 process-exclude
 * path when endpoint-bound activation is unavailable; only that process path may then permit
 * Chromium's loopback fallback.
 */
export async function tryStartWasapiLoopback(audioConfig: WasapiAudioConfig): Promise<WasapiVerdict> {
	const explicitEndpoint = audioConfig.captureSource === "endpoint-exclude-self" && audioConfig.endpointId !== "default";
	const failureVerdict: WasapiVerdict = explicitEndpoint ? "failed-no-fallback" : "unsupported-fallback-ok";

	if (process.platform !== "win32" || process.argv.includes("--no-wasapi")) {
		await logCapture("unsupported", failureVerdict);
		return failureVerdict;
	}

	if (audioConfig.mode !== "system") {
		await logCapture("invalid-mode", "failed-no-fallback");
		return "failed-no-fallback";
	}

	const wasapi = obtainWasapiLoopback();
	if (!wasapi) {
		await logCapture("addon-missing", failureVerdict);
		return failureVerdict;
	}

	try {
		await stopWasapiLoopback();

		const channel = new MessageChannelMain();
		port1 = channel.port1;
		mainWindow.webContents.postMessage("wasapi:pcm-port", null, [channel.port2]);
		port1.start();

		const onChunk = (err: unknown, chunk: Buffer) => {
			const port = port1;
			if (!port || err || !chunk) return;
			try {
				port.postMessage(toArrayBuffer(chunk));
			} catch {
				void stopWasapiLoopback();
			}
		};

		if (audioConfig.captureSource === "endpoint-exclude-self") {
			const kind = audioConfig.endpointId === "default" ? "endpoint-exclude-self:default" : `endpoint-exclude-self:${audioConfig.endpointId}`;
			let hr: number | undefined;
			try {
				hr =
					audioConfig.endpointId === "default"
						? wasapi.startDefaultRenderEndpointExcludeProcessTree(process.pid, onChunk)
						: wasapi.startRenderEndpointExcludeProcessTree(audioConfig.endpointId, process.pid, onChunk);
			} catch {
				// A pre-endpoint addon behaves like an unsupported endpoint activation.
			}

			if (hr === 0) {
				console.log(LOG_PREFIX, `WASAPI ${kind} capture streaming over MessageChannelMain`);
				await logCapture(kind, "started", hr);
				return "started";
			}

			if (explicitEndpoint) {
				await stopWasapiLoopback();
				await logCapture(kind, "failed-no-fallback", hr);
				return "failed-no-fallback";
			}

			await logCapture(kind, "unsupported-fallback-ok", hr);
		}

		const processKind = audioConfig.captureSource === "endpoint-exclude-self" ? "process-exclude:fallback" : "process-exclude";
		const ok = wasapi.start(process.pid, onChunk);
		if (!ok) {
			await stopWasapiLoopback();
			await logCapture(processKind, "unsupported-fallback-ok");
			return "unsupported-fallback-ok";
		}

		console.log(LOG_PREFIX, `WASAPI ${processKind} capture streaming over MessageChannelMain`);
		await logCapture(processKind, "started");
		return "started";
	} catch {
		await stopWasapiLoopback();
		await logCapture("exception", failureVerdict);
		return failureVerdict;
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
