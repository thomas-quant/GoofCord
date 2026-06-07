import { contextBridge, ipcRenderer } from "electron";

import { invoke } from "../../../ipc/client.preload.ts";
import { warn } from "../../../modules/logger.preload.ts";

interface Keybind {
	shortcut: string;
	eventSettings: {
		keyCode: number;
		ctrlKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
	};
}

// venbind matches a key by its physical character (libuiohook keycode_to_unicode, lowercased),
// so the shortcut we register must contain that character. String.fromCharCode is only an
// accidental identity for ASCII-aligned keyCodes (digits 48-57, letters 65-90); OEM/punctuation
// keyCodes (186-222) map to Latin-1 garbage (e.g. 221 "]" -> "Ý"), which never matched the
// pressed key, so those binds silently never fired. Map the OEM keys explicitly.
const OEM_KEYCODE_CHARS: Record<number, string> = {
	186: ";",
	187: "=",
	188: ",",
	189: "-",
	190: ".",
	191: "/",
	192: "`",
	219: "[",
	220: "\\",
	221: "]",
	222: "'",
};

const keyCodeToChar = (keyCode: number): string => OEM_KEYCODE_CHARS[keyCode] ?? String.fromCharCode(keyCode);

const getActiveKeybinds = (): Map<string, Keybind> => {
	const activeKeybinds = new Map<string, Keybind>();
	const keybindsRaw = window.localStorage.getItem("keybinds");

	if (!keybindsRaw) return activeKeybinds;

	const keybinds = JSON.parse(keybindsRaw)?._state;
	if (!keybinds) return activeKeybinds;

	const MODIFIERS = {
		CTRL: 17,
		ALT: 18,
		SHIFT: 16,
	};

	for (const bind in keybinds) {
		const binding = keybinds[bind];

		// We are only interested in user defined keybinds
		if (binding.managed === true || binding.enabled === false) continue;

		const keys = binding.shortcut.map((x: number[]) => x[1]);
		const modifiers = {
			ctrl: keys.includes(MODIFIERS.CTRL),
			alt: keys.includes(MODIFIERS.ALT),
			shift: keys.includes(MODIFIERS.SHIFT),
		};

		// Filter out modifier keys
		const mainKeys = keys.filter((key: number) => ![MODIFIERS.CTRL, MODIFIERS.ALT, MODIFIERS.SHIFT].includes(key));

		// Build keyboard shortcut string
		const keyParts: string[] = [];
		if (modifiers.ctrl) keyParts.push("ctrl");
		if (modifiers.alt) keyParts.push("alt");
		if (modifiers.shift) keyParts.push("shift");

		const mainKey = mainKeys.length > 0 ? keyCodeToChar(mainKeys.at(-1)) : "";
		keyParts.push(mainKey);

		if (!mainKey) continue;

		activeKeybinds.set(macroCaseToTitleCase(binding.action), {
			shortcut: keyParts.join("+").toLowerCase(),
			eventSettings: {
				keyCode: mainKeys.at(-1),
				ctrlKey: modifiers.ctrl,
				altKey: modifiers.alt,
				shiftKey: modifiers.shift,
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
