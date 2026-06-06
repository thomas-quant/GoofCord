# Phase 5: Verification + Upstream PR - Context

**Gathered:** 2026-06-06
**Status:** Ready for planning

<domain>
## Phase Boundary

Honestly close milestone v1.1 and produce the upstream contribution for the #46 Windows screenshare echo fix. **No new fix behaviour** — this is verification, cleanup, and packaging-for-contribution on top of the Phase 04 fix that is already VERIFIED working on real Windows hardware (CI `27044504559` / `8078b20`: second-device viewer heard shared desktop audio, no call echo, chunks 31→6600).

**IN scope:**
- A structured, viewer-side **verification report** (per the two-device + CI protocol) re-confirming ECHO-01 end-to-end on the FINAL shipping shape, plus the graceful-fallback check and Linux/macOS non-regression.
- **Stripping all diagnostic instrumentation** from the shipped code (keep at most one conventional fallback log line).
- Fixing the **ECHO-03 silent-fallback gap** (renderer swaps a silent track on unsupported builds instead of falling back to `"loopback"`).
- Shaping the **surgical GoofCord-side upstream PR** (separate, closes #46) — branch hygiene, logical commits, verification-first description.
- Shaping the **separate clean-room addon repo** (`thomas-quant/wasapi-loopback`) for publication: own `windows-latest` CI, per-platform prebuild naming, consumed via one `optionalDependencies` line.

**OUT of scope (this phase):**
- Any change to the echo capture mechanism, transport, or 3-way gate behaviour (Phase 04, verified — do not re-architect).
- Bug A / PR #210 (already a separate, open, mergeable upstream PR — leave untouched).
- win32-arm64 prebuild (fast-follow); maintainer-side adoption of the addon repo.
- Bundling the `electron-builder` `getPlatformString` fix + venbind-packaging generalization into the echo PR (fix them, but as a separate commit/follow-up).

### Carried forward — LOCKED, do NOT re-derive or re-ask

- **The #46 echo fix is VERIFIED working** on real Windows hardware (Phase 04). This phase does not re-prove the mechanism from scratch — it re-confirms the *final stripped shape* and documents it.
- **Native-only** — user-side workaround is not a deliverable (REQUIREMENTS, Out of Scope).
- **Clean-room boundary (D-05, LOCKED):** addon authored solely from the public Microsoft `ApplicationLoopback` MIT sample; MIT NOTICE retained; zero Discord symbols. Already satisfied in `native/wasapi-loopback/NOTICE` + `README.md`.
- **Verification is manual**, viewer-side (second device/account) with non-call audio actively playing; the streamer cannot self-verify (Electron mutes local echo). Diagnostics historically → userData `screenshare-debug.log` (no DevTools — 60% keyboard); AI can read that log from WSL at `/mnt/c/Users/Christ/AppData/Roaming/goofcord/screenshare-debug.log`.
</domain>

<decisions>
## Implementation Decisions

### PR delivery & split
- **D-01:** The echo fix ships as a **brand-new, separate upstream PR that closes #46**, branched fresh off `upstream/main`. It is NOT bundled with or stacked on **PR #210** (Bug A / Closes #196), which stays untouched and open.
- **D-02:** Phase 5 **prepares** the PR (clean branch + ready-to-paste description) for the **user to open** — opening against `Milkshiift/GoofCord` is outward-facing on the user's GitHub identity. Claude does not open/push the PR itself.
- **D-03:** Use **`gsd-pr-branch`** to filter the ~70 `.planning/` (and `ci-artifacts/`) commits, producing a clean **code-only branch** off `upstream/main`. Same clean-branch approach #210 already used (`pr/fix-screenshare-cancel-restart`).
- **D-04:** Squash the messy debugging trail into **a few logical commits** (e.g. addon integration + 3-way gate + transport / packaging + `optionalDependencies` / fallback gate). Not a single squash, not the raw per-fix trail.
- **D-05:** **No AI mention** in the PR. Win on substance — lead with the real hardware verification, the mechanism explanation, and the genuine debugging detail. Authentic engineer voice; **do NOT** use the `## Summary / ## Why / ## Testing` skeleton that the maintainer flagged as AI slop.
- **D-06:** PR description = **authentic, verification-first engineering writeup** in the maintainer's own framing ("native audio capture, akin to venmic but for Windows"; clean-room from the MS sample). Open with concrete two-device verification evidence, then a "how it works / why no echo" mechanism section, the surgical diff surface, and graceful fallback.
- **D-07:** **Leave PR #210 as-is** — do not add a comment or edit its body to distinguish it from the rejected look-alike #200.

### Addon repo strategy
- **D-08:** The addon lives in a **new repo `thomas-quant/wasapi-loopback`** (MIT, clean-room). GoofCord consumes it via **one `optionalDependencies` line** — `github:thomas-quant/wasapi-loopback` — mirroring `github:Milkshiift/patchcord`. The PR notes the maintainer is welcome to fork it under `Milkshiift/` and flip the ref.
- **D-09:** Claude **prepares a ready-to-push standalone repo dir** (de-`private`d `package.json`, README, MIT `LICENSE` + retained MS `NOTICE`, `.github/workflows` napi CI on `windows-latest`, prebuild naming `wasapi-loopback-win32-x64.node`). The **user creates the GitHub repo and pushes**; its CI builds the prebuilt.
- **D-10:** Prebuild **win32-x64 first** (the verified target). **win32-arm64 is a noted fast-follow** — graceful `"loopback"` fallback covers arm64 Windows until then; Linux/macOS no-op via the existing load guard.

### Cleanup-bug scope
- **D-11:** **Fix the ECHO-03 silent-fallback gap** — gate the renderer track-swap on capture being active / the PCM port being open, so an unsupported build falls through to Chromium `"loopback"` (viewer hears audio) instead of getting a silent generated track. Required for an honest ECHO-03; does not touch the supported-Windows happy path.
- **D-12:** **Fix the `electron-builder.ts` `getPlatformString` bug** (ships a misnamed `…-linux-x64.node` into the Windows package + breaks venbind's build-time loader; fix via `context.electronPlatformName`) and any venbind-packaging generalization — but **keep them OUT of the echo PR diff** (separate tiny commit / potential standalone upstream PR). The echo PR includes only the `build.ts`/`electron-builder.ts` changes the wasapi addon actually needs.
- **D-13:** After stripping, **keep exactly one** conventional fallback `console.log` (the "unsupported on this build, using fallback" line, matching patchcord/venbind logging). Strip everything else: the `screenshareDebug.ts` module + its IPC channels, `deliverySpike.ts` (Phase 3 throwaway), the `[sync]` `syncCrumb`/`appendFileSync`, every `appendScreenshareDebug(...)` call, the per-chunk counts/PID dumps, and the CI temp `DIAGNOSTICS` + assertion in `testBuild.yml`.

### Verification
- **D-14:** **Sequence = verify rich → strip → re-confirm final.** (1) Capture the FULL structured report on a build WITH instrumentation (build#, excluded root PID + Audio Service PID in subtree, activation line, viewer-audible + no-echo). (2) Strip + fix the fallback gap + move the addon to `optionalDependency`. (3) **Final viewer-side re-confirm on the stripped/dependency-packaged shipping shape.** Resolves the "stripping removes the evidence logging" tension and proves the actual shipped build works.
- **D-15:** **Exercise the graceful-fallback path by launching with `--no-wasapi`** on the dev box (Win10 19045, which otherwise activates the native path) → confirm the stream falls through to `"loopback"`, the viewer **hears audio (not silence** — proving D-11), no crash, and the one fallback log line fires.
- **D-16:** **Linux:** CI build + run — confirm the patchcord audio path is byte-identical (the `process.platform === "win32"` gate means Linux never enters the wasapi branch) AND the new `optionalDependency` no-ops on the Linux install/build. **macOS:** successful CI build + code-level proof the win32/load guards leave it untouched — **no Mac hardware, stated plainly in the report, not faked.**

### Claude's Discretion
- The exact location/structure of the verification-report artifact (e.g. `05-VERIFICATION.md`) — planner's call.
- The precise commit boundaries within "a few logical commits" (D-04).
- The exact mechanism by which the `github:` `optionalDependency` delivers its prebuilt `.node` into `node_modules` (committed binary vs. release asset vs. postinstall) — research the `patchcord` precedent; the *decision* is "mirror patchcord's github-ref pattern."
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase goal, requirements & locked decisions
- `.planning/ROADMAP.md` — Phase 5 goal + Success Criteria SC#1–SC#4 (verification report, instrumentation strip, surgical GoofCord diff, separate addon repo).
- `.planning/REQUIREMENTS.md` — **UPST-02** (owned by Phase 5); **ECHO-03** (graceful fallback, no regression — the silent-fallback gap fix honours this); the Out-of-Scope table (native-only).
- `.planning/PROJECT.md` — Key Decisions table (D-05 clean-room LOCKED; native-only; verification constraints).

### Phase 04 state — what's being verified, stripped, and shipped (the direct upstream of this phase)
- `.planning/phases/04-native-clean-room-exclude-tree-addon-integration/.continue-here.md` — the strip list, the three carried bugs (ECHO-03 gap, `getPlatformString`, venbind generalization), and the final key-file state.
- `.planning/phases/04-native-clean-room-exclude-tree-addon-integration/04-03-SUMMARY.md` — the hardware verification write-up (CI `27044504559`) + the five-bug debugging chain (the genuine engineering detail for the PR).
- `.planning/phases/04-native-clean-room-exclude-tree-addon-integration/04-CONTEXT.md` — the transport/gate decisions being preserved.

### Clean-room recon + delivery path (the substance for the PR "how it works" section)
- `.planning/phases/02-fix-bug-b-windows-loopback-audio-captured/02-FINDINGS.md` — §2.1 EXCLUDE-vs-INCLUDE; §2.2 exclude the Electron tree (Audio Service child); §2.3 + §2.3 UPDATE (build floor ≈19041); §3 clean-room GO. The basis for "same public Windows API as Discord, independent clean-room code."
- `.planning/phases/03-delivery-path-spike-pcm-mediastream-go-no-go/03-FINDINGS.md` — the proven PCM→MediaStream delivery path (the GoofCord-specific transport bridge Discord never needed).
- `.planning/research/PITFALLS.md` — the two-device viewer-side verification protocol + logging-must-not-ship.

### Upstream context (shapes the PR — review confirmed 2026-06-06)
- **Issue #46** (`github.com/Milkshiift/GoofCord/issues/46`) — the Windows echo bug, OPEN; the PR closes this. Maintainer **struck through** his own "native Windows capture is way out of scope" and named the wanted shape: "native audio capture, akin to venmic but for Windows." Sustained user demand.
- **PR #210** (`Milkshiift/GoofCord#210`) — the user's Bug-A fix (Closes #196), OPEN/mergeable — leave as-is.
- **Rejected look-alikes** — #200 ("I know AI is fun and all, but consider not wasting people's time"), #148 ("obviously vibe coded" → accepted on revision), #193 ("have you tested this?"). The maintainer's review bar = **real runtime verification + correct root-cause understanding + no slop-template**. Our PR is the anti-pattern of these.
- **Native-addon convention** — `optionalDependencies`: `github:Milkshiift/patchcord` (0BSD), npm `venbind` `0.1.7` (MIT), both maintainer-owned. License boundary is clean: addon stays MIT in its own repo, consumed by the OSL-3.0 GoofCord repo.

### Code seams / files this phase touches
- `src/modules/native/wasapiLoopback.ts` — strip `[sync]`/`appendFileSync`/`appendScreenshareDebug`; keep the one fallback log line.
- `src/modules/screenshareDebug.ts` (+ regenerated `src/ipc/gen.ts` / `src/ipc/types.ts`) — remove the module + its IPC channels.
- `src/windows/main/preload/deliverySpike.ts` — Phase 3 throwaway, remove; check `bridge.ts` / `preload.mts` / `wasapiTransport.ts` for spike wiring to remove.
- `src/windows/main/renderer/postVencord/screensharePatch.ts` — the swap seam; gate the swap on capture active (D-11).
- `src/windows/screenshare/screenshare.ts` — the additive 3-way gate (verify byte-identical Linux path).
- `build/build.ts` (`copyNativeAddonsToOutDir`) + `build/nativeImport.ts` + `electron-builder.ts` — packaging; `getPlatformString` fix (D-12, separate commit).
- `.github/workflows/testBuild.yml` — strip temp DIAGNOSTICS + assertion; the in-CI Rust build decouples once the addon moves to its own repo + `optionalDependencies`.
- `native/wasapi-loopback/` — the crate to extract into `thomas-quant/wasapi-loopback`.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`native/wasapi-loopback/`** — already has `NOTICE` (MS MIT copyright retained), `README.md` (clean-room provenance documented), `package.json` (napi config), `Cargo.toml`, `src/lib.rs` (~570 lines). Extraction to a standalone repo is mostly: drop `private: true`, add `LICENSE`, add `.github/workflows` CI.
- **`patchcord` / `venbind` consumption pattern** — `optionalDependencies` + `copyNativeModules()` + `nativeModulePlugin` glob. The wasapi addon already mirrors this (Phase 04); Phase 5 flips it from the `GOOFCORD_WASAPI_LOOPBACK_PATH` env-override to a published-dependency.
- **`pr/fix-screenshare-cancel-restart`** (PR #210's branch) — precedent for the clean, `.planning`-free PR branch this phase produces for the echo fix.

### Established Patterns
- Native addons are **consumed prebuilt**, never compiled in GoofCord's Bun build ("no new build tooling"). The addon repo builds its own prebuilt on `windows-latest` CI.
- Conventional logging: a module-prefixed `console.log`/`console.warn` (e.g. patchcord's). The one surviving fallback line (D-13) should match this, NOT the `screenshare-debug.log` discipline.
- The `process.platform === "win32"` gate is the non-regression guarantee for Linux/macOS — the wasapi branch is structurally unreachable off-Windows.

### Integration Points
- The strip must leave the diff at the **surgical SC#3 surface**: additive `screenshare.ts` gate, `wasapiLoopback.ts`, one build-script entry, one `optionalDependencies` line, regenerated IPC — nothing else.
- The ECHO-03 gap fix is a small, additive guard at the `screensharePatch.ts` swap seam — it must not regress the happy path where capture IS active.
</code_context>

<specifics>
## Specific Ideas

- The PR description should foreground the **non-fakeable** engineering: the dual-capture CoreMessaging heap-corruption crash (addon + Chromium loopback fighting the same WASAPI session), the PROPVARIANT `ManuallyDrop` heap fix, the napi `(err, chunk)` CalleeHandled arg, asarUnpack + host-agnostic native copy. These war-stories are what separate this PR from the rejected unverified ones.
- Frame the fix exactly as the maintainer thinks of it: **"venmic-for-Windows"** — same in-OS WASAPI process-loopback API Discord uses (confirmed by `discord_voice.node` inspection), independent clean-room Rust from the public MS sample, plus the web-client MediaStream bridge that's unique to wrapping the Discord web client.
- The verification report follows the existing evidence discipline: the AI can read `screenshare-debug.log` from WSL for the build#/PID/activation lines; the human supplies the two-device viewer-audible + no-echo ground truth.
</specifics>

<deferred>
## Deferred Ideas

- **win32-arm64 addon prebuild** — fast-follow after win32-x64 ships; graceful `"loopback"` fallback covers arm64 Windows until then.
- **Maintainer adopting the addon repo under `Milkshiift/`** — at which point the `optionalDependencies` ref flips from `thomas-quant/` to `Milkshiift/` (matching `patchcord`).
- **The `electron-builder` `getPlatformString` fix + venbind-packaging generalization as their own small upstream PR** — fixed this milestone but kept separate from the echo PR (D-12).

None lost — all scope-adjacent items above are captured, not acted on inside the echo PR.
</deferred>

---

*Phase: 5-verification-upstream-pr*
*Context gathered: 2026-06-06*
