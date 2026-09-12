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
// SESSION PROTOCOL (one capture at a time, each with a monotonically increasing captureId):
//   1. native sessions start; only if at least one does is a MessageChannelMain created and
//      port2 posted as webContents.postMessage("wasapi:pcm-port", { captureId }, [port2]);
//   2. the renderer builds fresh per-capture state and replies { type: "ready", captureId };
//      until then PCM is dropped. No ack within READY_TIMEOUT_MS ⇒ the attempt is torn down and
//      the caller falls back exactly as if native activation had failed;
//   3. PCM flows as { index, pcm: ArrayBuffer };
//   4. on stop/replacement/device loss main posts { type: "stopped", captureId } and closes.
// stopWasapiLoopback(captureId) ignores ids that are not current, so a late stop from an old
// share cannot kill a newer one.
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

// How long startWasapiCapture waits for the renderer's ready ack before giving up.
const READY_TIMEOUT_MS = 2000;

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
	// the error slot is the FIRST arg (null on Ok), the audio Buffer is the SECOND. A non-null
	// err means that session's stream died (device invalidated etc.) and will send nothing more.
	startExcludeProcessTree(excludeRootPid: number, onChunk: (err: unknown, chunk: Buffer) => void): number;
	startIncludeProcessTree(targetPid: number, onChunk: (err: unknown, chunk: Buffer) => void): number;
	stopSession?(id: number): void;
	stopAll(): void;
	listAudioApps?(): WasapiAudioApp[];
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

/** Test seam: inject a fake addon (the real one only loads on Windows from ts-out). */
export function __setWasapiAddonForTesting(fake: WasapiAddon | undefined) {
	addon = fake;
	addonLoadAttempted = true;
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
 * PIDs an INCLUDE capture must never target: our main process, every Electron child (the
 * "Audio Service" utility process is the one that actually plays the call), and our parent —
 * INCLUDE takes a whole process TREE, so including the process that launched us would include us.
 */
function ownProcessIds(): Set<number> {
	const own = new Set<number>([process.pid]);
	if (process.ppid > 0) own.add(process.ppid);
	try {
		for (const m of app.getAppMetrics()) own.add(m.pid);
	} catch {
		// metrics unavailable; main + parent are still excluded
	}
	return own;
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
		const own = ownProcessIds();
		return wasapi.listAudioApps().filter((a) => !own.has(a.processId));
	} catch (e: unknown) {
		console.error(LOG_PREFIX, "listAudioApps failed:", e);
		return [];
	}
}

/**
 * Turn the picker's PID list into INCLUDE targets: integers only, deduped, never one of ours,
 * and only PIDs that still have an audio session right now. A PID remembered from an earlier
 * picker may since have exited and been reused by an unrelated process — or by one of our own
 * children — so anything the addon no longer lists is dropped rather than captured.
 */
function resolveIncludeTargets(pids: unknown, wasapi: WasapiAddon): number[] {
	const own = ownProcessIds();
	let listed: Set<number> | undefined;
	if (typeof wasapi.listAudioApps === "function") {
		try {
			listed = new Set(wasapi.listAudioApps().map((a) => a.processId));
		} catch {
			listed = new Set(); // can't verify anything ⇒ capture nothing
		}
	}

	const targets: number[] = [];
	for (const pid of Array.isArray(pids) ? pids : []) {
		if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff || targets.includes(pid)) continue;
		if (own.has(pid)) {
			console.warn(LOG_PREFIX, `Refusing to INCLUDE-capture our own process ${pid}`);
			continue;
		}
		if (listed && !listed.has(pid)) {
			console.warn(LOG_PREFIX, `Dropping stale include target ${pid} (no audio session any more)`);
			continue;
		}
		targets.push(pid);
	}
	return targets;
}

// ── Capture state ─────────────────────────────────────────────────────────────────────────
interface Capture {
	captureId: number;
	sessionIds: number[];
	// Source indices whose native stream is still alive.
	live: Set<number>;
	port?: MessagePortMain;
	ready: boolean;
	closed: boolean;
	settle?: (why: "ready" | "closed") => void;
}

let current: Capture | undefined;
let lastCaptureId = 0;

/** The captureId of the running (or starting) capture, if any. */
export function currentWasapiCaptureId(): number | undefined {
	return current?.captureId;
}

// The addon's onChunk delivers a napi Buffer (480-frame / stereo / f32 = 3840 bytes); forward its
// bytes down the kept MessagePort. COPY into a fresh ArrayBuffer (the Buffer may share/reuse V8
// backing memory) so the structured clone over the port is stable.
function toArrayBuffer(chunk: Buffer): ArrayBuffer {
	const out = new ArrayBuffer(chunk.byteLength);
	new Uint8Array(out).set(chunk);
	return out;
}

