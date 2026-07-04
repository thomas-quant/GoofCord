import path from "node:path";

import { hasPipewirePulse, patchcordList, patchcordStartApp, patchcordStartSystem } from "@root/src/modules/native/patchcord.ts";
// Windows WASAPI native capture (the #46 echo fix + per-app INCLUDE). Additive 3-way audio gate:
// Linux patchcord → win32 native (config-dispatched, fail-closed verdict) → universal "loopback" fallback.
import { canRunWasapiCapture, listWasapiAudioApps, tryStartWasapiLoopback } from "@root/src/modules/native/wasapiLoopback.ts";
import { app, BrowserWindow, desktopCapturer, ipcMain, session } from "electron";
import type { ShareableNode } from "patchcord";
import pc from "picocolors";

import { dirname, isWayland, relToAbs } from "../../utils.ts";
import html from "./renderer/screenshare.html";

interface ActiveRequest {
	callback: (res: any) => void;
	window: BrowserWindow;
	frame: any;
	initialPromise?: Promise<any>;
}

const activeRequests = new Map<number, ActiveRequest>();

// Single-owner, exactly-once teardown for a screenshare request (Pitfall 3).
// The map-delete is the idempotency token: the first caller to reach a live entry
// owns the callback + window close; every later caller (select/cancel vs. the window
// `closed` event racing) hits the `!req` guard and is a no-op. Delete BEFORE the
// callback so a re-entrant `closed` during the callback can't double-fire.
function finishRequest(wcId: number, result: any) {
	const req = activeRequests.get(wcId);
	if (!req) return;
	activeRequests.delete(wcId);
	try {
		req.callback(result);
	} catch {
		// Swallow a throw from the Electron callback so teardown (window close) still completes.
	}
	if (!req.window.isDestroyed()) req.window.close();
}

// win32 audio-app enumeration for the picker checklist. Maps the addon's audio-session list into the
// renderer's ShareableNode contract (only processId/displayName/binary are consumed) and drops
// GoofCord's own Audio Service child PID — only the main process can resolve it — mirroring
// patchcordList's self-filter. Fail-closed to [] on any error (listWasapiAudioApps is already guarded).
function listWin32AudioNodes(): ShareableNode[] {
	try {
		const audioPid = app.getAppMetrics().find((p) => p.name === "Audio Service")?.pid;
		return listWasapiAudioApps()
			.filter((a) => a.processId !== audioPid)
			.map((a) => ({
				id: a.processId,
				displayName: a.displayName,
				applicationName: null,
				nodeName: null,
				description: null,
				mediaName: null,
				binary: a.binary,
				processId: a.processId,
				isDevice: false,
			}));
	} catch {
		return [];
	}
}

async function fetchScreenshareData(isRefresh = false) {
	// If it's a manual refresh AND we are on Wayland, skip fetching video sources to prevent re-triggering the OS portal.
	const skipSources = isRefresh && isWayland;

	const [rawSources, audioNodes] = await Promise.all([skipSources ? null : desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } }), process.platform === "linux" ? patchcordList().catch(() => [] as ShareableNode[]) : process.platform === "win32" ? listWin32AudioNodes() : []]);

	return {
		sources:
			rawSources?.map((s) => ({
				id: s.id,
				name: s.name || "unknown",
				thumbnail: s.thumbnail.toDataURL(),
			})) ?? null,
		audioNodes,
		isPatchcord: hasPipewirePulse,
		// win32 advanced-UI signal: true when the native addon can run → picker shows the audio-mode
		// control + app checklist instead of the plain system checkbox.
		isWasapiAudio: canRunWasapiCapture(),
	};
}

