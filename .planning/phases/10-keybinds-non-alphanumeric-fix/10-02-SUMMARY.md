---
phase: 10-keybinds-non-alphanumeric-fix
plan: 02
type: execute
status: complete
decision: github-ref
commits:
  - 5c01686  # build(10-02): consume the fixed venbind from the fork via github ref
related_venbind_commit: f8d7805  # chore(fork): commit x86_64 prebuilds
verification: bun run check ✓ (EXIT 0); Windows runtime test still PENDING (needs GoofCord CI build + manual keyboard test)
---

# Summary — Plan 10-02 (Task C): consume the fixed venbind

## Decision

User chose **github-ref + committed prebuild** (mirrors the wasapi-loopback pattern) over the
env-path and npm-publish alternatives.

## What changed

1. **venbind fork** (`thomas-quant/venbind` `fork-ci`, commit `f8d7805`, pushed): committed the
   CI-built x86_64 prebuilds (from run `27314521855`) at
   `prebuilds/windows-x86_64/venbind-windows-x86_64.node` (PE32+ x86-64) and
   `prebuilds/linux-x86_64/venbind-linux-x86_64.node` (ELF x86-64). venbind's `package.json` has
   `"scripts": {}` (no install/build hook), so `bun install` of the github dep uses the committed
   prebuild without compiling. Fork-distribution only — NOT on the clean upstream branch
   `fix/uiohook-named-key-matching`.
2. **GoofCord** (commit `5c01686`): `package.json` optionalDependency
   `"venbind": "0.1.7"` → `"github:thomas-quant/venbind#f8d7805…"` (pinned SHA, reproducible);
   `bun.lock` updated. No `build.ts` change — it already copies
   `node_modules/venbind/prebuilds/<target>/venbind-<target>.node`.

## Verification

- `bun install` → venbind resolved from the fork; prebuild landed at
  `node_modules/venbind/prebuilds/windows-x86_64/venbind-windows-x86_64.node` (confirmed PE32+).
- `bun run check` → EXIT 0.
- **NOT done — the actual Windows runtime test.** Needs a GoofCord Windows CI build
  (`testBuild.yml`, workflow_dispatch on the GoofCord fork → `win-artifacts` zip) and a manual
  on-keyboard test: bind an action to Page Up / an F-key, confirm it fires out-of-focus AND
  focused; regression-guard that punctuation (`]`, Ctrl-combos) still fire. Gated on a GoofCord
  push, which the user has not yet authorized.

## Notes
- aarch64 prebuilds are not produced by the fork CI; GoofCord's prebuild copy tolerates their
  absence (best-effort `.catch`), so arm64 GoofCord builds simply won't carry venbind (unchanged
  from the pre-existing situation for that arch).
- The 10-GOOFCORD-WIRING.md §4 `assets/native/` mention was stale; the real path is
  `node_modules/venbind/prebuilds/...` per build.ts. Followed the real path.
