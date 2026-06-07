# Phase 07 — Keybinds Non-Alphanumeric Investigation (INV-02)

## Verdict: GO

**BLUF:** The bug is **not** in venbind. It is a one-line conversion bug in GoofCord's own
preload glue. `src/windows/main/preload/keybinds.ts:53` builds the shortcut string that gets
registered with venbind using:

```ts
const mainKey = mainKeys.length > 0 ? String.fromCharCode(mainKeys.at(-1)) : "";
```

`mainKeys.at(-1)` is the **DOM `keyCode`** Discord stores for the bind. For letters/digits the
DOM keyCode equals the ASCII code (`A`=65, `0`=48), so `String.fromCharCode` happens to return
the right character — which is why **alphanumerics work**. For OEM/punctuation keys the DOM
keyCode is in the 186–222 range, which `String.fromCharCode` maps to **Latin‑1 garbage**, not
the punctuation glyph:

| key | DOM keyCode | `String.fromCharCode` | venbind receives | should be |
|-----|-------------|-----------------------|------------------|-----------|
| `]` | 221 | `Ý` → `ý` | `ý` | `]` |
| `[` | 219 | `Û` → `û` | `û` | `[` |
| `;` | 186 | `º` | `º` | `;` |
| `'` | 222 | `Þ` → `þ` | `þ` | `'` |
| `,` | 188 | `¼` | `¼` | `,` |
| `.` | 190 | `¾` | `¾` | `.` |
| `/` | 191 | `¿` | `¿` | `/` |

venbind (correctly) converts the **physically pressed** key to its lowercase Unicode char
(`]`) and compares it against the registered shortcut string. Because GoofCord registered
`ý` instead of `]`, the strings never match and the bind silently never fires. **Root cause
located: GoofCord preload glue, not the native addon.** Fix is a surgical ~15-line keyCode→char
map in GoofCord TypeScript — no venbind fork, no new native binary, no new dependency. Highly
upstream-able.

---

## 1. Current State (codebase today)

End-to-end keybind path (Windows). venbind = `0.1.7` (confirmed `package.json:51`).

**Registration (renderer change → native), runs in PACKAGED builds:**
1. `src/windows/main/renderer/postVencord/keybinds.ts:2` — subscribes to Discord's
   `KEYBINDS_SET_KEYBIND` Flux event and calls `window.keybinds.updateKeybinds()`.
   *(This file lives in the renderer bundle, but it only triggers the preload API.)*
2. `src/windows/main/preload/keybinds.ts` — **the load-bearing glue, and where the bug is**:
   - `getActiveKeybinds()` (`:16`) reads Discord's `localStorage["keybinds"]`, pulls
     `binding.shortcut` (array of `[deviceType, keyCode]` pairs), separates modifiers
     (ctrl=17/alt=18/shift=16, `:25`) from the main key.
   - **`:53` `String.fromCharCode(mainKeys.at(-1))`** ← the defect: wrong char for punctuation.
   - `:59` joins `keyParts` with `+` and `.toLowerCase()` → e.g. `"ctrl+ý"`.
   - `updateKeybinds()` (`:83`) sends `{id, name, shortcut}[]` over IPC via
     `invoke("venbind:setKeybinds", …)` (`:99`).
   - `startKeybindWatcher()` (`:106`) is wired into the preload entry at
     `src/windows/main/preload/preload.mts:8,25` → built to `ts-out/` and **shipped in the
     packaged app** (it is NOT one of the upstream-fetched renderer bundles, so the fix WILL
     run in a real build).
3. `src/modules/native/venbind.ts:43 setKeybinds()` → `venbind.setKeybinds(keybinds)` (the
   native addon, loaded from `assets/native/venbind-win32-x64.node`, `:7,22`).
