// @ts-nocheck Bun will not install venbind on macOS, so typescript won't compile with checks

import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { app } from "electron";
import { isWayland } from "@root/src/utils.ts";
// @ts-expect-error
import venbindPath from "native-module:../../../assets/native/venbind-*.node";
import pc from "picocolors";
// @ts-ignore Venbind may not be installed on all platforms
import type { Venbind as VenbindType } from "venbind";

import { mainWindow } from "../../windows/main/main.ts";

const require = createRequire(import.meta.url);

let venbind: VenbindType | undefined;
let venbindLoadAttempted = false;

// TEMP DIAGNOSTIC (diag/keybind-venbind-fire) — REVERT before merge.
// On the test box there is no DevTools, so route the signal to a file:
// <userData>/keybind-debug.log. This tells us whether venbind REGISTERS named keys
// (e.g. "pageup") and whether it FIRES on a real press — bisecting the global chain
// into "venbind side" vs "Discord matcher side".
function kbLog(msg: string) {
	try {
		appendFileSync(join(app.getPath("userData"), "keybind-debug.log"), `[${new Date().toISOString()}] ${msg}\n`);
	} catch {}
}

export async function obtainVenbind() {
	if (venbind !== undefined || process.argv.some((arg) => arg === "--no-venbind") || venbindLoadAttempted || !venbindPath) return venbind;
	try {
		venbind = require(venbindPath);
		if (!venbind) throw new Error("Venbind is undefined");
		await startVenbind(venbind);
		console.log(pc.green("[Venbind]"), "Loaded venbind");
	} catch (e: unknown) {
		console.error("Failed to import venbind", e);
	}
	venbindLoadAttempted = true;
	return venbind;
}

export async function startVenbind(venbind: VenbindType) {
	kbLog("startVenbind: hooking keybinds");
	venbind?.defineErrorHandle((err: string) => {
		kbLog(`venbind error: ${err}`);
		console.error("venbind error:", err);
	});
	venbind?.startKeybinds((id, keyup) => {
		let focused: boolean | string;
		try {
			focused = mainWindow?.isFocused?.();
		} catch {
			focused = "no-window";
		}
		kbLog(`FIRE id=${JSON.stringify(id)} keyup=${keyup} focused=${focused} wayland=${isWayland}`);
		if (!isWayland && mainWindow.isFocused()) return;
		mainWindow.webContents.send("keybinds:trigger", id, keyup);
	}, null);
}

export async function setKeybinds<IPCHandle>(keybinds: { id: string; name?: string; shortcut?: string }[]) {
	kbLog(`REGISTER ${JSON.stringify(keybinds.map((k) => k.shortcut))}`);
	console.log(pc.green("[Venbind]"), "Setting keybinds");
	(await obtainVenbind())?.setKeybinds(keybinds);
}

export async function isVenbindLoaded<IPCHandle>() {
	return (await obtainVenbind()) !== undefined;
}

// TEMP DIAGNOSTIC — reliable main-world -> file logging channel (appendFileSync flushes immediately,
// unlike localStorage). The preload forwards probe/dispatch findings here.
export async function keybindDebugLog<IPCHandle>(msg: string) {
	kbLog(msg);
}
