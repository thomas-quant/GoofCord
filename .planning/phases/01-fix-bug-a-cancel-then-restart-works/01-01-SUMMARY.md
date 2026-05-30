---
phase: 01-fix-bug-a-cancel-then-restart-works
plan: 01
subsystem: infra
tags: [electron, screenshare, getdisplaymedia, setdisplaymediarequesthandler, diagnostics, instrumentation, windows]

# Dependency graph
requires:
  - phase: 01-fix-bug-a-cancel-then-restart-works
    provides: "Phase context (D-01..D-04), PITFALLS H1/H2/H3 hypotheses, the two fix-surface files"
provides:
  - "Three tagged log points (A renderer/DevTools, B+C main/userData file) that route H1 vs H2 vs H3 from a single Windows CI artifact"
  - "A monotonic request-counter scheme so the FIRST click and the SECOND (post-cancel) click are unambiguous in one trace"
  - "A self-contained, revertable diagnostic commit ready to ride 01-02's combined CI build (D-01) and be stripped before the upstream PR (D-04)"
affects: [01-02-fix, phase-02-bug-b-windows-audio, upstream-pr]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "userData file-append diagnostic logging (appendDebugLog) for packaged GUI builds with no attached console (D-02)"
    - "Greppable [ScreenshareDebug][A|B|C] tag + monotonic per-call/per-request counter for one-trace, one-revert instrumentation"

key-files:
  created: []
  modified:
    - src/windows/main/renderer/postVencord/screensharePatch.ts
    - src/windows/screenshare/screenshare.ts

key-decisions:
  - "Log point A logs to DevTools only (plain console.log) — renderer cannot/should not write a userData file (D-02)"
  - "Log points B and C append to userData/screenshare-debug.log via appendDebugLog wrapped in try/catch so a write failure never throws into the handler (D-02)"
  - "Reverted build-regenerated bundles (assets/postVencord.js, preVencord.js) out of the commit so it stays source-only and one-revert clean (matches upstream convention from 710cfde; D-04)"
  - "Counter scheme: getDisplayMediaCallCount (renderer, log A) and debugRequestCount (main, logs B/C) are independent module-scoped monotonic counters"

patterns-established:
  - "Diagnostic instrumentation lives in its own distinctly-labeled commit (message contains 'revert before PR') so D-04 is a one-command revert"
  - "Every probe line carries the [ScreenshareDebug] tag and the wcId/event.sender.id so callbacks-per-request can be counted"

requirements-completed: [STREAM-01, STREAM-04, UPST-01]

# Metrics
duration: 4min
completed: 2026-05-30
---

# Phase 01 Plan 01: Bug A Diagnostic Instrumentation Summary

**Three tagged, counter-stamped log points (A at the patched `getDisplayMedia` entry → DevTools; B+C at the main `setDisplayMediaRequestHandler` and every callback/early-return/closed path → userData `screenshare-debug.log`) that let one Windows CI artifact route H1 vs H2 vs H3 for the cancel-then-restart bug, shipped as a single revertable commit.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-05-30T02:58:51Z
- **Completed:** 2026-05-30T03:03:11Z
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments

- **Log point A** (`screensharePatch.ts`): a module-scoped `getDisplayMediaCallCount` and a `console.log` as the first statement inside the patched `getDisplayMedia` — proves whether Discord re-issues `getDisplayMedia` on the second (post-cancel) click at all (**H1**: latched go-live state vs. re-entry).
- **Log point B** (`screenshare.ts`): a module-scoped `debugRequestCount` and a probe at the first line of the `setDisplayMediaRequestHandler` callback (plus a follow-up `wcId=` line once the webContents id exists) — proves whether the main handler fires on the second click (**H2**: Electron dispatch wedge).
- **Log point C** (`screenshare.ts`): probes at **every** callback site (cancel `callback({})`, grant `callback(result)`), the `!req` zero-callback early-return, and the `closed` handler (recording whether `activeRequests.has(wcId)` would fire the callback) — lets callbacks-per-request be counted: one = correct, two = double-fire, zero = hang (**H3**).
- **`appendDebugLog` helper**: appends ISO-timestamped lines to `userData/screenshare-debug.log` via `fs.appendFileSync`, wrapped in try/catch so a write failure never throws into the handler (D-02 — a packaged NSIS GUI build has no attached console).
- Instrumentation landed as **one distinctly-labeled, revertable, source-only commit**, ready to ride 01-02's combined CI build (D-01) and to be stripped before the upstream PR (D-04).

## Instrumentation Details (for 01-02 and the upstream PR strip)

- **Tag format (literal, greppable):** `[ScreenshareDebug][A]`, `[ScreenshareDebug][B]`, `[ScreenshareDebug][C]`. Grep the whole diagnostic with `grep -rn "\[ScreenshareDebug\]"`.
- **Counter scheme (two independent monotonic counters):**
  - Renderer: `let getDisplayMediaCallCount = 0;` → `#${++getDisplayMediaCallCount}` on log A. The first click is `#1`, the second (post-cancel) click is `#2` — so if A `#2` never prints, Discord never re-issued `getDisplayMedia` (**H1 confirmed**).
  - Main: `let debugRequestCount = 0;` → `#${++debugRequestCount}` on log B. If B `#2` never appears in the file, the main handler never fired on the second click (**H2**). C lines carry the `wcId` (`event.sender.id` / `capturerWindow.webContents.id`) so callbacks-per-`wcId` can be counted (**H3**).
