# Phase 5: Verification + Upstream PR - Pattern Map

**Mapped:** 2026-06-06
**Files analyzed:** 9 create/modify targets (+ 7 strip-only seams, no analogs needed)
**Analogs found:** 9 / 9

> Scope note: this phase is mostly (a) stripping diagnostics, (b) one additive ECHO-03 guard, and
> (c) extracting a NEW standalone addon repo. Analog mapping is concentrated on the net-new addon-repo
> files and the two small additive code changes. The strip/delete work (file removals, call-site
> deletions) is enumerated in 05-RESEARCH.md Q5 and needs NO analog — those seams are listed at the
> bottom under "Strip Seams (No Analog Needed)".

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `wasapi-loopback/.github/workflows/build.yml` (new repo) | config (CI) | batch | `.github/workflows/testBuild.yml` lines 29-72 | exact (same recipe, already proven) |
| `wasapi-loopback/package.json` (new repo) | config | — | `native/wasapi-loopback/package.json` + `node_modules/venbind/package.json` + `node_modules/patchcord/package.json` | exact (de-private the in-tree one; merge venbind os/cpu) |
| `wasapi-loopback/LICENSE` (new repo) | config | — | `native/wasapi-loopback/NOTICE` lines 18-38 (MIT body) | role-match (MIT body present; new copyright holder) |
| `wasapi-loopback/.gitignore` (new repo) | config | — | `native/wasapi-loopback/.gitignore` | exact (one edit: un-ignore `prebuilds/`) |
| `wasapi-loopback/README.md` (new repo) | config (doc) | — | `native/wasapi-loopback/README.md` | exact (edit Building/Status sections) |
| `package.json` (root, +1 optionalDep line) | config | — | `package.json` lines 49-52 (patchcord/venbind entries) | exact |
| `build/build.ts` (drop `envPath`, keep prebuild) | config (build) | file-I/O | `build/build.ts` lines 184-193 (venbind prebuild-only entry) | exact |
| `src/windows/main/preload/wasapiTransport.ts` (ECHO-03 guard, lines 194-218) | preload feeder | streaming | `wasapiLoopback.ts:127` + `wasapiTransport.ts:55-57` (early-return guards) | role-match (additive guard idiom) |
| `src/windows/screenshare/screenshare.ts` (one surviving `console.log`) | controller (IPC handler) | request-response | `src/modules/native/patchcord.ts` (module-prefixed `pc` logging) | exact |

---

## Pattern Assignments

### `wasapi-loopback/.github/workflows/build.yml` (config/CI, batch) — NEW REPO

**Analog:** `.github/workflows/testBuild.yml` (the steps that build the addon on the windows-latest runner are the empirically-proven recipe; the standalone CI = the same build + a commit-back step).

**Header + permissions** (testBuild.yml lines 1-7) — the standalone repo needs `contents: write` to commit the prebuilt back:
```yaml
name: Test build
on:
  workflow_dispatch
permissions:
  contents: write
```

**setup-bun step to copy verbatim** (testBuild.yml lines 29-31):
```yaml
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
```

