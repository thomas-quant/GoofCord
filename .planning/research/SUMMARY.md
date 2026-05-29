# Project Research Summary

**Project:** GoofCord — Windows Streaming Fixes
**Domain:** Electron desktop screenshare + Windows system-audio loopback (brownfield bug-fix fork)
**Researched:** 2026-05-29
**Confidence:** HIGH (Electron API contract + in-repo code paths); MEDIUM (Discord renderer state-machine internals; exact Electron 41.x failure mode)

## Executive Summary

GoofCord is a brownfield Electron 41.3.0 Discord client (Vencord wrapper) with two active Windows screenshare bugs. Bug A is the primary target: after the user cancels the source picker, clicking "start stream" a second time does nothing — no picker window appears. Bug B is closely related but separable: Windows system/app audio (`audio: "loopback"`) may not be captured when the user opts in. All four research agents converged strongly on the same diagnosis and fix directions. No new dependencies are needed; fixes must be surgical and upstream-PR-able.

The root cause of Bug A is almost certainly a latched Discord renderer "go-live pending" state flag that is never cleared on cancellation, preventing Discord from ever re-issuing `getDisplayMedia` on the second click. The existing `710cfde` fix correctly maps cancellation to `NotAllowedError`, but if Discord's internal stream-start reducer does not treat `NotAllowedError` as a benign cancel (vs. `AbortError` for user-abort), the button stays inert. A secondary contributor is GoofCord's own per-request teardown: two cleanup paths (the IPC select handler and the window `closed` event) must be consolidated into a single `finishRequest()` that guarantees `callback` is called exactly once and `activeRequests` is fully cleared. The handler registration itself (`setDisplayMediaRequestHandler` called once at startup) is correct and must not be changed.

The key mitigation strategy is instrument-before-fix: a single Windows CI build with three log points (patched `getDisplayMedia` entry, main handler entry, every `callback(...)` site) deterministically routes to the right hypothesis in one round-trip. Windows CI artifacts are scarce — all probes should be added in one pass. Bug B investigation should begin only after Bug A is closed, using a separate diagnosis protocol: verify the loopback audio track actually arrives in `stream.getAudioTracks()` on Windows and confirm the Linux Patchcord track-removal branch does not fire on Windows (which would silently drop the loopback track). Always verify Bug B from the viewer side, not locally, because `disable_local_echo=true` mutes the streamer's own speakers by design.

---

## Key Findings

### Recommended Stack

The existing stack is correct and no new dependencies are warranted. The fix lives entirely within two source files: `src/windows/screenshare/screenshare.ts` (main process) and `src/windows/main/renderer/postVencord/screensharePatch.ts` (renderer patch). The `session.setDisplayMediaRequestHandler` / `desktopCapturer.getSources` API is the only supported Electron path for a custom picker, and `audio: "loopback"` is the only supported Windows system-audio mechanism. The `useSystemPicker` option is macOS 15+ only in Electron 41 — it must not be used for this Windows fix.

**Core technologies (existing — no change):**
- `session.setDisplayMediaRequestHandler` + `desktopCapturer.getSources`: the only Electron-supported path for a custom picker → stream; handler registered once, `callback` must fire exactly once per request.
- `audio: "loopback"` (Windows only, Electron ≥ 31.0.1): the documented driver-free Windows loopback mechanism; always requires a valid video source.
- Renderer `getDisplayMedia` monkeypatch in `screensharePatch.ts`: intercepts `getDisplayMedia`, normalises error shapes, applies stream settings; `NotAllowedError` re-throw lives here.
- Windows x64 CI artifact (`.github/workflows/testBuild.yml`): the only reliable verification vehicle; manual test required — no automated screenshare repro exists.

**Ruled-out alternatives:**
- `useSystemPicker: true` — macOS-only, no-op on Windows in Electron 41; do not add.
- Re-registering `setDisplayMediaRequestHandler` between requests — documented cause of second-request failures; GoofCord correctly registers once and must keep it that way.
- Per-app audio isolation on Windows — not available via `"loopback"` (system mix only); Linux/Patchcord concern, out of scope.

### Expected Features

This is a bug-fix milestone, not a feature build. "Features" are defined as the correct, expected behaviours that are currently broken.

**Must have (table stakes — the definition of "fixed"):**
- Immediate picker restart after cancel: second "start stream" click re-opens the picker and starts a normal stream without an app restart.
- Single `callback` invocation per request: Electron's contract — double-invocation corrupts request state; zero-invocation hangs future requests.
- Full per-request teardown on cancel: `activeRequests` entry deleted, `initialPromise` cleared, picker `BrowserWindow` destroyed, Discord renderer stream-start flag reset.
- `NotAllowedError` (or `AbortError` if needed) on cancel → Discord re-arms its button: the `710cfde` fix is kept; the exception name may need adjustment depending on which name Discord's reducer treats as benign cancel.
- Windows system audio on opt-in: renderer `audio:true` AND handler `audio:"loopback"` — both required, neither works alone.

