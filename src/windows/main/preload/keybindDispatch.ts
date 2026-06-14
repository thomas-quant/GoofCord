// TEMP DIAGNOSTIC (diag/keybind-venbind-fire) — clean up before merge.
// Direct Discord keybind-action dispatch (Vesktop PR #326 approach): bypass the DOM keydown matcher
// (which ignores non-printable keys like PageUp/Insert) by capturing each keybind action's
// onTrigger/keyEvents from Discord's KeybindStore and invoking it directly when venbind fires.
//
// v3: the prior main-world setInterval/localStorage probe produced no output (unreliable in the
// injected context). This version exposes a SYNCHRONOUS inspector window.__goofcordProbe() that the
// preload (keybinds.ts) calls via webFrame.executeJavaScript and logs through the venbind:keybindDebugLog
// IPC to keybind-debug.log — a reliable, immediately-flushed channel. The probe reports whether the
// "[kb store] KeybindStore" find-string matches and dumps the real keybinds-destructure + onTrigger
// source so the patch match regex can be corrected.
export const keybindDispatchMainWorldSource = `
(() => {
	globalThis.__goofcordKeybindActions = globalThis.__goofcordKeybindActions || {};

	// Called from inside Discord's KeybindStore (via the patch below) with the live actions map.
	// Mirror Vesktop EXACTLY: wrap onTrigger so it is invoked AS A METHOD on the original action
	// object (this === the action) and bake the context arg into the wrapper. diag4 stored the bare
	// function reference on a new object, so calling it later had this === our wrapper object — which
	// silently no-ops any onTrigger that uses 'this' (the FIRE-but-no-transmit failure we saw).
	globalThis.__goofcordAddKeybindActions = function (actions) {
		try {
			globalThis.__goofcordActionSrc = globalThis.__goofcordActionSrc || {};
			for (const key in actions) {
				const v = actions[key];
				if (v && typeof v.onTrigger === "function") {
					// TEMP DIAGNOSTIC: stash the ORIGINAL onTrigger source so we can see exactly what
					// each action does (and which arg/edge actually activates it) without DevTools.
					try { globalThis.__goofcordActionSrc[key] = Function.prototype.toString.call(v.onTrigger).slice(0, 1200); } catch (e) {}
					globalThis.__goofcordKeybindActions[key] = {
						onTrigger: (keyState) => v.onTrigger(keyState, { context: undefined }),
						keyEvents: v.keyEvents,
					};
				}
			}
		} catch (e) {}
	};

	// Called by the preload when venbind fires. action = raw SCREAMING_SNAKE action type.
	globalThis.__goofcordTriggerKeybind = function (action, keyup) {
		try {
			const cb = globalThis.__goofcordKeybindActions[action];
			if (!cb || typeof cb.onTrigger !== "function") return { handled: false, reason: "not-captured", available: Object.keys(globalThis.__goofcordKeybindActions) };
			const ke = cb.keyEvents || {};
			const keInfo = { keyup: !!ke.keyup, keydown: !!ke.keydown };
			if (ke.keyup && keyup) { cb.onTrigger(false); return { handled: true, called: "release", keInfo }; }
			if (ke.keydown && !keyup) { cb.onTrigger(true); return { handled: true, called: "press", keInfo }; }
			return { handled: false, reason: "edge-skip", keInfo };
		} catch (e) {
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
	} catch (e) {}

	// Synchronous inspector — called repeatedly by the preload until { found:true } or it gives up.
	window.__goofcordProbe = function () {
		try {
			const VC = window.Vencord;
			if (!VC || !VC.Webpack) return { ready: false, hasVencord: !!VC };
			const W = VC.Webpack;
			const out = {
				ready: true,
				hasSearch: typeof W.search === "function",
				hasWreq: !!(W.wreq && W.wreq.m),
				captured: Object.keys(globalThis.__goofcordKeybindActions || {}),
			};
			let ids = [];
			try { if (out.hasSearch) ids = Object.keys(W.search("[kb store] KeybindStore") || {}); } catch (e) { out.searchErr = String(e); }
			out.searchIds = ids;
			let scanId = null, kbSnip = "", otSnip = "";
			try {
				if (out.hasWreq) {
					const m = W.wreq.m;
					out.modCount = Object.keys(m).length;
					for (const id in m) {
						let s;
						try { s = Function.prototype.toString.call(m[id]); } catch (e) { continue; }
						if (s.indexOf("onTrigger") !== -1 && s.indexOf("keybinds") !== -1) {
							scanId = id;
							const i = s.indexOf("keybinds");
							kbSnip = s.slice(Math.max(0, i - 70), i + 150);
							const j = s.indexOf("onTrigger");
							otSnip = s.slice(Math.max(0, j - 40), j + 110);
							break;
						}
					}
				}
			} catch (e) { out.scanErr = String(e); }
			out.scanId = scanId;
			out.kbSnip = kbSnip;
			out.otSnip = otSnip;
			out.found = ids.length > 0 || scanId !== null;
			// TEMP DIAGNOSTIC: dump the real onTrigger bodies so we can see what actually activates them.
			const src = globalThis.__goofcordActionSrc || {};
			out.muteSrc = src.TOGGLE_MUTE;
			out.pttSrc = src.PUSH_TO_TALK;
			out.pushMuteSrc = src.PUSH_TO_MUTE;
			return out;
		} catch (e) {
			return { ready: true, fatal: String(e) };
		}
	};
})();
`;