4. **Inside venbind (Rust + napi-rs, vendoring kwhat/libuiohook):**
   `Shortcut::from_string(shortcut)` parses the string; on a global key event Windows code
   converts the pressed key to a **lowercased Unicode char** via libuiohook
   `keycode_to_unicode()` (special keys: escape/backspace/tab/delete/return/space use
   `GetKeyNameTextW`) and matches it against the parsed shortcut. *(Source: `tuxinal/venbind`
   `src/windows.rs`; the binary's libuiohook logger strings `keycode_to_scancode` /
   `vk_code` confirm the lib.)* → venbind expects the **actual character**, e.g. `]`.

**Trigger (native → renderer):**
5. `src/modules/native/venbind.ts:37 startVenbind()` callback → if not focused (or Wayland),
   `mainWindow.webContents.send("keybinds:trigger", id, keyup)` (`:39`). Also a CLI/relaunch
   path in `src/windows/main/main.ts:95-100`.
6. `src/windows/main/preload/keybinds.ts:117` receives `keybinds:trigger`, looks up the bind
   and `document.dispatchEvent(new KeyboardEvent(…, keybind.eventSettings))` (`:124`) where
   `eventSettings.keyCode = mainKeys.at(-1)` (the raw DOM keyCode) — **this reverse path is
   correct** and unaffected; only the registration string is wrong.

**Patch enabling the feature:** `src/windows/main/renderer/preVencord/patches/keybinds.ts`
forces `isPlatformEmbedded`/`isDesktop` true so Discord exposes desktop keybinds.

**Why alphanumerics work / punctuation doesn't:** identical code path; the only difference is
that `String.fromCharCode` is an accidentally-correct identity for ASCII-aligned keyCodes
(48–57, 65–90) and produces garbage for OEM keyCodes (186–222).

## 2. Options Survey

| Option | What it is | Version / maint. | License | Fit for this bug |
|--------|-----------|------------------|---------|------------------|
| **(A) Fix GoofCord glue** (recommended) | Replace `String.fromCharCode` with a DOM‑keyCode→char map for OEM keys | n/a (in-repo TS) | project | **Exact fix.** venbind already does the right thing; just feed it the right string. No native work. |
| (B) Patch venbind | Fork `tuxinal/venbind` to add a char alias table | last ≈0.1.x; solo maint (Tuxinal); Rust+napi-rs | venbind LICENSE (MIT-style) | **Misdiagnosis** — venbind is not at fault; a fork would add prebuilt-`.node` maintenance for nothing. |
| (C) Electron `globalShortcut` | Built-in OS hotkey registration | bundled w/ Electron 41 | MIT | Poor: **no keyup/release events** (breaks PTT-release), consumes the combo globally (not pass-through), accelerator set is limited. Not a drop-in for venbind's low-level capture. |
| (D) `uiohook-napi` (SnosMe) | napi wrapper over the **same** libuiohook venbind uses | ~1.5.x, moderately maintained | MIT | Capable but you reimplement the whole shortcut-matching layer in GoofCord — strictly more code than (A), and duplicates what venbind already provides. |
| (E) `node-global-key-listener` | Spawns a native helper exe per OS, emits named key events | ~0.3.x, low activity | MIT | Heaviest: ship + sign a child-process binary; worse than patching a one-liner. |

## 3. Tech-Debt Cost

- **(A) GoofCord glue fix:** *Lowest.* ~15–20 lines (a `Record<number,string>` OEM map + a
  guard for the `+` key colliding with the `join("+")` delimiter). No native rebuild, no
  prebuilt `.node` to maintain, **zero new deps**, zero fork divergence from upstream's
  architecture. Touches one file (`preload/keybinds.ts`).
- **(B) venbind fork:** *High.* Inherits the wasapi-loopback/patchcord prebuilt-binary
  maintenance pattern (build + host 4 `.node` targets, keep them in `assets/native/`,
  re-roll on every venbind bump). Unjustified since venbind is not the defect.