**Boundary (must not regress, must not extend):**
- Resolution/framerate/content-hint controls, source refresh, Linux Patchcord audio path, macOS behaviour — already working; touch nothing.

**Defer:**
- Per-app audio isolation on Windows, live preview, quality UI improvements, architecture rewrite — explicitly out of scope per PROJECT.md.

### Architecture Approach

The screenshare flow is a four-component pipeline: Discord renderer (holds `getDisplayMedia` promise + "go-live" Flux state) → `screensharePatch.ts` (intercepts `getDisplayMedia`, normalises errors) → `screenshare.ts` main-process handler (maps request to picker BrowserWindow + Electron `callback`) → picker preload/renderer (source-selection UI). `registerScreenshareHandler()` is called once from `createMainWindow()` and sets `setDisplayMediaRequestHandler` once; it is not per-request. The fix scope is entirely within the main handler and the renderer patch — registration and picker UI are correct.

**Major components and their fix roles:**
1. **Discord renderer** — owns the "starting stream" Flux flag; calls `getDisplayMedia`; Bug A is primarily here (flag not cleared on cancel).
2. **`screensharePatch.ts`** (renderer patch) — must reject with the exact error name Discord treats as a benign cancel; must not leave a hanging promise.
3. **`screenshare.ts`** (main process) — owns `activeRequests: Map<wcId, {callback, window, frame, initialPromise}>`; must call `callback` exactly once per request across select, cancel, and `closed` event paths; consolidate into `finishRequest()`.
4. **Picker preload/renderer** — transient UI; no cross-request state except saved settings; correct as-is.

### Critical Pitfalls

All four research agents converged on the same five pitfalls, ranked by likelihood of being the direct cause:

1. **Discord renderer stream-start flag never cleared on cancel (Bug A — primary).** `callback({})` rejects `getDisplayMedia`, but if the error shape is not the one Discord's reducer treats as "user cancelled, re-arm button" (likely `NotAllowedError` vs. `AbortError`), the "go-live pending" flag stays latched and the next click is a no-op. Fix: verify which error name Discord's reducer resets on via the instrumented build; switch the synthetic exception name if needed.

2. **Two cleanup paths that can double-call or skip `callback` (Bug A — contributor).** The select-cancel IPC handler and the `closed` window event both attempt to call `callback({})`. The current `activeRequests.has()` guard prevents double-callback in the normal case, but the `!req` early-return in `selectScreenshareSource` can leave the Electron request hanging (zero callbacks) if the entry was already deleted by a racing `closed` event. Consolidate into `finishRequest(wcId, result)` using the map-delete as the idempotency token.

3. **Misdiagnosing Bug A as "Electron setDisplayMediaRequestHandler can't be used twice" (diagnostic trap).** Electron issue #39566 title pattern-matches the symptom but the reporter could not reproduce it in a Fiddle — it was their own app state. GoofCord registers the handler once (correct). Do not re-register it or null it between requests. Prove the handler fires on the second attempt with a log before making any other change.

4. **`useSystemPicker` assumed to fix Windows cancel (non-fix trap).** `useSystemPicker: true` is macOS 15+ only in Electron 41. It does nothing on Windows. Do not add it.

5. **Loopback audio track silently dropped by Patchcord block on Windows (Bug B — primary candidate).** `screensharePatch.ts` stops and removes all audio tracks to swap in a virtual mic. On Windows there is no `GoofCord-Virtual-Mic`, so `getVirtmic()` should return null and the block should not fire — but this must be verified at runtime. If a stale device label matches, the loopback track is removed and the stream is silent. Fix: gate the track-removal loop on `process.platform !== "win32"`. Additionally, confirm the renderer's `getDisplayMedia` call includes `audio: true` when the user opts in (handler `audio:"loopback"` alone is insufficient without the renderer also requesting audio).

---

## Implications for Roadmap

This milestone has exactly two bugs, strongly separated by investigation dependency. Bug A must be diagnosed before Bug B is touched, because the Windows CI round-trip budget is limited and Bug B diagnosis requires a clean, working screenshare to validate against.

### Phase 1: Diagnose Bug A — Instrument and Route the Hypothesis

**Rationale:** "Second click does nothing" has three candidate explanations (H1: renderer never issues second `getDisplayMedia`; H2: Electron dispatch wedge; H3: callback double/zero-fire race). All are distinguishable by log output in one CI build. Spending a CI round-trip on a fix before knowing which hypothesis is true is wasteful.

