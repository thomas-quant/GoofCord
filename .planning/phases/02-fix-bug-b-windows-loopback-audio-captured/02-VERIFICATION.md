---
phase: 02-fix-bug-b-windows-loopback-audio-captured
verified: 2026-05-30T00:00:00Z
status: passed
score: 6/6 must-haves verified
overrides_applied: 0
developer_approval:
  closed_in_session: true
  date: 2026-05-30
  signal: "Yeah no, that's cool"
  context: "Developer approved the 02-02 Task-3 human-verify checkpoint live during the execute-phase session, in direct response to the checkpoint presentation that itemised the WSL2/AI-run provenance and the specific honesty spot-checks (EXCLUDE is symbol-inferred not enum-read; live PIDs not observed; build correction; clean-room boundary). Both human_verification items below are thereby closed."
human_verification:
  - test: "Developer confirms 02-RECON-OBSERVATIONS.md contains their actual on-box results — specifically that the WSL2/Claude execution of the runbook (disclosed at the top of both 02-FINDINGS.md and 02-RECON-OBSERVATIONS.md) is an accurate record of what happened on their machine, and that any step not personally run is correctly marked not run / unknown."
    expected: "Developer explicitly approves the provenance disclosure — the fact that Claude ran the inspection from WSL2 on the developer's real Windows machine, not from a fabricated or inferred dataset."
    why_human: "The plan's Task 3 checkpoint (02-02-PLAN.md lines 136-164) is a human-verify gate specifically requiring the developer to confirm the honesty guardrail. The SUMMARY states the developer approved with 'Yeah no, that's cool' — but that approval itself is a SUMMARY claim, not codebase evidence. The verifier cannot confirm developer approval occurred; only the developer can attest it."
  - test: "Developer spot-checks 2-3 evidence rows in 02-FINDINGS.md §1 against 02-RECON-OBSERVATIONS.md and confirms the tags (hands-on confirmed vs. not run / unknown) match what was actually observed."
    expected: "No hands-on confirmed tag exists for a step the developer did not personally observe or approve Claude's WSL2 execution for."
    why_human: "Step 6 (live PIDs) is correctly marked 'not run / unknown' — the verifier can confirm that. But the developer needs to confirm the other five 'hands-on confirmed' rows represent observations they accept as genuine (either personally performed or approved via WSL2 proxy)."
---

# Phase 2: Fix Bug B — Windows Loopback Audio Captured Verification Report

**Phase Goal:** On Windows, determine and document exactly how the official Discord desktop client captures per-process / system audio for screenshare WITHOUT echoing the call back to viewers — identify the mechanism (installed virtual audio device driver vs. public WASAPI Application Loopback API with process-tree exclusion). Deliverable is a recon findings document enabling a later phase to decide, from evidence, whether GoofCord can replicate it clean-room from the public Microsoft API. No GoofCord code change and no prototype this phase.

**Verified:** 2026-05-30
**Status:** PASSED — all automated checks pass (6/6); the Task-3 human-verify gate was closed by explicit developer approval in the execute-phase session (see `developer_approval` in frontmatter: signal "Yeah no, that's cool", 2026-05-30), confirming the WSL2/AI-run provenance and that no `hands-on confirmed` tag overclaims.
**Re-verification:** No — initial verification.

---

## Note on Plan-Level Check Interpretation

The 02-01 PLAN's Task 1 and Task 2 automated checks contain a grep for `TO BE FILLED IN 02-02` and `depends on 02-02` being PRESENT. Running those checks against the current (finalized) `02-FINDINGS.md` produces FAIL — because those placeholders were correctly removed by plan 02-02. This is expected behavior: those were pre-conditions for the skeleton, not post-conditions for the finalized document. The correct post-conditions are the 02-02 Task 2 checks (0 occurrences of placeholders + Verdict: present + clean-room cited), which PASS. This verifier treats the 02-02 Task 2 checks as authoritative for the final state of 02-FINDINGS.md.

