# Roadmap: GoofCord — Windows Streaming Fixes (Fork)

## Shipped / Completed Milestones
- ✅ **v1.0 Windows Streaming Fixes** — Phases 1-2 (2026-05-30)
- ✅ **v1.1 Windows Screenshare Echo Fix (#46)** — Phases 3-5 (2026-06-06) → [archive](milestones/v1.1-ROADMAP.md)
- ✅ **v1.2 Feature Viability Investigations** — Phases 6-9 (2026-06-07), investigate-only triage → [archive](milestones/v1.2-ROADMAP.md). 4 verdicts: INV-02 keybinds GO, INV-04 found a `main.ts` flag typo, INV-01 + INV-03 NO-GO.

Upstream PRs: #210 (Wayland xdg-portal-cancel re-open) · #211 (Windows echo fix, Closes #46).

## Active Milestone: v1.3 — Small Upstream-able Fixes

**Type:** Build. Two surgical, upstream-able fixes promoted from the v1.2 investigations, plus one optional stretch. Independent files (no inter-phase dependency). Keybinds + flag-typo verification is manual on a Windows x64 CI artifact.

| # | Phase | REQ | Touches |
|---|-------|-----|---------|
| 10 | Keybinds Non-Alphanumeric Fix | KEY-01 | `src/windows/main/preload/keybinds.ts` |
| 11 | Occluded-Window Flag Typo Fix | STREAM-05 | `src/main.ts` |
| 12 | cloudToken Encryption *(stretch, optional)* | SEC-01 | `src/settingsSchema.ts` |

### Phase 10 — Keybinds Non-Alphanumeric Fix (KEY-01)
**Goal:** Global keybinds bound to OEM/punctuation keys register and fire on Windows.
**Success criteria:**
1. `keybinds.ts` feeds venbind the literal key char (e.g. `]`, `;`) instead of `String.fromCharCode(keyCode)` garbage.
2. Existing alphanumeric binds still work (no regression).
3. `bun run check` passes; manual Windows CI verification of a `Ctrl+]` / `;` bind firing.

### Phase 11 — Occluded-Window Flag Typo Fix (STREAM-05)
**Goal:** The intended `disable-backgrounding-occluded-windows` Chromium switch is actually applied on Windows.
**Success criteria:**
1. `src/main.ts:67` uses the correct flag name (single `disable-`).
2. No change to the other two Windows anti-backgrounding switches.
3. `bun run check` passes; flag verified present in the launched switch set.

### Phase 12 — cloudToken Encryption (SEC-01) *(stretch / optional)*
**Goal:** The only cleartext secret (`cloudToken`) is encrypted at rest.
**Success criteria:**
1. `cloudToken` carries `encrypted: true` and round-trips through the existing `ENC:`/`PLAIN:` machinery.
2. Verified the token is not read before `decryptSettings()`; existing-plaintext-token migration is graceful.
3. Only proceeds with explicit user go-ahead (deferred by default).
