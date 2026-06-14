// TEMP DIAGNOSTIC (diag/keybind-venbind-fire) — clean up before merge.
// Direct Discord keybind-action dispatch (Vesktop PR #326 approach): bypass the DOM keydown matcher
// (which ignores non-printable keys like PageUp/Insert) by capturing each keybind action's
// onTrigger/keyEvents from Discord's KeybindStore and invoking it directly when venbind fires.
//
// This source string runs in the page MAIN WORLD (injected via webFrame.executeJavaScript from the
// preload in assets.ts, BEFORE Vencord loads) so it can (a) register a Vencord patch into
// window.__GOOFCORD_PATCHES__ and (b) hold live Discord action closures across the
// preload<->renderer boundary. The patch is pushed fully-formed (plugin + pre-expanded \i +
// globalThis. helper instead of $self) because we bypass patchManager's processPatch.
//
// Diagnostics go to localStorage["goofcord-kb-diag"] — the main world has no fs, and localStorage is
// WSL-readable via the Local Storage leveldb (same channel used for keybind recon).
export const keybindDispatchMainWorldSource = `
(() => {
	const DIAG = "goofcord-kb-diag";
	function kbDiag(m) {
		try {
			const prev = localStorage.getItem(DIAG) || "";
			localStorage.setItem(DIAG, (prev + "[" + new Date().toISOString() + "] " + m + "\\n").slice(-8000));
		} catch (e) {}
	}

	globalThis.__goofcordKeybindActions = globalThis.__goofcordKeybindActions || {};

	// Called from inside Discord's KeybindStore (via the patch below) with the live actions map.
	globalThis.__goofcordAddKeybindActions = function (actions) {
		try {
			let n = 0;
			for (const key in actions) {
				const v = actions[key];
				if (!v) continue;
				globalThis.__goofcordKeybindActions[key] = { onTrigger: v.onTrigger, keyEvents: v.keyEvents };
				n++;
			}
			kbDiag("ADD captured " + n + ": " + JSON.stringify(Object.keys(globalThis.__goofcordKeybindActions)));
		} catch (e) {
			kbDiag("ADD error: " + e);
		}
	};

	// Called by the preload (keybinds.ts) when venbind fires. action = raw SCREAMING_SNAKE action type.
	globalThis.__goofcordTriggerKeybind = function (action, keyup) {
		try {
			const cb = globalThis.__goofcordKeybindActions[action];
			if (!cb || typeof cb.onTrigger !== "function") {
				kbDiag("TRIGGER miss action=" + action + " available=" + JSON.stringify(Object.keys(globalThis.__goofcordKeybindActions)));
				return { handled: false, reason: "not-captured" };
			}
			const ke = cb.keyEvents || { keydown: true, keyup: true };
			let called = null;
			if (ke.keyup && keyup) { cb.onTrigger(false, { context: undefined }); called = "release"; }
			else if (ke.keydown && !keyup) { cb.onTrigger(true, { context: undefined }); called = "press"; }
			kbDiag("TRIGGER action=" + action + " keyup=" + keyup + " called=" + called + " keyEvents=" + JSON.stringify(ke));
			return { handled: called !== null, called: called };
		} catch (e) {
			kbDiag("TRIGGER error action=" + action + ": " + e);
			return { handled: false, reason: String(e) };
		}
	};

	try {
		window.__GOOFCORD_PATCHES__ = window.__GOOFCORD_PATCHES__ || [];
		window.__GOOFCORD_PATCHES__.push({
			plugin: "GoofCord",
			find: "[kb store] KeybindStore",
			replacement: [{
				match: /let{keybinds:([A-Za-z_$][\\w$]*)}=[A-Za-z_$][\\w$]*;/,
				replace: "$&globalThis.__goofcordAddKeybindActions($1);",
			}],
		});
		kbDiag("PATCH registered; __GOOFCORD_PATCHES__ len=" + window.__GOOFCORD_PATCHES__.length);
	} catch (e) {
		kbDiag("PATCH register error: " + e);
	}
})();
`;
