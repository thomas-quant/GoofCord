# Requirements: GoofCord v1.2 — Feature Viability Investigations

**Milestone type:** Investigation / triage. **No feature code ships.** Each requirement is satisfied by a findings document carrying a GO / NO-GO / DEFER verdict, not by an implementation. Greenlit ideas become their own build milestones (v1.3+).

**Per-investigation deliverable bar — every INV-* findings doc must answer:**
1. **Current state** — how this works in the GoofCord codebase today (files + mechanism).
2. **Options survey** — maintained libraries, OSS repos, upstream/Vencord approaches that cover it (versions + maintenance status).
3. **Tech-debt cost** — complexity + ongoing maintenance each path adds; fork-divergence risk.
4. **Upstream-ability** — could a fix go back to Milkshiift/GoofCord? (High, AI-averse PR bar in mind.)
5. **Verdict** — GO (worth a build milestone) / NO-GO (drop) / DEFER (revisit), with a recommended next step + rough effort.

## v1.2 Requirements

### Investigations — all complete (verdicts landed 2026-06-07)
- [x] **INV-01** — encryption hardening → **NO-GO**. Secrets are already `safeStorage`/DPAPI ciphertext at rest (verified on the real on-disk config), not plaintext; StegCloak path uses Argon2 + AEAD, cloud uses scrypt+AES-256-GCM. Only optional item: one **S** micro-PR marking `cloudToken` `encrypted: true` (the sole cleartext secret, guards an already-E2E blob). See `06-FINDINGS.md`.
- [x] **INV-02** — keybinds non-alphanumeric → **GO (S)**. Root cause is **GoofCord's own preload glue, not venbind**: `src/windows/main/preload/keybinds.ts:53` builds the shortcut with `String.fromCharCode(domKeyCode)`, which yields Latin-1 garbage for OEM keys (`]`221→`ý`, `;`186→`º`). Fix = ~15-line DOM-keyCode→char map, pure-TS, no native fork, most upstream-able. See `07-FINDINGS.md`.
- [x] **INV-03** — deafen/mute recon → **NO-GO**. Inherited Discord-web-in-Chromium behaviour (Windows "communications" auto-ducking that native Discord's C++ engine bypasses + web gain-ramp); GoofCord touches **zero** audio-graph code. Curiosity satisfied; nothing to build. See `08-FINDINGS.md`.
- [x] **INV-04** — resource usage / Electron optimization → **mostly DEFER/AVOID**. Thin shell; renderer dominates; Windows deliberately spends resources to keep streams alive (mission). Only safe win: **measure-first** Windows RAM/CPU baseline (**S**). **Byproduct bug found:** `src/main.ts:67` flag typo `disable-disable-backgrounding-occluded-windows` (should be `disable-backgrounding-occluded-windows`) — a silent no-op; fixing it is a streaming-stability correctness fix (**S**, upstream-able). See `09-FINDINGS.md`.

**Milestone outcome:** 2 surgical upstream-able fixes surfaced (INV-02 keybinds + INV-04's `main.ts` typo), 1 optional micro-PR (INV-01 `cloudToken`), 2 clean "nothing to build" closes (INV-01 main, INV-03). Greenlit items → v1.3 build milestone.

## Future Requirements
- Build milestones for whichever INV-* return GO (v1.3+). Scope TBD by the findings.
- **WSTRM-01** — further Windows screenshare/streaming bugs (carried from v1.0 close).

## Out of Scope
- Implementing any investigated feature in v1.2 — investigate-only milestone (user decision 2026-06-07).
- Streaming behaviour (v1.0 / v1.1 territory) — untouched this milestone.
- Burning down the full `CONCERNS.md` tech-debt list — only the four named ideas.

## Traceability
| REQ | Phase |
|--------|-------|
| INV-01 | 06 |
| INV-02 | 07 |
| INV-03 | 08 |
| INV-04 | 09 |
