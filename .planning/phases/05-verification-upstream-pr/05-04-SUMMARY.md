---
phase: 05-verification-upstream-pr
plan: 04
subsystem: infra
tags: [optionalDependencies, github-ref, electron-builder, github-actions, packaging, wasapi, prebuilt-node]

# Dependency graph
requires:
  - phase: 05-02-standalone-addon-repo
    provides: the ready-to-push thomas-quant/wasapi-loopback repo whose CI commits prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node — the exact path build.ts reads
  - phase: 04-native-clean-room-exclude-tree-addon-integration
    provides: copyNativeModules()/copyNativeAddonsToOutDir() machinery, the asarUnpack ["**/*.node"] packaging, and the in-CI Rust build this plan now decouples
provides:
  - "GoofCord consumes the wasapi addon via one optionalDependencies github ref (github:thomas-quant/wasapi-loopback), mirroring patchcord/venbind — the GOOFCORD_WASAPI_LOOPBACK_PATH env override is gone"
  - "build/build.ts is prebuild-only for wasapi while PRESERVING the host-agnostic copy (copyNativeAddonsToOutDir + the ts-out/native runtime load) — the permanent fix for Bun's Windows-host file-loader bug"
  - "testBuild.yml no longer compiles Rust or exports an env path or dumps verbose diagnostics, but keeps the lean 2-line packaging presence assertion (V4 safeguard)"
  - "electron-builder.ts resolves the build platform via context.electronPlatformName (fixes the misnamed -linux-x64.node-in-Windows-package bug), kept as its OWN separable commit out of the echo PR (D-12)"
affects: [05-05, upstream-echo-PR]

# Tech tracking
tech-stack:
  added: ["github:thomas-quant/wasapi-loopback (optionalDependency — win32/x64-only, off-Windows install-skip)"]
  patterns:
    - "Native addon consumed prebuilt via github-ref optionalDependency (mirror patchcord/venbind); no in-repo Rust build"
    - "Packaging platform resolved via context.electronPlatformName (already process.platform form), not a Platform-enum switch on context.packager.platform"

key-files:
  created:
    - .planning/phases/05-verification-upstream-pr/05-04-SUMMARY.md
  modified:
    - build/build.ts
    - package.json
    - .github/workflows/testBuild.yml
    - electron-builder.ts

key-decisions:
  - "Drop ONLY the envPath line on the wasapi entry; KEEP the prebuilds entry + copyNativeAddonsToOutDir (the misleading PHASE-5 REMOVAL comments were rewritten, not obeyed)"
  - "getPlatformString fix made as its own atomic commit (D-12) — removed the now-dead helper + unused Platform import so the separable fix leaves no dead code"
  - "Lean packaging presence assertion KEPT (V4 safeguard); only the verbose DIAGNOSTICS dump stripped (D-13)"

patterns-established:
  - "Flipping a native addon from build-time env override to published optionalDependency: drop envPath, keep prebuilds[] + the host-agnostic ts-out/native copy, add one github-ref optionalDependencies line, strip the in-CI compile + env export"

requirements-completed: [UPST-02]

# Metrics
duration: 5min
completed: 2026-06-06
---

# Phase 5 Plan 04: GoofCord-side addon delivery via optionalDependency Summary