function stopNativeSessions(ids: number[]) {
	const wasapi = addon;
	if (!wasapi) return;
	for (const id of ids) {
		try {
			if (typeof wasapi.stopSession === "function") wasapi.stopSession(id);
			else wasapi.stopAll(); // pre-per-session addon: one capture at a time anyway
		} catch {
			// best-effort; stops are idempotent with a bounded native join
		}
	}
}

/**
 * Tear one capture down. Native first so no more chunks are produced; then tell the renderer
 * (unless it is the side that went away) and close the port. Idempotent.
 */
function stopCapture(cap: Capture, reason: string, notifyRenderer = true) {
	if (cap.closed) return;
	cap.closed = true;
	if (current === cap) current = undefined;

	stopNativeSessions(cap.sessionIds);

	const port = cap.port;
	if (port) {
		if (notifyRenderer) {
			try {
				port.postMessage({ type: "stopped", captureId: cap.captureId });
			} catch {
				// already closed
			}
		}
		try {
			port.close();
		} catch {
			// already closed
		}
	}
	cap.settle?.("closed");
	console.log(LOG_PREFIX, `WASAPI capture ${cap.captureId} stopped (${reason})`);
}

/** What the screenshare picker sends us. `pids` is only meaningful in "app" mode. */
export interface WasapiAudioConfig {
	mode: "none" | "system" | "app";
	pids: number[];
}

/**
 * Outcome of a capture attempt:
 *   "started"       — native capture running and the renderer holds its port; caller must NOT
 *                     also request Chromium "loopback".
 *   "unsupported"   — nothing started; caller may fall back to Chromium "loopback".
 *   "failed-closed" — app mode was requested and could not be honoured, or this attempt was
 *                     superseded by a newer one. The caller must leave audio UNSET rather than fall
 *                     back: falling back to system-wide "loopback" when the user explicitly asked for
 *                     one app is a privacy inversion (it would broadcast every app plus the call
 *                     itself), and next to a newer native capture it is the concurrent-loopback crash.
 */
export type WasapiStartResult = "started" | "unsupported" | "failed-closed";

/**
 * Start native capture for the requested mode behind the MessageChannelMain transport, replacing
 * any current capture. Resolves "started" only once the renderer has acknowledged this capture,
 * so the display-media callback (and Discord's getDisplayMedia) resolves after the page knows it.
 */
