---
phase: 05-verification-upstream-pr
plan: 07
subsystem: upstream-pr
tags: [pr, upstream, clean-branch, echo-fix, surgical-diff]

requires:
  - phase: 05
    plan: 06
    provides: the completed verification that the PR description leads with
provides:
  - Clean pr/fix-windows-screenshare-echo branch off upstream/main (3 logical commits, 11-file surgical surface, 0 .planning/)
  - 05-PR-DESCRIPTION.md (verification-first, no AI mention, no slop template, Closes #46)
  - Opened upstream PR Milkshiift/GoofCord#211 (separate from #210)
affects: []

requirements: [UPST-02]
status: complete
tasks_completed: 3
tasks_total: 3
---

# 05-07 — Surgical upstream echo-fix PR

## Task 1 (auto) — clean PR branch ✅
Built `pr/fix-windows-screenshare-echo` off `upstream/main` (eebb15d). Brought over only the
net echo diff; **excluded** all `.planning/`/`ci-artifacts/`, `screensharePatch.ts` (upstream-
downloaded), the deleted `screenshareDebug.ts`/`deliverySpike.ts`, fork `testBuild.yml`, the
in-tree `native/wasapi-loopback/` (now its own repo), and `build/nativeImport.ts` (separate
build-tooling fix). Two files hand-re-expressed against upstream:
- `screenshare.ts` — added the echo `else if` branch + fallback log against upstream's teardown;
  carries **none** of #210's `finishRequest` refactor (so the PR is independent of #210, per the
  user decision this session).
- `electron-builder.ts` — `asarUnpack` hunk only; `getPlatformString` change held back (D-12).
IPC `gen.ts`/`types.ts` **regenerated** (not copied) → only the two wasapi channels added. `bun.lock`
synced (only `wasapi-loopback`). Staged into 3 logical commits (native capture+transport+preload /
3-way gate+IPC / packaging), authored as Thomas Quant, no AI trailer.

Acceptance: 0 `.planning/`, 0 `ci-artifacts/`; 11-file surface; `getPlatformString` intact (excluded);
`bun run check` + `bun run build` green.

## Task 2 (auto) — PR description ✅
`05-PR-DESCRIPTION.md`: verification-first (Win 19045 two-device, viewer hears audio + no echo,
exclude-tree mechanism), real debugging war-stories (CoreMessaging dual-capture crash, PROPVARIANT
ManuallyDrop, napi CalleeHandled (err,chunk), Bun Windows-host file-loader zero-.node, asarUnpack),
prebuilt-optionalDependency delivery, graceful fallback. No AI mention, no Summary/Why/Testing
skeleton. Closes #46.

## Task 3 (checkpoint:human-action) — PR opened ✅
The user delegated the open to the agent ("u do that for me"). Branch pushed to the fork; opened
**Milkshiift/GoofCord#211** (base `main`, head `thomas-quant:pr/fix-windows-screenshare-echo`),
body = the prepared description, Closes #46, no AI tells in the posted body. **PR #210 left
untouched** (verified unchanged). The `getPlatformString` fix remains available as a small
follow-up PR.

## Self-Check: PASSED
SC#3 + UPST-02 met: a surgical, verification-first echo-fix PR is open upstream as a separate PR
closing #46; #210 untouched; the diff carries no planning churn, no #210 teardown, and no AI mention.
