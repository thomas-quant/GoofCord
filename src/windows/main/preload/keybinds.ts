import { contextBridge, ipcRenderer } from "electron";

import { invoke } from "../../../ipc/client.preload.ts";
import { warn } from "../../../modules/logger.preload.ts";
import { keyCodeToDomCode, parseDiscordShortcut } from "./keybindShortcut.ts";

interface Keybind {
	shortcut: string;
	eventSettings: {
		keyCode: number;
		ctrlKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
		code?: string;
		key?: string;
	};
}

const getActiveKeybinds = (): Map<string, Keybind> => {
	const activeKeybinds = new Map<string, Keybind>();
	const keybindsRaw = window.localStorage.getItem("keybinds");

	if (!keybindsRaw) return activeKeybinds;

	const keybinds = JSON.parse(keybindsRaw)?._state;
	if (!keybinds) return activeKeybinds;

	for (const bind in keybinds) {
		const binding = keybinds[bind];

		// We are only interested in user defined keybinds
		if (binding.managed === true || binding.enabled === false) continue;

		const { shortcut, mainKeyCode, ctrl, alt, shift } = parseDiscordShortcut(binding.shortcut);

		if (!shortcut || mainKeyCode === undefined) continue;

		// Non-printable keys (PageUp/Insert/F-keys/…) only match Discord's keybind handler when the
		// synthetic event carries a DOM `code`/`key`; printable keys leave these unset (matched by keyCode).
		const domCode = keyCodeToDomCode(mainKeyCode);

		activeKeybinds.set(macroCaseToTitleCase(binding.action), {
			shortcut,
			eventSettings: {
				keyCode: mainKeyCode,
				ctrlKey: ctrl,
				altKey: alt,
				shiftKey: shift,
				...(domCode ? { code: domCode, key: domCode } : {}),
			},
		});
	}

	return activeKeybinds;
};

// HELLO_WORLD -> Hello World
const macroCaseToTitleCase = (input: string): string => {
	return input
		.toLowerCase()
		.split("_")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
};

let activeKeybinds: Map<string, Keybind> = getActiveKeybinds();

function updateKeybinds() {
	activeKeybinds = getActiveKeybinds();
	const toSend: {
		id: string;
		name?: string | undefined;
		shortcut?: string | undefined;
	}[] = [];

	for (const [key, value] of activeKeybinds) {
		toSend.push({
			id: key,
			name: key,
			shortcut: value.shortcut,
		});
	}
	console.log(toSend);
	void invoke("venbind:setKeybinds", toSend);
}

export const KeybindApi = {
	updateKeybinds: debounce(updateKeybinds, 1000),
};

export function startKeybindWatcher() {
	updateKeybinds();

	// See postVencord/keybinds.ts
	contextBridge.exposeInMainWorld("keybinds", KeybindApi);
}

ipcRenderer.on("keybinds:getAll", () => {
	return activeKeybinds;
});

ipcRenderer.on("keybinds:trigger", (_, id, keyup) => {
	const keybind = activeKeybinds.get(id);
	if (!keybind) {
		warn("Keybind not found: " + id);
		return;
	}

	const event = new KeyboardEvent(keyup ? "keyup" : "keydown", keybind.eventSettings);

	document.dispatchEvent(event);
});

function debounce<T extends (...args: Parameters<T>) => void>(func: T, timeout = 300) {
	let timer: Timer;
	return (...args: Parameters<T>): void => {
		clearTimeout(timer);
		timer = setTimeout(() => func(...args), timeout);
	};
}