- **(C)–(E):** *Medium→High.* New dependency, behavioural regressions (loss of keyup in C),
  or shipping/signing native helpers (E). All replace a working low-level capture stack to
  fix a bug that isn't in that stack.

## 4. Upstream-ability

**Excellent — the best of the four INV investigations, but for a different reason than
predicted.** The brief assumed the fix would be a *venbind* PR; in fact the root cause is in
GoofCord's own TypeScript, so the fix is a **pure GoofCord PR** to
`src/windows/main/preload/keybinds.ts` with **no native code at all**. That clears the
upstream bar trivially: surgical, mechanism-explained, conventions-respected, no fork-only
hacks, no AI tells. A war-story-grade PR description is easy to write (DOM keyCode 221 →
`String.fromCharCode` → `ý` ≠ `]`, with the table above). Optionally, a tiny upstream venbind
note could add tolerance, but it is **not required** for the fix. Verifiable manually on the
existing Windows CI build by binding `Ctrl+]` / `;` and confirming the action fires.

## 5. Recommendation & Next Step

**GO — Option A. Effort: S (Small).**

Root cause is a single mis-conversion in GoofCord's preload, not a venbind limitation.

**Recommended build milestone:**
1. In `src/windows/main/preload/keybinds.ts`, replace `String.fromCharCode(mainKeys.at(-1))`
   (`:53`) with a helper that maps DOM keyCodes to characters: keep the existing
   `String.fromCharCode` for `48–57`/`65–90`, and add an explicit OEM map
   `{186:";",187:"=",188:",",189:"-",190:".",191:"/",192:"`",219:"[",220:"\\",221:"]",222:"'"}`
   (plus numpad punctuation if desired). Fall back to `String.fromCharCode` for unknowns.
2. Handle the `+` collision: when the main key is `+` (or any delimiter char), ensure the
   shortcut string venbind parses isn't ambiguous with the `join("+")` separator
   (e.g. confirm/normalize how `Shortcut::from_string` splits, or special-case it).
3. Keep the reverse `keybinds:trigger` path (`:117-126`) untouched — it already uses the raw
   keyCode correctly.
4. **Verify manually:** trigger `.github/workflows/testBuild.yml` (Windows x64), bind a
   non-alphanumeric global keybind (`Ctrl+]`, `;`), confirm it registers and fires while
   Discord is unfocused.
5. Open a clean upstream GoofCord PR (TS-only, no native artifacts).

**Stretch (optional, separate):** the same glue can't express **named** keys
(space/enter/tab/escape) either — `String.fromCharCode(32)` = `" "`, but venbind wants the
name `"space"`. Out of INV-02 scope (punctuation), but worth a follow-up bind-name map if
those binds are also reported broken.

---

### Evidence appendix
- venbind source: `https://github.com/tuxinal/venbind` — Rust + napi-rs, submodule
  `uiohook-sys/vendor` = `https://github.com/kwhat/libuiohook` (`node_modules/venbind/.gitmodules`).
- Repo tree confirms platform impls `src/windows.rs`, `src/linux.rs`, `src/structs.rs`
  (`Shortcut`), `src/js.rs`.
- venbind `src/windows.rs`: matches via libuiohook `keycode_to_unicode()` →
  `to_lowercase()`; special keys via `GetKeyNameTextW`. So shortcut main key must be the
  literal char (e.g. `]`).
- Win32 binary `assets/native/venbind-win32-x64.node` (PE32+ DLL) strings show libuiohook
  logger lines (`keycode_to_scancode`, `Using normal/extended lookup for vk_code`) and the
  napi exports (`setKeybinds`, `startKeybinds`, `getCurrentShortcut`) — consistent with the
  source.
- Note: a web search asserted a venbind issue **#6** tracked non-alphanumeric keys — **false**;
  issue #6 is titled "MacOS support" (verified via GitHub API). No existing venbind issue for
  this bug was found, consistent with the defect being GoofCord-side.