**Delivers:** A definitive answer to: does the patched `getDisplayMedia` fire on the second click? Does the main handler fire? Is `callback` called exactly once during the first cancel?

**Implements:** Three log points — (A) first line of patched `getDisplayMedia` in `screensharePatch.ts`; (B) first line inside the `setDisplayMediaRequestHandler` callback in `screenshare.ts`; (C) every `callback(...)` call site, the `!req` early-return, and the `closed` handler.

**Avoids:** Pitfall 2 (chasing the "can't be used twice" misdiagnosis) and wasting a CI artifact on the wrong fix.

**Research flag:** Standard Electron logging — no additional research needed.

### Phase 2: Fix Bug A — Cancel/Restart Lifecycle

**Rationale:** With the hypothesis confirmed, apply the smallest surgical fix. Two sub-tasks are required regardless of which hypothesis is confirmed: (a) consolidate cleanup into `finishRequest()` for an exactly-once `callback` guarantee; (b) ensure Discord's renderer stream-start flag is reset on cancel (verify or switch the error name; or directly dispatch the Discord abort-go-live Flux action if needed).

**Delivers:** Second "start stream" click after cancel reliably re-opens the picker and starts a normal stream. Passes the acceptance test: cancel → re-click → picker appears → select source → stream starts.

**Uses:** `screenshare.ts` (`finishRequest()` refactor) + `screensharePatch.ts` (error name verification/adjustment).

**Avoids:** Pitfall 1 (latched Discord state), Pitfall 3 (double/zero callback race), Pitfall 4 (`useSystemPicker` non-fix).

**Constraint:** Surgical diff — no handler re-registration, no new dependencies, PR-ready.

**Research flag:** If H1 is confirmed (renderer never re-issues `getDisplayMedia`), the fix may require identifying Discord's go-live Flux store flag. This is Discord-internal and lightly documented. Flag as a possible sub-step only if the instrumented build proves H1 and the error-name switch alone does not resolve it.

### Phase 3: Fix Bug B — Windows Loopback Audio

**Rationale:** Investigated separately after Bug A is closed, to avoid conflating two independent failure modes. Bug B has its own diagnosis protocol (check track arrival, check Patchcord block, verify from viewer side) that does not depend on Bug A being open.

**Delivers:** When the user opts into audio sharing on Windows, remote viewers hear system audio. `stream.getAudioTracks().length > 0` on Windows after a loopback grant.

**Uses:** `screensharePatch.ts` (gate Patchcord track-removal on `platform !== "win32"`), `screenshare.ts` (confirm `audio: "loopback"` is set when `audioConfig.mode !== "none"`), renderer `getDisplayMedia` call (confirm `audio: true` in options when user opts in).

**Avoids:** Pitfall 5 (loopback track dropped by Patchcord), Pitfall 6 (local echo muting mistaken for capture failure — test from viewer, not locally), Pitfall 7 (Electron regression over-attribution — do track logging before any version archaeology).

**Research flag:** No additional research needed. Fix directions are clear. The only unknown is whether `audio: "loopback"` on Electron 41.3.0 Windows produces a real track — confirmed by logging `stream.getAudioTracks()` in the Bug B diagnosis build.

### Phase Ordering Rationale

- Bug A before Bug B: Bug A blocks normal screenshare; without a working re-click, Bug B cannot be meaningfully isolated and validated.
- Diagnose before fix (Phase 1 before Phase 2): Windows CI artifacts require manual testing. A single instrumented build is the same cost as a fix build; diagnosing first eliminates the risk of shipping the wrong fix and burning a second round-trip.
- Both bugs before any out-of-scope work: The milestone is explicitly scoped to these two bugs only.

### Research Flags

Phases needing deeper research during planning:
- **Phase 2 (Bug A fix)** — if the instrumented build confirms H1 (Discord renderer never re-issues `getDisplayMedia`), and switching the error name from `NotAllowedError` to `AbortError` does not resolve the latch, a targeted exploration of Discord's go-live Flux state machine will be needed to identify and dispatch the correct abort action.

Phases with standard patterns (research not needed):
- **Phase 1 (instrumentation)**: Adding log statements to known call sites is a trivial operation.
- **Phase 3 (Bug B)**: The Patchcord platform gate is a one-line fix. The `audio: true` renderer alignment is a verified API contract. Both have high-confidence fix directions from research.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | API contract verified against Electron `main`/41 docs. All API shapes confirmed. `useSystemPicker` macOS-only confirmed via implementing PRs. |
| Features | HIGH | Cancel/restart contract from MDN, Electron #47980, Vesktop comparator. Windows loopback requirements from Electron docs + electron-audio-loopback reference. MEDIUM on Discord renderer internals (inferred from behaviour, not source). |
| Architecture | HIGH | Control flow read directly from GoofCord source. Handler registration, `activeRequests` map, callback paths, and picker lifecycle all confirmed. MEDIUM on exact Electron 41.x failure mode (corroborated by issues on 26.x–35.x, not a confirmed 41.x reproduction). |
| Pitfalls | MEDIUM-HIGH | Electron callback lifecycle pitfalls: HIGH (official docs + multiple issue reports). Discord renderer stuck-state: MEDIUM (inferred from code + API gap). Patchcord track-removal on Windows: HIGH (code read) — runtime-verified via log. |

