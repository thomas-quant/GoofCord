---
quick_id: 260614-2rn
slug: global-keybind-domcode
date: 2026-06-14
status: complete
commit: 893e4f7
---

# Quick Task 260614-2rn — Summary

## What & why

Global (window-unfocused) keybinds for **non-printable** keys (PageUp, PageDown, Insert, Delete,
arrows, F-keys, Home/End, …) silently never fired, while printable keys (`]`, `.`, `Space`) worked
on both focused and global paths.

**Root cause (reasoned to ground truth, no build round-trip):** Discord's keybind matcher is
branched by key class — **printable** keyCodes are matched by numeric `keyCode`; **non-printable**
keys are matched by their DOM `KeyboardEvent.code`/`key` string. GoofCord's global path dispatches a
**synthetic** `KeyboardEvent` (`keybinds.ts` `keybinds:trigger`) that carried **only** `keyCode` +
modifier flags — no `code`/`key` — so non-printable keys had nothing for Discord to match on.

Decisive evidence (not re-derived during execution):
- venbind firing for these keys is **source-confirmed** (thomas-quant/venbind `fork-ci`:
  `structs.rs` tokens `pageup`/`insert`/…, `windows.rs` VK map, `ctrl+pageup` unit test) → the
  global chain register→fire→trigger→dispatch is sound up to the synthetic event.
- The PageUp bind **exists in Discord's store** (recorded from a real press) → Discord *can* convert
  the key; the only missing ingredient is the `code` a real event carries.
- keyCode-only synthetic events match printable keys but not non-printable ones → the matcher reads
  `code` for the latter. Confidence ~90% pre-test.

## Changes

| File | Change |
|------|--------|
| `src/windows/main/preload/keybindShortcut.ts` | Added `NAMED_KEYCODE_DOMCODE` (non-printable named keys only) + exported `keyCodeToDomCode()`. Printable keys (Space 32, numpad 96-111, letters/digits/OEM) deliberately excluded. |
| `src/windows/main/preload/keybinds.ts` | `Keybind.eventSettings` gains optional `code?`/`key?`; `getActiveKeybinds` spreads `{ code, key }` from `keyCodeToDomCode(mainKeyCode)` only when defined, so printable binds emit byte-identical eventSettings. Dispatch site unchanged. |
| `src/windows/main/preload/keybindShortcut.test.ts` | New `keyCodeToDomCode` describe block: nav/edit/function keys → DOM code; printable/excluded → `undefined`. |

Commit: `893e4f7` (`fix(10): carry DOM code/key on synthetic keybind events for non-printable keys`).

## Verification

- `bun test src/windows/main/preload/keybindShortcut.test.ts` → **10 pass / 0 fail** (8 prior + 2 new).
- `bun run check` (tsgo) → **clean (exit 0)**.
- No global `bun run fmt` run (would rewrite 90+ files); style hand-matched.
- Not built locally (CI-only). No PR opened/pushed.

## Scope / known limits

- **Focused** non-printable keybinds are **not** addressed — that path early-returns in
  `venbind.ts:38` and is a separate Discord delivery/interception issue (the real event already
  carries `code`/`key`). Global was the target and venbind's purpose.
- Residual unknown: whether Discord's non-printable branch keys off `code` vs `key` — hedged by
  setting **both** to the canonical DOM string (for this key set `code === key`).

## Next step (manual, on the user)

Trigger CI (`gh workflow run testBuild.yml --repo thomas-quant/GoofCord --ref fix/windows-screenshare-cancel-restart`),
then test **global PageUp / Insert / Delete** (unfocused) on the portable build with `]`/`.` as the
regression guard. This is a **confirmation of a forced conclusion**, not guess-and-check.
