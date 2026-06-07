# KEY-01 Handoff — Non-Alphanumeric Global Keybinds (Windows)

> **Status:** fix committed (`7103149`), map **confirmed correct vs. ground truth**, but **NOT yet validated end-to-end**. The first Windows test used the wrong build base and produced a misleading result. This doc is the continuation brief for the next agent.
>
> **CLEAN-ROOM (hard rule):** the fix's keyCode→char map is grounded in the **public DOM `KeyboardEvent.keyCode` standard** (Chromium legacy values) that Discord-web rides on. Discord's own source / keycode tables were **NOT** consulted or copied — only the user's own persisted `localStorage["keybinds"]` values were *observed* as confirmation (standard DOM integers, not Discord IP). **Keep all Discord-internals investigation OUT of the repo / commits / PRs.**

---

## 1. The bug & the fix (committed)

**File:** `src/windows/main/preload/keybinds.ts` (ships via `preload.mts` → `ts-out/`; it is NOT one of the upstream-fetched renderer bundles, so it runs in packaged builds).

**Pre-fix defect** (`getActiveKeybinds`): the shortcut string registered with venbind was built with `String.fromCharCode(domKeyCode)`. That is an *accidental identity* for ASCII-aligned keyCodes (digits 48–57, letters 65–90) but produces **Latin-1 garbage** for OEM/punctuation keyCodes 186–222 (e.g. `221 "]" → "Ý"`, `188 "," → "¼"`). venbind matches the **physical key's character** (libuiohook `keycode_to_unicode`, lowercased), so a punctuation bind registered as `ý`/`¼` never matched the pressed `]`/`,` → **silently never fired** (global path only — see §3).

**Fix (commit `7103149`):** added an `OEM_KEYCODE_CHARS` map (186–222 → literal char) + `keyCodeToChar()`, and swapped the `String.fromCharCode` call. Alphanumerics keep the `String.fromCharCode` fallback unchanged.

## 2. Ground truth (clean-room) — the map is CORRECT

**Discord-web (Chromium) persists standard DOM `KeyboardEvent.keyCode` integers.** Confirmed by *observing the user's own* `localStorage["keybinds"]` (read from WSL: `/mnt/c/Users/Christ/AppData/Roaming/goofcord/Local Storage/leveldb/`, `strings | grep keybinds`) — **not** Discord source:

| Action | stored `shortcut` | keyCode(s) | meaning |
|---|---|---|---|
| TOGGLE_MUTE | `[[0,190,4]]` | 190 | `.` (period) |
| TOGGLE_MUTE | `[[0,188,4]]` | 188 | `,` (comma) |
| SOUNDBOARD_HOLD | `[[0,17,4],[0,192,4]]` | 17,192 | Ctrl + `` ` `` |
| SAVE_CLIP | `[[0,18,4],[0,67,4]]` | 18,67 | Alt + C |
| SAVE_SCREENSHOT | `[[0,123,4]]` | 123 | **F12** (see §4 gap) |

- Each entry is a `[deviceType, keyCode, flags]` **triple**; the existing code correctly takes index `1` (`x[1]`).
- The public DOM keyCode table (verified, CSS-Tricks / standard Chromium values) matches the fix's `OEM_KEYCODE_CHARS` **exactly** for 186–222: `186;` `187=` `188,` `189-` `190.` `191/` `192\`` `219[` `220\` `221]` `222'`.
- **So the fix's map is right** for printable punctuation on a US layout.

## 3. Why the first Windows test was MISLEADING (read this before re-testing)

The fix **only** affects the **out-of-focus / global (venbind)** registration string. Path facts:
- `src/modules/native/venbind.ts:38` — the venbind callback **returns early when `mainWindow.isFocused()`** (non-Wayland). So **when GoofCord is focused, Discord handles the real keypress natively** — venbind, and therefore this fix, is *not involved*.
- venbind parser `tuxinal/venbind` `src/structs.rs::from_string` **splits only on `+`**; every non-modifier piece goes into a key set. A punctuation bind (`,`, `]`) therefore **cannot** corrupt the batch or collide with a delimiter (only a literal `+` key could).

Mapping the user's observations onto these facts:
- **"Focused: `]` works, `,`/`.` fail"** → that's **Discord-native** behavior; the fix doesn't touch the focused path, so this says nothing about the fix.
- **"Global keybinds completely broke, incl. alphanumeric"** → **cannot be caused by the fix**: alphanumeric strings are byte-identical to before, and the parser can't be corrupted by a punctuation bind. This is a **build-base / runtime artifact** of the isolated test build (see below), not the fix.

**Test base mistake:** the isolated build was branched off **`origin/main`** (cancel-fix base) — `test/win-keybind-flag-fixes`, CI run `27084274815` (success). Global venbind capture appears **non-functional on that base** for a still-unknown reason → the fix got **no valid end-to-end test**.