**Overall confidence:** MEDIUM-HIGH

The API surface is well-understood and fix directions are clear. Remaining uncertainty: (1) the exact error name Discord's go-live state machine reacts to, confirmed only by the instrumented build; (2) whether `getVirtmic()` returns null on Windows in all real-world configurations, confirmed by a runtime log.

### Gaps to Address

- **Discord error name (NotAllowedError vs AbortError):** Research converges on the rejection name as the most likely lever for Bug A but cannot confirm which name Discord's reducer treats as "benign cancel → re-arm" without running. Resolution: Phase 1 build answers H1 vs H2; if H1, the Phase 2 fix can include an error-name switch with a documented rationale.
- **`getVirtmic()` return value on Windows:** The Patchcord track-removal block is conditionally guarded by a device-label lookup. Research identifies it as the primary Bug B candidate but cannot confirm it fires without a runtime log. Resolution: add `console.log(getVirtmic())` in the Bug B diagnosis build before adding the platform gate.
- **Electron 41.3.x `callback({})` wedge behaviour:** Issues #39566 and #47980 confirm the symptom class on 26.x–35.x; whether 41.3.0 is affected is unconfirmed. Resolution: the Phase 1 instrumented build distinguishes "handler not invoked" (H2, Electron wedge) from "handler invoked but Discord doesn't re-call" (H1, renderer state). If H2, a specific 41.x workaround investigation is added to Phase 2.

---

## Sources

### Primary (HIGH confidence)

- `src/windows/screenshare/screenshare.ts` (direct read) — main handler, `activeRequests`, cancel paths, `audio:"loopback"` grant
- `src/windows/main/renderer/postVencord/screensharePatch.ts` (direct read) — `getDisplayMedia` monkeypatch, `NotAllowedError` re-throw, Patchcord track-removal block
- `src/windows/main/main.ts:81` (direct read) — handler registered once per `createMainWindow()`
- git `710cfde` (direct read) — the cancellation→NotAllowedError fix that exposed the re-click bug
- `electron/electron` `docs/api/session.md` (`main`/41 branch) — `setDisplayMediaRequestHandler` full signature, `loopback`/`loopbackWithMute` Windows-only, `useSystemPicker` macOS 15+ only
- `electronjs.org/docs/latest/api/desktop-capturer` — `getSources` options, return type, `id` format, main-process-only
- electron/electron #47980 — no first-class cancel signal; unhandled handler exception hangs future requests
- electron/electron #45517 — `video: undefined` + `audio` throws `"video must be a WebFrameMain or DesktopCapturerSource"`
- electron/electron PRs #43581/#43679/#43680 — `useSystemPicker` macOS-only gating (ScreenCaptureKitPicker)
- electron/electron #37293 — `disable_local_echo=true` hardcoded; local speakers muted during loopback capture
- MDN `MediaDevices.getDisplayMedia()` — `NotAllowedError` on cancel; `AbortError` vs `NotAllowedError` taxonomy
- `.planning/PROJECT.md` — scope, constraints, existing validated requirements

### Secondary (MEDIUM confidence)

- electron/electron #39566 — "setDisplayMediaRequestHandler can't be used twice" (reporter could NOT reproduce in Fiddle → app state, not Electron; confirms handler is not the cause)
- alectrocute/electron-audio-loopback — `{video:true, audio:true}` required; `"loopback"` vs `"loopbackWithMute"`; Electron ≥ 31.0.1
- Vencord/Vesktop `src/main/screenShare.ts` — `callback({})` on cancel; `streams.audio = "loopback"` for win32 (working comparator)
- electron/electron #25120 — Windows loopback captures full system mix; no per-app isolation
- electron/electron #49607 — loopback silence with degenerate video on macOS 40.1.0 (macOS-specific; relevant as a class of failure to rule out on Windows)

### Tertiary (LOW/contextual)

- windowslatest / Chrome for Developers — WGC migration for Win11 24H2+; transparent to GoofCord but explains source enumeration timing changes
- Electron release notes — Electron 41 = Chromium 146 / Node 24.14 / V8 14.6

---
*Research completed: 2026-05-29*
*Ready for roadmap: yes*
