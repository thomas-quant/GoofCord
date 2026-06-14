// Pure, dependency-free shortcut-parsing logic shared by keybinds.ts and its bun:test suite.
// Intentionally imports nothing (no electron/window/localStorage/GoofCord runtime) so it can be
// imported directly under `bun test`.

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

export const keyCodeToChar = (keyCode: number): string => NAMED_KEYCODE_TOKENS[keyCode] ?? OEM_KEYCODE_CHARS[keyCode] ?? String.fromCharCode(keyCode);

// Discord's keybind matcher is branched by key class: PRINTABLE keys (letters/digits/OEM
// punctuation/space) are matched by their numeric keyCode, but NON-PRINTABLE keys (navigation,
// editing, function) are matched by their DOM KeyboardEvent.code/key string. The global-keybind
// path dispatches a synthetic KeyboardEvent that only carried `keyCode`, so non-printable keys had
// no `code` for Discord to read and silently never fired — while `]`/`.`/Space worked. Supplying the
// DOM code lets the matcher resolve them. For every key here the DOM `key` equals the DOM `code`, so
// one map serves both fields. Printable keys (Space 32, numpad 96-111, letters/digits/OEM) are
// intentionally excluded: they already match via the keyCode branch, and adding a `code` could flip
// Discord onto the other branch and regress them.
const NAMED_KEYCODE_DOMCODE: Record<number, string> = {
	8: "Backspace",
	9: "Tab",
	13: "Enter",
	27: "Escape",
	33: "PageUp",
	34: "PageDown",
	35: "End",
	36: "Home",
	45: "Insert",
	46: "Delete",
	37: "ArrowLeft",
	38: "ArrowUp",
	39: "ArrowRight",
	40: "ArrowDown",
	20: "CapsLock",
	144: "NumLock",
	145: "ScrollLock",
	44: "PrintScreen",
	19: "Pause",
	93: "ContextMenu",
	112: "F1",
	113: "F2",
	114: "F3",
	115: "F4",
	116: "F5",
	117: "F6",
	118: "F7",
	119: "F8",
	120: "F9",
	121: "F10",
	122: "F11",
	123: "F12",
	124: "F13",
	125: "F14",
	126: "F15",
	127: "F16",
	128: "F17",
	129: "F18",
	130: "F19",
	131: "F20",
	132: "F21",
	133: "F22",
	134: "F23",
	135: "F24",
};

// DOM `KeyboardEvent.code`/`key` for a non-printable named key, or undefined for printable keys
// (which Discord matches by keyCode and must be left untouched). Consumed by keybinds.ts to enrich
// the synthetic event so global non-printable keybinds match Discord's matcher.
export const keyCodeToDomCode = (keyCode: number): string | undefined => NAMED_KEYCODE_DOMCODE[keyCode];

const MODIFIERS = {
	CTRL: 17,
	ALT: 18,
	SHIFT: 16,
};

export interface ParsedShortcut {
	shortcut: string;
	mainKeyCode: number | undefined;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
}

// Mirrors the original getActiveKeybinds logic: each entry is a [deviceType, keyCode, flags]
// triple; we take index 1. Modifiers are CTRL=17 ALT=18 SHIFT=16; the main key is the last
// non-modifier keyCode. The shortcut string is [ctrl?,alt?,shift?,mainChar].join("+") lowercased.
// When there is no main key, mainKeyCode is undefined and shortcut is "".
export const parseDiscordShortcut = (shortcut: number[][]): ParsedShortcut => {
	const keys = shortcut.map((x: number[]) => x[1]);
	const ctrl = keys.includes(MODIFIERS.CTRL);
	const alt = keys.includes(MODIFIERS.ALT);
	const shift = keys.includes(MODIFIERS.SHIFT);

	// Filter out modifier keys
	const mainKeys = keys.filter((key: number) => ![MODIFIERS.CTRL, MODIFIERS.ALT, MODIFIERS.SHIFT].includes(key));
	const mainKeyCode = mainKeys.length > 0 ? mainKeys.at(-1) : undefined;

	// Build keyboard shortcut string
	const keyParts: string[] = [];
	if (ctrl) keyParts.push("ctrl");
	if (alt) keyParts.push("alt");
	if (shift) keyParts.push("shift");

	const mainKey = mainKeyCode !== undefined ? keyCodeToChar(mainKeyCode) : "";
	keyParts.push(mainKey);

	if (!mainKey) {
		return { shortcut: "", mainKeyCode: undefined, ctrl, alt, shift };
	}

	return {
		shortcut: keyParts.join("+").toLowerCase(),
		mainKeyCode,
		ctrl,
		alt,
		shift,
	};
};
