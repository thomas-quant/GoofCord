# Phase 5: Verification + Upstream PR - Research

**Researched:** 2026-06-06
**Domain:** Release engineering — manual two-device verification, diagnostic-strip refactor, native-addon repo extraction (napi-rs prebuilt-`.node`), surgical upstream PR shaping
**Confidence:** HIGH (all findings grounded in the live repo, node_modules, the verified CI run, and the readable debug log; two items flagged as genuine planner decisions)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions (do NOT re-derive — research resolves only the gaps)

**PR delivery & split**
- **D-01** Echo fix = brand-new separate upstream PR that **closes #46**, branched fresh off `upstream/main`. NOT bundled/stacked on PR #210.
- **D-02** Phase 5 *prepares* the PR (clean branch + ready-to-paste description) for the **user to open**. Claude does not open/push.
- **D-03** Use **`gsd-pr-branch`** to filter `.planning/`+`ci-artifacts/` commits → clean code-only branch off `upstream/main` (same approach as #210's `pr/fix-screenshare-cancel-restart`).
- **D-04** Squash the debugging trail into **a few logical commits** (e.g. addon integration + 3-way gate + transport / packaging + optionalDependencies / fallback gate). Not one squash, not the raw trail.
- **D-05** **No AI mention** in the PR. Lead with hardware verification + mechanism + genuine debugging detail. **No** `## Summary / ## Why / ## Testing` skeleton.
- **D-06** PR = authentic verification-first writeup in the maintainer's framing ("native audio capture, akin to venmic but for Windows"; clean-room from the MS sample).
- **D-07** Leave PR #210 as-is.

**Addon repo strategy**
- **D-08** Addon → new repo **`thomas-quant/wasapi-loopback`** (MIT, clean-room). GoofCord consumes via **one `optionalDependencies` line** `github:thomas-quant/wasapi-loopback`, mirroring `github:Milkshiift/patchcord`. PR notes the maintainer may fork under `Milkshiift/` and flip the ref.
- **D-09** Claude prepares a **ready-to-push standalone repo dir** (de-`private`d package.json, README, MIT LICENSE + retained MS NOTICE, `.github/workflows` napi CI on `windows-latest`, prebuild name `wasapi-loopback-win32-x64.node`). **User creates the GitHub repo and pushes**; its CI builds the prebuilt.
- **D-10** Prebuild **win32-x64 first**. win32-arm64 = noted fast-follow (graceful `"loopback"` fallback covers it).

**Cleanup-bug scope**
- **D-11** Fix the **ECHO-03 silent-fallback gap** — gate the renderer track-swap on capture being active / PCM port open, so an unsupported build falls through to `"loopback"` (viewer hears audio) instead of a silent generated track. Does not touch the supported-Windows happy path.
- **D-12** Fix the **`electron-builder.ts` `getPlatformString` bug** (+ venbind-packaging generalization) — but **keep OUT of the echo PR diff** (separate tiny commit / standalone follow-up PR). The echo PR includes only the `build.ts`/`electron-builder.ts` changes the wasapi addon actually needs.
- **D-13** After stripping, **keep exactly one** conventional fallback `console.log` (the "unsupported on this build, using fallback" line). Strip everything else: `screenshareDebug.ts` module + IPC channels, `deliverySpike.ts`, the `[sync]` `syncCrumb`/`appendFileSync`, every `appendScreenshareDebug(...)`, per-chunk counts/PID dumps, and the CI temp `DIAGNOSTICS` + assertion.

**Verification**
- **D-14** Sequence = **verify rich → strip → re-confirm final** (full structured report on instrumented build; strip + fix fallback gap + move addon to optionalDependency; final viewer-side re-confirm on the stripped/dependency-packaged shape).
- **D-15** Exercise graceful-fallback via **`--no-wasapi`** on the dev box (Win10 19045) → stream falls through to `"loopback"`, viewer **hears audio not silence** (proves D-11), no crash, one fallback log line fires.
- **D-16** **Linux:** CI build + run, patchcord path byte-identical + the optionalDependency no-ops on Linux install/build. **macOS:** successful CI build + code-level proof the win32/load guards leave it untouched — **no Mac hardware, stated plainly, not faked.**

### Claude's Discretion (research resolves these)
- Exact location/structure of the verification-report artifact (e.g. `05-VERIFICATION.md`).
- Precise commit boundaries within "a few logical commits" (D-04).
- The exact mechanism by which the `github:` optionalDependency delivers its prebuilt `.node` into `node_modules` (committed binary vs release asset vs postinstall) — **research the patchcord precedent; the decision is "mirror patchcord's github-ref pattern."**

### Deferred Ideas (OUT OF SCOPE)
- win32-arm64 addon prebuild (fast-follow).
- Maintainer adopting the addon repo under `Milkshiift/` (ref flip).
- The `getPlatformString` fix + venbind-packaging generalization as their own small upstream PR (fixed this milestone, kept separate from the echo PR per D-12).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| UPST-02 | Echo fix is upstream-PR-ready: native ships via the prebuilt-`.node` pattern (separate addon repo publishing per-platform prebuilds, copied by `copyNativeModules()`); GoofCord-side diff is surgical; diagnostic instrumentation stripped before the PR | Q1 (delivery = committed prebuilt, mirrors patchcord); Q2 (windows-latest napi CI skeleton); Q3 (standalone-repo extraction checklist); Q5 (exact strip inventory + IPC regeneration); Q4 (clean-branch + logical-commit shaping). The surgical surface is enumerated in **The Final Surgical Diff Surface** below. |
</phase_requirements>

## Summary

Phase 5 ships **no new fix behaviour**. It (1) re-confirms the already-hardware-verified #46 echo fix on the *final stripped/dependency-packaged shape*, (2) strips diagnostic scaffolding, (3) fixes the ECHO-03 silent-fallback gap, (4) shapes a surgical upstream PR closing #46, and (5) shapes a publishable `thomas-quant/wasapi-loopback` repo with its own `windows-latest` CI.

The single highest-value research finding is a **trap in the strip**: two files are labeled `THROWAWAY` in their headers but are the **real, hardware-verified shipping code** — `src/windows/main/preload/wasapiTransport.ts` (the actual getDisplayMedia swap seam + MessagePort feeder) and `src/modules/native/wasapiLoopback.ts` (the main-process capture wrapper). A naive "delete everything marked THROWAWAY" deletes the working fix. Likewise `src/modules/screenshareDebug.ts` cannot be wholesale-deleted: it exports `shouldInjectWasapiTransport`, which is **load-bearing** for the real path (read by `preload.mts:54` to decide injection). The strip is therefore a *surgical relocate-then-delete*, not a file delete.

The second key finding resolves Claude's discretion item: **patchcord and venbind both deliver their prebuilt binaries by committing them into the repo/package** (patchcord: `dist/*` committed, `.gitignore` ignores only `/target`, no `postinstall`/`prepare`; venbind: `prebuilds/<plat>/*.node` committed, `scripts: {}`). So `thomas-quant/wasapi-loopback` should **commit the prebuilt `.node` at `prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node`** — which is *exactly the path `build.ts:207` already expects*. Its `windows-latest` CI builds the `.node` and commits it back. No postinstall, no release-asset fetch (cleanest, bun-friendly, and matches the locked "mirror patchcord" decision).

**Primary recommendation:** Plan the strip as a relocate-then-delete (preserve `shouldInjectWasapiTransport`, rename the two THROWAWAY-labeled-but-real files, strip only diagnostics); keep the load-bearing `copyNativeAddonsToOutDir` + `ts-out/native` runtime load (they are the permanent fix for Bun's Windows-host file-loader bug, NOT scaffolding); deliver the addon as a committed prebuilt via the github-ref optionalDependency; and shape the PR off `upstream/main` with a manual squash into ~4 logical commits (gsd-pr-branch filters `.planning/` but does **not** squash).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| WASAPI EXCLUDE-tree capture | Native addon (Rust/.node) | — | Clean-room crate; the only place that touches Win32 audio |
| Capture activation + PCM transport host | Main process (`wasapiLoopback.ts`) | — | Owns PID resolution, MessageChannelMain, before-quit teardown |
| PCM → MediaStream feeder + swap seam | Renderer main-world (preload-injected `wasapiTransport.ts`) | — | The swap MUST run in the page main world where getDisplayMedia/MSTG live; ships via preload because postVencord is downloaded from upstream (see Q6) |
| 3-way audio dispatch (linux/win32/fallback) | Main process (`screenshare.ts`) | — | Single additive gate; the no-regression guarantee |
| Prebuilt `.node` delivery + packaging | Build pipeline (`build.ts`, `electron-builder.ts`) + addon repo CI | optionalDependencies | github-ref install drops the committed prebuild into node_modules; build.ts copies it host-agnostically |
| Verification evidence | Manual (human viewer-side) + AI (reads `screenshare-debug.log` from WSL) | — | Streamer cannot self-verify (Electron mutes local echo); AI reads PID/activation/chunk lines |

## Resolved Open Questions

### Q1 — Prebuilt-`.node` delivery via `github:` optionalDependency (D-08) — RESOLVED

**Finding (HIGH — inspected node_modules on disk):** Both precedents deliver by **committing the prebuilt into the repo**; neither uses a postinstall/release-fetch.

| Dep | Consumption | Prebuilt location (on disk) | Lifecycle scripts | `files` |
|-----|-------------|-----------------------------|-------------------|---------|
| `patchcord` | `github:Milkshiift/patchcord` (`.bun-tag` = `Milkshiift-patchcord-f261163` → bun clones the git ref) | `dist/patchcord-linux-x64`, `dist/patchcord-linux-arm64` **committed** (`.gitignore` ignores only `/target`, `/.idea`) | none (`build`/`test` only — **no `postinstall`, no `prepare`**) | `["dist"]` |
| `venbind` | npm `0.1.7` | `prebuilds/<os>-<arch>/venbind-<os>-<arch>.node` committed in tarball | `scripts: {}` | (npm default) |

**Mechanism for `wasapi-loopback` → option (a): committed prebuilt `.node`.** When bun installs `github:thomas-quant/wasapi-loopback`, it clones the repo; the committed `prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node` lands at `node_modules/wasapi-loopback/prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node`.

**This is the exact path `build.ts` already expects** (`build/build.ts:207`):
```ts
{ name: "wasapi-loopback", envPath: process.env.GOOFCORD_WASAPI_LOOPBACK_PATH,
  prebuilds: [{ src: ["wasapi-loopback","prebuilds","windows-x86_64","wasapi-loopback-win32-x64.node"], platform: "win32", arch: "x64" }] }
```
Phase 5 only **drops the `envPath` line** (keep the `prebuilds` entry). `copyNativeModules()` then copies it to `assets/native/wasapi-loopback-win32-x64.node`; `copyNativeAddonsToOutDir()` copies that into `ts-out/native/`; `wasapiLoopback.ts` loads it at runtime from `app.getAppPath()/ts-out/native/...`.

**Bun + github-ref + optionalDependencies notes (HIGH):**
- bun resolves `github:` refs by cloning; committed files come along verbatim. `optionalDependencies` means a failed/absent install (e.g. private repo before it's pushed) does not fail the overall `bun install` — matching how `patchcord`/`venbind` no-op off-platform.
- **No `postinstall` should be added** — it would (a) diverge from the patchcord precedent, (b) require network/Rust at consumer install time, (c) trip bun's `trustedDependencies` gate. Committed-binary delivery sidesteps all three.
- The `os`/`cpu` fields venbind uses (`"os": ["win32"]`, `"cpu": ["x64"]`) make bun **skip installing the optionalDependency on non-Windows hosts entirely** — this is the cleanest way to satisfy D-16's "no-ops on the Linux install/build". **Add `"os": ["win32"], "cpu": ["x64"]` to the standalone package.json.**

**CRITICAL — do NOT strip the host-agnostic copy machinery.** `copyNativeAddonsToOutDir()` (`build.ts:261`) and the `ts-out/native` runtime load (`wasapiLoopback.ts:58`) exist because **Bun's `native-module:` `with { type: "file" }` loader silently emits ZERO `.node` when the build host is Windows** (the GoofCord Windows CI runner) — a separate bug from the glob bug fixed in `nativeImport.ts`. These are the permanent shipping mechanism, hardware-verified on CI `27044504559`. The `PHASE-5 REMOVAL` comment at `build.ts:260` is **misleading** — only the `envPath`/Rust-build scaffolding is removed; the ts-out/native copy + runtime load **stay**.

### Q2 — napi-rs prebuild CI on `windows-latest` (D-09) — RESOLVED

The current in-GoofCord-CI Rust build (`testBuild.yml:51-72`) is the empirically-proven recipe; the standalone repo's CI is the same build + a commit-back step. `@napi-rs/cli@3.7.0` is **current latest on npm** `[VERIFIED: npm view @napi-rs/cli version → 3.7.0]`; the crate deps (`napi 3.9.0`, `napi-derive 3.5.6`, `windows 0.62`, `windows-core 0.62`) are pinned in the in-repo `Cargo.toml` and proven building on `windows-latest`.

**napi build output naming:** `napi build` emits `<napi.name>.<target-short>.node`, e.g. `wasapi-loopback.win32-x64-msvc.node`. It must be **normalized** to `wasapi-loopback-win32-x64.node` (contains BOTH `win32` AND `x64` — required by the `nativeImport.ts` substring glob; Pitfall M3). The existing CI already does this normalization in pwsh.

**Recommended `.github/workflows/build.yml` skeleton for `thomas-quant/wasapi-loopback`:**
```yaml
name: Build prebuilt
on:
  workflow_dispatch
  # optionally: push: { paths: ["src/**","Cargo.*","build.rs","package.json"] }
permissions:
  contents: write   # to commit the prebuilt back
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: x86_64-pc-windows-msvc }
      - name: Build .node
        shell: pwsh
        run: |
          bun install
          bun x napi build --release --target x86_64-pc-windows-msvc
          $node = Get-ChildItem -Path . -Filter "*.node" -Recurse | Select-Object -First 1
          if (-not $node) { Write-Error "napi build produced no .node"; exit 1 }
          New-Item -ItemType Directory -Force -Path prebuilds/windows-x86_64 | Out-Null
          Copy-Item $node.FullName prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node -Force
      - name: Commit prebuilt
        shell: pwsh
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add -f prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node
          git diff --cached --quiet; if ($LASTEXITCODE -ne 0) { git commit -m "ci: prebuilt win32-x64"; git push }
```
Notes: `git add -f` is required because the current `.gitignore` ignores `*.node` (see Q3). Single target only (win32-x64) per D-10. The `napi prepublishOnly`/platform-subpackage convention (`napi create-npm-dirs`, `@napi-rs/cli artifacts`) is **NOT needed** — that path is for npm-published multi-platform packages with optionalDependency sub-packages; here delivery is a single committed prebuilt consumed by file-path, so the simple commit-back is correct and matches patchcord.

### Q3 — Standalone repo extraction checklist (D-09) — RESOLVED

Current `native/wasapi-loopback/` already has: `NOTICE` (MS MIT retained), `README.md` (clean-room provenance), `package.json` (napi config, `private: true`), `Cargo.toml` (`publish = false`), `Cargo.lock` (committed — good, reproducible builds), `build.rs`, `src/lib.rs` (569 lines; `#[napi] pub fn start(...)` @460, `#[napi] pub fn stop()` @532), `.gitignore`.

**Exact delta to publish:**

| Action | File | Detail |
|--------|------|--------|
| Drop `"private": true` | `package.json` | required to be usable/publishable |
| Add `"os": ["win32"], "cpu": ["x64"]` | `package.json` | makes bun skip the install off-Windows (D-16 Linux no-op) |
| Add `"files": ["prebuilds","src","Cargo.toml","Cargo.lock","build.rs","NOTICE","README.md","LICENSE"]` | `package.json` | ensures the committed prebuilt ships; (mostly relevant if ever npm-published) |
| Add `"repository"`, `"homepage"` → `thomas-quant/wasapi-loopback` | `package.json` | metadata |
| Add `LICENSE` | new | MIT, copyright the addon author; **keep `NOTICE` (MS MIT) alongside it** — the two coexist (ECHO-04 clean-room provenance) |
| Fix `.gitignore` | `.gitignore` | currently ignores `*.node`, `index.js`, `index.d.ts`, `/target`, `/node_modules`. **The committed prebuild `prebuilds/**/*.node` must be tracked** → either scope to `/*.node` (root only) or add `!prebuilds/` exception, OR rely on `git add -f` in CI (Q2). Recommend the `.gitignore` exception for clarity. |
| Add CI | `.github/workflows/build.yml` | Q2 skeleton |
| Update README | `README.md` | **drop the `GOOFCORD_WASAPI_LOOPBACK_PATH` consumption note (lines ~60-64)** and the "In-repo during Phase 4 … slated to move" Status section — those assume the in-tree env-override. Replace with "consume via `github:thomas-quant/wasapi-loopback` in `optionalDependencies`; CI builds + commits `prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node`." |
| `napi.name` | `package.json` | already `"wasapi-loopback"` — keep; produces the correctly-prefixed `.node` |

**`main` / `index.js`:** GoofCord never does `require("wasapi-loopback")` — it copies the raw `.node` **by file path** from `node_modules/.../prebuilds/...` and loads it via `createRequire`. So an `index.js` loader is **not required** for GoofCord's consumption. (napi-rs would generate one for ergonomic `require`; harmless to omit. If included for general publishability, ensure it's not the only entry — the file-copy path is what matters here.)

**Cargo.toml `publish = false`:** fine to leave (the crate is consumed as a `.node`, not from crates.io). The npm package is the distribution unit.

### Q4 — `gsd-pr-branch` clean-branch flow + logical-commit shaping (D-03/D-04) — RESOLVED

**Environment confirmed:** `upstream` remote exists (`https://github.com/Milkshiift/GoofCord.git`); `upstream/main` is fetched (`eebb15d`). Current branch `fix/windows-screenshare-cancel-restart` is **92 commits ahead of `upstream/main`** — the vast majority are `docs(...)`/`.planning/` commits; the code commits are interleaved (the trail: `3e732a9` feat real addon, `e66201c` feat packaging, `df35852`/`ffe49b9`/`6e44ebd` fixes, `afd7e30`/`8078b20` crate fixes, plus the 04-01/04-02 transport+crate commits and 04-03 integration).

**How `gsd-pr-branch` works (`workflows/pr-branch.md`):** It creates `${CURRENT_BRANCH}-pr` off `$TARGET` (default `main` — **pass `upstream/main` explicitly**), then **cherry-picks each code/structural commit** with `--no-commit`, `git rm -r --cached` the transient `.planning/` subdirs, and re-commits with `git commit -C` (preserving the original message). It **excludes** transient-`.planning/`-only commits and **includes** code + structural-planning (`STATE/ROADMAP/MILESTONES/PROJECT/REQUIREMENTS.md`, `milestones/**`).

**Two gaps the planner must close:**
1. **It does NOT squash.** `gsd-pr-branch` replays each included commit 1:1. D-04 ("a few logical commits") is therefore a **separate manual step** after — interactive rebase / reset-and-recommit. Given the messy in-flight trail (`221a696` "correct assertion path", `0946dc4` "temporary CI diagnostics", `2e545c6`/`86bb396` Windows-host glob fixes, `df35852`/`ffe49b9` packaging fixes), replaying them 1:1 would expose exactly the debugging churn D-04 wants collapsed.
2. **Structural-planning files would leak.** `gsd-pr-branch` deliberately *keeps* `STATE.md`/`ROADMAP.md`/`REQUIREMENTS.md`/`PROJECT.md` changes — but the **upstream echo PR must contain ZERO `.planning/` files** (PR #210's branch has 0; verified `git ls-tree`). So the default gsd-pr-branch behaviour is **wrong for an outward-facing upstream PR** here.

**PR #210 precedent (verified):** `pr/fix-screenshare-cancel-restart` is **3 clean commits off `upstream/main`, 0 `.planning/` files**, and is **not** named `*-pr` (the gsd-pr-branch convention) — i.e. it was **manually crafted/squashed**, not produced by a raw gsd-pr-branch run. The 3 commits map cleanly to logical units (`abe557d` fix uncaught error, `d58f729` consolidate finishRequest, `db016f7` Wayland portal cancel).

**Recommended flow for the echo PR (mirrors #210):**
1. `git checkout -b pr/fix-windows-screenshare-echo upstream/main`
2. Bring over **only the net code diff** for the echo fix (e.g. `git checkout fix/windows-screenshare-cancel-restart -- <code paths>` after the strip, or a squashed `git diff upstream/main..HEAD -- <code paths>` applied), excluding all `.planning/` and `ci-artifacts/`.
3. Stage into **~4 logical commits** (suggested boundaries below), each with an authentic message.
4. Hand to the user to push to `origin` (`thomas-quant/GoofCord`) and open against `Milkshiift/GoofCord` (D-02).

`gsd-pr-branch` is still useful as the **`.planning/`-filter mechanism** if the planner prefers its cherry-pick path-stripping, but it must be followed by a manual squash AND a manual `git rm` of the structural `.planning/` files it intentionally preserves. The simpler, lower-risk path for an upstream PR is the manual #210-style recraft.

**Suggested logical commit boundaries (D-04):**
| # | Commit | Touches |
|---|--------|---------|
| 1 | `feat(screenshare): native WASAPI exclude-tree audio capture (Windows #46 echo fix)` | the native main-process wrapper (`wasapiLoopback.ts`) + the preload-injected feeder/swap (`wasapiTransport.ts` renamed) + preload wiring |
| 2 | `feat(screenshare): additive 3-way audio gate (patchcord / win32 native / loopback)` | `screenshare.ts` gate + ECHO-03 fallback-gap fix + regenerated IPC (`gen.ts`/`types.ts`) |
| 3 | `build: package the wasapi-loopback prebuilt .node + optionalDependency` | `build.ts` (prebuild entry + host-agnostic ts-out/native copy), `electron-builder.ts` (asarUnpack, only the changes the addon needs), `package.json` optionalDependency |
| 4 | (separate, per D-12) `fix(build): resolve electron-builder platform via context.electronPlatformName` | the `getPlatformString` fix — **own commit, may become its own upstream PR** |

### Q5 — The strip surface: concrete file/line inventory (D-13, SC#2) — RESOLVED

> **THE TRAP (read first):** `wasapiTransport.ts` and `wasapiLoopback.ts` say `THROWAWAY` in their headers but are the **real, hardware-verified shipping code**. `screenshareDebug.ts` exports the **load-bearing** `shouldInjectWasapiTransport`. The strip is *relocate-then-delete*, not delete.

**DELETE entirely:**
- `src/windows/main/preload/deliverySpike.ts` — genuine Phase-3 throwaway (synthetic beep + getStats poll). Remove its import + `injectDeliverySpike()` call from `preload.mts` (lines 8-9, 23, 32-43).
- `src/modules/screenshareDebug.ts` — **but first relocate `shouldInjectWasapiTransport`** (see below). After relocation, delete the file; remove the 3 dead IPC getters.

**RELOCATE (before deleting screenshareDebug.ts):**
- `shouldInjectWasapiTransport<IPCOn>()` → move to `wasapiLoopback.ts` (natural home) as an `IPCOn` getter. **Simplify it:** drop the `isTransportSpikeEnabled()` OR-branch; it becomes `process.platform === "win32" && !process.argv.includes("--no-wasapi")`. Update the channel name reference in `preload.mts:54` and the bridge.

**STRIP diagnostics in-place (KEEP the file):**
- `src/modules/native/wasapiLoopback.ts` — remove: the entire `syncCrumb()` function + all **8** `[sync]`/`appendFileSync` references (lines ~64-83, 162, 191), all **13** `appendScreenshareDebug(...)` calls, the per-chunk `chunkCount`/`logCount` audit logging (lines ~106-108, 156, 177-183, 193, 235), the `wasapi smoke`/`wasapiPath resolved?` lines. Reframe the header comment (it's the real fix, not a spike). **KEEP** the load model, the MessageChannelMain transport, the PID resolution, the before-quit teardown.
- `src/windows/main/preload/wasapiTransport.ts` — remove the `appendScreenshareDebug`-backed `log()` helper + all its call sites, the `chunks/dropped/underrun` counters used only for logging. Rename the file + drop the `GOOFCORD_TRANSPORT_SPIKE` framing from the header. **KEEP** the MSTG feeder, the MessagePort receiver, the readiness handshake, and the swap seam (which gets the D-11 gate — see Q6).
- `src/windows/screenshare/screenshare.ts` — remove the import of `appendScreenshareDebug` (line 7) + the **3** call sites (lines 111, 114). **KEEP** the 3-way gate logic. Replace the `audio=none`/`audio=loopback` debug lines with **the single surviving `console.log`** (D-13): one conventional `pc`-prefixed line on the fallback branch, e.g.
  `console.log(pc.cyan("[Screenshare]"), "WASAPI process-loopback unsupported on this build, using loopback fallback");`
  matching patchcord/venbind's logging style. **This is the one line that SURVIVES.**

**`src/windows/main/preload/bridge.ts` (strip 3 fields, keep 1):**
- Remove `deliverySpike` (line 46) and `appendScreenshareDebug` (line 47) — diagnostic/spike.
- Remove `feedWasapiChunk` (line 53) — **dead code**: it registers `ipcRenderer.on("wasapi:pcm-chunk", …)` but the main process **never sends `wasapi:pcm-chunk`** (it only uses `port.postMessage` + `webContents.postMessage("wasapi:pcm-port")`). The structured-clone fallback was never wired. Confirm with `grep "wasapi:pcm-chunk"` → only the bridge registration; remove both the bridge field and the `__goofcordWasapiFeedChunk` fallback in `wasapiTransport.ts`.
- **KEEP `stopWasapiLoopback` (line 50)** — the real STREAM_CLOSE teardown path (its `THROWAWAY` comment is wrong).

**`preload.mts`:** remove the `deliverySpike` import (line 9), `injectDeliverySpike()` (lines 23, 35-43); keep `injectWasapiTransport()` but update its gate channel to the relocated `shouldInjectWasapiTransport` and drop the "spike" wording.

**Regenerate IPC (required):** after removing `appendScreenshareDebug`/`isDeliverySpikeEnabled`/`isTransportSpikeEnabled` and relocating `shouldInjectWasapiTransport`, run:
```bash
bun run build --onlyGenerators
```
This rewrites `src/ipc/gen.ts` + `src/ipc/types.ts` (currently reference all 4 `screenshareDebug:*` channels at gen.ts:13-14,35-38 and types.ts:12-13,31,47-49, plus `wasapiLoopback:stopWasapiLoopback` at gen.ts:50 which **stays**). Never hand-edit these files.

**CI (`testBuild.yml`):** remove the `Install Rust toolchain` + `Build wasapi-loopback addon` steps (lines 51-72) and the `GOOFCORD_WASAPI_LOOPBACK_PATH` env export — the addon now arrives via the optionalDependency. Remove the **`DIAGNOSTICS (remove once green)`** block (lines 90-101). Decide on the `Assert wasapi addon packaged` step: D-13 says strip "the temp `DIAGNOSTICS` + assertion" — but a **lean packaging assertion is genuinely useful** and is exactly the V4 safeguard PITFALLS recommends. Recommend: **keep a 2-line presence assertion** (ts-out + dist), strip only the verbose diagnostics dump. (Flag to discuss-phase if D-13 intends the full assertion removed.)

### Q6 — ECHO-03 silent-fallback gap fix (D-11) — RESOLVED (with a location correction)

**Location correction (HIGH — verified):** CONTEXT/ROADMAP name `screensharePatch.ts` as "the swap seam." On the **fork at runtime that is NOT where the swap executes.** `postVencord.js` (which bundles `screensharePatch.ts`) is **downloaded from upstream at runtime** — `settingsSchema.ts:217` defaults `PostVencord` to `https://raw.githubusercontent.com/Milkshiift/GoofCord/refs/heads/main/assets/postVencord.js`. Fork edits to `screensharePatch.ts` **silently do not run** (confirmed: this is why the team moved the swap into the preload-injected `wasapiTransport.ts:194-218`, which ships from `ts-out/**` and reliably reaches the artifact — see its own header note and project memory "Renderer bundles fetched from upstream, not packaged").

**The actual seam:** `wasapiTransport.ts` getDisplayMedia wrap (lines 194-218):
```ts
md.getDisplayMedia = async function (...) {
  const stream = await originalGDM(opts);
  // UNCONDITIONAL today:
  for (const t of stream.getAudioTracks()) { t.stop(); stream.removeTrack(t); }
  stream.addTrack(gen);   // gen = the MSTG track fed from the MessagePort
  ...
};
```

**The gap mechanism (precise):** On an unsupported Windows build (API absent, addon load fail, or activation returns `false`), `tryStartWasapiLoopback()` returns `false` in `screenshare.ts:101` → the `else` sets `result.audio = "loopback"` (Chromium DOES capture the whole-mix loopback into the stream). **But** `shouldInjectWasapiTransport` returned `true` (it only checks `win32 && !--no-wasapi`, it can't know activation failed), so the feeder was injected and its getDisplayMedia wrap **still removes the loopback track and swaps in `gen`** — and since no port was ever forwarded (activation failed), `gen` only ever receives the drain-loop's **silence fill** (`wasapiTransport.ts:121`). Result: **viewer hears silence instead of the loopback fallback.**

**The minimal additive guard:** gate the swap on the capture actually being active. The available signal in the main world is **`activePort` being set** — the main process forwards the MessagePort (`wasapiLoopback.ts:153` → `preload.mts:78` → main-world `goofcord:wasapi-pcm-port` handler, `wasapiTransport.ts:164-174`) **only after** `tryStartWasapiLoopback()` succeeds. So:
```ts
// in the getDisplayMedia wrap:
if (!activePort) {
  // capture inactive (unsupported build / --no-wasapi / activation failed):
  // leave the original "loopback" track in place → viewer hears audio (ECHO-03).
  return stream;   // no swap
}
// else: capture active → perform the existing remove+addTrack(gen) swap (happy path unchanged)
```
**Race consideration:** getDisplayMedia resolution and the port forward are near-concurrent (both triggered by `selectScreenshareSource`). The port forward is gated behind the `goofcord:wasapi-ready` handshake which fires at injection time (before any stream), and the main process posts the port synchronously inside the picker callback **before** the callback returns the stream config — so `activePort` is reliably set by the time `getDisplayMedia` resolves on the supported path. If the planner wants belt-and-suspenders, await a short bounded signal (e.g. a one-shot promise resolved on port arrival, `Promise.race` with a ~250 ms timeout) before deciding — but the simple `activePort` check matches the verified ordering. **Do not** gate on "≥1 chunk received" alone (first chunk can lag ~10-30 ms behind the swap decision).

**Why this doesn't regress the happy path:** on a supported build `activePort` is set → the swap runs exactly as today (hardware-verified). The guard only changes the unsupported/`--no-wasapi` path, which is precisely D-11/D-15's target.

### Q7 — Verification mechanics (D-14/D-15/D-16, SC#1) — RESOLVED

**`--no-wasapi` already exists** (no new flag needed): checked in `wasapiLoopback.ts:78,127` AND in `shouldInjectWasapiTransport` (`screenshareDebug.ts:36`). With `--no-wasapi`: `shouldInjectWasapiTransport` → false → **no injection → no swap → byte-identical to upstream "loopback"**. This already exercises the fallback *path* — but note it bypasses the swap entirely, so it does **not** by itself prove the D-11 guard (which fires when injection happens but activation fails). To truly exercise the D-11 guard on the 19045 dev box, the cleanest lever is: **run WITHOUT `--no-wasapi`** so injection happens, but the API is unavailable on 19045 → `tryStartWasapiLoopback` returns false → `activePort` never set → the new guard must keep the loopback track. (D-15 phrases it as `--no-wasapi`; flag this nuance — `--no-wasapi` proves "no-injection fallback", the un-flagged 19045 run proves "injected-but-unsupported guard". Both are worth capturing; the un-flagged 19045 run is the one that actually tests D-11.)

**AI-readable from `/mnt/c/Users/Christ/AppData/Roaming/goofcord/screenshare-debug.log` (WSL — confirmed readable, 27 KB, sampled):**
| Evidence | Log signature (sampled live) |
|----------|------------------------------|
| Addon loads under Electron N-API | `[sync] addon require ok` / `wasapi smoke: loaded under electron napi ok` |
| Activation succeeded | `[sync] start() returned ok=true` |
| Excluded root PID + Audio Service PID in subtree (ECHO-02) | `wasapi exclude-root=<PID> audioService=<PID> procs=…` |
| Native path taken (not fallback) | `screenshare … audio=none path=win32-wasapi-exclude-tree (addon sole capturer…)` |
| Chunks streaming | `wasapi activation=ok hop1=messageport hop2=port-forward chunks=N` |
| Transport handshake | `hop2=port-forward ready-handshake ok` |
| MSTG mechanism confirmed | `mechanism=MSTG success kind=audio` |

**NOT in the log → must be ADDED for the rich build (gap):** the **Windows build number**. `grep` confirms nothing logs `os.release()`/build number anywhere in the screenshare path (only `chromeSpoofer.ts` uses `process.getSystemVersion`). The UA line shows `Windows NT 10.0` but not `19045` vs `22631`. SC#1 + PITFALLS V1 **require the detected build number** in the report. **Recommendation:** in the D-14 *rich* (pre-strip) build, add one log line `os.release()` (Windows → `"10.0.<build>"`) at activation, capture it in the report, then strip it with everything else. Without this, "which build the native path activated on" is unprovable from the log.

**Human-supplied ground truth (cannot be AI-read):**
- (a) second-device viewer **hears** the shared desktop audio (capture works, not silence) — keep non-call audio playing (PITFALLS V3).
- (b) second-device viewer **does NOT** hear the call echoed (exclude works) — PITFALLS V2.
- D-15 fallback: viewer hears **audio not silence** on the unsupported/`--no-wasapi` run (proves D-11), no crash.

**Log-reading discipline (project memory):** the log is **append-only and cumulative across runs**; it contains historical Phase-3/Phase-4 spike lines (`path=win32-transport-spike`, `activation=spike-synthetic`) AND Phase-1 Bug-A markers (`[ScreenshareDebug][B]/[C]`). The Phase 3 & 4 spikes emit the **same** sweep tone. **Verify by signature + timeline (latest run), not recollection** — confirm the final re-confirm run shows `path=win32-wasapi-exclude-tree` (real), NOT `spike-synthetic`.

**Linux non-regression (D-16):** `process.platform === "win32"` gate at `screenshare.ts:101` makes the wasapi branch structurally unreachable on Linux → patchcord path byte-identical. The `"os": ["win32"]` optionalDependency field (Q1) makes bun **skip the addon install** on Linux entirely → no-op confirmed at install time. Proof shape: CI Linux build succeeds + a one-line `git diff upstream/main -- src/windows/screenshare/screenshare.ts` showing the linux branch unchanged + `bun install` log showing the optionalDependency skipped.

**macOS (D-16):** no hardware — state plainly. Code-level proof: the `win32` gate + the `"os": ["win32"]` install skip + the `mac` electron-builder `files` already exclude `*-win32-*.node` and `*-linux-*.node` (`electron-builder.ts:66`). Proof shape: successful macOS CI build (if added to the matrix) OR the code-gate citation, explicitly labeled "verified by code inspection, no Mac hardware — not faked."

## The Final Surgical Diff Surface (SC#3 target — what the upstream PR contains)

After the strip, the GoofCord-side diff should be **only**:
1. `src/modules/native/wasapiLoopback.ts` (new) — main-process capture wrapper + the relocated `shouldInjectWasapiTransport` getter.
2. `src/windows/main/preload/wasapiTransport.ts` (new, renamed from the spike name) — feeder + gated swap seam.
3. `src/windows/main/preload/preload.mts` — `injectWasapiTransport()` wiring (additive).
4. `src/windows/main/preload/bridge.ts` — `stopWasapiLoopback` field (additive).
5. `src/windows/screenshare/screenshare.ts` — the additive 3-way gate + the one surviving fallback `console.log`.
6. `src/ipc/gen.ts` + `src/ipc/types.ts` — regenerated (mark as generated in the PR description).
7. `build/build.ts` — the `wasapi-loopback` prebuild entry + `copyNativeAddonsToOutDir` (the host-agnostic copy the addon needs).
8. `electron-builder.ts` — `asarUnpack: ["**/*.node"]` (the addon needs it). **The `getPlatformString` fix is a SEPARATE commit (D-12), not in this surface.**
9. `package.json` — one `optionalDependencies` line.

**No `screensharePatch.ts` change** (downloaded from upstream; the swap lives in the preload-injected file). **No `screenshareDebug.ts`, no `deliverySpike.ts`** (deleted). **No `.planning/`, no `ci-artifacts/`.**

## Runtime State Inventory

> This phase relocates a native addon and strips a userData log path. Most categories are code-only.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `screenshare-debug.log` at `%APPDATA%/goofcord/` (and Linux `~/.config/goofcord/`) — written by the stripped diagnostics. After strip, **nothing writes it** so it stops growing, but the **existing file is not auto-deleted**. | Code: remove all writers (Q5). Optional: a one-line note in the verification report that the stale file can be deleted manually; no migration task needed (it's a dev artifact, never shipped). |
| Live service config | None. No external service stores the renamed/relocated strings. (The addon repo is new; nothing references it until the optionalDependency lands.) | None — verified by grep (no datastore/service keys). |
| OS-registered state | None — no Task Scheduler / launchd / pm2 registration involves these files. | None. |
| Secrets/env vars | `GOOFCORD_WASAPI_LOOPBACK_PATH` (build-time only) and the CI `GITHUB_ENV` export of it — **removed** with the in-CI Rust build (D-13). `GOOFCORD_TRANSPORT_SPIKE`/`GOOFCORD_DELIVERY_SPIKE` (argv/env gates) — removed with the spike code. None are persisted secrets. | Code: remove env reads + the CI export. No secret-store change. |
| Build artifacts / installed packages | `native/wasapi-loopback/target/` (Rust build output, gitignored — stale after extraction, harmless). The in-tree `native/wasapi-loopback/` directory itself becomes **redundant once the addon is an optionalDependency** — decide: leave it (harmless, documents provenance) or remove it from the GoofCord repo (cleaner diff). `assets/native/` + `ts-out/native/` are build-generated, regenerated each build. | Planner decision: keep vs remove `native/wasapi-loopback/` from GoofCord after extraction. Recommend **remove from the PR branch** (the addon now lives in its own repo) — but keep it on the fork's working branch until the standalone repo is pushed + the optionalDependency verified installing. |

**Canonical question — after every file is updated, what runtime state still has the old shape?** Only the stale `screenshare-debug.log` on the dev box (harmless, stops being written). No databases, no service config, no OS registrations. This is a code-and-packaging phase, not a data migration.

## Package Legitimacy Audit

GoofCord installs **no new registry package**; it adds **one self-authored github-ref optionalDependency** (`github:thomas-quant/wasapi-loopback`) — clean-room, MIT, authored in Phase 04. slopcheck/registry-squat checks do not apply to a first-party github ref. The standalone repo's own toolchain dep is `@napi-rs/cli` `[VERIFIED: npm view @napi-rs/cli version → 3.7.0, current latest]`; Rust crates (`napi 3.9.0`, `napi-derive 3.5.6`, `windows`/`windows-core 0.62`) are pinned in `Cargo.toml` + `Cargo.lock` and proven building on CI `27044504559`.

| Package | Registry | Disposition |
|---------|----------|-------------|
| `wasapi-loopback` | github:thomas-quant (first-party) | Approved — clean-room, MIT, self-authored |
| `@napi-rs/cli@3.7.0` | npm (addon-repo devDep only) | Approved — current latest, established napi-rs tooling |

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Prebuilt `.node` delivery | A custom postinstall downloader / release-asset fetcher | Commit the prebuilt into the repo (patchcord/venbind pattern) | No network/trust/Rust at consumer install; bun-friendly; matches the locked "mirror patchcord" decision |
| Clean PR branch | Manual `git filter-branch`/`rebase --onto` gymnastics | `gsd-pr-branch` for `.planning/` filtering + a manual #210-style squash | The cherry-pick filter is built; only the squash + structural-file removal are manual |
| Off-platform install skip | A custom platform guard in build.ts | `package.json` `"os"`/`"cpu"` fields | bun honors them natively (venbind precedent) — D-16 Linux/mac no-op for free |
| Windows-host `.node` emission | Re-debug Bun's file-loader | Keep the proven `copyNativeAddonsToOutDir` + `app.getAppPath()/ts-out/native` load | Already hardware-verified; the file-loader silently emits zero `.node` on Windows hosts |

## Common Pitfalls (phase-specific, extends PITFALLS.md)

### Pitfall 1: Deleting the working fix because its header says THROWAWAY
**What goes wrong:** `wasapiTransport.ts` + `wasapiLoopback.ts` are labeled THROWAWAY/spike but are the real shipping code. A bulk "remove spike files" deletes the hardware-verified #46 fix.
**How to avoid:** Strip is *relocate-then-delete*. Only `deliverySpike.ts` is genuinely throwaway. Re-read each file's body, not its header.
**Warning sign:** A strip commit that removes `wasapiTransport.ts` or the `getDisplayMedia` swap wrap.

### Pitfall 2: Deleting screenshareDebug.ts wholesale → losing `shouldInjectWasapiTransport`
**What goes wrong:** That getter gates the real injection (`preload.mts:54`). Deleting the file silently disables the fix (no injection → swap never runs → echo returns).
**How to avoid:** Relocate `shouldInjectWasapiTransport` (simplified, no spike OR) into `wasapiLoopback.ts` FIRST, regenerate IPC, then delete `screenshareDebug.ts`.

### Pitfall 3: Stripping the load-bearing build machinery as "scaffolding"
**What goes wrong:** The `build.ts` `PHASE-5 REMOVAL` comments over-claim — removing `copyNativeAddonsToOutDir` / the ts-out/native runtime load breaks the Windows-host build (zero `.node` shipped → silent loopback fallback → looks like the fix regressed).
**How to avoid:** Remove only the `GOOFCORD_WASAPI_LOOPBACK_PATH` env branch + the in-CI Rust build. Keep the host-agnostic copy + runtime load.

### Pitfall 4: Replaying the 92-commit trail into the PR (D-04 violation)
**What goes wrong:** `gsd-pr-branch` cherry-picks 1:1 (no squash) and *keeps* structural `.planning/` files — the PR would show the debugging churn + `.planning/`.
**How to avoid:** Manual #210-style recraft: branch off `upstream/main`, apply the net code diff, stage ~4 logical commits, zero `.planning/`.

### Pitfall 5: Reporting "verified" without the build number / from the streamer side / on idle audio
**What goes wrong:** PITFALLS V1/V2/V3 — a pass that doesn't name the Windows build + branch taken, or is observed on the streamer machine, or with nothing playing, is not a pass.
**How to avoid:** Add the build-number log line for the rich build; viewer-side second device; non-call audio playing throughout.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `upstream` remote + `upstream/main` | PR branch off upstream (D-03) | ✓ | `eebb15d` fetched | — |
| `bun` | build, IPC regen, install | ✓ (project runtime) | latest (CI) | — |
| WSL read of `%APPDATA%/goofcord/screenshare-debug.log` | AI-side verification | ✓ | `/mnt/c/Users/Christ/...` (27 KB present) | human reads on-box |
| Windows ≥ 19041 box + second device | viewer-side ECHO-01 re-confirm | ✓ (dev box 19045 + friend's device, per Phase 04) | — | none — manual, required |
| `@napi-rs/cli` 3.7.0 + Rust msvc toolchain | addon-repo CI (not GoofCord CI) | ✓ on windows-latest (proven CI 27044504559) | 3.7.0 | — |
| GitHub repo `thomas-quant/wasapi-loopback` | optionalDependency target (D-09) | ✗ (user must create + push) | — | **blocks** the final dependency-packaged re-confirm until pushed |

**Missing dependency that gates the final step:** the standalone repo must be **created + pushed by the user (D-09) with its CI prebuild committed** before the D-14 *final* re-confirm can build against the real `optionalDependencies` ref. Sequence the plan so the strip + standalone-repo prep happen first, then the user-checkpoint (create/push repo), then the final re-confirm.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The ECHO-03 guard keying on `activePort` is sufficient given the verified port-forward-before-getDisplayMedia-resolves ordering | Q6 | If the race differs on some build, an unsupported path could still briefly swap silence; mitigate with the bounded-promise fallback noted in Q6 |
| A2 | D-13's "strip the assertion" allows keeping a lean 2-line packaging presence check (the V4 safeguard) | Q5 / CI | If D-13 means remove the assertion entirely, a packaging regression becomes silent again — confirm in discuss-phase |
| A3 | `feedWasapiChunk` / `__goofcordWasapiFeedChunk` is dead (main never sends `wasapi:pcm-chunk`) and can be removed | Q5 | grep-confirmed in this session; low risk |
| A4 | Committing the prebuilt `.node` into the addon repo (vs npm-published platform sub-packages) is the intended "mirror patchcord" reading of D-08 | Q1 | Low — patchcord/venbind both commit binaries; matches the locked decision verbatim |
| A5 | `native/wasapi-loopback/` should be removed from the GoofCord PR branch once extracted (kept on the working branch until the repo is pushed) | Runtime State Inventory | If the maintainer prefers the crate vendored in-tree, keep it — planner/discuss call |

## Open Questions

1. **PR swap-seam home for the long term.** The fork runs the swap from the preload-injected `wasapiTransport.ts` because it downloads upstream's `postVencord.js`. Once *merged upstream*, the maintainer rebuilds `postVencord.js`, so a `screensharePatch.ts` home would also ship. Submit the **verified** preload-injected version (it's what was hardware-tested); note in the PR that consolidating into `screensharePatch.ts` is a possible review-time refactor. **Recommendation:** ship verified-as-is; don't refactor unverified code into the PR.
2. **Build-number logging for SC#1.** Not currently logged anywhere. Add `os.release()` to the rich build, capture, then strip. **Recommendation:** include this as a small task in the rich-verification plan.
3. **Verification-report artifact location.** Claude's discretion. **Recommendation:** `.planning/phases/05-verification-upstream-pr/05-VERIFICATION.md` (transient `.planning/`, excluded from the PR branch automatically) — the report is project evidence, not PR content.

## Sources

### Primary (HIGH confidence — direct repo/runtime inspection this session)
- `package.json`, `build/build.ts`, `build/nativeImport.ts`, `electron-builder.ts` — packaging pipeline, prebuild entry, host-agnostic copy.
- `src/modules/native/wasapiLoopback.ts`, `wasapiTransport.ts`, `deliverySpike.ts`, `bridge.ts`, `preload.mts`, `screenshare.ts`, `screensharePatch.ts`, `screenshareDebug.ts` — strip surface + seam locations.
- `src/ipc/gen.ts`, `src/ipc/types.ts` — IPC channels to regenerate.
- `src/settingsSchema.ts:216-223` — postVencord downloaded from upstream (the Q6 location correction).
- `node_modules/patchcord/` (`.gitignore`, `.bun-tag`, `package.json`, `dist/`), `node_modules/venbind/` (`package.json`, `prebuilds/`) — the delivery-mechanism ground truth.
- `native/wasapi-loopback/` (`package.json`, `Cargo.toml`, `.gitignore`, `NOTICE`, `README.md`, `src/lib.rs`) — extraction delta.
- `git` — `upstream/main` fetched (`eebb15d`); `pr/fix-screenshare-cancel-restart` = 3 clean commits, 0 `.planning/`; current branch 92 ahead.
- `/mnt/c/Users/Christ/AppData/Roaming/goofcord/screenshare-debug.log` — live AI-readable evidence signatures.
- `.planning/config.json` — `nyquist_validation:false`, `security_enforcement:false` (Validation Architecture + Security Domain sections correctly omitted).
- `.github/workflows/testBuild.yml`, Phase 04 `.../04-03-SUMMARY.md`, `.planning/research/PITFALLS.md`, CONTEXT/ROADMAP/REQUIREMENTS/STATE.
- `npm view @napi-rs/cli version` → 3.7.0 (current latest).

### Secondary (MEDIUM)
- napi-rs build-output naming (`<name>.<target>.node`) — inferred from the proven CI normalization step + napi-rs conventions; the CI normalizes regardless, so exact naming is non-load-bearing.

## Metadata

**Confidence breakdown:**
- Delivery mechanism (Q1): HIGH — both precedents inspected on disk; build.ts path already matches.
- Strip inventory (Q5): HIGH — every file + call-site count verified by read/grep this session.
- Seam location / ECHO-03 fix (Q6): HIGH — confirmed postVencord is downloaded; seam is in wasapiTransport.ts.
- PR-branch flow (Q4): HIGH — gsd-pr-branch read; #210 precedent + upstream remote verified.
- CI skeleton (Q2) / extraction (Q3): HIGH — based on the proven CI + on-disk crate.
- Verification split (Q7): HIGH — log sampled live; build-number gap confirmed by grep.

**Research date:** 2026-06-06
**Valid until:** ~2026-07-06 (stable; re-check `@napi-rs/cli` latest and `upstream/main` drift before the final PR push)

## RESEARCH COMPLETE
