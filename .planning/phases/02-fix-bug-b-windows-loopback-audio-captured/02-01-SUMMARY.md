---
phase: 02-fix-bug-b-windows-loopback-audio-captured
plan: 01
subsystem: recon-docs
tags: [recon, windows, audio, wasapi, loopback, clean-room, docs]
requires: []
provides:
  - "02-FINDINGS.md (desk-research baseline + unfilled hands-on slots)"
  - "02-RECON-RUNBOOK.md (copy-pasteable Windows inspection script for 02-02)"
affects:
  - ".planning/phases/02-fix-bug-b-windows-loopback-audio-captured/"
tech-stack:
  added: []
  patterns:
    - "Evidence provenance + confidence two-tag convention on every claim"
    - "Desk-research baseline vs. hands-on-dependent slot separation (honesty guardrail)"
key-files:
  created:
    - ".planning/phases/02-fix-bug-b-windows-loopback-audio-captured/02-FINDINGS.md"
    - ".planning/phases/02-fix-bug-b-windows-loopback-audio-captured/02-RECON-RUNBOOK.md"
  modified: []
decisions:
  - "Mechanism verdict + clean-room go/no-go left as explicit unfilled [TO BE FILLED IN 02-02] / [depends on 02-02] slots — no hands-on conclusion pre-filled from inference (Pitfall 1; D-08/D-09 honesty theme)"
  - "AUDIO-02 recorded as investigated-only: getVirtmic() returns null on Windows so the Patchcord track-removal block never fires there → no GoofCord code change needed for that path (D-03)"
  - "EXCLUDE_TARGET_PROCESS_TREE documented as the echo fix; whole-mix Chromium loopback is the cause, not a fix"
  - "Recon-only boundary held: zero src/ changes across all 3 commits (D-02/D-04, UPST-01)"
metrics:
  duration_min: 3
  tasks_completed: 3
  files_created: 2
  files_modified: 0
  completed: 2026-05-30
---

# Phase 2 Plan 01: Desk-Research Baseline + Inspection Runbook Summary

Produced the AI-doable half of the Phase 2 recon deliverable: the `02-FINDINGS.md` skeleton with every desk-research-able section filled (public WASAPI process-loopback API surface, min Windows build 20348 + fallback, macOS-driver contrast, Electron multi-process complication, AUDIO-02 investigated-only conclusion) and the copy-pasteable `02-RECON-RUNBOOK.md` the developer runs on their Windows box in 02-02 — with the mechanism verdict and clean-room go/no-go deliberately left as explicit unfilled slots that depend on the human's on-box observations.

## What Was Built

- **`02-FINDINGS.md`** — findings-document skeleton whose four top-level sections map 1:1 to ROADMAP Phase 2 Success Criteria 1-4:
  - `## 1. Mechanism + Evidence` — unfilled `[TO BE FILLED IN 02-02]` mechanism verdict + an empty evidence table (one row per runbook step) + a `strings`-vs-`dumpbin` honesty guardrail.
  - `## 2. Replication Parameters` — desk-confirmed INCLUDE vs EXCLUDE (EXCLUDE = echo fix), min build 20348 + fallback for older builds, the Electron separate "Audio Service" utility process / process-tree exclude-target complication (exact PID on Electron 41.3.0 flagged as a future-impl open detail); the *actual* tree Discord excludes left as `[depends on 02-02 observations]`.
  - `## 3. Clean-room Go/No-Go` — public-API replication surface named (`ActivateAudioInterfaceAsync`, `AUDIOCLIENT_ACTIVATION_PARAMS`, `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS`, `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`, the `E_NOTIMPL`-on-`GetMixFormat` quirk) as the clean-room source of truth (D-05); macOS Rogue Amoeba driver contrast (MEDIUM); final go/no-go verdict left `[depends on 02-02 mechanism finding]`.
  - `## 4. Recon-only Boundary` — recon-only attestation (no src changed, no prototype, no packages), clean-room boundary statement (D-05), and the AUDIO-02 investigated-only conclusion.
  - Provenance legend + Confidence legend at the top; every substantive desk-research claim carries both tags.
