---
phase: 05-verification-upstream-pr
plan: 03
subsystem: screenshare
tags: [wasapi, echo-fix, diagnostics-strip, ipc-codegen, echo-03, getDisplayMedia, mediastreamtrackgenerator]

# Dependency graph
requires:
  - phase: 05-verification-upstream-pr
    provides: 05-01 captured the FULL rich-build verification evidence (build#, PIDs, native-path line, chunk counts, viewer ground truth) BEFORE the strip, so removing the diagnostics here is safe (D-14)
provides:
  - Diagnostic-free shipped source — zero appendScreenshareDebug / screenshare-debug.log / syncCrumb / deliverySpike / screenshareDebug references in src/ (SC#2 source half)
  - Exactly one conventional fallback console.log on the screenshare.ts fallback branch (pc.cyan("[Screenshare]")), matching patchcord/venbind style (D-13)
  - ECHO-03 honest-fallback fix (D-11) — getDisplayMedia swap gated on activePort so an unsupported build / --no-wasapi / failed activation leaves the original Chromium "loopback" track in place (viewer hears audio, not a silent gen track)
  - shouldInjectWasapiTransport relocated + simplified into wasapiLoopback.ts as an <IPCOn> getter; IPC regenerated (gen.ts/types.ts drop screenshareDebug:*, add wasapiLoopback:shouldInjectWasapiTransport)
affects: [05-04, 05-05, 05-06]

# Tech tracking
tech-stack:
  added: []
  patterns: [activePort-gated-swap-seam, one-conventional-fallback-log, relocate-then-delete-strip]

key-files:
  created: []
  modified:
    - src/modules/native/wasapiLoopback.ts
    - src/windows/main/preload/wasapiTransport.ts
    - src/windows/main/preload/bridge.ts
    - src/windows/main/preload/preload.mts
    - src/windows/screenshare/screenshare.ts
    - src/ipc/gen.ts
    - src/ipc/types.ts
  deleted:
    - src/modules/screenshareDebug.ts
    - src/windows/main/preload/deliverySpike.ts

key-decisions:
  - "Strip executed as relocate-then-delete (not blind file-delete): the two THROWAWAY-headed files are the real shipping code; shouldInjectWasapiTransport is load-bearing and was relocated first"
  - "shouldInjectWasapiTransport simplified to win32 && !--no-wasapi (transport-spike OR-branch dropped) and moved to wasapiLoopback.ts → channel wasapiLoopback:shouldInjectWasapiTransport"
  - "ECHO-03 guard keys on activePort (set only after the main process forwards the port on a successful activation), matching the verified port-forward-before-getDisplayMedia-resolves ordering"
  - "Reverted a build-host path artifact in assets/preVencord.js (embedded absolute build-machine path) rather than commit it — out of scope and would leak local filesystem layout"

patterns-established:
  - "activePort-gated swap seam: the unsupported audio path falls through to Chromium loopback instead of swapping a silence-filled gen track"
  - "One conventional fallback log: pc.cyan('[Screenshare]') prefix on the else branch, mirroring patchcord/venbind"

requirements-completed: [UPST-02]

# Metrics
duration: 18min
completed: 2026-06-06
---

# Phase 5 Plan 03: Strip diagnostics + ECHO-03 honest fallback Summary

**Surgically stripped all diagnostic scaffolding from the shipped #46-echo-fix source (relocate-then-delete), regenerated IPC, and gated the getDisplayMedia swap on activePort so unsupported builds fall back to audible Chromium "loopback" instead of a silent track — build green.**

## Performance

- **Duration:** ~18 min
- **Completed:** 2026-06-06T05:51:10Z
- **Tasks:** 3
- **Files modified:** 7 modified + 2 deleted (9 total — exactly the plan's files_modified set)

## Accomplishments
- Relocated the load-bearing `shouldInjectWasapiTransport` gate into `wasapiLoopback.ts` (simplified to `win32 && !--no-wasapi`), then deleted `screenshareDebug.ts`; regenerated `gen.ts`/`types.ts` to drop the 3 `screenshareDebug:*` getters + the `appendScreenshareDebug` handler and add `wasapiLoopback:shouldInjectWasapiTransport` (kept `wasapiLoopback:stopWasapiLoopback`).
- Stripped every diagnostic instrumentation point from the four real shipping files (`wasapiLoopback.ts`, `wasapiTransport.ts`, `bridge.ts`, `screenshare.ts`): `syncCrumb`/`appendFileSync`, all `appendScreenshareDebug` calls, the `os.release()` build breadcrumb (05-01), per-chunk `chunkCount`/`logCount`/`dropped`/`underrun` counters, PID dumps, and the `wasapi smoke` / `wasapiPath resolved?` lines — while preserving the load model, MessageChannelMain transport, PID resolution, before-quit teardown, MSTG feeder, MessagePort receiver, readiness handshake, and swap seam.
- Deleted the genuine Phase-3 throwaway `deliverySpike.ts` and its preload wiring; removed the dead `feedWasapiChunk` / `__goofcordWasapiFeedChunk` structured-clone fallback (main never sends `wasapi:pcm-chunk`).
- Fixed the ECHO-03 silent-fallback gap (D-11): a single `if (!activePort) return stream;` guard at the top of the getDisplayMedia swap, leaving the supported happy path unchanged.
- Left exactly one conventional fallback `console.log` on the `screenshare.ts` else branch (`pc.cyan("[Screenshare]")`), matching patchcord/venbind.

## Task Commits

Each task was committed atomically:

1. **Task 1: Relocate gate, strip wasapiLoopback.ts diagnostics, delete screenshareDebug.ts, regenerate IPC** - `969426f` (refactor)
2. **Task 2: Delete deliverySpike.ts, strip bridge/preload spike wiring, strip wasapiTransport.ts + add ECHO-03 guard** - `cb42b67` (refactor)
3. **Task 3: Strip screenshare.ts, add the one surviving fallback log, prove green build** - `7ccb432` (refactor)

## Files Created/Modified
- `src/modules/native/wasapiLoopback.ts` - Diagnostics removed; now hosts the relocated/simplified `shouldInjectWasapiTransport` `<IPCOn>` getter. Real fix (load model, MessageChannelMain transport, PID resolution, before-quit teardown, `stopWasapiLoopback`) preserved.
- `src/windows/main/preload/wasapiTransport.ts` - Stripped the `appendScreenshareDebug`-backed `log()` helper + counters + dead fallback + spike header framing; added the ECHO-03 `if (!activePort) return stream;` guard before the remove+addTrack swap. MSTG feeder / receiver / handshake / swap seam kept.
- `src/windows/main/preload/bridge.ts` - Removed `deliverySpike`, `appendScreenshareDebug`, and the dead `feedWasapiChunk` fields; kept `stopWasapiLoopback`.
- `src/windows/main/preload/preload.mts` - Removed `deliverySpike` import + `injectDeliverySpike()`; pointed `injectWasapiTransport()` at `wasapiLoopback:shouldInjectWasapiTransport`; de-spiked comments/log strings.
- `src/windows/screenshare/screenshare.ts` - Removed the `appendScreenshareDebug` import + both call sites; added the single conventional fallback log; 3-way audio gate logic unchanged.
- `src/ipc/gen.ts` / `src/ipc/types.ts` - Regenerated via `bun run build --onlyGenerators` (never hand-edited).
- `src/modules/screenshareDebug.ts` - **Deleted** (after relocating its load-bearing export).
- `src/windows/main/preload/deliverySpike.ts` - **Deleted** (genuine Phase-3 throwaway).

## Decisions Made
- Strip done as a surgical relocate-then-delete; trusted each file's body over its (wrong) `THROWAWAY` header.
- `shouldInjectWasapiTransport` simplified to `process.platform === "win32" && !process.argv.includes("--no-wasapi")` (transport-spike OR-branch dropped) and homed in `wasapiLoopback.ts` — the natural owner of the win32 gate.
- ECHO-03 guard keys on `activePort` (the only main-world signal that the main process actually forwarded the port, i.e. activation succeeded), consistent with the verified ordering where the port is forwarded synchronously in the picker callback before `getDisplayMedia` resolves.
- Converted the stripped error-path `appendScreenshareDebug` calls (start/stop throws, onChunk throw) to silent best-effort catches with explanatory comments rather than new `console.error` noise, keeping the "exactly one surviving conventional log" intent; left the pre-existing operational status `console.log`s (`Loaded wasapi-loopback addon`, `capture streaming`, `capture stopped`) which mirror patchcord/venbind's conventional logging and are not part of the diagnostic scaffolding.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Reverted a build-host path artifact in `assets/preVencord.js`**
- **Found during:** Task 3 (running `bun run build` for the green-build proof)
- **Issue:** `bun run build` regenerated `assets/preVencord.js`, rewriting a glob-plugin base64 identifier that embeds the build machine's absolute source path. The committed copy carried a different machine's path; my local build replaced it with `/mnt/e/backup/...`. This is an unrelated build-host artifact (none of my edits touch preVencord renderer scripts) and committing it would leak my local filesystem layout and pollute the surgical strip diff.
- **Fix:** `git checkout -- assets/preVencord.js` (sanctioned per-file restore) to keep the committed bundle untouched; staged only `screenshare.ts` for the Task 3 commit.
- **Files modified:** none (reverted)
- **Verification:** `git status --short` shows only `screenshare.ts` before the Task 3 commit.
- **Committed in:** n/a (reverted, not committed)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** No scope creep. The strip + ECHO-03 fix landed exactly on the plan's 9 declared files; the only deviation was avoiding an unintended build-artifact commit.

## Issues Encountered
- Intermediate per-task states are intentionally non-type-checking: after Task 1 (`screenshareDebug.ts` deleted) and Task 2, `screenshare.ts` still imported the deleted module, so `bun run check` reported exactly one expected `TS2307` until Task 3 swapped that import. Confirmed in isolation that no other type errors existed before committing Tasks 1/2; the full `bun run check` + `bun run build` are green at the end of Task 3.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- SC#2 source half is complete: the shipped source is diagnostic-free and the build is green (`bun run check`, `bun run build`, `bun run build --onlyGenerators` all pass).
- ECHO-03 honest fallback (D-11) is in place without touching the verified happy path — ready for the `--no-wasapi` / unsupported-build re-confirm (05-06, D-15).
- 05-04 (CI / build-script strip: `testBuild.yml` `DIAGNOSTICS`, `build.ts` envPath, `electron-builder.ts`, `package.json` optionalDependency) is untouched and parallel-safe — none of its files were modified here.
- The whole-tree strip-completeness assertion lands in 05-05 once 05-03 + 05-04 both complete.

## Self-Check: PASSED
- [x] Commits exist: `969426f`, `cb42b67`, `7ccb432`
- [x] `screenshareDebug.ts` and `deliverySpike.ts` deleted; 7 modified files present
- [x] `grep -rn "appendScreenshareDebug\|screenshare-debug.log\|syncCrumb\|deliverySpike\|screenshareDebug" src/` → 0
- [x] `if (!activePort) return stream` present in `wasapiTransport.ts`; `wasapiLoopback:shouldInjectWasapiTransport` in `gen.ts` + `preload.mts`
- [x] `bun run check` (tsgo, strict, noEmit) and `bun run build` exit 0

---
*Phase: 05-verification-upstream-pr*
*Completed: 2026-06-06*
