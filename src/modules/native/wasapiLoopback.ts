// @ts-nocheck Bun won't install the wasapi-loopback addon on macOS/linux, so typescript can't compile with checks (mirror venbind.ts:1)

// ─────────────────────────────────────────────────────────────────────────────
// Windows WASAPI screenshare audio (the #46 echo fix) — main-process capture wrapper.
//
// TWO capture modes, chosen by what the user picked in the source picker. This mirrors what
// Discord's desktop client does, which we confirmed by reading its own renderer bundle:
//
//   Discord `getPidFromDesktopSource(id)`:
//     "window:<hwnd>:…" -> the real PID behind that window  -> INCLUDE that process tree
//     "screen:…"        -> the sentinel PID 1               -> capture everything but itself
//
//   Ours:
//     audioConfig.mode === "app"    -> startIncludeProcessTree(pid) per selected app
//     audioConfig.mode === "system" -> startExcludeProcessTree(ourPid)
//
// WHY THE INCLUDE MODE MATTERS: EXCLUDE is a denylist, and the WASAPI activation struct has
// exactly ONE TargetProcessId — so it can drop OUR audio or a virtual cable's, never both. A
// transparent VAC looping the mic back to the speakers therefore lands in every EXCLUDE capture
// and viewers hear the sharer twice. INCLUDE is an allowlist: a VAC that was never added simply
// cannot appear. That is the entire reason Discord's window-share is echo-free, and it is the
// mode GoofCord was missing.
//
// N INCLUDE sessions run concurrently (one per selected app) and are mixed in the renderer;
// each chunk is tagged with its source index so the feeder can sum them.
//
// Load model: the addon ships at ts-out/native/wasapi-loopback-<plat>-<arch>.node (placed there by
// build.ts via a HOST-AGNOSTIC fs copy — NOT Bun's `native-module:` file-loader, which silently
// fails to emit the .node when the BUILD HOST is Windows). createRequire + a --no-wasapi guard load
// it; every addon entry point returns a falsy/0 result rather than throwing when the API is
// unavailable on this build.
//
// On non-win32 / --no-wasapi / addon-not-loaded, startWasapiCapture returns "unsupported"
// immediately so the normal "loopback" path stays byte-identical to upstream.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { app, MessageChannelMain, type MessagePortMain } from "electron";
import pc from "picocolors";

import { mainWindow } from "../../windows/main/main.ts";

const require = createRequire(import.meta.url);

const LOG_PREFIX = pc.cyan("[Screenshare]");

// An app with a live audio session, offered in the picker's per-app list.
export interface WasapiAudioApp {
	processId: number;
	displayName: string;
	binary: string;
}

// The addon's contract (see native/wasapi-loopback/src/lib.rs). Session-returning starts:
// a non-zero session id means capturing, 0 means "unavailable/failed" (never throws).
interface WasapiAddon {
	// onChunk is a napi CalleeHandled ThreadsafeFunction → JS is invoked as (err, chunk):
	// the error slot is the FIRST arg (null on Ok), the audio Buffer is the SECOND.
	startExcludeProcessTree(excludeRootPid: number, onChunk: (err: unknown, chunk: Buffer) => void): number;
	startIncludeProcessTree(targetPid: number, onChunk: (err: unknown, chunk: Buffer) => void): number;
	stopSession(id: number): void;
	stopAll(): void;
	listAudioApps(): WasapiAudioApp[];
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
		if (!addon || typeof addon.startExcludeProcessTree !== "function" || typeof addon.startIncludeProcessTree !== "function" || typeof addon.stopAll !== "function") {
			throw new Error("wasapi-loopback addon missing start/stop exports");
		}
		console.log(pc.green("[WASAPI]"), "Loaded wasapi-loopback addon");
	} catch (e: unknown) {
		addon = undefined;
		console.error("Failed to import wasapi-loopback", e);
	}
	return addon;
}

// Whether the native Windows capture path is usable at all.
function wasapiAvailable(): boolean {
	return process.platform === "win32" && !process.argv.includes("--no-wasapi");
}

