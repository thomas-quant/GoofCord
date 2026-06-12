# Phase 10 — Runtime test findings + debugging handoff

> **Status:** Code shipped & build-verified, but the Windows runtime test **FAILED for navigation/editing keys**. This handoff captures the exact results, what's been ruled out (with evidence), the architecture model, and a ranked, diagnostic-first plan. Read this before touching code — the obvious fix (the keyCode→token table) is **already correct**; the bug is elsewhere.

## 1. Test results (manual, Windows, build `GoofCord-2.2.1-win-x64` from CI run 27402678025)

| Bind | keyCode | type | focused | global (unfocused) |
|------|---------|------|---------|--------------------|
| `]` | 221 | OEM char | ✅ | ✅ |
| `.` | 190 | OEM char | ✅ | ✅ |
| Page Up | 33 | nav | ❌ | ❌ |
| Page Down | 34 | nav | ❌ | ❌ |
| Insert | 45 | edit/nav | ❌ | ❌ |
| Delete | 46 | edit/nav | ❌ | ❌ |
| Ctrl (alone) | 17 | modifier-only | ✅ | ❌ |
| F12 | 123 | function | *not reported* (unknown — ask user to retest) |

**Headline:** OEM **character** keys work on both paths; **navigation/editing** keys (PageUp/PageDown/Insert/Delete) fail on **both** paths. The split is by *key class*, not by code path.

## 2. What is CONFIRMED / RULED OUT (do not re-investigate)