export async function startWasapiCapture(audioConfig: WasapiAudioConfig, options: { readyTimeoutMs?: number } = {}): Promise<WasapiStartResult> {
	const mode = audioConfig?.mode;
	if (!wasapiAvailable() || (mode !== "system" && mode !== "app")) return "unsupported";
	const fallback: WasapiStartResult = mode === "app" ? "failed-closed" : "unsupported";

	const wasapi = obtainWasapiLoopback();
	if (!wasapi) return fallback;

	// One capture at a time: whatever was running belongs to a share this request replaces.
	const captureId = ++lastCaptureId;
	if (current) stopCapture(current, "replaced");

	// App mode with nothing (valid) selected has no meaning — treat it as "user asked for app
	// audio and we have none", i.e. fail closed rather than silently broadcasting the whole system.
	const targets = mode === "app" ? resolveIncludeTargets(audioConfig.pids, wasapi) : [];
	if (mode === "app" && targets.length === 0) return "failed-closed";

	const cap: Capture = { captureId, sessionIds: [], live: new Set(), ready: false, closed: false };

	// One chunk sink per source index. Chunks are dropped until the renderer has acked this
	// capture and after it stops; never let a throw inside the threadsafe callback become an
	// uncaught main-process exception.
	const sink = (index: number) => (err: unknown, chunk: Buffer) => {
		if (cap.closed) return;
		if (err) {
			console.warn(LOG_PREFIX, `WASAPI source ${index} of capture ${captureId} ended:`, err);
			cap.live.delete(index);
			if (cap.live.size === 0) stopCapture(cap, "native stream ended");
			return;
		}
		if (!cap.ready || !cap.port || !chunk) return;
		try {
			// Electron's MAIN-process MessagePortMain.postMessage transfer list accepts ONLY
			// MessagePortMain instances — NOT ArrayBuffers (unlike the renderer/DOM MessagePort).
			// Send the buffer as the MESSAGE (structured-cloned, ~384 KB/s per source).
			cap.port.postMessage({ index, pcm: toArrayBuffer(chunk) });
		} catch {
			stopCapture(cap, "port failed", false);
		}
	};

	try {
		const add = (index: number, id: number) => {
			if (!id) return false;
			cap.sessionIds.push(id);
			cap.live.add(index);
			return true;
		};
		if (mode === "app") {
			// INCLUDE one session per selected app — the VAC-immune allowlist path.
			targets.forEach((pid, i) => {
				if (!add(i, wasapi.startIncludeProcessTree(pid, sink(i)))) console.warn(LOG_PREFIX, `WASAPI INCLUDE capture failed for pid ${pid}`);
			});
		} else {
			// EXCLUDE our own tree — "share whole screen" audio. EXCLUDE_TARGET_PROCESS_TREE covers
			// the separate "Audio Service" utility child, so our own call playback never re-enters.
			add(0, wasapi.startExcludeProcessTree(process.pid, sink(0)));
		}
	} catch (e: unknown) {
		console.error(LOG_PREFIX, "WASAPI capture failed to start:", e);
		stopCapture(cap, "start threw");
		return fallback;
	}
	if (cap.sessionIds.length === 0) {
		cap.closed = true;
		return fallback;
	}

	// Native capture is actually running — only now hand the renderer a port. MessageChannelMain
	// is the canonical Electron zero-copy audio path — NEVER per-frame ipcRenderer.send of raw PCM.
	const webContents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined;
	if (!webContents || webContents.isDestroyed()) {
		stopCapture(cap, "no main window");
		return fallback;
	}

	const channel = new MessageChannelMain();
	cap.port = channel.port1;
	current = cap;

	const timeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
	const readiness = new Promise<"ready" | "closed" | "timeout">((resolve) => {
		const timer = setTimeout(() => resolve("timeout"), timeoutMs);
		cap.settle = (why) => {
			clearTimeout(timer);
			cap.settle = undefined;
			resolve(why);
		};
	});

	cap.port.on("message", (e) => {
		const data = e.data;
		if (cap.closed || cap.ready || data?.type !== "ready" || data.captureId !== captureId) return;
		cap.ready = true;
		cap.settle?.("ready");
	});
	// The renderer end disappearing (page reload/crash) ends the capture; nobody is listening.
	cap.port.on("close", () => stopCapture(cap, "renderer port closed", false));
	cap.port.start();

	try {
		webContents.postMessage("wasapi:pcm-port", { captureId }, [channel.port2]);
	} catch (e: unknown) {
		console.error(LOG_PREFIX, "Failed to hand the WASAPI port to the renderer:", e);
		stopCapture(cap, "port transfer failed", false);
		return fallback;
	}

	const outcome = await readiness;
	if (outcome === "ready" && current === cap && !cap.closed) {
		console.log(LOG_PREFIX, mode === "app" ? `WASAPI INCLUDE capture ${captureId} streaming (${cap.sessionIds.length}/${targets.length} app${targets.length === 1 ? "" : "s"})` : `WASAPI EXCLUDE-tree capture ${captureId} streaming`);
		return "started";
	}
	if (outcome === "timeout") {
		console.warn(LOG_PREFIX, `Renderer never acknowledged WASAPI capture ${captureId}`);
		stopCapture(cap, "ready timeout");
	}
	// Superseded by a newer attempt: that one owns audio now, so no fallback of any kind.
	return lastCaptureId !== captureId ? "failed-closed" : fallback;
}

/**
 * Stop native capture. With a captureId, only that capture is stopped and a stale id (an
 * earlier share, a late renderer teardown) is ignored. Without one it is a full shutdown.
 * Idempotent.
 */
export async function stopWasapiLoopback<IPCHandle>(captureId?: number) {
	if (captureId === undefined || captureId === null) {
		if (current) stopCapture(current, "stop requested");
		try {
			addon?.stopAll();
		} catch {
			// best-effort; stopAll() is idempotent and a throw here is non-fatal
		}
		return;
	}
	if (typeof captureId !== "number" || !Number.isSafeInteger(captureId)) return;
	if (current && current.captureId === captureId) stopCapture(current, "stop requested");
}

// A hung native stop must not wedge quit (mirror patchcord.ts:168-184 Promise.race([dispose, timeout])).
// Only a running capture defers quit, so the app.quit() below re-enters with nothing to do
// instead of looping forever on "the addon is loaded".
let quitStopInFlight = false;
app.on("before-quit", (event) => {
	if (quitStopInFlight) {
		event.preventDefault();
		return;
	}
	if (!current) return;

	event.preventDefault();
	quitStopInFlight = true;
	Promise.race([stopWasapiLoopback(), new Promise((resolve) => setTimeout(resolve, 1500))])
		.catch((err) => console.error(LOG_PREFIX, "WASAPI stop failed:", err))
		.finally(() => {
			quitStopInFlight = false;
			current = undefined;
			app.quit();
		});
});