---

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| SC-1 | A findings document records Discord's Windows per-process audio-capture mechanism backed by concrete evidence — DLL symbol inspection and Device Manager check | VERIFIED | `02-FINDINGS.md` §1: Verdict states "public WASAPI process-loopback, dynamically loaded — NOT a virtual-device driver." Evidence table has 5 populated rows: no virtual device (PowerShell), application-loopback symbols in discord_voice.node (strings), dynamic loading (objdump -p), EXCLUDE mode (strings/symbol level), Windows build (cmd.exe ver). Raw observations in `02-RECON-OBSERVATIONS.md` Steps 1-5, 7. |
| SC-2 | The document captures include-vs-exclude, which process tree Discord excludes (accounting for Electron's separate audio process), minimum build 20348, and fallback for older builds | VERIFIED | `02-FINDINGS.md` §2.1 documents EXCLUDE vs INCLUDE and why EXCLUDE is the echo fix. §2.2 documents process-tree scope (ActivateApplicationLoopbackForProcessTree / excludedSubtrees confirmed hands-on), Electron Audio Service complication, live PIDs correctly marked not run / unknown. §2.3 gives min build 20348, the Win10 22H2 = 19045 correction (hands-on), and fallback (user-side separate-output-device / no system audio). |
| SC-3 | The document gives a clear, evidence-based clean-room recommendation on whether GoofCord can replicate from the public WASAPI API only | VERIFIED | `02-FINDINGS.md` §3.3 Verdict: "GO — conditional (clean-room replication is viable; the condition is build ≥ 20348, effectively Windows 11)." §3.1 names the full public symbol surface from MS docs, explicitly states it is not lifted from Discord. D-06 inputs identified (native module required; build gate real; exclude target = process tree; do not lift Discord's symbol layout). |
| SC-4 | Recon-only boundary honoured: no GoofCord source changed and no prototype built | VERIFIED | `git diff --name-only 88ab8c4..HEAD` shows only `.planning/` files — zero `src/` changes. Attestation present in `02-FINDINGS.md` §4. |

**Score:** 6/6 must-haves verified (4 ROADMAP SCs + 2 plan-specific must-haves below)

### Additional Plan Must-Haves (from 02-01 and 02-02 PLAN frontmatter)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| A | AUDIO-02 investigated-only conclusion recorded: getVirtmic() returns null on Windows → Patchcord track-removal block never fires → no code change needed for that path | VERIFIED | `02-FINDINGS.md` §4.1 records exact conclusion with provenance tag `[desk-research / code read: screensharePatch.ts getVirtmic() / Patchcord track-removal block]`. Confirmed against actual source: `screensharePatch.ts` lines 4-20 show `getVirtmic()` searches for `GoofCord-Virtual-Mic` audioinput device (absent on Windows); lines 62-85 show `if (id)` guard — block does not execute when id is null/undefined. |
| B | Every hands-on confirmed claim in 02-FINDINGS.md traces to a line in 02-RECON-OBSERVATIONS.md; unobserved dimensions marked inconclusive/not-run, not inferred | VERIFIED (automated); UNCERTAIN (human confirm pending) | Automated cross-check: every hands-on confirmed symbol/finding in FINDINGS (ActivateApplicationLoopbackForProcessTree ×4, excludedSubtrees ×5, no virtual device, mmdevapi absent, build 19045) has a direct counterpart in RECON-OBSERVATIONS. Step 6 (live PIDs) correctly marked "not run / unknown" in both documents. EXCLUDE mode caveat (symbol-level, not raw enum) correctly preserved in both. Human gate pending (see human_verification section). |

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `02-FINDINGS.md` | Four-section findings doc mapping 1:1 to ROADMAP SCs, finalized with mechanism verdict and go/no-go | VERIFIED | Exists. All four `## 1.` / `## 2.` / `## 3.` / `## 4.` headings present. Verdict: lines at §1 and §3.3. Zero `TO BE FILLED IN 02-02` or `depends on 02-02` remaining. Provenance and Confidence legends present. |
| `02-RECON-OBSERVATIONS.md` | Raw on-box inspection results for all runbook steps, with provenance and not-run markers | VERIFIED | Exists. 7 steps documented. `grep -c 'Result:'` = 7 (≥ 6 required). Honesty disclosure at top. Step 6 correctly `NOT RUN / unknown`. Tooling-substitution table present (WSL equivalents disclosed). |
| `02-RECON-RUNBOOK.md` | Copy-pasteable Windows inspection script with exact commands, symbol targets, fillable result slots | VERIFIED | Exists. `%LocalAppData%\Discord` path present. `dumpbin /imports` present. `ActivateAudioInterface` present. `PROCESS_LOOPBACK` present. `devmgmt.msc` present. `winver` present. `Result:` slots = 9 (≥ 6 required). Corroboration warning present. |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `02-RECON-RUNBOOK.md` | `02-FINDINGS.md` | Runbook result slots map 1:1 to evidence table rows | VERIFIED | RUNBOOK §"How your results feed the findings doc" table maps Steps 2-7 to specific FINDINGS §1 rows. Evidence table in FINDINGS has corresponding rows populated from OBSERVATIONS. |
| `02-RECON-OBSERVATIONS.md` | `02-FINDINGS.md` | Each observation becomes an evidence row in §1 | VERIFIED | All five populated evidence rows in FINDINGS §1 trace to specific steps in OBSERVATIONS (Steps 2, 3, 4, 5, 7). Step 6 (not run) appears as the "Discord / Audio-Service process tree" row with `not run / unknown`. |
| `screensharePatch.ts` | `02-FINDINGS.md §4.1` | Code read confirming getVirtmic() behavior on Windows | VERIFIED | Lines 4-20 of screensharePatch.ts confirm: getVirtmic() returns undefined (not null, but falsy) when no `GoofCord-Virtual-Mic` audioinput exists. The `if (id)` guard at line 64 means Patchcord block does not execute. FINDINGS §4.1 accurately describes this. |

---

## Recon-Only Boundary Verification

**Command run:** `git diff --name-only 88ab8c4..HEAD`

**Result:**
```
.planning/ROADMAP.md
.planning/STATE.md
.planning/phases/02-fix-bug-b-windows-loopback-audio-captured/02-01-SUMMARY.md
.planning/phases/02-fix-bug-b-windows-loopback-audio-captured/02-02-SUMMARY.md
.planning/phases/02-fix-bug-b-windows-loopback-audio-captured/02-FINDINGS.md
.planning/phases/02-fix-bug-b-windows-loopback-audio-captured/02-RECON-OBSERVATIONS.md
.planning/phases/02-fix-bug-b-windows-loopback-audio-captured/02-RECON-RUNBOOK.md
```

**Verdict: PASS** — zero `src/` files. Every change is under `.planning/`. SC-4 and UPST-01 satisfied.

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| AUDIO-01 | 02-01, 02-02 | On Windows, when the user opts to share audio, a remote viewer hears the captured system/application audio | INVESTIGATED-ONLY | ROADMAP explicitly states "investigated only — delivery deferred to a follow-on implementation phase." The recon establishes the mechanism (WASAPI Application Loopback, EXCLUDE mode) and the go/no-go (conditional GO, build ≥ 20348). Implementation deferred to D-06 phase. |
| AUDIO-02 | 02-01, 02-02 | The Linux virtual-mic / Patchcord audio-track handling does not run on Windows | INVESTIGATED-ONLY (code confirms no code change needed) | `02-FINDINGS.md` §4.1 + code read confirms getVirtmic() null path → Patchcord block never fires on Windows → no code change needed for this path. Formally deferred; evidence-backed no-action conclusion recorded. |
| UPST-01 | 02-01, 02-02 | All fixes are surgical, minimal-divergence changes with no new dependencies | VERIFIED | Zero src/ changes in this phase. No dependencies added. Recon-only deliverable. |

**Note:** AUDIO-01 and AUDIO-02 remain open (unchecked) in REQUIREMENTS.md — this is intentional and correct. Phase 2 is explicitly a recon phase; these requirements are addressed by a future implementation phase. The phase goal is to produce the findings that enable that future decision, which it has done.

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `02-RECON-RUNBOOK.md` | 130 | Desk-research error carried in runbook: "All Windows 11 and Windows 10 21H2/22H2 are [≥ 20348]" | INFO | The runbook's Step 7 contains this incorrect claim from the 02-01 skeleton (Win10 22H2 is build 19045, below 20348). The hands-on inspection in 02-02 caught and corrected this error in `02-FINDINGS.md` §2.3. The RUNBOOK itself is not updated — it retains the incorrect claim. This is an informational issue only since the RUNBOOK is a one-time-use pre-execution checklist and the correction is recorded in FINDINGS (the authoritative deliverable). Not a blocker. |

No TBD, FIXME, XXX, or unresolved debt markers found in any phase-2 planning documents. No stub implementations (recon-only phase, no code). No hardcoded empty returns.

---

## Honesty Guardrail Assessment

The honesty guardrail is the load-bearing constraint for this recon phase. Assessment:

**PASS on automated dimensions:**

1. No `hands-on confirmed` tag appears for any claim that lacks a corresponding entry in `02-RECON-OBSERVATIONS.md`. Cross-checked: all five `hands-on confirmed` rows in the FINDINGS evidence table trace to specific observation steps.

2. Step 6 (live PIDs) is correctly `not run / unknown` in both FINDINGS (evidence table row 5) and OBSERVATIONS (Step 6). No process-tree PID inference was made.

3. EXCLUDE mode caveat is correctly preserved: both documents note this is symbol-level evidence (function/key names), not a raw WASAPI enum integer. This is an honest qualification of the confidence level.

4. The desk-research error (Win10 22H2 build claim) was caught by the hands-on inspection and explicitly corrected as a `⚠ Correction` in FINDINGS §2.3 — not papered over.

5. The dynamic-loading explanation for the missing static import (Pitfall 3 corroboration) is correctly handled: `strings` hit + `objdump` absence of static import + dynamic-loader strings together lead to "dynamically loaded" conclusion rather than refuting use.

**UNCERTAIN (human gate):**

The WSL2 executor provenance is disclosed prominently in both FINDINGS and OBSERVATIONS, and the SUMMARY states developer approval was given. However, the Task 3 human-verify checkpoint in 02-02-PLAN.md is a blocking gate requiring explicit developer sign-off. The verifier cannot confirm that approval occurred from codebase evidence alone.

---

## Behavioral Spot-Checks

SKIPPED — this is a documentation-only recon phase. No runnable code was produced. There are no API endpoints, CLI tools, or build scripts to spot-check.

---

## Probe Execution

SKIPPED — no probes defined or applicable. This is a recon-docs-only phase (no `scripts/` directory changes).

---

## Human Verification Required

### 1. Developer approves WSL2 provenance of 02-RECON-OBSERVATIONS.md

**Test:** Read the honesty disclosure at the top of `02-RECON-OBSERVATIONS.md` and the matching disclosure at the top of `02-FINDINGS.md`. Confirm: (a) the description of how the inspection was run (Claude from WSL2 on your real Windows 10 machine, inspecting `C:\Users\Christ\AppData\Local\Discord\app-1.0.9238`) accurately reflects what happened; (b) you accept this WSL2/Claude execution as equivalent to running the runbook yourself; (c) any step you personally did not run and did not authorize Claude to run stays `not run / unknown`.

**Expected:** Developer types "approved" or equivalent confirmation, closing the Task 3 human-verify gate from 02-02-PLAN.md.

**Why human:** The plan's Task 3 is an explicit blocking `checkpoint:human-verify` gate. The SUMMARY claims approval occurred ("Yeah no, that's cool") but SUMMARY claims are not evidence. Only the developer can confirm that the WSL2 inspection represents genuinely accepted hands-on data, not an AI fabrication they haven't reviewed. The honesty guardrail is the load-bearing constraint for this entire phase's value — if the observations are fabricated or unreviewed, all four Success Criteria collapse.

### 2. Spot-check hands-on confirmed evidence rows against observations

**Test:** Open `02-FINDINGS.md` §1 evidence table and `02-RECON-OBSERVATIONS.md` side by side. For 2-3 of the `hands-on confirmed` rows (suggested: the application-loopback symbols row and the dynamic-loading row), confirm the symbol strings listed in FINDINGS match the verbatim output recorded in OBSERVATIONS Step 3 and Step 4 respectively.

**Expected:** The verbatim strings in OBSERVATIONS (e.g., `ActivateApplicationLoopbackForProcessTree`, `excludedSubtrees`, `mmdevapi.dll` absent from import table) match what is claimed in FINDINGS with `hands-on confirmed` confidence.

**Why human:** The verifier ran grep cross-checks (counts ≥ 1) confirming the strings exist in both documents, but cannot perform a semantic quality check that the FINDINGS is faithfully representing the OBSERVATIONS rather than adding its own interpretation. The developer's eye on the actual content is the final quality gate.

---

## Gaps Summary

No technical gaps found. All four ROADMAP Success Criteria are satisfied by the delivered documents. The recon-only boundary is confirmed (zero src/ changes). The AUDIO-02 investigated-only conclusion is correctly recorded. The honesty guardrail automated checks pass.

The single blocking item is the human verification of WSL2 provenance — a planned gate in the phase design (02-02-PLAN.md Task 3), not an unexpected gap. Once the developer closes that gate, the phase is complete.

---

_Verified: 2026-05-30_
_Verifier: Claude (gsd-verifier)_
