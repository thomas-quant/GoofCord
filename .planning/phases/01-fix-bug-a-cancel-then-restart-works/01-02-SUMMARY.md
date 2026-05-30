---
phase: 01-fix-bug-a-cancel-then-restart-works
plan: 02
subsystem: infra
tags: [electron, screenshare, getdisplaymedia, setdisplaymediarequesthandler, finishrequest, notallowederror, windows]

# Dependency graph
requires:
  - phase: 01-fix-bug-a-cancel-then-restart-works
    provides: "01-01 diagnostic instrumentation (log points A/B/C) that rode the same combined Windows CI build (D-01) and routed H1/H2/H3"
provides:
  - "Exactly-once finishRequest(wcId, result) consolidating the select/cancel/closed teardown in screenshare.ts (map-delete is the idempotency token)"
  - "Deliberate, documented NotAllowedError re-throw in screensharePatch.ts so cancellation stays swallowed by Discord and the go-live control re-arms"
  - "A surgical, PR-ready, instrumentation-free diff (D-04 / UPST-01): finishRequest + the NotAllowedError re-throw only, no debug scaffolding, no new deps"
affects: [phase-02-bug-b-windows-audio, upstream-pr]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single-owner exactly-once teardown via finishRequest(wcId, result): get → !req guard → delete → try/catch callback → isDestroyed close (Pitfall 3)"
    - "Map-delete-before-callback as the idempotency token so a re-entrant `closed` during the callback cannot double-fire"

key-files:
  created: []
  modified:
    - src/windows/screenshare/screenshare.ts
    - src/windows/main/renderer/postVencord/screensharePatch.ts

key-decisions:
  - "KEPT NotAllowedError — Task 4 (AbortError switch / Flux abort) NOT needed; the developer confirmed on the combined Windows build that cancellation is error-free and the cancel→restart works, so finishRequest + the existing NotAllowedError cleared Bug A (research's strongest prior held)"
  - "Stripped 01-01 instrumentation MANUALLY, not via `git revert 2f4b94d`, because 88baaf2 relocated the [ScreenshareDebug][C] lines into/around finishRequest so a revert would not apply cleanly"
  - "Kept the diff source-only — reverted regenerated assets/postVencord.js + assets/preVencord.js out of the strip commit (matches 01-01 / 710cfde upstream convention)"

patterns-established:
  - "finishRequest single-owner teardown: the first finisher (select/cancel vs. the window `closed` event) wins on the map-delete; every later caller hits `!req` and is a no-op"
  - "PR-ready fix diff = behavior change + genuine fix-documentation comments only; all diagnostic scaffolding lives in a separate, strippable instrumentation commit (D-01/D-04)"

requirements-completed: [STREAM-01, STREAM-02, STREAM-03, STREAM-04, UPST-01]

# Metrics
duration: 25min
completed: 2026-05-30
---

# Phase 01 Plan 02: Bug A Fix (finishRequest + NotAllowedError) Summary

**Consolidated screenshare teardown into an exactly-once `finishRequest(wcId, result)` (map-delete as the idempotency token) and kept the deliberate `NotAllowedError` re-throw — verified on a combined Windows CI build to clear the cancel-then-restart bug, then stripped all 01-01 diagnostic instrumentation so the remaining diff is the surgical, PR-ready fix only.**

## Performance

- **Duration:** ~25 min wall-clock (most of it the human-verify checkpoint: one combined Windows CI build + manual on-box testing)
- **Started:** 2026-05-30T03:08:51Z (Task 1 commit)
- **Completed:** 2026-05-30T03:33:20Z (Task 5 strip commit)
- **Tasks:** 4 executed (Task 1, Task 2, Task 3 human-verify, Task 5) + 1 skipped (Task 4)
- **Files modified:** 2

## Accomplishments

- **Exactly-once teardown (Task 1, `88baaf2`):** Added `function finishRequest(wcId, result)` to `screenshare.ts` implementing the Pitfall 3 sketch and rewired all three teardown sites (cancel, grant, `closed`) to call it. The Electron `callback` is now exactly-once by construction — no double-fire, no zero-callback hang, no "Object has been destroyed" path.
- **Deliberate rejection name (Task 2, `2cf5e5a`):** Kept the synthetic `NotAllowedError` re-throw inside the `catch` of the patched `getDisplayMedia`, marked as the deliberate single-point cancellation lever for the combined build.
- **Combined Windows CI verification (Task 3):** The developer ran the single combined build (D-01) on their own Windows box and confirmed the fix works — cancellation is error-free (STREAM-03) and the cancel→restart "roughly looked okay" (restart worked).
- **Task 4 NOT needed:** The gate condition (H1 persists / second click produces NO picker) did not occur, so the `NotAllowedError`→`AbortError` switch and the conditional Flux go-live abort were both SKIPPED.
- **Instrumentation stripped (Task 5, `88d6682`):** Removed every `[ScreenshareDebug]` log point, the `appendDebugLog` helper, both debug counters, and the now-unused `fs` / `userDataPath` imports across both files. The remaining diff is `finishRequest` + the `NotAllowedError` re-throw only (D-04 / UPST-01).

