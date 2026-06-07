# KEY-01 Handoff — Non-Alphanumeric Global Keybinds (Windows)

> **Status:** fix committed (`7103149`), map **confirmed correct vs. ground truth**, and the **primary win is user-CONFIRMED**: with the fix, non-alphanumeric keybinds (e.g. `]`, Ctrl-combos) **now register and fire when GoofCord is focused** — they did **not** before. **This is the success and must be preserved (do not regress it).** Still **un**validated: the **out-of-focus / global** firing path (broke on the wrong test base). **Targets upstream issue #179** (non-alphanumeric global keybinds, OPEN — maintainer blamed venbind; we found it's GoofCord's `String.fromCharCode` glue) → see §7. This doc is the continuation brief for the next agent.
>
> **CLEAN-ROOM (hard rule):** the fix's keyCode→char map is grounded in the **public DOM `KeyboardEvent.keyCode` standard** (Chromium legacy values) that Discord-web rides on. Discord's own source / keycode tables were **NOT** consulted or copied — only the user's own persisted `localStorage["keybinds"]` values were *observed* as confirmation (standard DOM integers, not Discord IP). **Keep all Discord-internals investigation OUT of the repo / commits / PRs.**

---

## 1. The bug & the fix (committed)

**File:** `src/windows/main/preload/keybinds.ts` (ships via `preload.mts` → `ts-out/`; it is NOT one of the upstream-fetched renderer bundles, so it runs in packaged builds).

**Pre-fix defect** (`getActiveKeybinds`): the shortcut string registered with venbind was built with `String.fromCharCode(domKeyCode)`. That is an *accidental identity* for ASCII-aligned keyCodes (digits 48–57, letters 65–90) but produces **Latin-1 garbage** for OEM/punctuation keyCodes 186–222 (e.g. `221 "]" → "Ý"`, `188 "," → "¼"`). venbind matches the **physical key's character** (libuiohook `keycode_to_unicode`, lowercased), so a punctuation bind registered as `ý`/`¼` never matched the pressed `]`/`,` → **silently never fired** (affects focused keybinds too — see §3).

**Fix (commit `7103149`):** added an `OEM_KEYCODE_CHARS` map (186–222 → literal char) + `keyCodeToChar()`, and swapped the `String.fromCharCode` call. Alphanumerics keep the `String.fromCharCode` fallback unchanged.

**User-confirmed result:** with the fix, non-alphanumeric keybinds (`]`, Ctrl-combos) **register and fire when GoofCord is focused** — previously they did not. So the fix's registration string feeds the path that fires keybinds *even when focused* (see §3 — Discord runs in desktop/embedded mode and relies on venbind, not its own browser listeners). **Preserve this.**

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

## 3. Corrected model — focused vs out-of-focus (SUPERSEDES an earlier wrong claim)

> An earlier draft claimed "focused keybinds are Discord-native, so the fix doesn't touch them." **That was WRONG.** The user confirmed the fix changes focused behavior. Corrected model below — do not revert to the old framing.

- `preVencord/patches/keybinds.ts` forces Discord into **desktop/embedded mode** (`isPlatformEmbedded`/`isDesktop → true`). In that mode Discord does **not** run its own browser keybind listeners — it expects the "native client" to capture global keybinds and feed them in. Here that client is **venbind**, dispatched into Discord via `keybinds:trigger` → synthetic `KeyboardEvent` (`keybinds.ts:117`).
- **Therefore the registration string this fix corrects is on the firing path even for *focused* keybinds** — which is exactly why fixing it made `]` / Ctrl-combos register and fire while focused. This is the **confirmed win — preserve it.**
- venbind parser (`tuxinal/venbind` `src/structs.rs::from_string`) **splits only on `+`**; a punctuation key (`,`, `]`) cannot corrupt the batch (only a literal `+` key could).

