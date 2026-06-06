---
phase: 05-verification-upstream-pr
plan: 02
subsystem: infra
tags: [napi-rs, rust, wasapi, prebuilt-node, github-actions, optionalDependencies, packaging]

# Dependency graph
requires:
  - phase: 04-native-clean-room-exclude-tree-addon-integration
    provides: the in-tree native/wasapi-loopback crate (clean-room WASAPI EXCLUDE-tree .node addon) that this plan extracts into a standalone publishable repo
provides:
  - A ready-to-push standalone addon repo dir (wasapi-loopback-repo/) — de-private-d, MIT-licensed, MS NOTICE retained, off-Windows install-skip
  - Its own windows-latest napi CI (build.yml) that builds the prebuilt and commits it to prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node (the exact path build.ts:207 reads)
  - The optionalDependency-consumption story (README) mirroring patchcord's github-ref committed-binary delivery
affects: [05-03, 05-04, 05-05, upstream-echo-PR]

# Tech tracking
tech-stack:
  added: ["@napi-rs/cli@3.7.0 (addon-repo devDep, already pinned)", "dtolnay/rust-toolchain (addon CI)", "oven-sh/setup-bun (addon CI)"]
  patterns:
    - "Committed-prebuilt delivery via github-ref optionalDependency (mirror patchcord/venbind — no postinstall/prepare)"
    - "os/cpu package.json fields for off-Windows install skip (D-16 no-op for free)"
    - "CI normalizes napi output to a win32+x64 substring name and commits it back via git add -f"

key-files:
  created:
    - wasapi-loopback-repo/package.json
    - wasapi-loopback-repo/LICENSE
    - wasapi-loopback-repo/.github/workflows/build.yml
    - wasapi-loopback-repo/README.md
    - wasapi-loopback-repo/.gitignore
    - wasapi-loopback-repo/NOTICE
    - wasapi-loopback-repo/Cargo.toml
    - wasapi-loopback-repo/Cargo.lock
    - wasapi-loopback-repo/build.rs
    - wasapi-loopback-repo/src/lib.rs
  modified: []

key-decisions:
  - "Committed-binary delivery (patchcord/venbind precedent): no postinstall/prepare; CI commits the prebuilt back to prebuilds/windows-x86_64/"
  - "os:[win32]/cpu:[x64] in the addon package.json makes bun skip the install entirely off-Windows (free D-16 Linux/macOS no-op)"
  - "LICENSE = MIT (Thomas Quant 2026) coexisting with the retained Microsoft NOTICE for ECHO-04 clean-room provenance; root OSL-3.0 LICENSE deliberately NOT copied"
  - "Single target win32-x64 only (D-10); win32-arm64 is a noted fast-follow covered by the loopback fallback"
  - "Staging dir COMMITTED to the worktree branch (not left untracked) so it survives worktree force-removal — see Deviations"

patterns-established:
  - "Standalone napi addon repo extraction: copy crate, drop private, add os/cpu/files/repository, add MIT LICENSE + keep NOTICE, un-ignore prebuilds/, single-target windows-latest commit-back CI"

requirements-completed: [UPST-02]

# Metrics
duration: 12min
completed: 2026-06-06
---

# Phase 5 Plan 02: Standalone wasapi-loopback Addon Repo Summary

**A ready-to-push, clean-room MIT `thomas-quant/wasapi-loopback` repo dir extracted from the in-tree crate, with off-Windows install-skip and its own windows-latest napi CI that commits `prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node` to the exact path GoofCord's `build.ts` reads.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-06-06T04:47:00Z
- **Completed:** 2026-06-06T04:59:26Z
- **Tasks:** 2
- **Files created:** 10 (the full staging repo)

## Accomplishments
- Extracted `native/wasapi-loopback/` into a standalone `wasapi-loopback-repo/` staging dir (crate sources, Cargo.toml/Cargo.lock, build.rs, NOTICE all carried verbatim).
- Applied the publish-deltas to `package.json`: dropped `private`; added `os:["win32"]`/`cpu:["x64"]` (off-Windows install skip), a `files` array, and `repository`/`homepage` → `thomas-quant/wasapi-loopback`; kept `napi.name = "wasapi-loopback"`; no `postinstall`/`prepare` (committed-binary delivery).
- Added an MIT `LICENSE` (Thomas Quant, 2026) coexisting with the retained Microsoft `NOTICE` (ECHO-04 clean-room provenance).
- Edited `.gitignore` to track the committed prebuild via `!prebuilds/**/*.node`.
- Authored the repo's own `windows-latest` napi CI (`.github/workflows/build.yml`): `workflow_dispatch`, `contents: write`, setup-bun + Rust msvc toolchain, `napi build`, normalize to `prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node` (name contains BOTH `win32` AND `x64`), commit-back via `git add -f`.
- Rewrote the README: dropped the `GOOFCORD_WASAPI_LOOPBACK_PATH` env-override note and the in-repo "Status" section; documented `github:thomas-quant/wasapi-loopback` optionalDependency consumption; kept the Clean-room provenance (ECHO-04) section verbatim.

## Task Commits

Each task was committed atomically:

1. **Task 1: Copy crate + apply package.json / LICENSE / .gitignore publish-deltas** - `44461af` (chore)
2. **Task 2: windows-latest napi CI + optionalDependency README rewrite** - `c4d2c9b` (chore)