export function registerScreenshareHandler() {
	ipcMain.removeHandler("refreshScreenshareSources");
	ipcMain.removeHandler("selectScreenshareSource");
	ipcMain.removeHandler("showScreenshareWindow");

	ipcMain.handle("refreshScreenshareSources", async (event) => {
		const req = activeRequests.get(event.sender.id);

		if (req?.initialPromise) {
			const res = await req.initialPromise;
			req.initialPromise = undefined;
			return res;
		}

		return fetchScreenshareData(true);
	});

	ipcMain.handle("selectScreenshareSource", async (event, id, name, audioConfig, contentHint, resolution, framerate) => {
		const wcId = event.sender.id;
		// Snapshot what we need to read before any `await` — finishRequest owns the
		// delete + callback + close, so we never pre-delete or call the callback here.
		const req = activeRequests.get(wcId);
		if (!req) return;
		const { frame } = req;

		if (!id) {
			finishRequest(wcId, {});
			return;
		}

		if (frame) {
			frame.executeJavaScript(`window.screenshareSettings = ${JSON.stringify({ resolution, framerate, contentHint })};`).catch(() => {});
		}

		const result: any = { video: { id, name, width: 9999, height: 9999 } };

		if (audioConfig.mode !== "none") {
			if (hasPipewirePulse && process.platform === "linux") {
				try {
					await (audioConfig.mode === "system" ? patchcordStartSystem : patchcordStartApp)(audioConfig.pids);
				} catch (err) {
					console.error("[Screenshare] Failed to start patchcord node:", err);
				}
			} else if (process.platform === "win32") {
				// Windows native WASAPI capture, dispatched on audioConfig (EXCLUDE-self for
				// system+process-exclude, per-app INCLUDE for app mode; endpoint mode fails closed until
				// Plan 04). The verdict enforces fail-closed: only system+process-exclude may fall back.
				const verdict = await tryStartWasapiLoopback(audioConfig);
				if (verdict === "started") {
					// Native capture is running — leave result.audio UNSET.
					// Do NOT also request Chromium "loopback" here. The addon is already running its OWN
					// WASAPI loopback capture, and a SECOND concurrent WASAPI loopback (Chromium's) fighting
					// over the same shared Windows audio session corrupts it → CoreMessaging.dll heap-
					// corruption HARD CRASH on system-audio shares (confirmed: crash only with wasapi ON +
					// system audio; Chromium loopback alone and the addon alone are each fine). Leaving
					// result.audio unset means Chromium captures NO audio; the swap seam adds the
					// reconstructed native track to the (audio-less) stream — the addon is the sole
					// capturer (and the seam discarded Chromium's loopback track anyway, so nothing is lost).
				} else if (verdict === "unsupported-fallback-ok") {
					// system+process-exclude only: the dynamic OS floor rejected the native path; the
					// Chromium "loopback" fallback is acceptable here (byte-behavior-identical to #211).
					result.audio = "loopback";
					console.log(pc.cyan("[Screenshare]"), "WASAPI process-loopback unsupported on this build, using loopback fallback");
				} else {
					// "failed-no-fallback": app / explicit-endpoint activation failed. FAIL CLOSED — leave
					// result.audio UNSET. NEVER a broad Chromium "loopback" fallback: the user asked for ONE
					// app / ONE device, and a silent fallback would capture everything (privacy inversion) +
					// risk the CoreMessaging crash. Silence is the correct, safe outcome.
					console.log(pc.cyan("[Screenshare]"), "app/endpoint audio failed closed — no audio (never falling back to loopback)");
				}
			} else {
				result.audio = "loopback";
				console.log(pc.cyan("[Screenshare]"), "Non-Windows/Linux platform, using loopback fallback");
			}
		}

		finishRequest(wcId, result);
	});

	ipcMain.handle("showScreenshareWindow", (event) => {
		const req = activeRequests.get(event.sender.id);
		if (req && !req.window.isDestroyed()) {
			req.window.show();
			req.window.focus();
		}
	});

	session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
		const capturerWindow = new BrowserWindow({
			width: 800,
			height: 650,
			minWidth: 600,
			minHeight: 500,
			resizable: true,
			frame: true,
			autoHideMenuBar: true,
			backgroundColor: "#27292e",
			show: false,
			webPreferences: {
				sandbox: true,
				preload: path.join(dirname(), "windows/screenshare/preload/preload.js"),
			},
		});

		const wcId = capturerWindow.webContents.id;

		activeRequests.set(wcId, { callback, window: capturerWindow, frame: request.frame, initialPromise: fetchScreenshareData(false) });

		capturerWindow.once("closed", () => {
			// Idempotent: if select/cancel already ran, the entry is gone and
			// finishRequest is a no-op (its `!req` guard). Otherwise (OS close button /
			// window destroyed mid-request) this is the cancel path.
			finishRequest(wcId, {});
		});

		capturerWindow.center();
		void capturerWindow.loadFile(relToAbs(html.index));
	});
}
