import path from "node:path";

import { hasPipewirePulse, patchcordList, patchcordStartApp, patchcordStartSystem } from "@root/src/modules/native/patchcord.ts";
// Windows WASAPI screenshare audio (the #46 fix). Additive 3-way audio gate:
// Linux patchcord → win32 native capture (INCLUDE per app / EXCLUDE self) → "loopback" fallback.
import { isWasapiAvailable, listWasapiAudioApps, startWasapiCapture } from "@root/src/modules/native/wasapiLoopback.ts";
import { BrowserWindow, desktopCapturer, ipcMain, session } from "electron";
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

async function fetchScreenshareData(isRefresh = false) {
	// If it's a manual refresh AND we are on Wayland, skip fetching video sources to prevent re-triggering the OS portal.
	const skipSources = isRefresh && isWayland;

	// Per-app audio sources: patchcord on Linux, WASAPI audio-session enumeration on Windows.
	// Both yield { processId, displayName } so the picker renders them identically.
	const [rawSources, audioNodes] = await Promise.all([skipSources ? null : desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } }), process.platform === "linux" ? patchcordList().catch(() => [] as ShareableNode[]) : listWasapiAudioApps()]);

	return {
		sources:
			rawSources?.map((s) => ({
				id: s.id,
				name: s.name || "unknown",
				thumbnail: s.thumbnail.toDataURL(),
			})) ?? null,
		audioNodes,
		// Show the 3-mode audio UI (none / system / app) wherever per-app capture exists.
		hasAdvancedAudio: hasPipewirePulse || isWasapiAvailable(),
		// Only patchcord can do "system MINUS these apps". WASAPI's activation struct has a single
		// TargetProcessId, spent excluding ourselves — so Windows must NOT offer an exclusion list.
		supportsAudioExclude: hasPipewirePulse,
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
		if (!req) return;

		activeRequests.delete(event.sender.id);
		const { callback, window, frame } = req;

		if (!id) {
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
			} else if (process.platform === "win32") {
				// Windows native WASAPI capture: INCLUDE the selected app(s) in "app" mode, or
				// EXCLUDE our own tree in "system" mode (the #46 echo fix).
				const outcome = await startWasapiCapture(audioConfig);

				if (outcome === "started") {
					// Do NOT also request Chromium "loopback" here. The addon is already running its OWN
					// WASAPI loopback capture, and a SECOND concurrent WASAPI loopback (Chromium's) fighting
					// over the same shared Windows audio session corrupts it → CoreMessaging.dll heap-
					// corruption HARD CRASH on system-audio shares (confirmed: crash only with wasapi ON +
					// system audio; Chromium loopback alone and the addon alone are each fine). Leaving
					// result.audio unset means Chromium captures NO audio; the swap seam adds the
					// reconstructed track to the (audio-less) stream — the addon is the sole capturer
					// (and the seam discarded Chromium's loopback track anyway, so nothing is lost).
				} else if (outcome === "failed-closed") {
					// The user asked for specific apps and we could not capture them. Falling back to
					// Chromium "loopback" would broadcast EVERY app plus the call itself — a privacy
					// inversion, and exactly the echo we are fixing. Ship the share without audio.
					console.warn(pc.cyan("[Screenshare]"), "Per-app WASAPI capture unavailable; sharing without audio rather than falling back to system capture");
				} else {
					result.audio = "loopback";
					console.log(pc.cyan("[Screenshare]"), "WASAPI process-loopback unsupported on this build, using loopback fallback");
				}
			} else {
				result.audio = "loopback";
			}
		}

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
			if (activeRequests.has(wcId)) {
				activeRequests.delete(wcId);
				callback({});
			}
		});

		capturerWindow.center();
		void capturerWindow.loadFile(relToAbs(html.index));
	});
}