Re-reading the user's observations correctly:
- **Focused, with fix: `]` and Ctrl-combos now register/fire (didn't before)** → ✅ the fix working as intended. **Preserve.** *(The earlier "`,`/`.` failed focused" needs per-key re-verification — likely a test artifact or a key-specific quirk, NOT a refutation; the map values for 188=`,` / 190=`.` are confirmed correct vs ground truth.)*
- **Out-of-focus / global: "broke, incl. alphanumeric"** → this is the **still-unvalidated path**, and it **cannot be the map** (alphanumeric strings are byte-identical to pre-fix; the parser can't be corrupted by punctuation). Most likely the focus-gate at `venbind.ts:38` and/or the wrong build base.

**Wrong test base:** the isolated build was off **`origin/main`** (`test/win-keybind-flag-fixes`, CI run `27084274815`). Re-validate the **global/out-of-focus** path on the **dev/release base**.

### ⚠️ OPEN QUESTION (resolve next, without regressing the focused win)
Confirm out-of-focus firing works with the fix, and pin the mechanism:
1. `venbind.ts:38` focus-gate (`if (!isWayland && mainWindow.isFocused()) return;`) — does `isFocused()` reflect real focus? Does the synthetic path run when genuinely unfocused? (This gate is the prime suspect for "global broke.")
2. venbind `.node` load/capture (`[Venbind] Loaded venbind` log / `defineErrorHandle` output).
3. Reverse `keybinds:trigger` synthetic `KeyboardEvent` (`keybinds.ts:117`) dispatches `keyCode` only (no `key`/`code`) — verify Discord still matches modern builds.

## 4. Known remaining gaps (document, don't silently ship)

- **Named / non-printable keys are still broken** (out of KEY-01's punctuation scope but real): F1–F12 = 112–123, Space 32, Enter 13, Tab 9, Esc 27, Backspace 8, arrows 37–40. `keyCodeToChar` falls back to `String.fromCharCode` → wrong (`123 → "{"`, `32 → " "`). venbind wants **names** for these (its `windows.rs` uses `GetKeyNameTextW` for escape/backspace/tab/delete/return/space — note these are OS-localized, so matching is fiddly). The user's `SAVE_SCREENSHOT` (F12) is a live example. **Needs a keyCode→venbind-name table; confirm exact expected names from `tuxinal/venbind` `src/windows.rs`.**
- **Layout dependence:** DOM keyCode is US-biased (188 is always the comma-position key); venbind/libuiohook `keycode_to_unicode` yields the **OS-layout** char. On non-US layouts these can diverge → the char map may mismatch. User appears US (188=comma confirmed). Caveat only for now.
- **Firefox keyCode quirks (59/61/173)** are irrelevant — Electron is Chromium.

## 5. Plan for the next agent

1. **Automated tests (assigned to you).** Use Bun's built-in runner (`bun test`, **no new deps**). Extract the pure logic out of `getActiveKeybinds` into a testable module (suggested `src/windows/main/preload/keybindShortcut.ts`) exporting e.g. `parseDiscordShortcut(shortcut: number[][]): { shortcut: string; mainKeyCode: number | undefined; ctrl: boolean; alt: boolean; shift: boolean }` plus `keyCodeToChar`. Refactor `keybinds.ts` to consume it (keep `eventSettings.keyCode = mainKeyCode`). Drive tests from the **real ground-truth cases in §2** (e.g. `[[0,190,4]]→"."`, `[[0,188,4]]→","`, `[[0,17,4],[0,192,4]]→"ctrl+\`"`, `[[0,18,4],[0,67,4]]→"alt+c"`, `[[0,221,4]]→"]"`). Add the named-key cases as `expect.fail`/TODO until §4 is implemented.
2. **Extend the map to named keys** (§4) — keyCode→venbind-name; verify names against venbind `windows.rs`.
3. **Validate on the DEV/RELEASE base** (not `origin/main`): build via `testBuild.yml` on a branch off the dev branch (where the user's real release works). **Two success criteria:** (a) **REGRESSION GUARD** — non-alpha keybinds (`]`, Ctrl-combos) still register/fire when **focused** (the confirmed win — must not break); (b) the same keybinds now also fire **out-of-focus** (the §3 open question). Minimize tedium: one punctuation key, test once focused + once unfocused.
4. Only then decide release inclusion.

## 6. State / pointers

- **Fix commit:** `7103149` (KEY-01, dev branch `fix/windows-screenshare-cancel-restart`). Map verified correct; end-to-end unvalidated.
- **STREAM-05** (`main.ts:67` occluded-window flag typo) — commit `c988872`, separate & low-risk, also unvalidated.
- **Isolated test branch (fork):** `test/win-keybind-flag-fixes` = `origin/main` + the 2 fixes. CI run `27084274815` succeeded; artifact in `C:\Users\Christ\Downloads\goofcord-winfix-test\` (wrong base for keybinds — see §3). Safe to delete the branch.
- **Key files:** `src/windows/main/preload/keybinds.ts` (fix + reverse trigger path:117), `src/modules/native/venbind.ts` (loader; focus-gate:38), `src/windows/main/renderer/postVencord/keybinds.ts` (renderer trigger — *fetched upstream bundle*), `preVencord/patches/keybinds.ts` (enables desktop keybinds). venbind source: `github.com/tuxinal/venbind` (`structs.rs` parser, `windows.rs` matching).
- **Diagnostic source of truth:** `…/goofcord/Local Storage/leveldb/` `keybinds` entry (WSL-readable).
- **Release context:** user's fork release is `v2.2.1-winfix` (GH release, tag at `2bd8808`, cut from the dev branch — bundles cancel + echo fixes). v1.3 would add KEY-01 + STREAM-05 once validated.

## 7. Upstream issue #179 — KEY-01's real-world target (investigate)

**`Milkshiift/GoofCord` #179 — "[BUG] Global keybinds don't work with non-alphanumeric shortcuts"** (OPEN). The canonical upstream report for exactly what KEY-01 fixes. KEY-01 likely **Closes #179**.

**Why it matters / PR angle:**
- The maintainer tried twice and **concluded "I will likely need to make changes to venbind itself."** Our investigation found the root cause is GoofCord's own `String.fromCharCode(domKeyCode)` glue (`keybinds.ts`), **not** venbind — so the minimal GoofCord-side fix may resolve #179 where his attempts didn't. **Tactful framing required** (AI-averse maintainer who already invested here): lead with the concrete mechanism (keyCode 221 → `String.fromCharCode` → `Ý` ≠ `]`, with the ground-truth localStorage evidence) + a real Windows repro. Do **not** frame it as "venbind was a red herring."
- **Regression history corroborates the glue theory:** a reporter says `[` and `\` toggle-mute/deafen binds **worked in older versions** and broke (~2.2.1) — "now only A–z & 0–9 are compatible." Something regressed punctuation; `String.fromCharCode` is the prime suspect.

**Maintainer's prior attempts (study before PRing):**
- `f5eec78` "Fix native modules on Windows" (bun.lock, electron-builder.ts, package.json, messageEncryption.ts) — venbind **native-module loading** on Windows. **Relevant to the §3 global-capture question:** venbind `.node` loading is historically fragile on Windows → a candidate cause for "global broke incl. alphanumeric" on the wrong base.
- `3f9096e` "Improve keybinds.ts and fix special keys" (+161/−67, keybinds.ts only) — a big special-key rewrite the maintainer concluded **didn't work**. **Appears reverted: `upstream/main` keybinds.ts STILL has the simple `String.fromCharCode(mainKeys.at(-1))` line (identical to our base).** Read `3f9096e` to understand his rejected approach and avoid re-proposing it.

**#179 scope is broader than KEY-01's punctuation:**
- **Named keys** (PAGEUP/PAGEDOWN) → overlaps the §4 named-key gap (venbind names, not chars).
- **Mouse buttons** (mouse5) → a NEW dimension; check whether venbind supports mouse-button binds at all.
- Maintainer **can't reproduce in a VM**; we have a **real repro + ground truth** — a key PR asset.

**Investigation tasks:** (1) confirm KEY-01 resolves #179's punctuation cases on the dev base; (2) read `3f9096e`; (3) decide whether to also cover named keys / mouse buttons or scope the PR to punctuation and note the rest; (4) draft the PR around mechanism + repro, `Closes #179`.

## 8. Clean-room reminder
Map = **public DOM keyCode standard** only. Do **not** copy Discord's keycode tables/source into the fix, commits, or any PR. Observing the user's own config (`localStorage`) is fine; ingesting Discord code is not. *(Note: #179 + the maintainer's own commits are GoofCord/upstream material — fine to study and reference; the clean-room rule is specifically about Discord's code.)*
