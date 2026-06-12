---
phase: 10-keybinds-non-alphanumeric-fix
plan: 01
subsystem: keybinds (Windows global hotkeys / venbind)
tags: [keybinds, venbind, windows, refactor, tdd]
requires:
  - "DOM KeyboardEvent.keyCode integers from Discord localStorage['keybinds']"
provides:
  - "keybindShortcut.ts: pure keyCodeToChar + parseDiscordShortcut (bun:test-able)"
  - "Named/control keys resolve to venbind canonical tokens (KEY-01 named-key half)"
affects:
  - "src/windows/main/preload/keybinds.ts (getActiveKeybinds now consumes the pure module)"
tech-stack:
  added: []
  patterns:
    - "Pure dependency-free module extracted for bun:test coverage"
key-files:
  created:
    - src/windows/main/preload/keybindShortcut.ts
    - src/windows/main/preload/keybindShortcut.test.ts
  modified:
    - src/windows/main/preload/keybinds.ts
decisions:
  - "keyCode 13 -> 'enter' only; NO 'numpadenter' entry (unreachable from Discord keyCodes)"
  - "NAMED_KEYCODE_TOKENS consulted FIRST, then OEM_KEYCODE_CHARS, then String.fromCharCode"
metrics:
  duration: "~12m"
  completed: 2026-06-12
  tasks: 2
  files: 3
requirements: [KEY-01]
---

# Phase 10 Plan 01: Named-key keybinds + pure keybindShortcut module Summary

Finished the named-key half of KEY-01 (upstream #179): control/named keys (Enter, Space,
F-keys, arrows, Page Up/Down, numpad…) now resolve to venbind's canonical lowercase token
instead of `String.fromCharCode` garbage, and the shortcut-parsing logic was extracted into a
pure, dependency-free `keybindShortcut.ts` module guarded by a bun:test suite that locks in the
already-confirmed punctuation win.

## What Was Built

**Task A** — Added `NAMED_KEYCODE_TOKENS: Record<number, string>` to `keybinds.ts` (initially),
mapping DOM keyCodes to the exact venbind token vocabulary (`thomas-quant/venbind`
`src/structs.rs::tokens`): control keys (8/9/13/27/32), navigation (33/34/35/36/45/46), arrows
(37/38/39/40), locks/system (20/144/145/44/19/93), f1..f24 (112..135), and numpad
(96..105 + add/subtract/multiply/divide/decimal). `keyCodeToChar` now reads
`NAMED_KEYCODE_TOKENS[k] ?? OEM_KEYCODE_CHARS[k] ?? String.fromCharCode(k)`.

**Task B (TDD)** — Extracted a pure, import-free `keybindShortcut.ts` exporting `keyCodeToChar`
and `parseDiscordShortcut(shortcut: number[][]) => { shortcut, mainKeyCode, ctrl, alt, shift }`,
moving the keyCode tables and the modifier/main-key logic out of `getActiveKeybinds`. Added
`keybindShortcut.test.ts` (bun:test, no new deps) covering punctuation ground truth, named keys,
alphanumeric, no-main-key, and mainKeyCode/modifier threading. Refactored `getActiveKeybinds` to
call `parseDiscordShortcut(binding.shortcut)` and thread the result into `eventSettings`,
deleting the now-duplicated tables/logic (123 lines removed from keybinds.ts).

## Spec Correction Applied

Per plan: kept `13 -> "enter"` with NO `numpadenter` entry. venbind emits `numpadenter` for
physical numpad Enter, but Discord's stored shortcut carries only DOM keyCode 13 with no numpad
location, so a `numpadenter` entry would be unreachable. Net effect: numpad Enter no longer
triggers an Enter bind — now consistent with the Linux backend. This is folded into the code
comment in both `keybinds.ts` (Task A, then removed in refactor) and `keybindShortcut.ts`.

## Verification (run locally, real output)

`bun test src/windows/main/preload/keybindShortcut.test.ts`:
```
bun test v1.3.13 (bf2e2cec)
 8 pass
 0 fail
 29 expect() calls
Ran 8 tests across 1 file. [114.00ms]
```

`bun run check` (tsgo strict):
```
EXIT: 0
$ tsgo
```

NOT run locally (per plan + project constraints): any app build/package; Windows runtime
verification is gated to plan 10-02 + CI.

## Commits

- `fbf0492` feat(10-01): map named/control keyCodes to venbind tokens (Task A)
- `dd17805` test(10-01): add failing tests for pure keybindShortcut module (Task B RED)
- `9ddb478` feat(10-01): extract pure keybindShortcut module (Task B GREEN)
- `131a333` refactor(10-01): consume keybindShortcut in getActiveKeybinds (Task B REFACTOR)

## Deviations from Plan

None — plan executed exactly as written. The spec correction (no `numpadenter`) was part of the
plan body and was applied as specified.

## Known Stubs

None. The runtime dependency switch (consuming the fixed venbind prebuilt `.node`) is
intentionally out of scope and deferred to plan 10-02, as stated in the plan objective.

## TDD Gate Compliance

Task B followed RED -> GREEN -> REFACTOR with distinct commits:
- RED: `dd17805` test(...) — tests fail (module missing)
- GREEN: `9ddb478` feat(...) — module created, 8/8 tests pass
- REFACTOR: `131a333` refactor(...) — keybinds.ts consumes module, tests still pass

## Self-Check: PASSED

- FOUND: src/windows/main/preload/keybindShortcut.ts
- FOUND: src/windows/main/preload/keybindShortcut.test.ts
- FOUND: src/windows/main/preload/keybinds.ts
- FOUND commits: fbf0492, dd17805, 9ddb478, 131a333