- **The keyCode→token table is CORRECT.** Dumped Discord's actual stored binds from the Local Storage leveldb (see §5 for the command). Discord stores **standard DOM keyCodes**: `[[0,45,4]]`=Insert, `[[0,46,4]]`=Delete, `[[0,123,4]]`=F12, `[[0,221,4]]`=`]`, `[[0,17,4],[0,192,4]]`=Ctrl+`` ` ``, `[[0,18,4],[0,67,4]]`=Alt+C. So `NAMED_KEYCODE_TOKENS` (45→insert, 46→delete, 33→pageup, …) keys match what Discord stores. **The fix already maps these correctly — do NOT go re-deriving the table; that's a dead end.**
- **venbind binary is the fixed one and is bundled.** The `.node` inside the package is sha256-identical to the fork prebuild `f8d7805` (PE32+ x86-64), at `resources/app.asar.unpacked/ts-out/venbind-win32-x64-*.node`. So this is NOT a stale/wrong-binary problem.
- **Token vocabulary + parsing is unit-tested green** (`keybindShortcut.test.ts`, 8 pass) and `bun run check` clean.
- **"Ctrl works focused but not globally" is EXPLAINED, likely not a bug:** the stored `[[0,17,4]]` is a **modifier-only** bind. `parseDiscordShortcut` filters out modifiers → no main key → returns `shortcut:""` → `updateKeybinds` skips it (keybinds.ts `if (!shortcut || mainKeyCode === undefined) continue`). So it's never registered with venbind → can't fire globally. Focused works because Discord handles it natively. (NOTE: modifier-only PTT, e.g. Ctrl-as-PTT, is a real use case GoofCord currently can't do globally — see §6 follow-up. Separate from the named-key bug.)

## 3. Architecture model (the key mental model — two delivery paths)

GoofCord fakes desktop mode via the preVencord patch `src/windows/main/renderer/preVencord/patches/keybinds.ts` (forces `isDesktop()`/`isPlatformEmbedded` → true so Discord exposes desktop keybind action types). Then:

- **GLOBAL (window unfocused):** native `venbind` hook detects the key → matches a registered token → IPC `keybinds:trigger(id)` → **preload** `keybinds.ts:95` dispatches a **synthetic** `new KeyboardEvent("keydown", eventSettings)` (only `keyCode` + `ctrl/alt/shift` set; **NO `key`/`code`**) to `document` → Discord's (desktop-mode) keybind matcher fires the action.
- **FOCUSED (window focused):** `venbind.ts` callback returns early (`if (!isWayland && mainWindow.isFocused()) return;`) — GoofCord does **nothing**. The keybind fires only if Discord's own matcher catches the **real** DOM keydown.

**Critical inference:** the focused path involves ZERO GoofCord token/venbind code. So **navigation keys failing _focused_ means Discord's own matcher does not fire on real PageUp/Insert/Delete events** (while it does fire on real `]`/`.`). That rules out "it's purely a venbind/synthetic-event bug" and points at Discord's matcher / browser default-action consumption of non-character keys.

## 4. Root-cause hypotheses (ranked; diagnostic-first — gather data before coding)

The discriminator is **character keys work, non-character navigation/editing keys don't, on both paths.**

- **H1 — Discord's keybind matcher rejects these keyCodes (most likely, explains BOTH paths).** Discord likely maps event keyCodes through its own keycode table at match time; if 33/34/45/46 aren't in that map (or map to a different value than was stored), matching fails for both real and synthetic events, while 221/190 round-trip fine. → Inspect the Discord bundle module the patch targets (`find: "keybindActionTypes"`) and its keycode map. Grep the running renderer bundle / `assets/` for the keybind keycode table.
- **H2 — Browser/Discord consumes nav/edit keys before the matcher.** PageUp/Down scroll, Delete/Insert edit; a higher-priority handler `preventDefault`/`stopPropagation`s before the keybind listener. Explains focused; may also hit the synthetic dispatch if it lands on a focused input/scroller. → Check whether the synthetic event needs to be dispatched on a different target or with `{bubbles:true}` and whether default actions are intercepting.
- **H3 — Synthetic event lacks `key`/`code` and Discord uses them for non-character keys.** Char keys match via `keyCode`; named keys may need `event.code`/`event.key`. Explains GLOBAL only (not focused). Cheap to test: enrich the synthetic event (e.g. `code:"PageUp", key:"PageUp"`). → But H3 alone can't explain the focused failure, so it's at most a partial/secondary fix.
- **H4 — venbind not emitting tokens for these keys at runtime (GLOBAL only).** Possible but does NOT explain focused failure, so it's not the whole story. Confirm via the §5 logging before assuming.

**Note on focused named keys:** if H1/H2 prove to be Discord-inherent, focused named-key binds may simply not be fixable from GoofCord. **Global is venbind's whole purpose** — getting GLOBAL nav keys working is the real, achievable win; document focused as a Discord limitation if so.

## 5. Diagnostic plan (no DevTools on the test box — file-based)

**(a) Bisect the GLOBAL chain with file logging.** There is no DevTools (60% keyboard, no F12). Add temporary logging routed to a userData file (mirror the screenshare-debug.log pattern) at three points, then have the user reproduce a Page Up press (unfocused) and share the log:
- `venbind.ts` startVenbind callback — did venbind fire? what `id`? (proves H4 in/out)
- preload `keybinds.ts:95` `keybinds:trigger` handler — received? `keybind` found? log `eventSettings`.
- `updateKeybinds()` (keybinds.ts ~line 104, already `console.log(toSend)`) — what shortcut strings got registered with venbind? confirm `"insert"`,`"delete"`,`"pageup"` are in the set.
This isolates the break: registration → venbind-fire → trigger-received → synthetic-dispatch → Discord-match.

**(b) leveldb keybind dump (reproducible, WSL-readable; already used to get §2 data):**
```bash
GC="/mnt/c/Users/Christ/AppData/Roaming/goofcord/Local Storage/leveldb"
for f in "$GC"/*.ldb "$GC"/*.log; do strings -n 6 "$f" | grep -oE '"action":"[A-Z_]+"|"shortcut":\[\[[0-9,\]\[ ]*\]\]'; done | sort -u
```
(Best run with GoofCord closed for a clean read.)

**(c) Inspect Discord's keybind matcher** for H1: find the module behind `find:"keybindActionTypes"` and how it converts event→keycode at match time; check whether 33/34/45/46 are handled.

## 6. State / pointers

- **Build under test:** `C:\Users\Christ\Downloads\GoofCord-keybind-test\GoofCord.exe` (portable; shares `%APPDATA%\goofcord` config). Re-trigger: `gh workflow run testBuild.yml --repo thomas-quant/GoofCord --ref fix/windows-screenshare-cancel-restart`.
- **GoofCord branch:** `fix/windows-screenshare-cancel-restart` (pushed to fork `origin`). Phase-10 commits `fbf0492`→`5752fda`. venbind pinned to `github:thomas-quant/venbind#f8d7805`.
- **venbind fork:** `thomas-quant/venbind` `fork-ci` (CI green both targets). windows.rs `vk_to_token` maps VK_PRIOR→pageup, VK_NEXT→pagedown, VK_INSERT→insert, VK_DELETE→delete (all present).
- **Files:**
  - `src/windows/main/preload/keybindShortcut.ts` — `NAMED_KEYCODE_TOKENS` (correct), `keyCodeToChar`, `parseDiscordShortcut`.
  - `src/windows/main/preload/keybinds.ts:95-104` — `keybinds:trigger` → synthetic `KeyboardEvent` (the suspect: keyCode-only, no key/code).
  - `src/modules/native/venbind.ts:37-40` — focused early-return; the global vs focused fork.
  - `src/windows/main/renderer/preVencord/patches/keybinds.ts` — the desktop-mode patch (Discord matcher entry point).
- **Follow-up (separate from this bug):** modifier-only global keybinds (e.g. Ctrl-as-PTT) are dropped by `parseDiscordShortcut` (no main key). Supporting them = venbind must accept a modifiers-only shortcut without matching every keypress. Out of scope here; capture if wanted.

## 7. What "done" looks like
Global Page Up / Insert / Delete fire a bound action when GoofCord is unfocused, with `]`/`.` still working (regression guard). Focused named keys are a stretch — fix if H1/H2 turn out GoofCord-side, otherwise document as a Discord limitation. Re-test via the portable build in §6.