## Files Created/Modified
- `wasapi-loopback-repo/package.json` - Publishable addon manifest (no `private`; `os`/`cpu`/`files`/`repository`/`homepage`; `napi.name` kept)
- `wasapi-loopback-repo/LICENSE` - MIT license body, addon-author copyright (coexists with MS NOTICE)
- `wasapi-loopback-repo/NOTICE` - Retained Microsoft MIT copyright (ECHO-04 clean-room provenance)
- `wasapi-loopback-repo/.gitignore` - Ignores `*.node` but un-ignores `prebuilds/**/*.node` so the committed prebuilt is tracked
- `wasapi-loopback-repo/.github/workflows/build.yml` - windows-latest napi build + normalize + git add -f commit-back
- `wasapi-loopback-repo/README.md` - optionalDependency consumption docs; Clean-room provenance intact
- `wasapi-loopback-repo/Cargo.toml`, `Cargo.lock`, `build.rs`, `src/lib.rs` - Crate sources carried verbatim from the extraction base

## Decisions Made
- **Committed-binary delivery** (mirror patchcord/venbind): no `postinstall`/`prepare`; the CI commits the prebuilt back. This is the cleanest, bun-friendly, network-free consumer install and matches the locked "mirror patchcord" decision (D-08/Q1).
- **`os`/`cpu` install-skip:** `os:["win32"]`/`cpu:["x64"]` makes bun skip the optionalDependency entirely on Linux/macOS (D-16 no-op for free), so no consumer-side platform guard is needed.
- **License boundary:** the addon stays MIT in its own repo with the MS NOTICE retained; the GoofCord root `LICENSE` (OSL-3.0) was deliberately NOT copied (D-05 clean-room).
- **Single target win32-x64** (D-10); win32-arm64 noted as a fast-follow covered by the `"loopback"` fallback.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Committed the staging dir to the worktree branch instead of leaving it untracked**
- **Found during:** Task 1 (commit step)
- **Issue:** The plan's prose acceptance note says `wasapi-loopback-repo/` should remain "untracked or gitignored" in GoofCord. However, this plan runs as a parallel **worktree executor**, and the orchestrator force-removes the worktree after return — any **uncommitted/untracked** file (the entire staging dir) would be **permanently lost** before the user can push it in 05-05, failing the plan's own success criteria. The plan frontmatter also lists every `wasapi-loopback-repo/*` file under `files_modified` (the worktree write set), signalling these files are meant to be committed.
- **Fix:** Committed the staging dir to the per-agent worktree branch (`worktree-agent-*`) via the two atomic task commits so it survives worktree removal + merge back to the fork working branch (`fix/windows-screenshare-cancel-restart`).
- **Reconciliation of intent:** "Do not commit into GoofCord history" is honored for what matters — the **upstream echo PR** is curated separately off `upstream/main` via `gsd-pr-branch` (05-03/05-04), which excludes `wasapi-loopback-repo/` (and all non-PR-surface files). The dir lives only on the fork's kitchen-sink working branch (which already holds all `.planning/`), exactly mirroring the branch topology noted in project memory. The user copies it out to create `thomas-quant/wasapi-loopback` in 05-05.
- **Files modified:** all `wasapi-loopback-repo/*` (committed, not GoofCord source code)
- **Verification:** `git status --porcelain wasapi-loopback-repo` is clean (committed) → survives worktree removal; the upstream PR branch will not contain it.
- **Committed in:** `44461af`, `c4d2c9b`

---

**Total deviations:** 1 auto-fixed (1 blocking — worktree survival).
**Impact on plan:** Necessary to prevent total loss of the plan's deliverable on worktree teardown. No scope change to the staging dir contents; the literal "untracked" acceptance note is superseded by the curated-upstream-PR mechanism that achieves the same end (zero addon-repo files in the upstream PR).

## Issues Encountered
- The reference `node_modules/{patchcord,venbind}/package.json` were not installed in this worktree, so the `os`/`cpu`/`files` shapes were taken from 05-RESEARCH.md (Q1/Q3, inspected on disk during research) and 05-PATTERNS.md rather than re-read live. Patterns applied verbatim; no impact.

## Clean-room / Threat Notes
- No Discord code or symbols are present in the extracted crate (`grep -i discord src/lib.rs` → none). The crate is authored solely from the public Microsoft `ApplicationLoopback` MIT sample; the Microsoft NOTICE is retained verbatim. No new network/auth/file surface is introduced by this packaging-only plan.

## Next Phase Readiness
- `wasapi-loopback-repo/` is a complete, ready-to-push package: valid manifest, MIT LICENSE + MS NOTICE, off-Windows-skip fields, single-target windows-latest commit-back CI writing the exact glob-matched prebuild path.
- **Blocking for 05-05 (user action):** the USER must create the GitHub repo `thomas-quant/wasapi-loopback`, push this dir, and run the `Build prebuilt` workflow so the prebuilt `.node` is committed before the final dependency-packaged re-confirm. Claude does not create/push the repo (D-09).
- Pairs with the root `package.json` `optionalDependencies` line (`github:thomas-quant/wasapi-loopback`) added in the GoofCord-side packaging plan, and `build.ts` dropping the `GOOFCORD_WASAPI_LOOPBACK_PATH` envPath while keeping the `prebuilds` entry.

## Self-Check: PASSED

- All 10 staging files + SUMMARY.md present on disk.
- Task commits `44461af` and `c4d2c9b` present in git history.

---
*Phase: 05-verification-upstream-pr*
*Completed: 2026-06-06*
