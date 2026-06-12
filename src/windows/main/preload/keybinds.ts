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

// Named/control keys (Enter, Space, F-keys, arrows, numpad…) have no meaningful character, so
// venbind's press side matches them by a canonical lowercase token, not a char. String.fromCharCode
// would turn these keyCodes into control/garbage chars (13 -> "\r", 32 -> " ", 123 -> "{",
// 33 -> "!"), which never matched a token, so those binds silently never fired. Map them to the
// exact venbind tokens (thomas-quant/venbind src/structs.rs::tokens) and consult this FIRST.
// SPEC NOTE: keyCode 13 -> "enter" only (no "numpadenter"). venbind emits "numpadenter" for the
// physical numpad Enter, but Discord's stored shortcut carries only DOM keyCode 13 with no numpad
// location, so GoofCord can only ever register "enter" — a numpadenter entry would be unreachable.
// Net effect: numpad Enter no longer triggers an Enter bind, now consistent with the Linux backend.
const NAMED_KEYCODE_TOKENS: Record<number, string> = {
	8: "backspace",
	9: "tab",
	13: "enter",
	27: "escape",
	32: "space",
	33: "pageup",
	34: "pagedown",
	35: "end",
	36: "home",
	45: "insert",
	46: "delete",
	37: "left",
	38: "up",
	39: "right",
	40: "down",
	20: "capslock",
	144: "numlock",
	145: "scrolllock",
	44: "printscreen",
	19: "pause",
	93: "menu",
	112: "f1",
	113: "f2",
	114: "f3",
	115: "f4",
	116: "f5",
	117: "f6",
	118: "f7",
	119: "f8",
	120: "f9",
	121: "f10",
	122: "f11",
	123: "f12",
	124: "f13",
	125: "f14",
	126: "f15",
	127: "f16",
	128: "f17",
	129: "f18",
	130: "f19",
	131: "f20",
	132: "f21",
	133: "f22",
	134: "f23",
	135: "f24",
	96: "numpad0",
	97: "numpad1",
	98: "numpad2",
	99: "numpad3",
	100: "numpad4",
	101: "numpad5",
	102: "numpad6",
	103: "numpad7",
	104: "numpad8",
	105: "numpad9",
	107: "numpadadd",
	109: "numpadsubtract",
	106: "numpadmultiply",
	111: "numpaddivide",
	110: "numpaddecimal",
};

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

const keyCodeToChar = (keyCode: number): string => NAMED_KEYCODE_TOKENS[keyCode] ?? OEM_KEYCODE_CHARS[keyCode] ?? String.fromCharCode(keyCode);

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
