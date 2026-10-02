// Windows screenshare audio: EXCLUDE our main process tree for system audio, or
// INCLUDE explicitly selected non-overlapping process trees mixed by wasapiTransport.
// Process loopback is endpoint-independent. Other processes re-rendering our audio
// (e.g. Sonar) can remain audible; this is not semantic echo cancellation.
// Native start -> captureId-tagged MessagePort -> renderer ready -> PCM. Failed
// native/transport attempts never fall back to broader Chromium system audio.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { app, MessageChannelMain, type MessagePortMain, Notification } from "electron";
import pc from "picocolors";

import { mainWindow } from "../../windows/main/main.ts";
import { resolveWasapiTrees, sameWasapiProcess, snapshotWasapiProcesses, type WasapiProcessSnapshot } from "./wasapiProcesses.ts";

const require = createRequire(import.meta.url);

const LOG_PREFIX = pc.cyan("[Screenshare]");

// How long startWasapiCapture waits for the renderer's ready ack before giving up.
const READY_TIMEOUT_MS = 2000;

let queryProcesses = snapshotWasapiProcesses;
/** Test seam; production always uses the bounded Windows query. */
export function __setWasapiProcessQueryForTesting(query: typeof snapshotWasapiProcesses) {
	queryProcesses = query;
}

// An app with an enumerated audio session, offered in the picker's per-app list.
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
	startIncludeProcessTree(targetPid: number, onChunk: (err: unknown, chunk: Buffer) => void): number;
	startExcludeProcessTree(rootPid: number, onChunk: (err: unknown, chunk: Buffer) => void): number;
	stopSession?(id: number): void;
	stopAll(): void;
	listAudioApps?(): WasapiAudioApp[];
}

// The user has no console on Windows: a share that ends up silent must say so, and why.
function notifyAudioProblem(title: string, body: string) {
	console.warn(LOG_PREFIX, `${title}: ${body}`);
	try {
		new Notification({ title, body, timeoutType: "default" }).show();
	} catch {
		// notifications unavailable; the log line above still records it
	}
}

