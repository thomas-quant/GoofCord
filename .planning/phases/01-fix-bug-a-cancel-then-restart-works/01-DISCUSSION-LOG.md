# Phase 1: Fix Bug A — Cancel then Restart Works - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-30
**Phase:** 1-fix-bug-a-cancel-then-restart-works
**Areas discussed:** Windows test access, Reading the logs, CI build strategy, Diagnostic cleanup

> Note: This phase was already heavily pre-decided by milestone research (`.planning/research/`) and ROADMAP.md. The discussion deliberately skipped the (research-converged) fix mechanics and focused on the open **process & environment** decisions. The user selected all four offered areas and volunteered "All builds done on GitHub Actions."

---

## Windows test access

| Option | Description | Selected |
|--------|-------------|----------|
| My own Windows box | Physical machine or VM you control; DevTools (F12) available for renderer log A; can iterate freely. | ✓ |
| A separate tester runs it | Someone else installs/clicks through; no DevTools assumption; all diagnostics must be self-contained + step-by-step. | |
| No Windows access yet | No machine lined up; would be a blocker to surface. | |

**User's choice:** My own Windows box
**Notes:** Builds are produced on GitHub Actions (`testBuild.yml`); the artifact is downloaded and run on the developer's own Windows machine. DevTools available, so renderer log A is free; main-process logs still need a capture path (→ next area). Developer runs the repeated cancel/retry stability cycles (STREAM-04) themselves.

---

## Reading the logs

| Option | Description | Selected |
|--------|-------------|----------|
| Append to a userData log file | Write main-process probes to `app.getPath('userData')/screenshare-debug.log`; robust on packaged NSIS GUI build; readable after the test. | ✓ |
| Forward main logs to DevTools | Push main-process lines to the Discord window's renderer console via `mainWindow.webContents`; everything in F12 but adds plumbing. | |
| Terminal + ELECTRON_ENABLE_LOGGING | Run the `.exe` from PowerShell with the env var; lightest but unreliable for main-process `console.log` on a packaged GUI build. | |

**User's choice:** Append to a userData log file
**Notes:** Chosen for robustness — packaged main process has no attached console, so file capture avoids a silently-wasted CI round-trip. Renderer log A reads from DevTools.

---

## CI build strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Combined, separate commits | ONE build with instrumentation + the high-confidence fix as distinct commits; diagnosed AND fixed in a single round-trip; log file routes the hypothesis if it fails; clean upstream PR. | ✓ |
| Strict diagnose-first | Build 1 = instrumentation only → confirm hypothesis → Build 2 = fix. Cleanest narrative, lowest risk, but 2+ scarce round-trips. | |
| Combined, single squashed change | One build, one commit; fastest to author but no clean attribution/revert and logs need stripping anyway. | |

**User's choice:** Combined, separate commits
**Notes:** Justified by scarce GitHub Actions round-trips plus strong research convergence on H1 + `finishRequest`. Collapses the roadmap's 01-01/01-02 two-build split into a single artifact. Distinct commits preserve upstream-PR cleanliness and revert-ability.

---

## Diagnostic cleanup

| Option | Description | Selected |
|--------|-------------|----------|
| Strip before the PR | Instrumentation is its own commit → trivially dropped; PR contains only the fix; maximally surgical (UPST-01). | ✓ |
| Keep a few minimal console logs | Drop file scaffolding but retain 1-2 plain console lines in existing style for lasting observability. | |
| Gate behind a debug flag | Keep full instrumentation dormant behind an env/config flag; most observable but least surgical. | |

**User's choice:** Strip before the PR
**Notes:** The userData log-file writes are debug scaffolding and must not ship; the separate-commits choice makes removal trivial.

---

## Claude's Discretion

- Final rejection-name decision (`NotAllowedError` vs `AbortError` vs direct Flux abort dispatch) — data-driven from the diagnostic build.
- Exact `finishRequest()` signature and the log-line format / file-append helper — implementation detail per research + existing conventions.
- Whether renderer log A also tees into the log file vs DevTools-only.

## Deferred Ideas

- Bug B (Windows loopback audio) → already scoped as Phase 2; sequenced after Bug A, not new scope.
- Discord go-live Flux store flag exploration → conditional sub-step within Phase 1 planning, only if H1 is confirmed and the error-name switch alone doesn't clear the latch.
- Typing `callback: any` → `Electron.Streams` in `ActiveRequest` → tech-debt; out of surgical scope unless implicated.