**Rust toolchain + napi build + normalize — the load-bearing block to lift** (testBuild.yml lines 51-72). Note the pwsh normalization that produces the exact glob-matched name `wasapi-loopback-win32-x64.node` (contains BOTH `win32` AND `x64` — required by `nativeImport.ts`'s substring glob; Pitfall M3):
```yaml
      - name: Install Rust toolchain (wasapi-loopback addon)
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: x86_64-pc-windows-msvc

      - name: Build wasapi-loopback addon (.node)
        shell: pwsh
        run: |
          bun add -d "@napi-rs/cli@3.7.0"
          bun x napi build --release --target x86_64-pc-windows-msvc
          $node = Get-ChildItem -Path . -Filter "*.node" -Recurse | Select-Object -First 1
          if (-not $node) { Write-Error "napi build produced no .node"; exit 1 }
          $dest = Join-Path $PWD "wasapi-loopback-win32-x64.node"
          Copy-Item $node.FullName $dest -Force
```

**What CHANGES vs. the analog (the addon CI is the build + a commit-back, not an env export):**
- Drop the `matrix`/`if: matrix.name == 'win'` scaffolding — the addon repo is single-target `windows-latest` (D-10).
- Drop the GoofCord build/package steps (`bun run build`, `electron-builder`, upload-artifact) — irrelevant to the addon.
- Replace the `GITHUB_ENV` export line (testBuild.yml:72) with: write to `prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node` (the exact path `build.ts:207` expects) + a `git add -f … && git commit … && git push` commit-back step.
- The `git add -f` is REQUIRED because `.gitignore` ignores `*.node` (see `.gitignore` analog below). Full skeleton is in 05-RESEARCH.md Q2 lines 109-143.

---

### `wasapi-loopback/package.json` (config) — NEW REPO

**Primary analog:** `native/wasapi-loopback/package.json` (the current in-tree one — copy as the base):
```json
{
  "name": "wasapi-loopback",
  "version": "0.1.0",
  "description": "Clean-room WASAPI process-tree EXCLUDE loopback capture (.node addon, Windows only).",
  "license": "MIT",
  "private": true,
  "napi": { "name": "wasapi-loopback" },
  "scripts": { "build": "napi build --release --target x86_64-pc-windows-msvc" },
  "devDependencies": { "@napi-rs/cli": "3.7.0" },
  "engines": { "node": ">= 20" }
}
```

**Off-platform-skip pattern — copy `os`/`cpu` from `node_modules/venbind/package.json`** (this is what makes bun skip the install on non-Windows hosts, satisfying D-16 Linux/mac no-op for free):
```json
  "cpu": ["x64", "arm64"],
  "os": ["linux", "win32"],
```
For wasapi (win32-x64 only per D-10) use: `"os": ["win32"], "cpu": ["x64"]`.

**`files` pattern — copy the shape from `node_modules/patchcord/package.json`** (ensures the committed prebuilt ships if ever npm-published):
```json
  "files": ["dist"]
```
For wasapi use: `"files": ["prebuilds","src","Cargo.toml","Cargo.lock","build.rs","NOTICE","README.md","LICENSE"]`.

**Exact deltas to apply (05-RESEARCH.md Q3 lines 149-161):**
- DROP `"private": true` (required to be installable as a github ref).
- ADD `"os": ["win32"], "cpu": ["x64"]`.
- ADD the `"files"` array above.
- ADD `"repository"` + `"homepage"` → `thomas-quant/wasapi-loopback`.
- KEEP `napi.name = "wasapi-loopback"` (produces the correctly-prefixed `.node`).
- Do NOT add a `postinstall`/`prepare` (patchcord/venbind have none — `node_modules/patchcord/package.json` has only `build`/`test` scripts; venbind's `scripts: {}`). Delivery is a committed binary, not an install-time build.

---

### `wasapi-loopback/LICENSE` (config) — NEW REPO

**Analog:** `native/wasapi-loopback/NOTICE` lines 18-38 — the MIT license body text is already present verbatim there (Microsoft's copy). Reuse the SAME MIT body but with the addon author's copyright line, and KEEP `NOTICE` (MS MIT) alongside it — the two coexist for clean-room provenance (ECHO-04).

**MIT body to reuse** (NOTICE lines 18-38), substituting the copyright holder:
```
MIT License

Copyright (c) <addon author / year>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
... (rest of the standard MIT text, identical to NOTICE lines 22-38) ...
```

**Anti-analog — do NOT copy the root `LICENSE`:** the GoofCord root `/LICENSE` is **OSL-3.0** (`Open Software License ("OSL") v. 3.0`), not MIT. The addon stays MIT in its own repo; the OSL-3.0/MIT boundary is intentional (D-05 clean-room, RESEARCH Package Legitimacy Audit). Use the NOTICE MIT body, not the root LICENSE.

---

### `wasapi-loopback/.gitignore` (config) — NEW REPO

**Analog:** `native/wasapi-loopback/.gitignore` (copy as base):
```gitignore
/target/
*.node
index.js
index.d.ts
/node_modules/
```

**Required edit (05-RESEARCH.md Q3 line 158):** the committed prebuilt `prebuilds/**/*.node` must be TRACKED. Either scope the `*.node` ignore to root only (`/*.node`) OR add an un-ignore exception:
```gitignore
*.node
!prebuilds/**/*.node
```
(The CI's `git add -f` is the belt-and-suspenders backstop; the exception is for clarity.)

---

### `wasapi-loopback/README.md` (config/doc) — NEW REPO

**Analog:** `native/wasapi-loopback/README.md` (copy verbatim, then edit two sections per 05-RESEARCH.md Q3 line 160):
- **Building section (README.md lines 51-64):** DROP the `GOOFCORD_WASAPI_LOOPBACK_PATH` env-override consumption note (lines ~60-64) — that assumed the in-tree env override.
- **Status section (README.md lines 66-70):** replace "In-repo during Phase 4 … slated to move" with: consume via `github:thomas-quant/wasapi-loopback` in `optionalDependencies`; CI builds + commits `prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node`.
- KEEP the Clean-room provenance section (lines 13-19) verbatim — it's load-bearing for ECHO-04.

---

### `package.json` (root, +1 `optionalDependencies` line) (config)

**Analog:** `package.json` lines 49-52 — the existing optionalDependencies block:
```json
	"optionalDependencies": {
		"patchcord": "github:Milkshiift/patchcord",
		"venbind": "0.1.7"
	},
```

**Change:** add ONE line mirroring the `patchcord` github-ref shape (D-08):
```json
	"optionalDependencies": {
		"patchcord": "github:Milkshiift/patchcord",
		"venbind": "0.1.7",
		"wasapi-loopback": "github:thomas-quant/wasapi-loopback"
	},
```
Bun resolves `github:` by cloning the ref; the committed `prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node` lands at `node_modules/wasapi-loopback/prebuilds/windows-x86_64/…` — the exact path `build.ts:207` already reads. The `"os": ["win32"]` field in the addon's package.json makes bun skip it entirely on Linux/mac (D-16 no-op).

---

### `build/build.ts` (config/build, file-I/O) — drop `envPath`, keep `prebuilds`

**Analog:** the `venbind` entry at `build/build.ts` lines 184-193 — a prebuild-only module entry (note: venbind ALSO carries an `envPath`, but the *shape to converge on* is "name + prebuilds[], copied from node_modules"). The wasapi entry already has the right `prebuilds` shape at lines 204-208:
```ts
{
  name: "wasapi-loopback",
  envPath: process.env.GOOFCORD_WASAPI_LOOPBACK_PATH,   // ← Phase 5: DELETE this line
  prebuilds: [{ src: ["wasapi-loopback", "prebuilds", "windows-x86_64", "wasapi-loopback-win32-x64.node"], platform: "win32", arch: "x64" }],
},
```

**Change:** delete only the `envPath:` line (line 206). The `prebuilds` entry stays — `copyNativeModules()` then resolves `node_modules/wasapi-loopback/prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node` via the same `mod.prebuilds.map(...)` path used for patchcord/venbind (build.ts lines 237-243).

**CRITICAL — do NOT strip these despite the misleading "PHASE-5 REMOVAL" comments** (Pitfall 3, 05-RESEARCH.md Q1 lines 101 / 345-347):
- `copyNativeAddonsToOutDir()` (build.ts lines 261-282) — the host-agnostic `ts-out/native` copy. KEEP. Bun's `native-module:` file-loader emits ZERO `.node` on a Windows build host; this fs copy is the permanent shipping mechanism.
- The matching runtime load `wasapiLoopback.ts:58` (`app.getAppPath()/ts-out/native/...`). KEEP.
- Reword the `PHASE-5 REMOVAL` comments (build.ts:195-196, 260) to "Phase 5: env override removed; prebuild-only" — only the `envPath`/Rust-build scaffolding is removed.

---

### `src/windows/main/preload/wasapiTransport.ts` (preload feeder, streaming) — ECHO-03 additive guard

**Seam (verified, NOT `screensharePatch.ts`):** the `getDisplayMedia` wrap at **lines 194-218**. The unconditional track swap (lines 200-204) is the gap: on an unsupported build the loopback track is removed and `gen` (only ever fed silence) is swapped in → viewer hears silence instead of the loopback fallback (05-RESEARCH.md Q6 lines 243).

**Available signal:** `activePort` (declared `wasapiTransport.ts:88`, set only on real port arrival at line 168). It is set only after `tryStartWasapiLoopback()` succeeds and the main process forwards the port.

**Analog for the additive early-return guard idiom** — the codebase consistently uses a top-of-block guard that bails to the unchanged path:
- `wasapiLoopback.ts:127` — `if (process.platform !== "win32" || process.argv.includes("--no-wasapi")) return false;`
- `wasapiLoopback.ts:78` — `if (addon !== undefined || addonLoadAttempted || … || !wasapiPathExists) return addon;`
- `wasapiTransport.ts:55-57` — the existing idempotence early-return inside this same function (`if ((globalThis…)[flag]) return; … if (!bridge) return;`).

**Pattern to apply** (additive guard at the top of the swap `try`, before the remove/addTrack at lines 200-204):
```ts
md.getDisplayMedia = async function (this: MediaDevices, opts?: DisplayMediaStreamOptions): Promise<MediaStream> {
  const stream = await originalGDM(opts);
  // ECHO-03 (D-11): only swap when capture is actually active. activePort is set only after
  // tryStartWasapiLoopback() succeeded and the main process forwarded the port. If it's unset
  // (unsupported build / --no-wasapi / activation returned false), leave the original "loopback"
  // track in place so the viewer hears audio instead of the silence-filled gen track.
  if (!activePort) return stream;   // ← no swap; happy path below is unchanged
  try {
    for (const t of stream.getAudioTracks()) { t.stop(); stream.removeTrack(t); }
    stream.addTrack(gen as MediaStreamTrack);
    ...
  }
};
```
**Why it doesn't regress the happy path:** on a supported build `activePort` is set before `getDisplayMedia` resolves (port forwarded synchronously inside the picker callback, gated behind the `goofcord:wasapi-ready` handshake) → the existing swap runs exactly as hardware-verified. Guard only changes the unsupported path (D-11/D-15 target). Optional belt-and-suspenders bounded `Promise.race(~250ms)` noted in 05-RESEARCH.md Q6 lines 255 — not required for the verified ordering.

> This file is also renamed + stripped (drop the `appendScreenshareDebug`-backed `log()` helper at lines 45-51 and its call sites, the `chunks/dropped/underrun` counters, and the `GOOFCORD_TRANSPORT_SPIKE` header framing). KEEP the MSTG feeder, the MessagePort receiver (lines 164-174), the readiness handshake (line 224), and the swap seam. See Strip Seams below.

---

### `src/windows/screenshare/screenshare.ts` (controller/IPC handler, request-response) — the ONE surviving log

**Seam:** the 3-way gate at lines 94-116. After stripping the 2 `appendScreenshareDebug` call sites (lines 111, 114) and the import (line 7), exactly ONE conventional `console.log` survives on the fallback branch (D-13).

**Analog — module-prefixed `pc` logging, the established convention** (`src/modules/native/patchcord.ts`):
```ts
// patchcord.ts:58
console.log(pc.cyan("[Screenshare]"), pc.dim("System audio graph changed, refreshing routes..."));
// patchcord.ts:136
console.log(pc.cyan("[Screenshare]"), "Starting Patchcord...");
```
Reinforced by `venbind.ts:25` (`console.log(pc.green("[Venbind]"), "Loaded venbind")`) and by this file's sibling `wasapiLoopback.ts:37` which already defines `const LOG_PREFIX = pc.cyan("[Screenshare]");` and logs via `console.log(LOG_PREFIX, …)` (lines 202, 236).

**The one surviving line** (05-RESEARCH.md Q5 lines 209-211) — `pc.cyan("[Screenshare]")` prefix to match patchcord/venbind, placed on the `else`/fallback branch (replacing the line-114 debug call):
```ts
console.log(pc.cyan("[Screenshare]"), "WASAPI process-loopback unsupported on this build, using loopback fallback");
```
Requires importing `pc from "picocolors"` (this file does not currently import it; patchcord.ts:4 / wasapiLoopback.ts:31 show the import line). The `path=win32-wasapi-exclude-tree` debug line at 111 is deleted with no replacement (happy path stays quiet).

---

## Shared Patterns

### Native-addon delivery (committed prebuilt via github-ref optionalDependency)
**Source:** `node_modules/patchcord/` (`dist/patchcord-linux-x64` committed, `files: ["dist"]`, no postinstall) + `node_modules/venbind/prebuilds/<plat>/venbind-<plat>.node` committed.
**Apply to:** the new addon repo + the root `optionalDependencies` line + `build.ts`.
Both precedents commit the binary into the repo/package — NO postinstall, NO release-asset fetch. `wasapi-loopback` mirrors this: commit `prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node`, consume by file-copy in `copyNativeModules()`. (05-RESEARCH.md Q1.)

### Off-platform install/run skip
**Source:** `node_modules/venbind/package.json` (`"os": ["linux","win32"], "cpu": ["x64","arm64"]`) + the `process.platform === "win32"` runtime gate (`screenshare.ts:101`, `wasapiLoopback.ts:127`).
**Apply to:** the addon `package.json` (`"os": ["win32"], "cpu": ["x64"]`) — bun honors these natively (D-16 Linux/mac no-op). The runtime gate is the structural non-regression guarantee; verify it stays byte-identical.

### Module-prefixed `pc` logging
**Source:** `src/modules/native/patchcord.ts` (`pc.cyan("[Screenshare]")`), `venbind.ts:25` (`pc.green("[Venbind]")`).
**Apply to:** the one surviving fallback `console.log` (D-13). Match this exactly — NOT the `screenshare-debug.log` append discipline being stripped.

### Idempotent before-quit teardown with bounded race
**Source:** `patchcord.ts:168-184` (`Promise.race([pb.dispose(), timeout])`).
**Apply to:** already mirrored in `wasapiLoopback.ts:241-248` — preserve it through the strip (it is the real teardown, not scaffolding).

### Native-load guard (`--no-X` + load-once + null-on-failure)
**Source:** `venbind.ts:19-31` (`obtainVenbind`: `--no-venbind` guard + `venbindLoadAttempted` + try/`require`/null-on-catch).
**Apply to:** already mirrored in `wasapiLoopback.ts:77-98` (`obtainWasapiLoopback`) — preserve through the strip; only remove the `syncCrumb`/`appendScreenshareDebug` diagnostic lines inside it.

---

## Strip Seams (No Analog Needed)

These are deletions/relocations fully inventoried in 05-RESEARCH.md Q5 — listed here so the planner has the seam map in one place. No analog applies; the work is removal.

| Action | File / Lines | Note |
|--------|--------------|------|
| DELETE file | `src/windows/main/preload/deliverySpike.ts` | genuine Phase-3 throwaway |
| DELETE file (AFTER relocate) | `src/modules/screenshareDebug.ts` | relocate `shouldInjectWasapiTransport` first |
| RELOCATE | `shouldInjectWasapiTransport` (screenshareDebug.ts:35-38) → `wasapiLoopback.ts` as `IPCOn` getter; simplify to `process.platform === "win32" && !process.argv.includes("--no-wasapi")` (drop the `isTransportSpikeEnabled()` OR-branch) | load-bearing — read by `preload.mts:54` |
| STRIP in-place (keep file) | `wasapiLoopback.ts` — `syncCrumb()` (64-75) + all `[sync]`/`appendFileSync`, all `appendScreenshareDebug(...)` calls, `chunkCount`/`logCount` audit logging (106-108,156,177-183,193,235), `wasapi smoke`/`wasapiPath resolved?` lines, the `appendScreenshareDebug` import (28). KEEP load model, MessageChannelMain transport, PID resolution, before-quit teardown. | "THROWAWAY" header is WRONG — real shipping code |
| STRIP in-place (keep file) | `wasapiTransport.ts` — `log()` helper (45-51) + call sites, `chunks/dropped/underrun` counters, `__goofcordWasapiFeedChunk` fallback (180-182), `appendScreenshareDebug` field from `TransportBridge` (40). Rename file, drop spike header. KEEP feeder/receiver/handshake/swap-seam (+ add the D-11 guard above). | "THROWAWAY" header is WRONG |
| STRIP | `screenshare.ts` — `appendScreenshareDebug` import (7) + 2 call sites (111,114); replace 114 with the one surviving log. KEEP the 3-way gate. | add `pc` import |
| STRIP fields | `bridge.ts` — remove `deliverySpike` (46), `appendScreenshareDebug` (47), `feedWasapiChunk` (53, dead — main never sends `wasapi:pcm-chunk`). KEEP `stopWasapiLoopback` (50). | its `THROWAWAY` comment is wrong |
| STRIP | `preload.mts` — remove `deliverySpike` import (9) + `injectDeliverySpike()` (23,35-43). KEEP `injectWasapiTransport()`; update its gate channel to the relocated `shouldInjectWasapiTransport`. | — |
| REGEN | `bun run build --onlyGenerators` → rewrites `src/ipc/gen.ts` + `src/ipc/types.ts` | removes the 3 `screenshareDebug:*` getters; never hand-edit |
| STRIP | `.github/workflows/testBuild.yml` — remove Rust toolchain + addon build steps (51-72) + `GOOFCORD_WASAPI_LOOPBACK_PATH` export; remove the `DIAGNOSTICS` dump (90-101). KEEP a lean 2-line presence assertion (research A2 — flag if D-13 means full removal). | addon now arrives via optionalDependency |

---

## No Analog Found

None. Every create/modify target has a strong in-codebase or on-disk-dependency analog. (The addon repo's MIT `LICENSE` is a partial match — the MIT *body* exists in `native/wasapi-loopback/NOTICE` but with Microsoft's copyright; the addon author's copyright line is net-new.)

---

## Metadata

**Analog search scope:** `.github/workflows/`, `native/wasapi-loopback/`, `src/modules/native/`, `src/windows/main/preload/`, `src/windows/screenshare/`, `build/`, root `package.json` + `LICENSE`, on-disk `node_modules/{patchcord,venbind}/`.
**Files scanned:** 14 (5 source/preload, 1 build, 1 CI, 4 addon-repo source, root package.json+LICENSE, 2 dependency package.json + prebuild layouts).
**Pattern extraction date:** 2026-06-06
</content>
</invoke>
