import { contextBridge, ipcRenderer, webFrame } from "electron";

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
		// (eventSettings is now only a fallback — the primary path is direct action dispatch below.)
		const domCode = keyCodeToDomCode(mainKeyCode);

		// Key by the raw SCREAMING_SNAKE action (e.g. PUSH_TO_MUTE) so venbind's fired id IS the
		// action type, which the main-world dispatcher uses to invoke Discord's onTrigger directly.
		activeKeybinds.set(binding.action, {
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

	startKeybindProbe();
}

// TEMP DIAGNOSTIC — drive the main-world __goofcordProbe from the preload (reliable timers + return
// value) and log findings to keybind-debug.log via IPC. Reveals whether the KeybindStore patch
// find/match matches this Discord build, and dumps the real source so the patch can be corrected.
function startKeybindProbe() {
	let n = 0;
	const poll = () => {
		webFrame
			.executeJavaScript("(typeof window.__goofcordProbe === 'function' ? window.__goofcordProbe() : { ready: false, stage: 'no-probe-fn' })")
			.then((r: { found?: boolean } | undefined) => {
				void invoke("venbind:keybindDebugLog", "PROBE " + JSON.stringify(r));
				if (!r?.found && n++ < 20) setTimeout(poll, 3000);
			})
			.catch((e) => {
				void invoke("venbind:keybindDebugLog", "PROBE exec-err " + String(e));
				if (n++ < 20) setTimeout(poll, 3000);
			});
	};
	setTimeout(poll, 6000);
}

ipcRenderer.on("keybinds:getAll", () => {
	return activeKeybinds;
});

function dispatchKeybind(id: string, keyup: boolean, keybind: Keybind) {
	const dispatchSynthetic = () => {
		document.dispatchEvent(new KeyboardEvent(keyup ? "keyup" : "keydown", keybind.eventSettings));
	};

	// Primary path: invoke Discord's keybind action directly in the main world (Vesktop-style),
	// bypassing the DOM matcher that ignores non-printable keys. id is the raw action type.
	// Fall back to the synthetic DOM event if the action wasn't captured (e.g. KeybindStore patch
	// shape drifted) so printable keys can never regress.
	// TEMP DIAGNOSTIC: log the dispatch result so we can tell (no DevTools) whether onTrigger was
	// actually called (handled/called/keInfo) vs skipped/not-captured — the diag4 gap.
	webFrame
		.executeJavaScript(`(globalThis.__goofcordTriggerKeybind ? globalThis.__goofcordTriggerKeybind(${JSON.stringify(id)}, ${keyup ? "true" : "false"}) : { handled: false, reason: "no-fn" })`)
		.then((result: { handled?: boolean } | undefined) => {
			void invoke("venbind:keybindDebugLog", `TRIGGER id=${id} keyup=${keyup} result=${JSON.stringify(result)}`);
			if (!result?.handled) dispatchSynthetic();
		})
		.catch((e) => {
			void invoke("venbind:keybindDebugLog", `TRIGGER exec-err id=${id} ${String(e)}`);
			dispatchSynthetic();
		});
}

// TEMP DIAGNOSTIC: coalesce venbind key auto-repeat. While a key is HELD, venbind emits repeated
// down/up/down/up pairs (~10/sec), which re-fires onTrigger over and over — toggles cancel out and
// hold-actions (PTT) stutter. Collapse the burst into ONE logical press (first down) + ONE release
// (debounced after the last up): a down cancels any pending release (it was just a repeat), and a
// release only "counts" if no down arrives within the coalesce window.
const keyRepeatState = new Map<string, { held: boolean; releaseTimer: ReturnType<typeof setTimeout> | null }>();
const REPEAT_COALESCE_MS = 220;

ipcRenderer.on("keybinds:trigger", (_, id, keyup) => {
	const keybind = activeKeybinds.get(id);
	if (!keybind) {
		warn("Keybind not found: " + id);
		void invoke("venbind:keybindDebugLog", `TRIGGER no-keybind id=${id}`);
		return;
	}

	let state = keyRepeatState.get(id);
	if (!state) {
		state = { held: false, releaseTimer: null };
		keyRepeatState.set(id, state);
	}
	const st = state;

	if (!keyup) {
		// raw key-down: cancel a pending release (auto-repeat), emit one logical press on first down
		if (st.releaseTimer) {
			clearTimeout(st.releaseTimer);
			st.releaseTimer = null;
		}
		if (!st.held) {
			st.held = true;
			dispatchKeybind(id, false, keybind);
		}
	} else {
		// raw key-up: debounce — a real release only counts if no key-down arrives within the window
		if (st.releaseTimer) clearTimeout(st.releaseTimer);
		st.releaseTimer = setTimeout(() => {
			st.held = false;
			st.releaseTimer = null;
			dispatchKeybind(id, true, keybind);
		}, REPEAT_COALESCE_MS);
	}
});

function debounce<T extends (...args: Parameters<T>) => void>(func: T, timeout = 300) {
	let timer: Timer;
	return (...args: Parameters<T>): void => {
		clearTimeout(timer);
		timer = setTimeout(() => func(...args), timeout);
	};
}
