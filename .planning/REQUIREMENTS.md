# Requirements: GoofCord v1.3 — Small Upstream-able Fixes

**Milestone type:** Build — surgical, upstream-able fixes surfaced by the v1.2 investigations. Each is small and self-contained; verification for the Windows-behaviour items is manual on a Windows x64 CI artifact (no automated repro), consistent with the project's verification reality.

## v1.3 Requirements

### Fixes
- [x] **KEY-01** *(implemented `7103149`; type-check + lint green; manual Windows CI verification pending)*: Non-alphanumeric global keybinds (OEM/punctuation keys: `]` `[` `;` `'` `,` `.` `/` `=` `-` `` ` `` `\`) register and fire on Windows. *Root cause (INV-02): `String.fromCharCode(domKeyCode)` at `src/windows/main/preload/keybinds.ts:53` yields Latin-1 garbage for OEM keyCodes; venbind matches the literal char. Fix = DOM-keyCode→char map (`OEM_KEYCODE_CHARS`). Pure-TS, no native work.*
- [x] **STREAM-05** *(implemented `c988872`; type-check + lint green; manual Windows CI verification pending)*: The Windows "don't background an occluded window" Chromium switch is actually applied. *Root cause (INV-04 byproduct): `src/main.ts:67` set `disable-disable-backgrounding-occluded-windows` (doubled `disable-`) — an unknown switch Chromium silently ignores, so occluded GoofCord windows can still be throttled/backgrounded, risking stream stalls when occluded. Fix = corrected the flag name to `disable-backgrounding-occluded-windows`.*

### Stretch (optional — not committed; pending read-timing verification + user go-ahead)
- [ ] **SEC-01**: `cloudToken` stored encrypted at rest (`encrypted: true` in `settingsSchema.ts:441`). *INV-01: the only cleartext secret; guards an already-E2E-encrypted cloud blob. Low value; needs a check that the token isn't read before `decryptSettings()` and an existing-plaintext-token migration note before shipping.*

## Out of Scope
- Numpad / named-key (space/enter/tab/escape) keybind mapping — INV-02 stretch, separate follow-up if reported.
- Broader Electron resource optimization — INV-04 DEFER/AVOID (streaming-regression risk).
- Encryption-hardening beyond the `cloudToken` one-liner — INV-01 NO-GO (crypto already sound).
- Scoping the Windows un-throttling to only-while-streaming — INV-04 DEFER (M/L, needs manual Windows verification).

## Traceability
| REQ | Phase |
|-----------|-------|
| KEY-01 | 10 |
| STREAM-05 | 11 |
| SEC-01 (stretch) | 12 |
