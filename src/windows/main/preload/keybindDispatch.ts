// TEMP DIAGNOSTIC (diag/keybind-venbind-fire) — clean up before merge.
// Direct Discord keybind-action dispatch (Vesktop PR #326 approach): bypass the DOM keydown matcher
// (which ignores non-printable keys like PageUp/Insert) by capturing each keybind action's
// onTrigger/keyEvents from Discord's KeybindStore and invoking it directly when venbind fires.
//
// v2 adds a PROBE: the first build proved the KeybindStore patch never applied (no "ADD captured"
// line), so this version uses Vencord's own Webpack.search to test the find-string and dump the real
// module source (the keybinds destructure + onTrigger shape) so the patch can be corrected. All
// output goes to localStorage (no fs in the main world; WSL-readable via the Local Storage leveldb):
//   - "goofcord-kb-diag": ADD/TRIGGER/PATCH lines (capped)
//   - "gcp0".."gcpN":     probe findings (one short value per key, easy to grep out of leveldb)
export const keybindDispatchMainWorldSource = `
(() => {
	const DIAG = "goofcord-kb-diag";
	function kbDiag(m) {
		try {
			const prev = localStorage.getItem(DIAG) || "";
			localStorage.setItem(DIAG, (prev + "[" + new Date().toISOString() + "] " + m + "\\n").slice(-8000));
		} catch (e) {}
	}
	let _gcpN = 0;
	function gcp(m) {
		try { localStorage.setItem("gcp" + (_gcpN++), String(m).slice(0, 480)); } catch (e) {}
	}

	globalThis.__goofcordKeybindActions = globalThis.__goofcordKeybindActions || {};

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

	// ---- PROBE: find Discord's keybind store + dump its real source so the patch can be fixed ----
	function dumpSnippet(label, src, needle, before, after) {
		const i = src.indexOf(needle);
		if (i < 0) { gcp(label + " (no '" + needle + "')"); return; }
		gcp(label + ":" + src.slice(Math.max(0, i - before), i + after));
	}
	let scanned = false;
	function runProbe() {
		const VC = window.Vencord;
		const W = VC && VC.Webpack;
		if (!W) return false;

		// Method 1: Vencord's own search by the find-string (the exact matcher the patch uses).
		let hits = null;
		try { if (typeof W.search === "function") hits = W.search("[kb store] KeybindStore"); } catch (e) { gcp("search err:" + e); }
		const hitIds = hits ? Object.keys(hits) : [];

		// Method 2: raw factory scan for the keybind-action registry (onTrigger + keybinds).
		let kbId = null, kbSrc = "";
		try {
			const m = W.wreq && W.wreq.m;
			if (m) {
				if (!scanned) { gcp("wreq.m modules=" + Object.keys(m).length); scanned = true; }
				for (const id in m) {
					let s; try { s = Function.prototype.toString.call(m[id]); } catch (e) { continue; }
					if (s.indexOf("onTrigger") !== -1 && s.indexOf("keybinds") !== -1) { kbId = id; kbSrc = s; break; }
				}
			}
		} catch (e) { gcp("scan err:" + e); }

		if (!hitIds.length && !kbId) return false; // keep polling until the module loads

		gcp("FOUND search-ids=" + JSON.stringify(hitIds) + " scan-id=" + kbId);
		// Prefer the search hit's source if available, else the scan hit.
		let src = kbSrc;
		try { if (hitIds.length) src = Function.prototype.toString.call(hits[hitIds[0]]); } catch (e) {}
		if (src) {
			gcp("srcLen=" + src.length);
			dumpSnippet("KBDESTR", src, "keybinds:", 80, 160);
			dumpSnippet("ONTRIG", src, "onTrigger", 60, 120);
			dumpSnippet("KBSTORE", src, "kb store", 10, 80);
		}
		return true;
	}
	let tries = 0;
	const iv = setInterval(() => {
		tries++;
		let done = false;
		try { done = runProbe(); } catch (e) { gcp("probe-loop err:" + e); done = true; }
		if (done || tries > 40) { clearInterval(iv); if (tries > 40) gcp("PROBE timeout (no module found)"); }
	}, 1500);
})();
`;