## Final Fix Shape

### `finishRequest(wcId, result)` — exact ordering (screenshare.ts)

```text
const req = activeRequests.get(wcId);   // 1. get
if (!req) return;                       // 2. !req exactly-once guard
activeRequests.delete(wcId);            // 3. delete BEFORE callback (idempotency token)
try { req.callback(result); } catch {}  // 4. try/catch — swallow a throw so teardown completes
if (!req.window.isDestroyed()) req.window.close();  // 5. isDestroyed guard before close
```

**Three call sites, all routed through `finishRequest`:**
1. **Cancel branch** (`selectScreenshareSource`, the `if (!id)` block) → `finishRequest(wcId, {})`.
2. **Grant branch** (`selectScreenshareSource`, after `result` is fully assembled including the `result.audio = "loopback"` / patchcord branch) → `finishRequest(wcId, result)`.
3. **`closed` handler** (`capturerWindow.once("closed", …)`) → `finishRequest(wcId, {})` — idempotent: if select/cancel already ran, the entry is gone and this is a no-op via the `!req` guard.

No bare `callback({})` / `callback(result)` remains outside `finishRequest`. The handler is still registered exactly once; no `setDisplayMediaRequestHandler(null)`, no `useSystemPicker`, no new imports/dependencies.

### Rejection-name decision (screensharePatch.ts)

- **KEPT `throw new DOMException("Permission denied by system", "NotAllowedError")`** inside the `catch` of the patched `getDisplayMedia`.
- **Task 4 NOT needed.** Evidence: the developer confirmed on the combined Windows build (run 26673048740) that cancellation is error-free and the cancel→restart works. `finishRequest` + the existing `NotAllowedError` cleared Bug A — matching research's strongest prior (H1 cleared without the `AbortError` switch). No Flux go-live abort dispatch was added.
- The comment was simplified to an upstream-friendly rationale (NotAllowedError is the standard cancellation the web client ignores, so the go-live control re-arms); the internal-process references ("combined diagnostic build", "H1", "switch to AbortError if the trace proves…") were dropped.

## Instrumentation Stripped (D-04)

Removed from `src/windows/screenshare/screenshare.ts`:
- The `// ─── [ScreenshareDebug] DIAGNOSTIC INSTRUMENTATION ───` block (`debugRequestCount` + the `appendDebugLog` helper).
- Every `appendDebugLog(...)` call (inside `finishRequest`, the `selectScreenshareSource` early-return / cancel / grant paths, the `setDisplayMediaRequestHandler` entry + `wcId` line, and the `closed` handler).
- The `debugReqNum` counter usage in the handler.
- The now-unused `import fs from "node:fs";` and `userDataPath` from the `../../utils.ts` import. **Kept** `dirname`, `isWayland`, `relToAbs`, and `import path from "node:path";` (still used by `path.join(dirname(), …)`).

Removed from `src/windows/main/renderer/postVencord/screensharePatch.ts`:
- The module-scoped `getDisplayMediaCallCount` counter and the `[ScreenshareDebug][A]` `console.log` at the patched `getDisplayMedia` entry.

**Kept (fix documentation, not instrumentation):** the `finishRequest` doc comment (single-owner / idempotency-token / delete-before-callback), the `closed`-handler idempotent-no-op comment, and the pre-fix `catch` comment explaining why the re-throw exists.

**Result:** `grep -rn "ScreenshareDebug\|appendDebugLog\|screenshare-debug.log\|debugRequestCount\|getDisplayMediaCallCount"` over both files returns nothing; `function finishRequest` still matches; the `NotAllowedError` re-throw remains inside the `catch`. The PR-ready diff is the `finishRequest` consolidation + the `NotAllowedError` re-throw only — no debug scaffolding, no new dependencies (UPST-01).

## Verification Record (provenance — be precise)

