---
phase: 05-verification-upstream-pr
plan: 05
subsystem: packaging
tags: [optionalDependencies, github-ref, prebuilt-node, ci, packaging, strip-verify]

requires:
  - phase: 05
    plan: 02
    provides: the wasapi-loopback-repo/ staging dir that became the published repo
  - phase: 05
    plan: 04
    provides: the package.json optionalDependencies github ref + Rust-free CI this plan exercises
provides:
  - Published thomas-quant/wasapi-loopback repo with CI-committed prebuilt (commit 1ecb8ec)
  - bun.lock resolving github:thomas-quant/wasapi-loopback#1ecb8ec
  - Green final-shape Windows CI artifact (run 27054703843) — stripped + dependency-packaged
affects: [05-06, 05-07]

requirements: [UPST-02]
status: complete
tasks_completed: 2
tasks_total: 2
---

# 05-05 — Publish addon repo + final dependency-packaged build

## Task 1 (checkpoint:human-action) — addon repo published ✅
The user delegated this to the agent mid-flight ("can u do that for me") — explicit
authorization for the outward-facing repo creation (the addon repo is the user's own,
NOT the identity-sensitive upstream PR, which remains the user's in 05-07).

- Created **https://github.com/thomas-quant/wasapi-loopback** (public, default `main`)
  from the `wasapi-loopback-repo/` staging dir (git init → commit as Thomas Quant →
  `gh repo create --source=. --push`).
- Ran its `Build prebuilt` CI (run 27054645964 → success); it built the napi addon on
  windows-latest and committed back **`prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node`**
  (344,576 B, commit `1ecb8ec`).

## Task 2 (auto) — resolve dependency + final-shape Windows build ✅
- `bun install` → `+ wasapi-loopback@github:thomas-quant/wasapi-loopback#1ecb8ec`;
  `bun.lock` records it (lines 28 + 751). bun cloned the full repo incl. prebuilds.
- Prebuilt lands at the exact path `build.ts` reads:
  `node_modules/wasapi-loopback/prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node`.
- Local `bun run build` green → `Copied native addon into ts-out/native: wasapi-loopback-win32-x64.node`
  (copyNativeModules now sources the .node from the optionalDependency — env override gone,
  host-agnostic copy preserved). Reverted a build-host asset path-leak (out of scope).
- Committed `bun.lock`; pushed `fix/windows-screenshare-cancel-restart`.
- Dispatched final-shape Windows CI **27054703843 → success** (Rust-free, addon via dep).

### Acceptance / packaging verification
- `grep "wasapi-loopback" bun.lock` → present ✅
- Whole-tree strip grep across `src/ build/ .github/` → **0 diagnostic tokens** ✅
- Artifact `app.asar` contains the fork code (`shouldInjectWasapiTransport`, `wasapi:pcm-port`)
  and the loadable addon at `app.asar.unpacked/ts-out/native/wasapi-loopback-win32-x64.node` ✅
- `app.asar` is strip-clean: 0 of {appendScreenshareDebug, screenshare-debug.log, syncCrumb,
  deliverySpike, GOOFCORD_WASAPI_LOOPBACK_PATH} present ✅
- Note: `win32-wasapi-exclude-tree` / `tryStartWasapiLoopback` absent from the asar is EXPECTED —
  the former was a stripped diagnostic string; the latter is minified in the Bun main bundle. The
  "latest debug-log shows path=win32-wasapi-exclude-tree" check is N/A for the stripped build (no
  debug log by design); native-path confirmation is the viewer-audible test in 05-06.

## Hand-off to 05-06
Final stripped/dependency-packaged artifact (run 27054703843) extracted to
`…/Downloads/goofcord-final-27054703843/app/GoofCord.exe` for the user's final two-device
re-confirm + ECHO-03 / `--no-wasapi` fallback test.

## Self-Check: PASSED
- [x] Repo published with CI-committed prebuilt on main
- [x] bun.lock resolves the optionalDependency
- [x] Green final-shape Windows CI; addon packaged + loadable; tree strip-clean