- **`02-RECON-RUNBOOK.md`** — ordered, copy-pasteable Windows inspection script (7 steps + honesty rules + out-of-scope verification caveats): locate `%LocalAppData%\Discord\app-*\modules\`, Device Manager (`devmgmt.msc`) virtual-device check, Sysinternals `strings` pass, authoritative `dumpbin /imports` corroboration, INCLUDE-vs-EXCLUDE determination, Discord/Audio-Service PID enumeration (`tasklist /v`), and `winver` build check. CLI/GUI tools only (no DevTools, D-09). 9 fillable `Result:` slots that map 1:1 to the FINDINGS Section-1 evidence rows.

## Task Commits

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Scaffold 02-FINDINGS.md (4 sections, legends, unfilled verdict, boundary attestation) | f1267f2 | 02-FINDINGS.md (created) |
| 2 | Fill desk-research baseline (build 20348, EXCLUDE-tree, public API, Electron multi-process, macOS contrast, AUDIO-02) | bf2fac2 | 02-FINDINGS.md (modified) |
| 3 | Author 02-RECON-RUNBOOK.md (7-step copy-pasteable inspection script) | f0a9401 | 02-RECON-RUNBOOK.md (created) |

## Verification

All per-task automated `<verify>` checks returned PASS:
- Task 1: 4 section headings + both legends + unfilled `TO BE FILLED IN 02-02` verdict — PASS.
- Task 2: `20348`, `EXCLUDE_TARGET_PROCESS_TREE`, `ActivateAudioInterfaceAsync`, `getVirtmic`, `depends on 02-02`, `Audio Service|process tree` all present — PASS.
- Task 3: `modules`, `dumpbin /imports`, `ActivateAudioInterface`, `PROCESS_LOOPBACK`, `winver`, ≥6 `Result:` slots (found 9), `devmgmt`, `%LocalAppData%\Discord` path, corroboration warning — PASS.

Overall plan verification:
- **Recon-only boundary holds:** `git diff --name-only HEAD~3 HEAD -- src/` shows zero `src/` changes; only the two phase-dir docs were touched ([UPST-01], D-02). 
- Mechanism verdict and clean-room go/no-go remain explicit unfilled slots (9 × "TO BE FILLED IN 02-02", 4 × "depends on 02-02") — no hands-on conclusion pre-filled.
- Honesty guard: the only occurrence of "hands-on confirmed" outside the legends is the guardrail sentence stating no claim *may* be tagged that way until the human step runs — no asserted Discord-mechanism claim is tagged hands-on confirmed.

## Deviations from Plan

None — plan executed exactly as written. No bugs, missing functionality, or blocking issues encountered (this is a docs-only recon plan).

## Authentication Gates

None.

## Known Stubs

None. The unfilled mechanism verdict, evidence-table rows, the "which process tree Discord excludes" sub-point, and the final go/no-go verdict are **intentional** unfilled slots — they are hands-on-dependent and are resolved by plan 02-02 when the developer runs the runbook on their physical Windows box. They are explicitly marked `[TO BE FILLED IN 02-02]` / `[depends on 02-02 observations]` per the phase honesty guardrail (Pitfall 1, D-08/D-09); pre-filling them from inference is prohibited by this phase's critical boundary.

## Notes for 02-02

- The developer runs `02-RECON-RUNBOOK.md` on their Windows box; each of the 9 `Result:` slots maps 1:1 to a row in `02-FINDINGS.md → ## 1. Mechanism + Evidence`.
- After observations are recorded, the Section-1 Verdict placeholder is replaced with the evidence-backed mechanism (virtual-device driver | public WASAPI process-loopback | other | inconclusive), and Section 3.3 final clean-room go/no-go is synthesized from the public API (Section 3.1) + the hands-on mechanism finding.
- A `strings` hit MUST be corroborated by `dumpbin /imports` before confidence is upgraded (Pitfall 3/5).