const RETRY_HINT = "The share continues without audio. Share again to retry, or pick specific apps under Audio.";
const APP_RETRY_HINT = "The share continues without audio. Share again and re-pick the apps under Audio.";

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
		if (!addon || ["startIncludeProcessTree", "startExcludeProcessTree", "stopSession", "stopAll", "listAudioApps"].some((name) => typeof (addon as unknown as Record<string, unknown>)[name] !== "function")) {
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

// Only win32/x64 ships an addon (build.ts). Other Windows arches never had the echo fix, so they keep
// upstream's Chromium loopback instead of failing closed on an addon that was never packaged.
const WASAPI_ARCHES: readonly string[] = ["x64"];

// Whether the native Windows capture path is usable at all.
function wasapiAvailable(): boolean {
	return process.platform === "win32" && WASAPI_ARCHES.includes(process.arch) && !process.argv.includes("--no-wasapi");
}

/**
 * Whether Windows native capture is available, so the picker can offer the 3-mode audio UI
 * (none / system / app) instead of the bare on-off toggle.
 *
 * NOTE the asymmetry with Linux: patchcord can capture "system MINUS these apps", but Windows
 * system mode excludes only our own process tree. So Windows supports per-app
 * INCLUDE but NOT per-app exclude, and the picker must not offer an exclusion list it cannot honour.
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
 * PIDs an INCLUDE capture must never target: our main process, every Electron child (including Audio Service).
 * resolveWasapiTrees also rejects ancestors and descendants of these roots.
 */
function ownProcessIds(): Set<number> {
	const own = new Set<number>([process.pid]);
	try {
		for (const m of app.getAppMetrics()) own.add(m.pid);
	} catch {
		// metrics unavailable; main is still excluded
	}
	return own;
}

/**
 * Apps with an enumerated audio session, for the picker's per-app include list. This is the Windows
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

/** Request-local trusted identities; never sent to or accepted from the renderer. */
export async function listWasapiPickerApps(): Promise<{ apps: WasapiAudioApp[]; identities: WasapiProcessSnapshot }> {
	const identities: WasapiProcessSnapshot = new Map();
	if (!wasapiAvailable()) return { apps: [], identities };
	try {
		const snapshot = await queryProcesses();
		const apps = listWasapiAudioApps().filter((a) => {
			const identity = snapshot.get(a.processId);
			if (!sameWasapiProcess(identity, identity)) return false;
			identities.set(a.processId, identity!);
			return true;
		});
		return { apps, identities };
	} catch (error) {
		notifyAudioProblem("App audio unavailable", `Cannot verify Windows process identities: ${error instanceof Error ? error.message : String(error)}. Refresh the Audio list to retry.`);
		return { apps: [], identities };
	}
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
	detachRendererListeners?: () => void;
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
	cap.detachRendererListeners?.();
	cap.detachRendererListeners = undefined;

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

/** Unsupported system capture preserves the explicit legacy path. App requests always fail
 * closed if native support/identity verification is unavailable; they never become system audio. */
export type WasapiStartResult = "started" | "unsupported" | "failed-closed";

/**
 * Start native capture for the requested mode behind the MessageChannelMain transport, replacing
 * any current capture. Resolves "started" only once the renderer has acknowledged this capture,
 * so the display-media callback (and Discord's getDisplayMedia) resolves after the page knows it.
 */
export async function startWasapiCapture(audioConfig: WasapiAudioConfig, options: { readyTimeoutMs?: number; identities?: WasapiProcessSnapshot } = {}): Promise<WasapiStartResult> {
	const mode = audioConfig?.mode;
	if (mode !== "system" && mode !== "app") return "unsupported";
	if (!wasapiAvailable()) {
		if (mode === "system") return "unsupported";
		notifyAudioProblem("App audio unavailable", `Native per-app audio is unsupported or disabled. ${APP_RETRY_HINT}`);
		return "failed-closed";
	}

	const captureId = ++lastCaptureId;
	if (current) stopCapture(current, "replaced");
	const cap: Capture = { captureId, sessionIds: [], live: new Set(), ready: false, closed: false };
	current = cap;

	const webContents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined;
	if (!webContents || webContents.isDestroyed()) {
		stopCapture(cap, "no main window");
		return "failed-closed";
	}
	// A reload/crash can happen during the identity query, before any port exists.
	// Bind to this capture, not `current`, so a late old event cannot stop its replacement.
	const onNavigation = (details: Electron.WebContentsDidStartNavigationEventParams) => {
		if (details.isMainFrame && !details.isSameDocument) stopCapture(cap, "renderer document changed");
	};
	const onRendererGone = () => stopCapture(cap, "renderer gone", false);
	webContents.on("did-start-navigation", onNavigation);
	webContents.on("render-process-gone", onRendererGone);
	webContents.on("destroyed", onRendererGone);
	cap.detachRendererListeners = () => {
		webContents.removeListener("did-start-navigation", onNavigation);
		webContents.removeListener("render-process-gone", onRendererGone);
		webContents.removeListener("destroyed", onRendererGone);
	};

	const wasapi = obtainWasapiLoopback();
	if (!wasapi) {
		stopCapture(cap, "addon unavailable");
		if (mode === "system") notifyAudioProblem("Screenshare audio unavailable", `GoofCord's Windows audio addon could not be loaded, so system audio can't be captured. ${RETRY_HINT} Reinstalling GoofCord restores the addon.`);
		else notifyAudioProblem("Screenshare audio unavailable", `GoofCord's Windows audio addon could not be loaded, so app audio can't be captured. ${APP_RETRY_HINT} Reinstalling GoofCord restores the addon.`);
		return "failed-closed";
	}

	let targets: number[] = [];
	if (mode === "app") {
		try {
			const snapshot = await queryProcesses();
			if (cap.closed || current !== cap) return "failed-closed";
			if (!wasapi.listAudioApps) throw new Error("Audio session enumeration is unavailable");
			targets = resolveWasapiTrees(audioConfig.pids, options.identities, snapshot, new Set(wasapi.listAudioApps().map((a) => a.processId)), ownProcessIds());
		} catch (error) {
			if (cap.closed || current !== cap) return "failed-closed";
			stopCapture(cap, "unverified app selection");
			notifyAudioProblem("Screenshare audio unavailable", `${error instanceof Error ? error.message : String(error)}. ${APP_RETRY_HINT}`);
			return "failed-closed";
		}
	}

	// One chunk sink per source index. Chunks are dropped until the renderer has acked this
	// capture and after it stops; never let a throw inside the threadsafe callback become an
	// uncaught main-process exception.
	const sink = (index: number) => (err: unknown, chunk: Buffer) => {
		if (cap.closed) return;
		if (err) {
			if (!cap.live.delete(index)) return;
			const why = err instanceof Error ? err.message : typeof err === "string" ? err : "native stream failure";
			if (cap.live.size === 0) {
				notifyAudioProblem("Screenshare audio stopped", `Windows ended ${mode} audio capture (${why}). ${mode === "system" ? RETRY_HINT : APP_RETRY_HINT}`);
				stopCapture(cap, "native stream ended");
			} else {
				notifyAudioProblem("Some shared audio stopped", `One selected app's capture ended (${why}). Other selected apps continue. Share again to retry.`);
			}
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

	if (mode === "system" && typeof wasapi.startExcludeProcessTree !== "function") {
		stopCapture(cap, "missing EXCLUDE export");
		notifyAudioProblem("Screenshare audio unavailable", `Windows audio addon is missing startExcludeProcessTree. Update GoofCord. ${RETRY_HINT}`);
		return "failed-closed";
	}

	try {
		const add = (index: number, id: number) => {
			if (!id) return false;
			cap.sessionIds.push(id);
			cap.live.add(index);
			return true;
		};
		if (mode === "app") {
			// INCLUDE only verified, non-overlapping selected roots.
			targets.forEach((pid, i) => {
				if (!add(i, wasapi.startIncludeProcessTree(pid, sink(i)))) console.warn(LOG_PREFIX, `WASAPI INCLUDE capture failed for pid ${pid}`);
			});
		} else {
			add(0, wasapi.startExcludeProcessTree(process.pid, sink(0)));
		}
	} catch (e: unknown) {
		console.error(LOG_PREFIX, "WASAPI capture failed to start:", e);
		stopCapture(cap, "start threw");
		const why = e instanceof Error ? e.message : String(e);
		if (mode === "system") notifyAudioProblem("Screenshare audio unavailable", `System audio failed to start: ${why}. ${RETRY_HINT}`);
		else notifyAudioProblem("Screenshare audio unavailable", `App audio failed to start: ${why}. ${APP_RETRY_HINT}`);
		return "failed-closed";
	}
	if (cap.sessionIds.length === 0) {
		stopCapture(cap, "activation refused");
		if (mode === "system") notifyAudioProblem("Screenshare audio unavailable", `Windows refused process-loopback capture. This requires a supported Windows build (20348 or newer). ${RETRY_HINT}`);
		else if (mode === "app") notifyAudioProblem("Screenshare audio unavailable", `Windows refused to capture audio from the selected app${targets.length === 1 ? "" : "s"}. ${APP_RETRY_HINT}`);
		return "failed-closed";
	}
	if (mode === "app" && cap.sessionIds.length < targets.length) notifyAudioProblem("Some shared audio unavailable", "Windows could not capture every selected app. Only successfully started apps are shared. Share again to retry.");

	// Native capture is actually running — only now hand the renderer a port. MessageChannelMain
	// is the canonical Electron zero-copy audio path — NEVER per-frame ipcRenderer.send of raw PCM.
	if (cap.closed || current !== cap || webContents.isDestroyed()) {
		stopCapture(cap, "renderer unavailable");
		return "failed-closed";
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
		return "failed-closed";
	}

	const outcome = await readiness;
	if (outcome === "ready" && current === cap && !cap.closed) {
		if (mode === "app") {
			console.log(LOG_PREFIX, `WASAPI INCLUDE capture ${captureId} streaming (${cap.sessionIds.length}/${targets.length} app${targets.length === 1 ? "" : "s"})`);
		} else {
			console.log(LOG_PREFIX, `WASAPI EXCLUDE-own-tree capture ${captureId} streaming`);
		}
		return "started";
	}
	if (outcome === "timeout") {
		console.warn(LOG_PREFIX, `Renderer never acknowledged WASAPI capture ${captureId}`);
		stopCapture(cap, "ready timeout");
		notifyAudioProblem("Screenshare audio unavailable", `Discord's page did not accept the audio stream. ${mode === "system" ? RETRY_HINT : APP_RETRY_HINT} Reloading Discord (Ctrl+R) may help.`);
	}
	// Superseded by a newer attempt (that one owns audio now) or failed: no fallback of any kind.
	return "failed-closed";
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