### ⚠️ OPEN QUESTION (resolve first)
Why did **global** keybind capture fail (for *all* keys) on the `origin/main`-based build? Hypotheses to check on the **dev/release base**:
1. venbind `.node` didn't load/capture on that base (check the `[Venbind] Loaded venbind` log / `defineErrorHandle` output).
2. The reverse `keybinds:trigger` → synthetic `KeyboardEvent` path (keybinds.ts:117) — note it dispatches with `keyCode` only, not `key`/`code`; modern Discord may key off `key`/`code`.
3. Test methodology (binds not actually saved, app instance/lock, etc.).

## 4. Known remaining gaps (document, don't silently ship)

- **Named / non-printable keys are still broken** (out of KEY-01's punctuation scope but real): F1–F12 = 112–123, Space 32, Enter 13, Tab 9, Esc 27, Backspace 8, arrows 37–40. `keyCodeToChar` falls back to `String.fromCharCode` → wrong (`123 → "{"`, `32 → " "`). venbind wants **names** for these (its `windows.rs` uses `GetKeyNameTextW` for escape/backspace/tab/delete/return/space — note these are OS-localized, so matching is fiddly). The user's `SAVE_SCREENSHOT` (F12) is a live example. **Needs a keyCode→venbind-name table; confirm exact expected names from `tuxinal/venbind` `src/windows.rs`.**
- **Layout dependence:** DOM keyCode is US-biased (188 is always the comma-position key); venbind/libuiohook `keycode_to_unicode` yields the **OS-layout** char. On non-US layouts these can diverge → the char map may mismatch. User appears US (188=comma confirmed). Caveat only for now.
- **Firefox keyCode quirks (59/61/173)** are irrelevant — Electron is Chromium.

## 5. Plan for the next agent

1. **Automated tests (assigned to you).** Use Bun's built-in runner (`bun test`, **no new deps**). Extract the pure logic out of `getActiveKeybinds` into a testable module (suggested `src/windows/main/preload/keybindShortcut.ts`) exporting e.g. `parseDiscordShortcut(shortcut: number[][]): { shortcut: string; mainKeyCode: number | undefined; ctrl: boolean; alt: boolean; shift: boolean }` plus `keyCodeToChar`. Refactor `keybinds.ts` to consume it (keep `eventSettings.keyCode = mainKeyCode`). Drive tests from the **real ground-truth cases in §2** (e.g. `[[0,190,4]]→"."`, `[[0,188,4]]→","`, `[[0,17,4],[0,192,4]]→"ctrl+\`"`, `[[0,18,4],[0,67,4]]→"alt+c"`, `[[0,221,4]]→"]"`). Add the named-key cases as `expect.fail`/TODO until §4 is implemented.
2. **Extend the map to named keys** (§4) — keyCode→venbind-name; verify names against venbind `windows.rs`.
3. **Validate on the DEV/RELEASE base** (not `origin/main`): build via `testBuild.yml` on a branch off the dev branch (where the user's real release works), user binds **one** punctuation key + tests it **unfocused**. Resolve the §3 open question. (Minimize tedium: one key, one global press.)
4. Only then decide release inclusion.

## 6. State / pointers

- **Fix commit:** `7103149` (KEY-01, dev branch `fix/windows-screenshare-cancel-restart`). Map verified correct; end-to-end unvalidated.
- **STREAM-05** (`main.ts:67` occluded-window flag typo) — commit `c988872`, separate & low-risk, also unvalidated.
- **Isolated test branch (fork):** `test/win-keybind-flag-fixes` = `origin/main` + the 2 fixes. CI run `27084274815` succeeded; artifact in `C:\Users\Christ\Downloads\goofcord-winfix-test\` (wrong base for keybinds — see §3). Safe to delete the branch.
- **Key files:** `src/windows/main/preload/keybinds.ts` (fix + reverse trigger path:117), `src/modules/native/venbind.ts` (loader; focus-gate:38), `src/windows/main/renderer/postVencord/keybinds.ts` (renderer trigger — *fetched upstream bundle*), `preVencord/patches/keybinds.ts` (enables desktop keybinds). venbind source: `github.com/tuxinal/venbind` (`structs.rs` parser, `windows.rs` matching).
- **Diagnostic source of truth:** `…/goofcord/Local Storage/leveldb/` `keybinds` entry (WSL-readable).
- **Release context:** user's fork release is `v2.2.1-winfix` (GH release, tag at `2bd8808`, cut from the dev branch — bundles cancel + echo fixes). v1.3 would add KEY-01 + STREAM-05 once validated.

## 7. Clean-room reminder
Map = **public DOM keyCode standard** only. Do **not** copy Discord's keycode tables/source into the fix, commits, or any PR. Observing the user's own config (`localStorage`) is fine; ingesting Discord code is not.
