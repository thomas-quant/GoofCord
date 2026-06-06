# Roadmap: GoofCord — Windows Streaming Fixes

## Overview

A tight, Windows-focused bug-fix project for a brownfield Electron/Vencord Discord client, run as two milestones — both now shipped and contributed back upstream.

- **v1.0 — Windows Streaming Fixes:** Bug A (cancel the source picker, second start-stream click is inert) fixed via an exactly-once `finishRequest()` teardown + the kept `NotAllowedError` re-throw; Bug B a recon-only investigation identifying Discord's Windows per-process audio mechanism (public WASAPI Application Loopback, EXCLUDE process-tree).
- **v1.1 — Windows Screenshare Echo Fix (#46):** native WASAPI per-process-tree EXCLUDE loopback (capture everything except GoofCord's own Electron tree) replacing whole-mix `"loopback"`, built clean-room from the public Microsoft `ApplicationLoopback` sample and shipped as a venbind-style prebuilt `.node` addon. Verified viewer-side on Windows CI build 19045.

## Milestones

- ✅ **v1.0 Windows Streaming Fixes** — Phases 1-2 (shipped 2026-05-30)
- ✅ **v1.1 Windows Screenshare Echo Fix** — Phases 3-5 (shipped 2026-06-06) → [archive](milestones/v1.1-ROADMAP.md)

Upstream PRs: #210 (Wayland xdg-portal-cancel re-open) · #211 (Windows echo fix, Closes #46).

## Phases

<details>
<summary>✅ v1.0 Windows Streaming Fixes (Phases 1-2) — SHIPPED 2026-05-30</summary>

- [x] Phase 1: Fix Bug A — Cancel then Restart Works (2/2 plans) — completed 2026-05-30
- [x] Phase 2: Fix Bug B — Windows Loopback Audio Captured, recon-only (2/2 plans) — completed 2026-05-30

Full record: `.planning/MILESTONES.md` (v1.0 entry).

</details>

<details>
<summary>✅ v1.1 Windows Screenshare Echo Fix (Phases 3-5) — SHIPPED 2026-06-06</summary>

- [x] Phase 3: Delivery-Path Spike — PCM → MediaStream (GO/NO-GO) (3/3 plans) — completed 2026-06-02
- [x] Phase 4: Native Clean-Room Exclude-Tree Addon + Integration (3/3 plans) — completed 2026-06-06
- [x] Phase 5: Verification + Upstream PR (7/7 plans) — completed 2026-06-06

Full phase details: [milestones/v1.1-ROADMAP.md](milestones/v1.1-ROADMAP.md).

</details>

## Progress

**Execution Order:** Phases executed in numeric order: 1 → 2 → 3 → 4 → 5.

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Fix Bug A — Cancel then Restart Works | v1.0 | 2/2 | Complete | 2026-05-30 |
| 2. Fix Bug B — Windows Loopback Audio Captured | v1.0 | 2/2 | Complete | 2026-05-30 |
| 3. Delivery-Path Spike — PCM → MediaStream (GO/NO-GO) | v1.1 | 3/3 | Complete | 2026-06-02 |
| 4. Native Clean-Room Exclude-Tree Addon + Integration | v1.1 | 3/3 | Complete | 2026-06-06 |
| 5. Verification + Upstream PR | v1.1 | 7/7 | Complete | 2026-06-06 |
