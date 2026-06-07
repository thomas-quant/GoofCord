# Roadmap: GoofCord — Windows Streaming Fixes (Fork)

## Shipped Milestones
- ✅ **v1.0 Windows Streaming Fixes** — Phases 1-2 (2026-05-30)
- ✅ **v1.1 Windows Screenshare Echo Fix (#46)** — Phases 3-5 (2026-06-06) → [archive](milestones/v1.1-ROADMAP.md)

Upstream PRs: #210 (Wayland xdg-portal-cancel re-open) · #211 (Windows echo fix, Closes #46).

## Active Milestone: v1.2 — Feature Viability Investigations

**Type:** Investigation / triage — **no feature code ships.** Each phase is an independent spike that produces a `FINDINGS.md` with a GO / NO-GO / DEFER verdict + tech-debt estimate. Greenlit ideas become their own build milestones (v1.3+).

**Parallelism:** Phases 6-9 have no inter-dependencies and are run concurrently (one spike agent each).

| # | Phase | REQ | Deliverable |
|---|-------|-----|-------------|
| 6 | Encryption Hardening Investigation | INV-01 | `06-FINDINGS.md` |
| 7 | Keybinds Non-Alphanumeric Investigation | INV-02 | `07-FINDINGS.md` |
| 8 | Deafen/Mute Mechanism Recon | INV-03 | `08-FINDINGS.md` |
| 9 | Resource Usage / Electron Optimization Investigation | INV-04 | `09-FINDINGS.md` |

### Phase 6 — Encryption Hardening Investigation (INV-01)
**Goal:** Determine whether GoofCord's encryption / secret handling has a meaningful weakness worth fixing, and whether a stronger approach is viable without unupstreamable divergence.
**Success criteria:**
1. Current message-encryption password + config-at-rest mechanism documented (files + flow).
2. Any effectively-plaintext exposure identified — or ruled out — with evidence.
3. Stronger-path options surveyed with tech-debt cost + upstream-ability.
4. GO / NO-GO / DEFER verdict + recommended next step.

### Phase 7 — Keybinds Non-Alphanumeric Investigation (INV-02)
**Goal:** Find the root cause of `venbind` failing on non-alphanumeric keys on Windows and decide patch-vs-replace-vs-accept.
**Success criteria:**
1. Root cause located (venbind native layer vs. GoofCord glue vs. Discord-web layer).
2. Patch-venbind, alternative-library, and accept-as-is options compared with tech-debt + upstream-ability.
3. GO / NO-GO / DEFER verdict + recommended next step.

### Phase 8 — Deafen/Mute Mechanism Recon (INV-03)
**Goal:** Explain the speaker-attenuation-when-deafened behavior and locate the responsible layer.
**Success criteria:**
1. Mechanism traced across GoofCord / Vencord / Discord-web.
2. Whether the behavior is GoofCord-caused or inherited is settled with evidence.
3. Whether anything is actionable (and if so, where) stated clearly.

### Phase 9 — Resource Usage / Electron Optimization Investigation (INV-04)
**Goal:** Produce a realistic, prioritized list of resource optimizations for this Electron app with safe-vs-risky labeling.
**Success criteria:**
1. Current resource posture characterized (process model, Chromium flags, known costs).
2. Concrete optimization opportunities surveyed (memory / CPU / V8 / throttling / process model) with tech-debt + regression risk.
3. Prioritized GO / DEFER list + recommended next step.