- **Log file path:** `path.join(userDataPath, "screenshare-debug.log")` where `userDataPath = app.getPath("userData")` (imported from `src/utils.ts`). On the developer's Windows box this is typically `%APPDATA%/goofcord/screenshare-debug.log` (or `<exe-dir>/goofcord-data/screenshare-debug.log` in portable mode). Log point A is DevTools-only (renderer).
- **Read paths (D-02/D-03):** A → DevTools (F12) on the developer's Windows box; B/C → the `screenshare-debug.log` file (survives the no-console gap on a packaged build).
- **STRIP BEFORE UPSTREAM PR (D-04):** plan 01-02 MUST revert this commit (`git revert <hash>` — verified clean) before opening the upstream PR. The userData log-file writes are debug scaffolding and must not ship. The instrumentation commit is below.

## Task Commits

Tasks 1 and 2 were source edits verified in place; per the plan they were committed together as the single diagnostic commit in Task 3 (D-01/D-04 require ONE self-contained instrumentation commit):

1. **Task 1: Add log point A — patched `getDisplayMedia` entry** — verified (`grep [ScreenshareDebug][A]` hit; `bun run check` exit 0), committed in Task 3.
2. **Task 2: Add log points B and C + `appendDebugLog` helper** — verified (7 `[ScreenshareDebug]` occurrences ≥ 5 required; `bun run check` exit 0; `bun run build` success), committed in Task 3.
3. **Task 3: Commit instrumentation as a distinct, revertable commit** — `2f4b94d` (`debug`)

**Instrumentation commit (to revert before PR, D-04):** `2f4b94d` — `debug(screenshare): add Bug A diagnostic log points A/B/C (revert before PR)`

_No separate plan-metadata commit yet — STATE/ROADMAP/SUMMARY are committed in the final docs commit for this plan._

## Files Created/Modified

- `src/windows/main/renderer/postVencord/screensharePatch.ts` — Added module-scoped `getDisplayMediaCallCount` and log point A (`console.log`, `[ScreenshareDebug][A]`) as the first statement inside the patched `getDisplayMedia`. No change to the `NotAllowedError` re-throw, the Patchcord `getVirtmic()` block, or the constraints/contentHint logic.
- `src/windows/screenshare/screenshare.ts` — Added `fs` import + `userDataPath` import, the `appendDebugLog` helper, module-scoped `debugRequestCount`, log point B (handler entry + `wcId`), and log point C at the `!req` early-return, the cancel `callback({})`, the grant `callback(result)`, and the `closed` handler. Teardown structure (delete-before-callback, dual cleanup paths, `activeRequests.has` guard) left exactly as-is.

## Decisions Made

- **Reverted build-regenerated bundles out of the commit.** The build (`bun run build`) regenerates the tracked `assets/postVencord.js` / `assets/preVencord.js` bundles (which embed renderer source). The prior screenshare-source fix `710cfde` committed only the source file, not the bundle — so I matched that upstream convention and kept the commit source-only. This keeps the diff surgical (UPST-01) and the D-04 revert to exactly the two fix-surface files.
- **Two independent counters** (renderer `getDisplayMediaCallCount`, main `debugRequestCount`) rather than a shared one — they live in different processes and cannot share state; each is the right monotonic lever for its hypothesis (A→H1, B→H2/H3).
- **`appendDebugLog` is local to `screenshare.ts`** (not added to `utils.ts`) so the entire diagnostic is contained in the two fix-surface files and reverts in one commit.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Installed project dependencies from the committed lockfile**
- **Found during:** Task 1 (running `bun run check`)
- **Issue:** `node_modules` was absent, so `tsgo` (type check) and `bun run build` — both mandated verifications and what the Windows CI runs — could not execute (`tsgo: command not found`).
- **Fix:** `bun install --frozen-lockfile` to restore the already-declared dependencies from the committed `bun.lock` (no new/unknown packages added — this restores existing project state, not a package-manager add).
- **Files modified:** None tracked (only `node_modules/`, which is gitignored).
- **Verification:** `bun run check` then exited 0 and `bun run build` succeeded.
- **Committed in:** N/A (no tracked file change).

---

**Total deviations:** 1 auto-fixed (1 blocking).
**Impact on plan:** Required to run the mandated `bun run check` / `bun run build` verifications. No scope creep, no tracked-file change, no new dependencies.

## Issues Encountered

- **`bun run fmt` reformatted ~25 unrelated files repo-wide.** `oxfmt` ran over the whole tree (including `.planning/*.md`, `CLAUDE.md`, and other source files) — out of this task's scope. Resolved by reverting every reformatted file except the two instrumented sources (which `oxfmt` left unchanged — they were already tab-formatted and lint-clean: `oxlint --type-aware` reported 0 warnings / 0 errors on both).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- **Ready for 01-02 (the fix):** the instrumentation commit `2f4b94d` is in place and will ride the SAME single Windows CI artifact (D-01). Once the developer runs that artifact through cancel → re-click on their Windows box (D-03), `screenshare-debug.log` + DevTools will route H1/H2/H3 and tell 01-02 whether the `NotAllowedError` → `AbortError` switch (and/or a go-live Flux reset) is needed alongside the `finishRequest()` consolidation.
- **D-04 reminder for 01-02:** revert `2f4b94d` before opening the upstream PR — the diagnostic log-file writes must not ship. Revert verified clean.
- **No behavior changed** in this plan; the trace reflects current pre-fix behavior, exactly as required for routing the hypothesis.

## Self-Check: PASSED

- `01-01-SUMMARY.md` — FOUND
- `src/windows/main/renderer/postVencord/screensharePatch.ts` — FOUND (1× `[ScreenshareDebug][A]` in committed source)
- `src/windows/screenshare/screenshare.ts` — FOUND (7× `[ScreenshareDebug]` in committed source)
- Commit `2f4b94d` — FOUND
- Revert dry-run of `2f4b94d` — CLEAN (D-04 one-command strip confirmed)

---
*Phase: 01-fix-bug-a-cancel-then-restart-works*
*Completed: 2026-05-30*