**The wasapi echo-fix addon now ships through one `optionalDependencies` github ref (mirroring patchcord/venbind) with the in-CI Rust build, env override, and CI diagnostics stripped — while the load-bearing host-agnostic `ts-out/native` copy is preserved and the `electron-builder` `getPlatformString` bug is fixed as a separable commit kept out of the echo PR.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-06-06T05:56:08Z
- **Completed:** 2026-06-06T06:01:04Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments
- **Published-dependency delivery (SC#3):** `package.json` carries one new optionalDependencies line `github:thomas-quant/wasapi-loopback`; `build/build.ts` dropped the `GOOFCORD_WASAPI_LOOPBACK_PATH` env override so the wasapi entry is now a normal prebuild-only module like venbind/patchcord.
- **Host-agnostic copy PRESERVED:** `copyNativeAddonsToOutDir()` (and its call) plus the `prebuilds` entry pointing at `windows-x86_64/wasapi-loopback-win32-x64.node` are intact — the misleading `PHASE-5 REMOVAL` comments were rewritten to document that this copy is the permanent fix for Bun's Windows-host file-loader bug, not scaffolding.
- **CI decoupled from Rust:** removed the `Install Rust toolchain` + `Build wasapi-loopback addon` steps and the `GITHUB_ENV` env-path export from `testBuild.yml`; stripped the temporary `DIAGNOSTICS` dump while keeping the lean 2-line presence assertion (V4 safeguard) that `wasapi-loopback-win32-x64.node` is present in `ts-out` and in the packaged `dist/`.
- **Separable packaging fix (D-12):** `electron-builder.ts` now resolves the build platform via `context.electronPlatformName` instead of switching on `context.packager.platform` (which didn't reliably `===` `Platform.WINDOWS`, producing a misnamed `…-linux-x64.node` in the Windows package). Committed on its own, leaving `asarUnpack: ["**/*.node"]` untouched.

## Task Commits

Each task was committed atomically:

1. **Task 1: Drop env override in build.ts (keep copy machinery) + add optionalDependencies line** - `b238ed1` (chore)
2. **Task 2: Strip in-CI Rust build + diagnostics from testBuild.yml, keep lean assertion** - `beb4a01` (ci)
3. **Task 3: Fix electron-builder getPlatformString via electronPlatformName (separable, D-12)** - `d540506` (fix)

## Files Created/Modified
- `package.json` - Added `"wasapi-loopback": "github:thomas-quant/wasapi-loopback"` to `optionalDependencies` (mirrors the patchcord github-ref shape; bun skips it off-Windows via the addon's os/cpu fields)
- `build/build.ts` - Removed the wasapi `envPath` line; kept the `prebuilds` entry + `copyNativeAddonsToOutDir()`; rewrote the misleading `PHASE-5 REMOVAL` comments to reflect optionalDependency delivery + the preserved host-agnostic copy
- `.github/workflows/testBuild.yml` - Removed the Rust toolchain + napi build steps + the `GOOFCORD_WASAPI_LOOPBACK_PATH` GITHUB_ENV export and the verbose `DIAGNOSTICS` block; kept the lean packaging presence assertion; reworded comments for optionalDependency delivery
- `electron-builder.ts` - `beforePack` resolves platform via `context.electronPlatformName`; removed the now-dead `getPlatformString` helper + unused `Platform` import; `asarUnpack` unchanged

## Decisions Made
- **Removed the dead `getPlatformString` helper + unused `Platform` import** rather than leaving the function in place after switching to `electronPlatformName`. The plan said "confine to the getPlatformString resolution path"; replacing the resolver and deleting its now-unreferenced helper + import is one logical hunk and keeps the separable upstream-candidate fix free of dead code. The explanatory comment intentionally still names `getPlatformString`/`Platform.WINDOWS` (in prose) to document the bug.
- **Kept the `prebuilds` entry exactly** at `windows-x86_64/wasapi-loopback-win32-x64.node` — `copyNativeModules()` resolves it from `node_modules/wasapi-loopback/...` via the same `mod.prebuilds.map(...)` path used for patchcord/venbind once bun clones the github ref (05-05).

## Deviations from Plan

None — plan executed exactly as written. (The `getPlatformString` helper + `Platform` import removal noted under "Decisions Made" is within the Task 3 action's stated scope of confining the change to the getPlatformString resolution path; it is not unplanned work.)

## Issues Encountered
- **Inferred-union type risk in `build.ts`:** removing `envPath` from one element of the `modules` array literal (the other two entries still carry it) could have produced a TS error at the `if (mod.envPath)` access site. `bun run check` (tsgo) passed clean (exit 0), so the inference tolerates the omission — no annotation needed; the minimal "delete only the envPath line" change was kept.
- **electron-builder.ts is outside tsgo's include scope** (`tsconfig.json` include is `["src/**/*", "build/**/*"]`). `bun run check` does NOT type-check it, so the `context.electronPlatformName` change was validated against the installed `app-builder-lib` types directly (`BeforePackContext = PackContext` with `readonly electronPlatformName: string`, set from `platform.nodeName` → `"win32"/"linux"/"darwin"`) and a `bun build` parse-only sanity pass.

## Verification
- `! grep GOOFCORD_WASAPI_LOOPBACK_PATH build/build.ts` (0) AND `grep copyNativeAddonsToOutDir build/build.ts` (present) AND `grep github:thomas-quant/wasapi-loopback package.json` (present) AND valid JSON — PASS.
- `! grep -E "GOOFCORD_WASAPI_LOOPBACK_PATH|Install Rust toolchain|napi build|DIAGNOSTICS" testBuild.yml` (0) AND `grep wasapi-loopback-win32-x64.node testBuild.yml` (present, lean assertion) — PASS; YAML parses clean.
- `grep context.electronPlatformName electron-builder.ts` AND `grep asarUnpack electron-builder.ts` — PASS; no code-level dangling `getPlatformString`/`Platform` references (only the explanatory comment); parse-only build OK.
- `bun run check` (tsgo) — exit 0. `assets/preVencord.js` / `postVencord.js` untouched (never ran `bun run build`; no build-host path leak). Working tree clean.

## Next Phase Readiness
- The GoofCord-side delivery now matches the surgical SC#3 surface: additive screenshare gate + `wasapiLoopback.ts` (05-03) + one `build.ts` prebuild entry + one `optionalDependencies` line + regenerated IPC. The `getPlatformString` fix is isolated in `d540506`, ready to exclude from the echo PR's logical commits (D-12).
- **Expected/pending for 05-05 (user action):** `github:thomas-quant/wasapi-loopback` does NOT exist yet — the USER must create + push the 05-02 staging repo and run its CI so the prebuilt `.node` is committed. Until then, `bun install` skips the win32-only optionalDependency off-Windows and the addon `.node` is absent on this Linux/WSL box (so the CI packaging assertion only passes after the repo is pushed). `bun.lock` was deliberately NOT regenerated (out of scope; bun cannot clone the not-yet-existing ref) — the lockfile update is a 05-05 concern alongside the final dependency-packaged Windows re-confirm.

## Self-Check: PASSED

- All 4 modified files present on disk (`build/build.ts`, `package.json`, `.github/workflows/testBuild.yml`, `electron-builder.ts`) + `05-04-SUMMARY.md`.
- All task/doc commits present in git history: `b238ed1`, `beb4a01`, `d540506`, `df1fa02`.

---
*Phase: 05-verification-upstream-pr*
*Completed: 2026-06-06*
