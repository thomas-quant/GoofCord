---
phase: 05-verification-upstream-pr
plan: 01
subsystem: verification
tags: [wasapi, verification, ci, two-device, echo-fix, os-release, build-number]

# Dependency graph
requires:
  - phase: 04-native-clean-room-exclude-tree-addon-integration
    provides: the activated WASAPI EXCLUDE-tree path + screenshare-debug instrumentation that this plan captures rich evidence from
provides:
  - 05-VERIFICATION.md rich-build section (build#, exclude-root/Audio-Service PIDs, native-path line, N-API smoke, chunk counts, viewer-side ground truth) captured BEFORE any strip (resolves D-14 evidence-vs-strip tension)
  - The os.release() build-number breadcrumb on the rich build (closes RESEARCH Q7 — Windows build was previously unlogged)
  - Green rich-build Windows x64 CI artifact (run 27053219078, commit 5882491)
affects: [05-03, 05-06]

# Tech tracking
tech-stack:
  added: []
  patterns: [appendScreenshareDebug-discipline, os.release-breadcrumb]

requirements: [UPST-02]
status: complete
tasks_completed: 3
tasks_total: 3
---

# 05-01 — Rich-build verification capture (pre-strip)

**Goal:** Capture the FULL structured verification evidence on a build that STILL
has instrumentation, BEFORE 05-03 strips it (D-14). Add the one missing evidence
line (Windows build number), trigger CI, get the two-device viewer ground truth,
read the WSL log, and write the rich-build verification section.

## What was done

### Task 1 (auto) — build-number breadcrumb + CI ✅
- Added `import os from "node:os"` and one `appendScreenshareDebug(\`wasapi build=${os.release()}\`)`
  breadcrumb at the activation point in `src/modules/native/wasapiLoopback.ts`
  (routes through the existing `[sync]`/`appendScreenshareDebug` discipline to
  `screenshare-debug.log`). Marked as diagnostic scaffolding → stripped in 05-03.
- `bun run check` (tsgo) clean.
- Committed `5882491` as Thomas Quant on `fix/windows-screenshare-cancel-restart`,
  pushed to origin, dispatched `testBuild.yml` on the **fork** (`--repo
  thomas-quant/GoofCord` — `gh`'s default repo is upstream Milkshiift, which 403s).
- CI run **27053219078** → `success`; `win-artifacts` (127 MB) produced.

### Task 2 (checkpoint:human-verify, blocking) — two-device test ✅
- Artifact downloaded to the Windows box and run by the user (normal launch).
- **Ground truth: viewer HEARS desktop audio + hears NO call echo. No crash.**
- User noted "needed a restart once" — investigated and cleared (see below).

### Task 3 (auto) — read log + write rich-build section ✅
- Read `…/goofcord/screenshare-debug.log` (WSL), latest-run signature (05:26, PID 19076).
- Wrote `05-VERIFICATION.md` rich-build section, every datum tied to a log line.

## Evidence captured (all from the latest-run log signature)

| Datum | Value | Log signature |
|-------|-------|---------------|
| Windows build | **10.0.19045** (> 19041 floor) | `wasapi build=10.0.19045` |
| Native path active | `win32-wasapi-exclude-tree` (not loopback, not spike) | `screenshare … path=win32-wasapi-exclude-tree` |
| Excluded root PID | `19076` (Electron main) | `wasapi exclude-root=19076` |
| Audio Service PID (in subtree) | `12280` | `… audioService=12280 procs=…,Audio Service:12280,…` |
| N-API ABI smoke | ok under Electron 41.3.0 | `wasapi smoke: loaded under electron napi ok` + `require ok` |
| Stream health | 0 → 4900+ chunks, ~100/s | `wasapi activation=ok … chunks=N` |
| Viewer ground truth | audible=YES, echo=NO | human-supplied (SC#1) |

## Deviations / notes

- **"Restart once" anomaly — NOT a native-path failure.** The whole 05:2x test
  window contains **zero** `threw`/`load failed`/`unsupported`/crash lines. The
  pre-restart instance (PID 18528) served 6 shares (wcId 2→8) all `activation=ok`;
  the post-restart instance (PID 19076) also `ok`. The restart recovered cleanly
  (the milestone Core Value). Logged as an open watch-item for 05-06; does not
  block the echo fix.
- `05-VERIFICATION.md` left `status: in_progress` with a "Final shipping shape"
  placeholder for 05-06 to complete the stripped/dependency-packaged re-confirm.

## Self-Check: PASSED
- [x] `grep "os.release()"` returns the breadcrumb; routed through appendScreenshareDebug
- [x] Green Windows x64 CI artifact (run 27053219078)
- [x] Human confirms viewer-audible + no-echo, no crash
- [x] 05-VERIFICATION.md rich-build section populated (build#, root PID, Audio Service PID, native-path line, CI run id) + final-reconfirm placeholder
