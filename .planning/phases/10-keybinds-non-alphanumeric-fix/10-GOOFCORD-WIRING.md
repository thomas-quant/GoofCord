# GoofCord-side wiring for venbind named-key support (GSD pickup)

> **Status:** NOT STARTED. Blocked on the fixed venbind prebuilt `.node` existing.
> **Depends on:** the venbind fix (separate repo — see below) being built by CI and consumed by GoofCord.
> **Goal:** make non-printable/named global keybinds (Page Up/Down, F-keys, arrows, Home/End, numpad…) register and fire on Windows, finishing what KEY-01 (punctuation, commit `7103149`) started. Closes the named-key half of upstream #179.

---

## 0. Where the venbind fix lives (prerequisite)

- Repo: **`thomas-quant/venbind`** (fork of `tuxinal/venbind`), cloned at `/mnt/e/backup/code/personal/venbind`.
- Branch **`fix/uiohook-named-key-matching`** (commit `b8d9c82`) — the clean Rust fix (for the eventual upstream PR). Adds a shared canonical lowercase token vocabulary (`src/structs.rs` → `mod tokens`) + `vk_to_token` (windows.rs) / `keysym_to_token` (linux.rs).
- Branch **`fork-ci`** — `fix` + `.github/workflows/build.yml` (build-only CI) + `docs/windows-*.md` (MS API references). CI builds the prebuilt `.node`.
- **Before wiring, confirm CI is green** and grab the artifact: `gh run list --repo thomas-quant/venbind`, then download `venbind-windows-x64.node` (+ `venbind-linux-x64.node`).
- **DO NOT** open the upstream PR to `tuxinal/venbind` until the user says so.

## 1. Canonical token vocabulary (MUST match venbind exactly)

GoofCord registers a shortcut string; venbind's fixed press-side emits these exact lowercase tokens. The DOM-keyCode→token table below MUST produce strings identical to `src/structs.rs::tokens` in the fork. Printable keys are unchanged (lowercased char).

## 2. Task A — extend `keyCodeToChar` with a named-key table

In `src/windows/main/preload/keybinds.ts` (or the extracted `keybindShortcut.ts`, see Task B), add a DOM-keyCode → venbind-token map and consult it **first** in `keyCodeToChar` (before `OEM_KEYCODE_CHARS`, before `String.fromCharCode`). Control-char keyCodes (8/9/13/27/32) and named keys must hit this map, not `String.fromCharCode`.

```ts
// DOM KeyboardEvent.keyCode -> venbind canonical token (must match venbind tokens module)
const NAMED_KEYCODE_TOKENS: Record<number, string> = {
	8: "backspace", 9: "tab", 13: "enter", 27: "escape", 32: "space",
	33: "pageup", 34: "pagedown", 35: "end", 36: "home", 45: "insert", 46: "delete",
	37: "left", 38: "up", 39: "right", 40: "down",
	20: "capslock", 144: "numlock", 145: "scrolllock", 44: "printscreen", 19: "pause", 93: "menu",
	112: "f1", 113: "f2", 114: "f3", 115: "f4", 116: "f5", 117: "f6", 118: "f7", 119: "f8",
	120: "f9", 121: "f10", 122: "f11", 123: "f12", 124: "f13", 125: "f14", 126: "f15", 127: "f16",
	128: "f17", 129: "f18", 130: "f19", 131: "f20", 132: "f21", 133: "f22", 134: "f23", 135: "f24",
	96: "numpad0", 97: "numpad1", 98: "numpad2", 99: "numpad3", 100: "numpad4", 101: "numpad5",
	102: "numpad6", 103: "numpad7", 104: "numpad8", 105: "numpad9",
	107: "numpadadd", 109: "numpadsubtract", 106: "numpadmultiply", 111: "numpaddivide", 110: "numpaddecimal",
};
// keyCodeToChar: NAMED_KEYCODE_TOKENS[k] ?? OEM_KEYCODE_CHARS[k] ?? String.fromCharCode(k)
```

## 3. Task B — refactor + tests (the original handoff §5 task 1, still wanted)

Extract the pure logic out of `getActiveKeybinds` into a new dependency-free `src/windows/main/preload/keybindShortcut.ts` exporting `keyCodeToChar(keyCode)` and `parseDiscordShortcut(shortcut: number[][]) => { shortcut, mainKeyCode, ctrl, alt, shift }`. No electron/window/localStorage imports (so it's `bun test`-able). Refactor `keybinds.ts` to consume it (keep `eventSettings.keyCode = mainKeyCode`).

Add `keybindShortcut.test.ts` (bun:test, no new deps) covering:
- Punctuation ground truth (KEY-01): `[[0,190,4]]→"."`, `[[0,188,4]]→","`, `[[0,221,4]]→"]"`, `[[0,17,4],[0,192,4]]→"ctrl+\`"`, `[[0,18,4],[0,67,4]]→"alt+c"`.
- **Named keys (now REAL, not expect-broken):** `[[0,33,4]]→"pageup"`, `[[0,123,4]]→"f12"`, `[[0,32,4]]→"space"`, `[[0,17,4],[0,34,4]]→"ctrl+pagedown"`.
- Alphanumeric + no-main-key cases.

## 4. Task C — point GoofCord at the fixed venbind

Currently `package.json` pins `"venbind": "0.1.7"` (npm, the broken upstream). Options to consume the fork's prebuilt `.node` (pick per maintainer-friendliness / upstream-PR cleanliness):
- **Vendor the prebuilt** `venbind-windows-x64.node` into `assets/native/` (build resolves `native-module:../../../assets/native/venbind-*.node`; there's also a `GOOFCORD_VENBIND_PATH` override env). Simplest for a Windows test.
- Publish the fork to npm under a scope and bump the pin (heavier; mirrors the `wasapi-loopback` optionalDependency approach from the echo fix).
- For the **upstream-bound** GoofCord PR: ideally the venbind fix is merged + released upstream first, then just bump `"venbind"`. Until then, fork-prebuild is the bridge.

## 5. Verification

- `bun test` (Task B) + `bun run check`.
- **Manual Windows test** (no automated repro): bind Toggle Mute to **Page Up** (or any F-key), confirm it fires globally (out of focus) AND focused. Regression-guard: punctuation (`]`, Ctrl-combos) still fire.

## 6. Caveats (document, don't be surprised)

- **Numpad with NumLock OFF** emits navigation VKs (numpad-9 → Page Up) — inherent OS behavior, handled by whatever keyCode arrives.
- **Numpad Enter** has no distinct keyCode/VK on Windows → resolves to `enter` (same as main Enter). Acceptable.
- **mouse5** (rpcarvalheira in #179) is still unsupported — venbind has no mouse events (its issue #8, open). Out of scope.
- **Linux Wayland** uses the XDG portal (compositor matches; the user picks the key in the portal UI), so the token table is irrelevant there; Linux **X11** uses the same fixed `keysym_to_token` path and benefits from the fix.

## 7. Cross-refs

- venbind fix commit `b8d9c82`; MS API docs at `venbind/docs/windows-key-input-apis.md` + `windows-virtual-key-codes.md`.
- Memory: `venbind-fix-branch-wip`, `venbind-dormant-no-maintained-fork`, `dont-open-upstream-prs-until-instructed`, `pr-211-windows-echo-fix` (prebuild playbook).
- Upstream target: #179 (named-key half). KEY-01 punctuation = `7103149` (separate, already works).
