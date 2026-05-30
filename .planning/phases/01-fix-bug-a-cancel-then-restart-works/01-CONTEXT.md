# Phase 1: Fix Bug A — Cancel then Restart Works - Context

**Gathered:** 2026-05-30
**Status:** Ready for planning

<domain>
## Phase Boundary

On Windows, make the **second "Go Live" click after cancelling the source picker** re-open the picker and start a normal stream — with no app restart and no progressive wedging across repeated cancel/retry cycles. The fix lives entirely in two files: `src/windows/screenshare/screenshare.ts` (main-process handler) and `src/windows/main/renderer/postVencord/screensharePatch.ts` (renderer `getDisplayMedia` patch). Cancellation must remain error-free in Discord (preserve `710cfde`). The diff must be surgical and PR-ready for upstream GoofCord.

**Not in this phase:** Windows loopback audio (Bug B → Phase 2), any handler re-registration, `useSystemPicker`, new dependencies, or screenshare architecture changes.

</domain>

<decisions>
## Implementation Decisions

This phase was already heavily pre-decided by milestone research (`.planning/research/`) and ROADMAP.md. The discussion locked the **process and environment** decisions around executing that plan — not the fix mechanics, which are research-converged (see Canonical References).

### Already locked upstream of this discussion (do NOT re-litigate)
- **Diagnose-before-fix** with three log points: (A) first line of the patched `getDisplayMedia` in `screensharePatch.ts`; (B) first line inside the `setDisplayMediaRequestHandler` callback in `screenshare.ts`; (C) every `callback(...)` call site, the `!req` early-return, and the `closed` handler.
- **Fix shape:** consolidate all per-request teardown into an exactly-once `finishRequest(wcId, result)` in `screenshare.ts` (map-delete as the idempotency token), and reset Discord's latched go-live state by verifying/switching the renderer rejection name (`NotAllowedError` → `AbortError`) in `screensharePatch.ts`.
- **Hard no's:** no handler re-registration / `setDisplayMediaRequestHandler(null)`; no `useSystemPicker` (macOS-only in Electron 41); no new dependencies.
- **Verification:** manual, on the Windows x64 CI artifact (`.github/workflows/testBuild.yml`).

### CI Build Strategy
- **D-01:** **Combined, separate commits.** Produce **ONE** Windows CI build that carries BOTH the instrumentation AND the speculative fix (`finishRequest()` consolidation + error-name switch), landed as **distinct commits**. This collapses the roadmap's two-build split (01-01 diagnose, then 01-02 fix) into a single round-trip. Rationale: every build is a scarce GitHub Actions round-trip, and research converges hard on H1 (latched Discord go-live state) + `finishRequest`. If the fix lands, it's diagnosed + fixed in one trip; if it doesn't, the log file still routes H1/H2/H3 for the next build. Distinct commits keep the upstream PR clean and allow splitting/reverting.
  - **Planner note:** plans 01-01 and 01-02 may stay as separate plans for authoring clarity, but they build and verify against the **same single CI artifact**. Do not schedule two separate Windows builds.

### Reading the Logs (diagnostic capture)
- **D-02:** **Main-process probes append to a userData log file.** Log points B and C write to a file under `app.getPath('userData')` (e.g. `screenshare-debug.log`). On a packaged NSIS GUI build the main-process `console.log` has no attached console, so file capture is the robust path (survives the console gap; readable after the test; would still work if handed to a tester). Renderer log point A reads from **DevTools** on the developer's own Windows box (it may also echo to the file for a single combined trace — implementer's choice).

### Windows Test Access
- **D-03:** Developer runs the downloaded CI artifact on **their own Windows box** with DevTools (F12) available; they iterate freely and run the repeated cancel→retry stability cycles themselves (STREAM-04). **All builds are produced on GitHub Actions** (`testBuild.yml`) — there is no local build loop, which is why the single-round-trip strategy (D-01) and self-contained file logging (D-02) matter.

### Diagnostic Cleanup (for the upstream PR)
- **D-04:** **Strip the instrumentation before the upstream PR.** Because the instrumentation is its own commit (D-01), it is trivially reverted/dropped; the resulting PR contains ONLY the `finishRequest()` + error-name fix — maximally surgical per UPST-01. The userData log-file writes are debug scaffolding and must not ship.

