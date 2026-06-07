# Requirements: GoofCord v1.2 — Feature Viability Investigations

**Milestone type:** Investigation / triage. **No feature code ships.** Each requirement is satisfied by a findings document carrying a GO / NO-GO / DEFER verdict, not by an implementation. Greenlit ideas become their own build milestones (v1.3+).

**Per-investigation deliverable bar — every INV-* findings doc must answer:**
1. **Current state** — how this works in the GoofCord codebase today (files + mechanism).
2. **Options survey** — maintained libraries, OSS repos, upstream/Vencord approaches that cover it (versions + maintenance status).
3. **Tech-debt cost** — complexity + ongoing maintenance each path adds; fork-divergence risk.
4. **Upstream-ability** — could a fix go back to Milkshiift/GoofCord? (High, AI-averse PR bar in mind.)
5. **Verdict** — GO (worth a build milestone) / NO-GO (drop) / DEFER (revisit), with a recommended next step + rough effort.

## v1.2 Requirements

### Investigations
- [ ] **INV-01**: Viability assessment — **encryption hardening**. Audit message-encryption password handling + config-at-rest storage (`safeStorage`, StegCloak, cloud encryption); identify any effectively-plaintext exposure (or rule it out); survey a more-secure path. Verdict + tech-debt estimate.
- [ ] **INV-02**: Viability assessment — **keybinds, non-alphanumeric keys**. Root-cause why `venbind` 0.1.7 fails on keys like `]` `;` on Windows; compare patch-venbind vs. alternative-library vs. accept. Verdict + tech-debt estimate. *(Most upstream-able.)*
- [ ] **INV-03**: Mechanism recon — **deafen/mute**. Explain why GoofCord shows speaker attenuation when deafened (differs from native); locate the responsible layer across GoofCord / Vencord / Discord-web. Findings + whether anything is actionable. *(Curiosity / lightest.)*
- [ ] **INV-04**: Viability assessment — **resource usage / Electron optimization**. Survey realistic memory/CPU/process-model/V8/throttling optimizations for this Electron app; label safe vs. risky. Prioritized verdict + tech-debt estimate.

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
