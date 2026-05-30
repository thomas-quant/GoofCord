---
phase: 01-fix-bug-a-cancel-then-restart-works
verified: 2026-05-30T03:38:42Z
status: human_needed
score: 4/5 must-haves verified
overrides_applied: 0
human_verification:
  - test: "On a Windows x64 CI build, cancel the source picker then click Go Live again — confirm the picker window re-opens (STREAM-01) and the stream starts and plays normally with no app restart (STREAM-02)"
    expected: "Picker window appears on the second click; stream plays audio and video without requiring a restart"
    why_human: "Windows-only runtime behaviour; no automated screenshare repro exists. Developer attested 'roughly looked okay' on run 26673048740 but the detailed A/B counter trace was not captured (no F12 on 60% keyboard), so the evidence level is behavioral observation, not trace-confirmed."
  - test: "Perform 10+ repeated cancel then retry cycles on the Windows build — confirm no progressive wedging, no 'Object has been destroyed' main-process errors, no orphaned picker windows (STREAM-04)"
    expected: "Start-stream control works every cycle; screenshare-debug.log shows no destroyed-object errors; activeRequests map stays clean"
    why_human: "Exhaustive cycle-count testing was not performed at runtime. STREAM-04 was argued satisfied by code construction (idempotent finishRequest, isDestroyed guard) per the developer/orchestrator review, but was not runtime-confirmed with a 10+ cycle trace."
  - test: "Verify no regression on Linux/Wayland — start a screenshare, cancel, and restart on a Patchcord/Wayland setup"
    expected: "Wayland portal logic unaffected; patchcord await still precedes teardown; stream behaves identically to before the fix"
    why_human: "Linux/Wayland was not runtime-tested. Assessed as behavior-preserving by code review (fetchScreenshareData / patchcordStart* paths untouched; delete-timing change is inside finishRequest which stays exactly-once), but no runtime pass was performed."
---

# Phase 01: Fix Bug A — Cancel then Restart Works — Verification Report

**Phase Goal:** On Windows, a user can cancel the screenshare source picker and start a stream again immediately — the picker re-opens and the stream works, with no app restart, and no progressive wedging across repeated cancel/retry cycles.
**Verified:** 2026-05-30T03:38:42Z
**Status:** human_needed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Teardown consolidated into exactly-once `finishRequest(wcId, result)` with map-delete as idempotency token, delete before callback, try/catch around callback, isDestroyed guard before close | VERIFIED | `screenshare.ts` lines 24-34 confirm exact ordering; `finishRequest` body extracted and verified in full |
| 2 | All three teardown sites (cancel branch, grant branch, `closed` handler) route through `finishRequest`; no bare `callback({})` or `callback(result)` escapes it | VERIFIED | `finishRequest` called at lines 80, 102, 138; `awk` scan of non-finishRequest context found zero bare `req.callback(` calls outside the function body |
| 3 | `NotAllowedError` re-throw is inside the `catch` of the patched `getDisplayMedia` (STREAM-03 / 710cfde preserved) | VERIFIED | `screensharePatch.ts` lines 24-31 confirmed; `throw new DOMException("Permission denied by system", "NotAllowedError")` is inside the `} catch {` block |
| 4 | All diagnostic instrumentation stripped — no `[ScreenshareDebug]`, `appendDebugLog`, `screenshare-debug.log`, `debugRequestCount`, or `getDisplayMediaCallCount` in either fix-surface file (D-04 / UPST-01) | VERIFIED | `grep -rn "ScreenshareDebug\|appendDebugLog\|screenshare-debug\.log\|debugRequestCount\|getDisplayMediaCallCount"` across both files returned nothing (exit 1 = no matches) |
| 5 | On Windows runtime: cancel→restart works (picker re-opens, stream plays normally, no app restart) with no uncaught JS error in Discord; 10+ repeated cycles stable with no "Object has been destroyed" | UNCERTAIN | Developer confirmed STREAM-03 (cancel error-free) and STREAM-01/02 behaviorally ("roughly looked okay — restart worked") on CI run 26673048740. Detailed A/B counter trace NOT captured (no F12). STREAM-04 (10+ cycles) argued by code construction, not exhaustively runtime-tested. |