### Claude's Discretion
- The exact rejection-name decision (`NotAllowedError` vs `AbortError`, or a direct Flux abort dispatch) is **data-driven** from the diagnostic build — confirm from the log file / DevTools, then keep or switch.
- The precise `finishRequest()` signature and the exact log-line format / file-append helper are implementation details (follow research's Pitfall 3 sketch and existing logging conventions).
- Whether renderer log A also tees into the log file vs. DevTools-only.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Diagnosis & fix direction (read first — this phase's spine)
- `.planning/research/PITFALLS.md` — Pitfalls 1–4 are Bug A: latched Discord go-live state (P1), the "can't be used twice" misdiagnosis to avoid (P2), the `finishRequest()` consolidation for exactly-once callback (P3), why `useSystemPicker` won't help (P4). Includes the "Looks Done But Isn't" checklist and the `finishRequest` code sketch.
- `.planning/research/SUMMARY.md` — executive synthesis; H1/H2/H3 hypotheses, error-name lever, the single-instrumented-build strategy, and the Phase 2 research flag.

### Code targets (the only two files the fix touches)
- `src/windows/screenshare/screenshare.ts` — main handler, `activeRequests` map, the two cleanup paths (select/cancel handler `:54-87` + `closed` event `:118-123`) to consolidate into `finishRequest()`, the `audio:"loopback"` grant. Log points B and C go here.
- `src/windows/main/renderer/postVencord/screensharePatch.ts` — `getDisplayMedia` monkeypatch, the synthetic `NotAllowedError` re-throw (`:22-31`) that is the error-name lever. Log point A goes here.
- `src/windows/main/main.ts` (~`:81`) — confirms `registerScreenshareHandler()` (and thus `setDisplayMediaRequestHandler`) is called **once** per `createMainWindow()`. Do not change registration.

### Verification vehicle
- `.github/workflows/testBuild.yml` — the Windows x64 CI build; the only verification path. All probes batched into one artifact per D-01.

### Supporting research / codebase maps
- `.planning/research/ARCHITECTURE.md` — screenshare four-component control flow (Discord renderer → patch → main handler → picker).
- `.planning/research/STACK.md` — Electron API contract (`setDisplayMediaRequestHandler`, `desktopCapturer`, `audio:"loopback"`, `useSystemPicker` macOS-only).
- `.planning/research/FEATURES.md` — the "definition of fixed" behaviours.
- `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONCERNS.md` — process model, error-handling/logging conventions, fragile areas.
- git commit `710cfde` — the cancellation→`NotAllowedError` fix that stopped the crash but exposed this re-click bug; its behaviour must be preserved (STREAM-03).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Logging conventions:** `screensharePatch.ts` already uses `console.log` (renderer); `screenshare.ts` uses `console.error("[Screenshare] ...")`. Main-process modules use a colored `LOG_PREFIX` (`pc.yellowBright("[Config]")` style) and `getErrorMessage(e)` from `src/utils.ts`. Match these for any retained logging.
- **`app.getPath('userData')`** (Electron) is the natural target for the D-02 debug log file; the app already persists config under the user data path.

### Established Patterns
- `activeRequests: Map<number, ActiveRequest>` keyed by `webContents.id`; the **map-delete is the idempotency token** — preserve delete-before-callback ordering when building `finishRequest()`.
- Callback-exactly-once is an Electron contract: double-invoke corrupts request state, zero-invoke hangs future requests (the `!req` early-return is the zero-callback risk).
- `frame.executeJavaScript(...).catch(() => {})` already guards destroyed frames — keep that safety.

### Integration Points
- `registerScreenshareHandler()` is invoked once from `createMainWindow()` (`main.ts`). The handler body and the renderer patch are the entire fix surface.

</code_context>

<specifics>
## Specific Ideas

- Use the `finishRequest(wcId, result)` consolidation exactly as sketched in PITFALLS.md Pitfall 3: `const req = activeRequests.get(wcId); if (!req) return; activeRequests.delete(wcId); try { req.callback(result); } catch {} if (!req.window.isDestroyed()) req.window.close();` — called from select, cancel, and `closed`.
- The error-name switch (`NotAllowedError` → `AbortError`) is the candidate Bug A lever — but only switch if the diagnostic build proves H1 and the current name doesn't clear Discord's latch.
- Single combined build means the log file should clearly tag the **second** click vs the first (e.g. include a request counter or timestamp) so the cancel→re-click sequence is unambiguous in one trace.

</specifics>

<deferred>
## Deferred Ideas

- **Bug B — Windows loopback audio** → already scoped as **Phase 2**; investigated only after Bug A is closed (a working screenshare is needed to validate audio). Not new scope, just sequenced.
- **Discord go-live Flux store flag exploration** → conditional sub-step *within* Phase 1 planning (research flag): pursue only IF the diagnostic build confirms H1 (renderer never re-issues `getDisplayMedia`) AND the `NotAllowedError`→`AbortError` switch alone does not clear the latch. Then identify/dispatch the correct `ApplicationStreamingStore` abort action.
- **Type `callback: any` → `Electron.Streams`** in `ActiveRequest` (tech-debt noted in PITFALLS.md) — out of this surgical fix's scope unless directly implicated in the bug.

None of the above expand this phase's scope — they are sequenced or conditional.

</deferred>

---

*Phase: 1-fix-bug-a-cancel-then-restart-works*
*Context gathered: 2026-05-30*
