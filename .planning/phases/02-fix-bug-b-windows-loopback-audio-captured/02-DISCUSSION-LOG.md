# Phase 2: Fix Bug B — Windows Loopback Audio Captured - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-30
**Phase:** 2-fix-bug-b-windows-loopback-audio-captured
**Areas discussed:** Area selection, Upstream-issue recon (WASAPI/Electron loopback), Target symptom, Echo-fix path, Investigation approach, Upstream intent, Verification

---

## Area Selection

| Option | Description | Selected |
|--------|-------------|----------|
| Renderer diagnostic path | Route renderer-side probe to userData log (no DevTools) | ✓ |
| Viewer-side verification | 2nd account/device to confirm audio | ✓ |
| Build strategy | Combined build vs. diagnostic-first | ✓ |
| Fix breadth | Minimal `!win32` gate vs. broader | ✓ |

**User's choice:** All four areas — **plus** a freeform addition: *"also want to examine open issues on upstream relating to streaming. primarily focusing on waspi [WASAPI] electron loopback however."*
**Notes:** The WASAPI/upstream-issue research was pulled in first because it could change the answers to the other areas — and it did (it reframed the whole phase). The four original areas were largely overtaken by the re-scope.

---

## Upstream-Issue Recon (research input)

**Findings surfaced (GoofCord + Vesktop + Electron + WASAPI):**
- GoofCord [#46] — echo / "viewers hear their own voice" on Windows; maintainer says no Electron API for per-window capture, "way out of scope."
- GoofCord [#185] — "share with system audio immediately closes" on Windows (the surgically-fixable symptom).
- Vesktop [#789/#657/#1059/#569/#772] — same echo problem, unsolved upstream.
- WASAPI Application Loopback (`EXCLUDE_TARGET_PROCESS_TREE`, Win10 20348+) is the only mechanism that excludes Discord's own audio — needs a native addon.
- WASAPI delivers no samples without active playback ([PortAudio #935], [Audacity #2356]) — verification gotcha.

**Notes:** This recon is what reframed Bug B from "audio missing" to "echo," and established that the fix is native-only.

---

## Target Symptom

| Option | Description | Selected |
|--------|-------------|----------|
| Audio broken / no track (#185) | Stream closes on audio-enable / no track — code-fixable, matches AUDIO-01/02 | |
| Echo / viewers hear selves (#46) | Whole-mix capture incl. Discord call; upstream calls it unfixable without native driver | ✓ |
| Disambiguate via diagnosis | Let an instrumented Windows build decide | |

**User's choice:** **Echo / viewers hear selves (#46).**
**Notes:** This collides with the milestone's locked Out-of-Scope ("per-app Windows capture") and "bug-fix not feature fork" identity — surfaced explicitly before proceeding.

---

## Echo-Fix Path

| Option | Description | Selected |
|--------|-------------|----------|
| Build native WASAPI module | Real fix; milestone pivot, new native dep, Win 20348+ only | (leaning) |
| Document workaround only | Separate-output-device workaround in FAQ; no code | |
| Refocus to #185 | Make Phase 2 the surgically-fixable symptom instead | |
| Diagnose on Windows first | Confirm which symptom the build shows | |

**User's choice (free text):** *"either build a native wasapi module, or what im thinking might be the better option, is see how discord does it — read their dll."*
**Notes:** User wants to understand Discord's mechanism (inspect their audio DLL/driver) before committing to a native build. Led to a clean-room guardrail (use public MS WASAPI API only; don't copy Discord code).

---

## Investigation Approach

| Option | Description | Selected |
|--------|-------------|----------|
| Spike first, then decide | Recon + throwaway WASAPI prototype, then commit | |
| Commit to building the module | Skip spike, build the native addon | |
| Recon Discord only, no prototype yet | Just document Discord's mechanism; defer impl decision | ✓ |

**User's choice:** **Recon Discord only, no prototype yet.**
**Notes:** Phase 2 deliverable is now a findings document — no GoofCord code, no prototype.

---

## Upstream Intent

| Option | Description | Selected |
|--------|-------------|----------|
| Still upstream-PR-able | Public WASAPI API only, clean-room | |
| Fork-only is fine | Becomes a fork-differentiating feature | |
| Decide after the spike | Defer until recon shows invasiveness | ✓ |

**User's choice:** **Decide after the spike (recon).**

---

## Verification

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — 2nd account + device | Can confirm echo-gone from the viewer side | ✓ |
| Only a helper available | Async/scheduled viewer verification | |
| No viewer access yet | Blocker | |

**User's choice:** **Yes — 2nd account + device.**
**Notes:** Applies to the future implementation phase, not the recon. Reminders captured: verify only from the viewer (local echo muted by design); keep audio playing (WASAPI needs active playback).

---

## Claude's Discretion

- Format/structure of the recon findings document.
- Which DLL-inspection tools to recommend (string/symbol scan, Device Manager check, etc.) beyond the documented recon checklist floor.

## Deferred Ideas

- Build the native Windows WASAPI exclude-process-tree module (post-recon; likely a milestone re-scope).
- User-side separate-output-device workaround + documentation (zero-code alternative).
- Upstream-PR vs. fork-only decision (post-recon).
- [#185] "share-with-audio immediately closes" surgical fix (separable future phase).
- Original AUDIO-01/AUDIO-02 "loopback track / `!win32` gate" framing (superseded for the echo target).
- Reconcile ROADMAP / REQUIREMENTS / PROJECT to the recon-then-feature direction (planning task, via `/gsd-phase` + milestone review).