/**
 * Whether Windows native capture is available, so the picker can offer the 3-mode audio UI
 * (none / system / app) instead of the bare on-off toggle.
 *
 * NOTE the asymmetry with Linux: patchcord can capture "system MINUS these apps", but WASAPI
 * cannot — `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS` carries a single `TargetProcessId`, which we
 * must spend excluding ourselves. So Windows supports per-app INCLUDE but NOT per-app exclude,
 * and the picker must not offer an exclusion list it cannot honour.
 */
export function isWasapiAvailable(): boolean {
	return wasapiAvailable() && obtainWasapiLoopback() !== undefined;
}

// Whether preload.mts should inject the MSTG feeder + getDisplayMedia swap seam into the Discord
// page main world. The feeder must be present whenever the addon can run (win32, not --no-wasapi)
// so the addon's chunks have somewhere to land; otherwise capture silently falls through to the
// echoing "loopback" path. Read from main via sendSync (the sandboxed preload has no process.argv /
// authoritative platform). Off-Windows or --no-wasapi ⇒ false ⇒ no injection ⇒ byte-identical to upstream.
export function shouldInjectWasapiTransport<IPCOn>() {
	return wasapiAvailable();
}

/**
 * Apps with a live audio session, for the picker's per-app include list. This is the Windows
 * counterpart of `patchcordList()` on Linux — it is what makes the 3-mode picker (none / system /
 * app) meaningful on Windows instead of a bare on-off toggle.
 *
 * Fail-closed: returns [] off-Windows, without the addon, or on any error — never throws.
 */
export function listWasapiAudioApps(): WasapiAudioApp[] {
	if (!wasapiAvailable()) return [];
	const wasapi = obtainWasapiLoopback();
	if (!wasapi || typeof wasapi.listAudioApps !== "function") return [];
	try {
		// Never offer ourselves as an include target: capturing GoofCord's own tree is the echo
		// we are here to remove.
		return wasapi.listAudioApps().filter((a) => a.processId !== process.pid);
	} catch (e: unknown) {
		console.error(LOG_PREFIX, "listAudioApps failed:", e);
		return [];
	}
}

// ── State (cleared by stopWasapiLoopback; safe to call stop twice) ────────────────────────
let port1: MessagePortMain | undefined;
let sessionIds: number[] = [];

// The addon's onChunk delivers a napi Buffer (480-frame / stereo / f32 = 3840 bytes); forward its
// bytes down the kept MessagePort. COPY into a fresh ArrayBuffer (the Buffer may share/reuse V8
// backing memory) so the structured clone over the port is stable.
function toArrayBuffer(chunk: Buffer): ArrayBuffer {
	const out = new ArrayBuffer(chunk.byteLength);
	new Uint8Array(out).set(chunk);
	return out;
}

/** What the screenshare picker sends us. `pids` is only meaningful in "app" mode. */
export interface WasapiAudioConfig {
	mode: "none" | "system" | "app";
	pids: number[];
}

/**
 * Outcome of a capture attempt:
 *   "started"       — native capture running; caller must NOT also request Chromium "loopback".
 *   "unsupported"   — nothing started; caller may fall back to Chromium "loopback".
 *   "failed-closed" — app mode was requested and could not be honoured. The caller must leave
 *                     audio UNSET rather than fall back: falling back to system-wide "loopback"
 *                     when the user explicitly asked for one app is a privacy inversion (it would
 *                     broadcast every app plus the call itself).
 */
export type WasapiStartResult = "started" | "unsupported" | "failed-closed";

/**
 * Start native capture for the requested mode behind the proven MessageChannelMain transport.
 *
 * On success the addon's ThreadsafeFunction pushes 480-frame/3840-byte f32 buffers, which we
 * forward down `port1` tagged with their source index so the renderer can mix N app streams.
 */
