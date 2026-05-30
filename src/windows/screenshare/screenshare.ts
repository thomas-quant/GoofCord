import fs from "node:fs";
import path from "node:path";

import { hasPipewirePulse, patchcordList, patchcordStartApp, patchcordStartSystem } from "@root/src/modules/native/patchcord.ts";
import { BrowserWindow, desktopCapturer, ipcMain, session } from "electron";
import type { ShareableNode } from "patchcord";

import { dirname, isWayland, relToAbs, userDataPath } from "../../utils.ts";
import html from "./renderer/screenshare.html";

// ─── [ScreenshareDebug] DIAGNOSTIC INSTRUMENTATION ──────────────────────────
// Revert this whole commit before the upstream PR (D-04). A packaged NSIS GUI build has no
// attached console, so main-process probes (B/C) append to a file under userData (D-02).
let debugRequestCount = 0;
function appendDebugLog(line: string) {
	try {
		fs.appendFileSync(path.join(userDataPath, "screenshare-debug.log"), `${new Date().toISOString()} ${line}\n`);
	} catch {
		// Never let a debug-log write failure throw into the screenshare handler.
	}
}
// ────────────────────────────────────────────────────────────────────────────

interface ActiveRequest {
	callback: (res: any) => void;
	window: BrowserWindow;
	frame: any;
	initialPromise?: Promise<any>;
}

const activeRequests = new Map<number, ActiveRequest>();

async function fetchScreenshareData(isRefresh = false) {
	// If it's a manual refresh AND we are on Wayland, skip fetching video sources to prevent re-triggering the OS portal.
	const skipSources = isRefresh && isWayland;

	const [rawSources, audioNodes] = await Promise.all([skipSources ? null : desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } }), process.platform === "linux" ? patchcordList().catch(() => [] as ShareableNode[]) : []]);

	return {
		sources:
			rawSources?.map((s) => ({
				id: s.id,
				name: s.name || "unknown",
				thumbnail: s.thumbnail.toDataURL(),
			})) ?? null,
		audioNodes,
		isPatchcord: hasPipewirePulse,
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
		const req = activeRequests.get(event.sender.id);
		if (!req) {
			appendDebugLog(`[ScreenshareDebug][C] selectScreenshareSource: no active request (early return) for wcId=${event.sender.id}`);
			return;
		}

		activeRequests.delete(event.sender.id);
		const { callback, window, frame } = req;

		if (!id) {
			appendDebugLog(`[ScreenshareDebug][C] cancel callback({}) for wcId=${event.sender.id}`);
			callback({});
			if (!window.isDestroyed()) window.close();
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
			} else {
				result.audio = "loopback";
			}
		}

		appendDebugLog(`[ScreenshareDebug][C] grant callback(result) for wcId=${event.sender.id} audio=${result.audio ?? "none"}`);
		callback(result);
		if (!window.isDestroyed()) window.close();
	});

	ipcMain.handle("showScreenshareWindow", (event) => {
		const req = activeRequests.get(event.sender.id);
		if (req && !req.window.isDestroyed()) {
			req.window.show();
			req.window.focus();
		}
	});

	session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
		const debugReqNum = ++debugRequestCount;
		appendDebugLog(`[ScreenshareDebug][B] setDisplayMediaRequestHandler fired #${debugReqNum} (proves main handler reached on second click → H2)`);
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
		appendDebugLog(`[ScreenshareDebug][B] request #${debugReqNum} wcId=${wcId}`);

		activeRequests.set(wcId, { callback, window: capturerWindow, frame: request.frame, initialPromise: fetchScreenshareData(false) });

		capturerWindow.once("closed", () => {
			const willFire = activeRequests.has(wcId);
			appendDebugLog(`[ScreenshareDebug][C] closed handler for wcId=${wcId} firesCallback=${willFire}`);
			if (willFire) {
				activeRequests.delete(wcId);
				callback({});
			}
		});

		capturerWindow.center();
		void capturerWindow.loadFile(relToAbs(html.index));
	});
}
