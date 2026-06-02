import { getConfig, setConfig } from "@root/src/stores/config/config.preload.ts";
import { contextBridge, ipcRenderer } from "electron";

import { invoke, sendSync } from "../../../ipc/client.preload.ts";
import { type Config, type ConfigKey, getDefaults, isEncrypted } from "../../../settingsSchema.ts";
import { flashTitlebar, flashTitlebarWithText } from "./titlebarFlash.ts";

export let isVencordPresent = false;
export function setVencordPresent(value: boolean) {
	isVencordPresent = value;
}

const api = {
	window: {
		show: () => invoke("window:Show"),
		hide: () => invoke("window:Hide"),
		minimize: () => invoke("window:Minimize"),
		maximize: () => invoke("window:Maximize"),
		close: () => invoke("window:Close"),
	},
	titlebar: {
		flashTitlebar: (color: string) => flashTitlebar(color),
		flashTitlebarWithText: (color: string, text: string) => flashTitlebarWithText(color, text),
	},
	arrpc: {
		onActivity: (callback: (dataJson: string) => void) => ipcRenderer.on("arrpc:activity", (_event, dataJson: string) => callback(dataJson)),
		onInvite: (callback: (code: string) => void) => ipcRenderer.on("arrpc:invite", (_event, code) => callback(code)),
	},
	version: sendSync("utils:getVersion"),
	displayVersion: sendSync("utils:getDisplayVersion"),
	getVersions: () => process.versions,
	getConfig: <K extends ConfigKey>(key: K) => {
		if (isEncrypted(key)) {
			return getDefaults()[key];
		}
		return getConfig(key);
	},
	setConfig: <K extends ConfigKey>(key: K, value: Config[K]) => setConfig(key, value),
	encryptMessage: (message: string, salt: string) => sendSync("messageEncryption:encryptMessage", message, salt),
	decryptMessage: (message: string, salt: string) => sendSync("messageEncryption:decryptMessage", message, salt),
	cycleThroughPasswords: () => invoke("messageEncryption:cycleThroughPasswords"),
	openSettingsWindow: () => invoke("settings:createSettingsWindow"),
	setBadgeCount: (count: number) => invoke("dynamicIcon:setBadgeCount", count),
	stopPatchcord: () => invoke("patchcord:stopPatchcord"),
	// THROWAWAY — Phase 3 delivery-path spike (GOOFCORD_DELIVERY_SPIKE); strip before upstream PR.
	deliverySpike: sendSync("screenshareDebug:isDeliverySpikeEnabled"),
	appendScreenshareDebug: (line: string) => invoke("screenshareDebug:appendScreenshareDebug", line),
	// THROWAWAY — Phase 4 transport spike (GOOFCORD_TRANSPORT_SPIKE); strip before upstream PR.
	// Tears the native WASAPI capture down from the main-world STREAM_CLOSE handler (mirror stopPatchcord).
	stopWasapiLoopback: () => invoke("wasapiLoopback:stopWasapiLoopback"),
	// Hop-2 FALLBACK: if the zero-copy port-forward is not honored into the injected main world,
	// the preload lands PCM here and the main-world feeder is invoked via this structured-clone path.
	feedWasapiChunk: (callback: (chunk: ArrayBuffer) => void) => ipcRenderer.on("wasapi:pcm-chunk", (_event, chunk: ArrayBuffer) => callback(chunk)),
	isVencordPresent: () => isVencordPresent,
	onInvidiousConfigChanged: (callback: () => void) => ipcRenderer.on("invidiousConfigChanged", callback),
	openQuickCssWindow: () => invoke("quickCssFix:createQuickCssWindow"),
};

contextBridge.exposeInMainWorld("goofcord", api);
export type GoofCordApi = typeof api;