export async function startWasapiCapture(audioConfig: WasapiAudioConfig): Promise<WasapiStartResult> {
	if (!wasapiAvailable() || audioConfig.mode === "none") return "unsupported";

	const wasapi = obtainWasapiLoopback();
	if (!wasapi) return audioConfig.mode === "app" ? "failed-closed" : "unsupported";

	// App mode with nothing selected has no meaning — treat it as "user asked for app audio and
	// we have none", i.e. fail closed rather than silently broadcasting the whole system.
	const targets = audioConfig.mode === "app" ? audioConfig.pids.filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid) : [];
	if (audioConfig.mode === "app" && targets.length === 0) return "failed-closed";

	try {
		// Make start idempotent across re-clicks: tear down any prior session/port first.
		await stopWasapiLoopback();

		// Hop-1: create the channel, keep port1, transfer port2 to the renderer's preload
		// (isolated world). MessageChannelMain is the canonical Electron zero-copy audio path —
		// NEVER per-frame ipcRenderer.send of raw PCM (locked anti-pattern T2).
		const channel = new MessageChannelMain();
		port1 = channel.port1;
		mainWindow.webContents.postMessage("wasapi:pcm-port", null, [channel.port2]);
		port1.start();

		// One chunk sink per source index. Guard on err/chunk so a stray error frame can't crash
		// the callback, and never let a throw inside the threadsafe callback become an uncaught
		// main-process exception.
		const sink = (index: number) => (err: unknown, chunk: Buffer) => {
			const port = port1;
			if (!port || err || !chunk) return;
			try {
				// Electron's MAIN-process MessagePortMain.postMessage transfer list accepts ONLY
				// MessagePortMain instances — NOT ArrayBuffers (unlike the renderer/DOM MessagePort).
				// Send the buffer as the MESSAGE (structured-cloned, ~384 KB/s per source).
				port.postMessage({ index, pcm: toArrayBuffer(chunk) });
			} catch {
				void stopWasapiLoopback();
			}
		};

		const started: number[] = [];
		if (audioConfig.mode === "app") {
			// INCLUDE one session per selected app — the VAC-immune allowlist path.
			targets.forEach((pid, i) => {
				const id = wasapi.startIncludeProcessTree(pid, sink(i));
				if (id) started.push(id);
				else console.warn(LOG_PREFIX, `WASAPI INCLUDE capture failed for pid ${pid}`);
			});
		} else {
			// EXCLUDE our own tree — "share whole screen" audio. EXCLUDE_TARGET_PROCESS_TREE covers
			// the separate "Audio Service" utility child, so our own call playback never re-enters.
			const id = wasapi.startExcludeProcessTree(process.pid, sink(0));
			if (id) started.push(id);
		}

		sessionIds = started;

		if (started.length === 0) {
			await stopWasapiLoopback();
			return audioConfig.mode === "app" ? "failed-closed" : "unsupported";
		}

		console.log(LOG_PREFIX, audioConfig.mode === "app" ? `WASAPI INCLUDE capture streaming (${started.length}/${targets.length} app${targets.length === 1 ? "" : "s"})` : "WASAPI EXCLUDE-tree capture streaming over MessageChannelMain");
		return "started";
	} catch (e: unknown) {
		console.error(LOG_PREFIX, "WASAPI capture failed to start:", e);
		await stopWasapiLoopback();
		return audioConfig.mode === "app" ? "failed-closed" : "unsupported";
	}
}

/**
 * Idempotent teardown: stop every native session, close the kept port, null state.
 * Safe to call twice (mirrors stopPatchcord; composes with the single-owner finishRequest).
 */
export async function stopWasapiLoopback<IPCHandle>() {
	// Stop the native capture FIRST so no more chunks arrive after we drop the port. stopAll() is
	// idempotent with a bounded internal join; obtain (cached) without re-loading.
	const wasapi = addon;
	if (wasapi) {
		try {
			wasapi.stopAll();
		} catch {
			// best-effort; stopAll() is idempotent and a throw here is non-fatal
		}
	}
	sessionIds = [];

	const port = port1;
	port1 = undefined;
	if (port) {
		try {
			port.close();
		} catch {
			// already closed
		}
		console.log(LOG_PREFIX, "WASAPI capture stopped");
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