- **STREAM-03 (cancel error-free):** CONFIRMED by the developer on the Windows CI build (run 26673048740, branch `fix/windows-screenshare-cancel-restart`). Cancelling the source-picker selection no longer produces the JavaScript error in Discord.
- **STREAM-01 / STREAM-02 (re-click re-opens picker / restart streams normally):** Developer reports it "roughly looked okay" — the restart worked. The detailed DevTools / `screenshare-debug.log` A-vs-B re-fire trace was **NOT** captured (the developer's 60% keyboard has no F12). So the picker-re-open and restart are confirmed at the behavioral level (the fix is successful) but not via the instrumented A/B counter trace.
- **STREAM-04 (10+ repeated cancel→retry cycles, no leak / no destroyed-object):** NOT exhaustively runtime-tested. Satisfied by code construction — `finishRequest` is idempotent (the `!req` guard + delete-before-callback) and guarded by `isDestroyed()` before `window.close()`, so repeated cycles cannot double-fire the callback or touch a destroyed window — per orchestrator review.
- **Linux / Wayland:** NOT runtime-tested. Code-reviewed as behavior-preserving: the Wayland portal logic in `fetchScreenshareData` is untouched, the patchcord `await` still precedes teardown, and the only delta is the delete-timing inside `finishRequest`, which stays exactly-once.
- **Artifact used:** `ci-artifacts/win-26673048740/GoofCord-2.2.1-win-x64.zip` (local, untracked — under the gitignored `ci-artifacts/` folder).

## Task Commits

1. **Task 1: Consolidate teardown into exactly-once finishRequest** — `88baaf2` (`fix`)
2. **Task 2: Keep NotAllowedError as the deliberate cancellation lever** — `2cf5e5a` (`fix`)
3. **Task 3: Trigger combined Windows CI build + manual cancel→restart acceptance test** — human-verify checkpoint; no source commit (verification vehicle). Outcome: fix successful, NotAllowedError kept.
4. **Task 4: CONDITIONAL AbortError switch / Flux abort** — SKIPPED (gate condition did not occur — the restart worked with NotAllowedError).
5. **Task 5: Strip 01-01 diagnostic instrumentation (D-04)** — `88d6682` (`refactor`)

**Plan metadata:** committed with this SUMMARY + STATE.md + ROADMAP.md in the final docs commit.

## Files Created/Modified

- `src/windows/screenshare/screenshare.ts` — Added `finishRequest(wcId, result)` (exactly-once teardown) and routed cancel/grant/closed through it; stripped all instrumentation (helper, counter, log lines, unused `fs`/`userDataPath` imports).
- `src/windows/main/renderer/postVencord/screensharePatch.ts` — Kept the `NotAllowedError` re-throw inside the `catch`; simplified its comment to an upstream-friendly rationale; stripped the log point A counter + `console.log`.

## Decisions Made

- **KEPT NotAllowedError; Task 4 not needed.** The combined-build evidence showed cancellation is error-free and the restart works, so the `finishRequest` consolidation + the existing `NotAllowedError` cleared Bug A — research's strongest prior held, and the `AbortError` switch / Flux go-live abort were unnecessary.
- **Manual strip instead of `git revert 2f4b94d`.** Commit `88baaf2` relocated the `[ScreenshareDebug][C]` lines into/around `finishRequest`, so reverting the instrumentation commit would not apply cleanly. Stripped manually across both files instead.
- **Source-only diff.** Reverted the build-regenerated `assets/postVencord.js` and `assets/preVencord.js` out of the strip commit so the diff stays source-only and surgical (matches the 01-01 / 710cfde upstream convention).

## Deviations from Plan

None requiring deviation rules — the plan's own gate logic drove the flow. Per the plan's Task 4 GATE, Task 4 was correctly SKIPPED because Task 3 reported "approved" (the picker re-opened / restart worked with `NotAllowedError`), and per Task 5's note the instrumentation was stripped manually rather than by `git revert` because the fix commit relocated the diagnostic C lines.

## Issues Encountered

- **Build regenerated tracked bundles.** `bun run build` re-emitted `assets/postVencord.js` / `assets/preVencord.js`. Resolved by reverting both out of the working tree before staging so the strip commit is source-only (no asset bundle / fmt churn), matching 01-01.
- **Verification trace not fully captured.** The developer's 60% keyboard has no F12, so the DevTools / `screenshare-debug.log` A-vs-B re-fire trace for STREAM-01/02 was not captured. The fix was confirmed behaviorally (restart works, cancel error-free) rather than via the instrumented counter trace — recorded honestly in the Verification Record above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- **Bug A is fixed and PR-ready (UPST-01).** The diff across the two fix-surface files is `finishRequest` consolidation + the `NotAllowedError` re-throw only, with all 01-01 instrumentation stripped, no handler re-registration, no `useSystemPicker`, and no new dependencies — surgical and upstreamable to the main GoofCord repo.
- **Open item for the eventual upstream PR / before merge:** the combined-build verification confirmed the fix behaviorally but did not capture the detailed A/B re-fire trace, and Linux/Wayland + the 10+ repeated cancel→retry stability cycles (STREAM-04) were satisfied by code review rather than exhaustive runtime testing. A follow-up runtime pass (Wayland + repeated cycles, with the log trace if a keyboard with F12 is available) would harden the evidence, though it is not required to close the phase given the idempotent construction.
- **Ready for Phase 2 (Bug B — Windows loopback audio):** a working cancelled-then-restarted screenshare now exists to validate audio against.

## Self-Check: PASSED

- `src/windows/screenshare/screenshare.ts` — FOUND (`function finishRequest` present; 0 instrumentation refs)
- `src/windows/main/renderer/postVencord/screensharePatch.ts` — FOUND (`NotAllowedError` re-throw present; 0 instrumentation refs)
- Commit `88baaf2` (Task 1 fix) — FOUND
- Commit `2cf5e5a` (Task 2 keep NotAllowedError) — FOUND
- Commit `88d6682` (Task 5 strip) — FOUND
- `bun run check` exit 0; `bun run build` succeeded — CONFIRMED

---
*Phase: 01-fix-bug-a-cancel-then-restart-works*
*Completed: 2026-05-30*