**Score:** 4/5 truths verified (Truth 5 is UNCERTAIN — needs human attestation at trace level)

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/windows/screenshare/screenshare.ts` | `function finishRequest` with exactly-once teardown consolidating cancel/grant/closed | VERIFIED | Present at line 24 with correct ordering: get → `!req` guard → delete → try/catch callback → isDestroyed close |
| `src/windows/main/renderer/postVencord/screensharePatch.ts` | `DOMException` with `NotAllowedError` inside `catch` of patched `getDisplayMedia` | VERIFIED | Present at line 31 inside the `} catch {` block; comment documents it as the deliberate cancellation lever |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `selectScreenshareSource` cancel branch | `finishRequest` | `finishRequest(wcId, {})` at line 80 | WIRED | Confirmed by `grep -n "finishRequest"` |
| `selectScreenshareSource` grant branch | `finishRequest` | `finishRequest(wcId, result)` at line 102 | WIRED | After `result` fully assembled including `result.audio = "loopback"` / patchcord branch |
| `capturerWindow.once("closed", ...)` handler | `finishRequest` | `finishRequest(wcId, {})` at line 138 | WIRED | Idempotent: if select/cancel already ran, `!req` guard makes it a no-op |
| `getDisplayMedia` `catch` block | `NotAllowedError` re-throw | `throw new DOMException("Permission denied by system", "NotAllowedError")` | WIRED | Inside `} catch {` at lines 26-32 of the patched function |

---

### Data-Flow Trace (Level 4)

Not applicable. Both fix-surface files are control-flow / error-handling fixes, not data-rendering components. No state flows to a UI render target.

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| `bun run check` exits 0 | `bun run check` | `tsgo` exit 0 | PASS |
| `bun run build` succeeds | `bun run build` | Build completed successfully | PASS |
| No instrumentation in either fix-surface file | `grep -rn "ScreenshareDebug\|appendDebugLog\|..."` | exit 1 (no matches) | PASS |
| `finishRequest` present in `screenshare.ts` | `grep -n "function finishRequest" screenshare.ts` | Line 24 | PASS |
| `NotAllowedError` in `catch` block | Direct read of `screensharePatch.ts` lines 24-31 | Confirmed inside `} catch {` | PASS |
| No forbidden patterns (`setDisplayMediaRequestHandler(null)`, `useSystemPicker`) | `grep -n "setDisplayMediaRequestHandler(null)\|useSystemPicker"` | exit 1 (no matches) | PASS |
| Diff vs origin/main touches only the two fix-surface files | `git diff origin/main..HEAD -- src/ \| grep "^+++ b/"` | Only `screenshare.ts` and `screensharePatch.ts` | PASS |

---

### Probe Execution

Step 7c: SKIPPED — no conventional `scripts/*/tests/probe-*.sh` exist in this project, and neither PLAN declared probes. Verification is manual-only per CLAUDE.md and CONTEXT.md (D-03).

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| STREAM-01 | 01-02-PLAN.md | After cancelling, second click re-opens source picker | UNCERTAIN | Behaviorally confirmed by developer on CI run 26673048740 ("roughly looked okay"); A/B counter trace not captured |
| STREAM-02 | 01-02-PLAN.md | Cancelled-then-restarted screenshare streams normally, no app restart | UNCERTAIN | Same attestation as STREAM-01 — behavioral observation level, not trace-confirmed |
| STREAM-03 | 01-02-PLAN.md | Cancel shows no uncaught/visible JS error in Discord | VERIFIED (developer-confirmed) | Developer confirmed on CI run 26673048740: "cancelling the source-picker selection no longer produces the JavaScript error in Discord" |
| STREAM-04 | 01-01-PLAN.md, 01-02-PLAN.md | 10+ cancel→retry cycles stable, no wedging, no destroyed-object errors | UNCERTAIN | Code-construction argument: `finishRequest` is idempotent via `!req` guard + `isDestroyed()` guard. NOT exhaustively runtime-tested with 10+ cycles. |
| UPST-01 | 01-01-PLAN.md, 01-02-PLAN.md | Surgical diff, no new deps, no handler re-registration, PR-ready | VERIFIED | `git diff origin/main..HEAD -- src/` touches exactly two files; no `setDisplayMediaRequestHandler(null)`, no `useSystemPicker`, no new imports beyond what was already present; `bun run check` + `bun run build` both pass |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `screenshare.ts` | 11 | `callback: (res: any) => void` — `any` type in `ActiveRequest` interface | Info | Tech-debt noted in PITFALLS.md; pre-existing in upstream; not introduced by this fix; out of surgical scope per CONTEXT.md |

No `TBD`, `FIXME`, or `XXX` markers found in either fix-surface file.

---

### Human Verification Required

#### 1. STREAM-01 / STREAM-02: Cancel→restart picker and stream (trace-level confirmation)

**Test:** On a Windows x64 CI build (branch `fix/windows-screenshare-cancel-restart`), open Discord with DevTools (F12). Start a screenshare — the source picker window appears. Cancel it. Click "Go Live" / start-stream a second time.
**Expected:** The source picker window re-opens on the second click. Selecting a source starts the stream normally with audio/video, requiring no app restart.
**Why human:** Windows-only runtime behaviour; no automated screenshare repro. Developer behaviorally confirmed this on CI run 26673048740 but did not capture the A/B counter trace from DevTools (60% keyboard, no F12 key available). A trace-level confirmation (seeing log point A fire twice with counter `#1` then `#2`, and log point B fire twice) would upgrade this from behavioral observation to fully confirmed.

#### 2. STREAM-04: 10+ repeated cancel→retry cycles stable

**Test:** On the same Windows build, perform at least 10 cancel→retry cycles in sequence. After each cancel, click "Go Live" again and verify the picker re-opens.
**Expected:** The start-stream control keeps working every cycle. No "Object has been destroyed" errors in the main process. No orphaned picker windows accumulating. The `activeRequests` map does not leak entries.
**Why human:** Exhaustive cycle-count testing was not performed at runtime. STREAM-04 was satisfied by code-construction argument (idempotent `finishRequest` via `!req` guard and `isDestroyed()` before `window.close()`), but a runtime pass with 10+ cycles would confirm the argument.

#### 3. Linux/Wayland non-regression

**Test:** On a Linux box with PipeWire/Wayland, start a screenshare, cancel the picker, and start again.
**Expected:** Wayland portal-based source selection is unaffected. Patchcord audio path behaves identically to before the fix. No regression in cancel→restart behavior on Linux.
**Why human:** Linux/Wayland was not runtime-tested. Code review confirms the `fetchScreenshareData` / `isWayland` portal logic is untouched and the patchcord `await` still precedes the `finishRequest` call in the grant branch, but a runtime pass would validate there is no regression.

---

### Gaps Summary

No code-level gaps were found. All statically verifiable must-haves are VERIFIED:

- `finishRequest` exists with the precise ordering the Pitfall 3 sketch specified.
- All three teardown sites call `finishRequest` exclusively; no bare callback calls escape it.
- `NotAllowedError` re-throw is confirmed inside the `catch` block.
- All instrumentation is stripped; the diff vs `origin/main` touches exactly the two fix-surface files with no new dependencies, no handler re-registration, no `useSystemPicker`.
- `bun run check` and `bun run build` both pass.

The three human verification items above are not code failures — they reflect the manual-only nature of Windows screenshare runtime verification (per CLAUDE.md and CONTEXT.md D-03). The developer provided behavioral confirmation of STREAM-03 (trace-level) and STREAM-01/02 (observation-level). STREAM-04 and Linux/Wayland await a runtime pass to move from code-argued to runtime-confirmed.

---

_Verified: 2026-05-30T03:38:42Z_
_Verifier: Claude (gsd-verifier)_
