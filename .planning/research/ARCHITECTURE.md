# Architecture Research — Screenshare Request/Cancel/Restart Control Flow

**Domain:** Electron screenshare lifecycle (GoofCord, Windows) — brownfield bug-fix
**Researched:** 2026-05-29
**Confidence:** HIGH on the in-repo control flow (read directly from source); MEDIUM on the exact Electron failure mode (corroborated by Electron issues #39566, #47980, #45517 but not reproduced here; Windows-specific, no automated repro).

> Scope note: this documents the lifecycle of a *single* screenshare request through request → picker → select/cancel → callback → stream/rejection → restart, and identifies **where state must reset for a second attempt to succeed**. It does not re-document the whole app (see `.planning/codebase/ARCHITECTURE.md`).

---

## Standard Architecture

### System Overview — the four components in the flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│  DISCORD RENDERER (web client, inside main BrowserWindow)                  │
│  • "Share Your Screen" / "Go Live" button → calls getDisplayMedia()        │
│  • Holds Flux/React UI state: "is a stream-start in flight?"               │
│  • Owns the PROMISE returned by getDisplayMedia                            │
└───────────────┬────────────────────────────────────────────────────────────┘
                │ navigator.mediaDevices.getDisplayMedia(opts)
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  RENDERER PATCH (postVencord/screensharePatch.ts) — runs in same context  │
│  • Monkeypatches getDisplayMedia: await original.call(...) inside try      │
│  • On reject → throw NotAllowedError DOMException (the 710cfde fix)         │
│  • On success → applies contentHint/constraints, swaps in virtmic audio    │
└───────────────┬────────────────────────────────────────────────────────────┘
                │ "original" getDisplayMedia traps into Electron's
                │ session.setDisplayMediaRequestHandler  (IPC boundary)
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  MAIN PROCESS HANDLER (screenshare/screenshare.ts)                         │
│  • setDisplayMediaRequestHandler((request, callback) => …) — registered    │
│    ONCE per main-window creation                                           │
│  • Per request: new picker BrowserWindow; activeRequests.set(wcId, {...})  │
│  • Holds the Electron `callback` that resolves/denies getDisplayMedia      │
│  • selectScreenshareSource IPC → callback(result) | callback({}) on cancel │
│  • "closed" handler → if entry still present: delete + callback({})        │
└───────────────┬────────────────────────────────────────────────────────────┘
                │ loadFile(screenshare.html) + preload.js
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  PICKER WINDOW (screenshare/preload/preload.mts + renderer)                │
│  • Renders sources/audio UI                                                │
│  • Click source → invoke selectScreenshareSource(id, …)                    │
│  • Esc / "back out" → invoke selectScreenshareSource() with no id          │
│  • Window close (X) → main "closed" handler fires cancel                   │
└──────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Owns which state |
|-----------|----------------|------------------|
| Discord renderer | Initiates capture, drives "Go Live" UI | React/Flux "starting stream" flag; the `getDisplayMedia` promise; the resulting `MediaStream` |
| `screensharePatch.ts` | Intercepts `getDisplayMedia`, normalizes errors, post-processes the stream | The patched `getDisplayMedia` function reference (replaced once, at postVencord init) |
| `screenshare.ts` (main) | Maps each capture request to a picker window + Electron `callback` | `activeRequests: Map<wcId, {callback, window, frame, initialPromise}>`; the live `callback`; the picker `BrowserWindow` |
| Picker preload/renderer | Source selection UI + IPC back to main | Transient form state only; no cross-request persistence except `screensharePreviousSettings` (config) |

**Key boundary fact:** `registerScreenshareHandler()` is called **once**, from `createMainWindow()` in `src/windows/main/main.ts:81` — *not* per request. It begins with `ipcMain.removeHandler(...)` for its three channels (idempotent re-registration guard) and then calls `setDisplayMediaRequestHandler` once. So between a cancel and a re-click, **the handler is NOT re-registered** — this matters for hypothesis ranking below.

---

## Control Flow

### Happy path (works today)

```
1. Discord renderer: user clicks "Share Your Screen"
2. getDisplayMedia(opts)  [patched]
3. patch: stream = await original.call(this, opts)   ── enters Electron handler
4. main: setDisplayMediaRequestHandler fires
        → new picker BrowserWindow (show:false)
        → wcId = webContents.id
        → activeRequests.set(wcId, {callback, window, frame, initialPromise})
        → loadFile(screenshare.html)
5. picker preload init(): refreshScreenshareSources → consumes initialPromise
        → renders sources, showScreenshareWindow (window.show())
6. user clicks a source → selectScreenshareSource(id, name, audioCfg, …)
7. main: req = activeRequests.get(wcId); activeRequests.delete(wcId)
        → result = {video:{id,…}}; (audio="loopback" on Windows if requested)
        → callback(result)         ── RESOLVES the renderer's getDisplayMedia
        → window.close()
8. patch: stream resolves → applies constraints/contentHint → returns stream
9. Discord renderer: stream live, UI transitions to "streaming"
```

### Cancel path (the suspect)

```
1–5. identical to happy path
6'. user backs out: either
     (a) Esc           → invoke("selectScreenshareSource")  with NO id
     (b) source btn w/ empty id → selectScreenshareSource("", …)  → id falsy
     (c) window X / programmatic close → main "closed" handler
7'. main, selectScreenshareSource branch:
     req = activeRequests.get(wcId)
     if (!req) return;                         ← (note: early-out if already gone)
     activeRequests.delete(wcId)
     if (!id) { callback({}); window.close(); return; }   ← DENY
   OR main, "closed" branch:
     if (activeRequests.has(wcId)) { delete; callback({}); }  ← DENY
8'. callback({})  ── Electron REJECTS getDisplayMedia
9'. patch catch{}: throw new DOMException("Permission denied", "NotAllowedError")
10'. Discord renderer: getDisplayMedia promise rejects with NotAllowedError
        → (intended) UI quietly returns to idle, button re-armed
11'. user clicks "Share Your Screen" AGAIN
        → SECOND getDisplayMedia call
        → EXPECTED: handler fires again, new picker window
        → ACTUAL BUG: no picker window appears; button does nothing
```

### Where state MUST reset for attempt #2 to succeed

For the second click to produce a picker, **all four** of these must be true at the moment of the second `getDisplayMedia`:

| # | State that must be clean | Who resets it on cancel | Verified in code? |
|---|--------------------------|-------------------------|-------------------|
| R1 | `activeRequests` has **no** stale entry for the renderer's `webContents.id` | `delete(wcId)` in both the select branch and the "closed" branch | YES — both paths delete. **But the key is `event.sender.id` (the picker's wcId), and the map is keyed by picker wcId, not the Discord renderer's id.** See gap below. |
| R2 | The previous picker `BrowserWindow` is destroyed (no orphan holding `callback`) | `window.close()` then `"closed"` fires | YES, but ordering of `delete` vs `close` matters (see H3) |
| R3 | Electron's internal display-media request slot for that renderer is released so a new request can be dispatched to the handler | Electron, upon `callback({})` | UNVERIFIED — this is the Electron-side state (issues #39566 / #47980) |
| R4 | Discord renderer UI "stream-start in flight" flag is cleared by the rejected promise | Discord's own catch on `getDisplayMedia` rejection | UNVERIFIED — depends on whether `NotAllowedError` is the error shape Discord treats as "user cancelled, re-arm button" vs. "fatal, stay disabled" |

**Critical observation on R1 keying:** `activeRequests` is keyed by the **picker window's** `webContents.id` (`capturerWindow.webContents.id`), and every IPC handler reads `event.sender.id` — which is *also the picker's* id because those IPC calls originate from the picker preload. The map is therefore self-consistent and a new request creates a *new* picker with a *new* wcId. So a literal "stale map entry blocks the new picker" is **unlikely to be a Map collision** — a second request would get a fresh key. The risk is not a key collision but a **dangling callback / dangling Electron request** (R3) or the renderer never issuing the second call at all (R4).

---

## Ranked Hypotheses — "second click does nothing / no picker window"

Ranked by likelihood given the code as written and the corroborating Electron issues.

### H1 (MOST LIKELY) — Discord renderer never issues the 2nd `getDisplayMedia`; its "starting stream" UI state is stuck on the `NotAllowedError`

**Why:** "No picker window at all" means the main-process handler very likely never fired, which means `getDisplayMedia` was very likely never called the second time. The most common cause is renderer UI state: Discord's Go-Live flow sets an internal "modal open / starting" flag *before* calling `getDisplayMedia`, and expects either resolve (→ streaming) or a *specific* rejection to roll it back. If the rejection shape (`NotAllowedError`) is swallowed by the patch but not in the exact way Discord's handler expects, the button can stay in a latched/disabled state and the second click is a no-op.
**Evidence:** The 710cfde fix deliberately changed the error from "generic Electron error (surfaced as uncaught)" to `NotAllowedError`. The symptom *appeared/was exposed after that change* (PROJECT.md "introduced/exposed the re-click failure"). General Discord community reports also describe Go-Live becoming inert after a cancelled picker until a reload (corroborating, MEDIUM confidence — generic, not GoofCord-specific).
**How to confirm:** In the Discord renderer devtools, set a breakpoint / log at the top of the patched `getDisplayMedia`. Click cancel, then click "Share Your Screen" again. **If the log does NOT fire on the 2nd click → H1 confirmed** (fault is renderer-side, above getDisplayMedia). If it DOES fire → fault is below the patch (H2/H3/H4).
**Fix direction:** Match the exact cancellation contract Discord expects. Options: (a) `AbortError` instead of `NotAllowedError` (browsers raise `AbortError`/`NotAllowedError` differently for user-cancel vs permission-deny — Discord may branch on `.name`); (b) resolve with a sentinel the client treats as "no-op"; (c) re-throw the original error unchanged but suppress only the uncaught-error console noise. Needs renderer-side inspection of how Discord branches on the error `.name`.

### H2 (LIKELY) — Electron's display-media request slot is not released after `callback({})`, so the 2nd request is dropped silently

**Why:** Electron issue #39566 ("setDisplayMediaRequestHandler can't be used twice") reports the *exact* symptom: first request works, second request's callback "is not being called... No errors are raised, no timeouts — it happens silently." Issue #47980 adds that after a cancellation that isn't signaled the way Electron wants, "subsequent share attempts fail or don't callback," sometimes persisting until restart. `callback({})` IS the documented deny pattern, but these issues indicate the *deny/cancel* path specifically can leave Electron's per-renderer request state wedged.
**Evidence:** #39566, #47980, #45517 (HIGH that these issues exist and describe this symptom; MEDIUM that GoofCord hits this exact path on Electron 41.3.0 — the issues span 26.x–35.x and none confirms 41.x fixed/unfixed).
**How to confirm:** If H1's getDisplayMedia log *does* fire on the 2nd click but the main `setDisplayMediaRequestHandler` callback does NOT fire (add a log as the first line inside the handler), → H2 confirmed (fault is in Electron's dispatch, between the renderer request and the handler).
**Fix direction:** Avoid the wedged-deny state. Candidate fixes, cheapest first: (a) ensure `callback` is invoked **exactly once** and the picker window is fully closed/destroyed before the renderer can re-request; (b) test whether denying with a *different* callback shape (e.g. not `{}`) avoids the wedge; (c) as a last resort, the native system picker path (`useSystemPicker`) — but per Electron docs this is **macOS-only/experimental**, so NOT viable on Windows. (d) If Electron 41 truly wedges, a re-arm workaround may be required (see Investigation).

### H3 (POSSIBLE) — `callback({})` then `window.close()` ordering, or double-callback, corrupts the request state

**Why:** In the cancel branch the order is `callback({})` → `window.close()`. The `"closed"` handler guards with `if (activeRequests.has(wcId))` and the select branch already `delete`d the entry, so the guard *should* prevent a double `callback({})`. But: (1) if `selectScreenshareSource` runs with `!req` (entry already deleted by a racing `closed`), it `return`s **without ever calling `callback`** — leaving the Electron request hanging (no resolve, no reject) → feeds directly into H2's wedge. (2) Calling `callback({})` and *then* synchronously closing the window is fine, but if any path calls `callback` twice or zero times, Electron's request bookkeeping can desync.
**Evidence:** Direct code read (HIGH on the code paths; MEDIUM that a race actually occurs — depends on Electron event timing on Windows).
**How to confirm:** Add logs at every `callback(...)` site and the `!req` early-return. Reproduce cancel; verify `callback` is called **exactly once** per request and the early-return never fires. A `!req` early-return during cancel = smoking gun for a hung request.
**Fix direction:** Guarantee exactly-once callback. Ensure the `!req` branch in `selectScreenshareSource` cannot strand a request, and that `closed` and `select` cannot both fire-or-both-skip the callback.

### H4 (LESS LIKELY) — picker `BrowserWindow` not fully destroyed; orphan holds the `callback` / focus

**Why:** If `window.close()` doesn't lead to `"closed"` (e.g. a `close`-prevented window, or close handler elsewhere), the old picker could linger, and Electron might consider a capture still pending.
**Evidence:** No `close`-prevention is present in `screenshare.ts` (unlike the main window). LOW that this is the cause, but cheap to rule out.
**How to confirm:** Log in the `"closed"` handler; confirm it fires once per cancel and `window.isDestroyed()` is true before the 2nd attempt.

### H5 (LEAST LIKELY) — Windows `"loopback"` audio path interaction

**Why:** On the cancel path no audio is ever started (`callback({})` short-circuits before the audio block), so loopback is not implicated in the *cancel→no-picker* bug. It is a **separate** active requirement (correct system-audio capture), not this symptom. Keep separate.
**Evidence:** Code read — cancel branch returns before audio handling (HIGH).

---

## Data Flow: the `"loopback"` audio path (separate audio bug)

```
picker (Windows, non-patchcord): audio-share-checkbox checked
   → audioConfig.mode = "system"
selectScreenshareSource: audioConfig.mode !== "none"
   → NOT (hasPipewirePulse && linux)            ← Windows falls to else
   → result.audio = "loopback"
callback({ video:{…}, audio:"loopback" })
   → Electron maps "loopback" to system loopback capture (Chromium WebRTC)
```

**Where it can silently fail on Windows (MEDIUM, from Electron issues + general knowledge):**
- Electron's `"loopback"` string must be honored by the build/Chromium; recent Electron versions have a separate "Broken Desktop Audio Capture" report (#49607) — verify loopback still works on 41.3.0.
- `enableLocalEcho` is **not** set; without it, system audio may be muted locally during capture (by design) but should still be in the stream — confirm the *remote* viewer hears audio vs. the local muting being mistaken for failure.
- The renderer patch's virtmic/`getVirtmic()` swap only runs if a `vencord-screen-share`/`GoofCord-Virtual-Mic` device is found; on Windows that's absent, so the `"loopback"` track from Electron is what's actually streamed — confirm Electron actually attaches an audio track when `audio:"loopback"`.
- Loopback requires the request to have `audioRequested`; if Discord's `opts` didn't request audio, Electron may ignore `result.audio`. Verify `request.audioRequested` on the Windows path.

Treat audio as a **second, independent investigation** after the cancel/re-click bug is closed.

---

## Suggested Investigation / Build Order

Bisect the pipeline top-down to localize "button does nothing" with the fewest Windows builds (each build = a CI artifact + manual test, so minimize round-trips by adding **all** probes at once).

1. **One instrumented build, three log points (single CI round-trip):**
   - (A) first line of patched `getDisplayMedia` in `screensharePatch.ts` — "renderer requested capture";
   - (B) first line inside `setDisplayMediaRequestHandler` callback — "main handler fired";
   - (C) every `callback(...)` site + the `!req` early-return + the `"closed"` handler in `screenshare.ts` — "callback invoked (n times)".
2. **Run the manual repro:** start → cancel → click again. Read logs:
   - 2nd click, **A does NOT fire** → **H1** (renderer state). Fix is renderer-side error-shape/UI-state; no main-process change.
   - 2nd click, **A fires, B does NOT** → **H2** (Electron dispatch wedge). Focus on exactly-once callback + window teardown; evaluate Electron-version workaround.
   - **B fires but no window shows** → picker window creation/`loadFile`/`show` regression → **H4**.
   - During the *first* cancel, **C shows the `!req` early-return or ≠1 callback** → **H3** (hung/double callback) — fix first regardless, it feeds H2.
3. **Apply the smallest fix for the confirmed hypothesis**, rebuild, re-test the same repro. Keep the diff surgical (upstream-PR constraint).
4. **Only then** address Windows `"loopback"` audio as a separate change, verified independently.

---

## Anti-Patterns (specific to this flow)

### Re-registering `setDisplayMediaRequestHandler` per request
**What people do:** Call `setDisplayMediaRequestHandler` again on each capture, or in a place that runs more than once. **Why it's wrong:** Electron #39566 shows re-registration is exactly what breaks the second call. **Do this instead:** Register once (GoofCord already does — keep it that way; do not "fix" by re-registering inside the handler).

### Throwing from inside the handler instead of calling `callback`
**What people do:** `throw`/reject inside the `setDisplayMediaRequestHandler` body to signal cancel. **Why it's wrong:** #47980 — Electron stalls `getDisplayMedia`, no callback, subsequent attempts wedge. **Do this instead:** Always call `callback` exactly once (`callback({})` to deny). GoofCord does this; the risk is the `!req` path that returns *without* calling it (H3).

### Assuming `NotAllowedError` is the universal "user cancelled" signal
**What people do:** Normalize all picker dismissals to `NotAllowedError`. **Why it's wrong:** Clients may branch on `.name` — `AbortError` (user aborted) vs `NotAllowedError` (permission denied) trigger different UI recovery. The wrong one can latch the button. **Do this instead:** Match the error the real browser raises for *user cancellation* and verify Discord re-arms on it.

---

## Sources

- `src/windows/screenshare/screenshare.ts` (read) — main handler, `activeRequests`, cancel paths — HIGH
- `src/windows/screenshare/preload/preload.mts` (read) — picker IPC, Esc/back-out, empty-id select — HIGH
- `src/windows/main/renderer/postVencord/screensharePatch.ts` (read) — getDisplayMedia patch, NotAllowedError — HIGH
- `src/windows/main/main.ts:81` (read) — handler registered once per window — HIGH
- git `710cfde` (read) — the cancellation→NotAllowedError fix that exposed the re-click bug — HIGH
- [electron/electron #39566 — setDisplayMediaRequestHandler can't be used twice](https://github.com/electron/electron/issues/39566) — symptom match (silent no-callback on 2nd request) — MEDIUM (version coverage 26.x, not confirmed for 41.x)
- [electron/electron #47980 — must handle exceptions and user cancellation](https://github.com/electron/electron/issues/47980) — deny/cancel can wedge subsequent attempts — MEDIUM
- [electron/electron #45517 — Unhandled rejection in setDisplayMediaRequestHandler](https://github.com/electron/electron/issues/45517) — `{video:undefined}` throws in main; `{}` is the clean deny — MEDIUM
- [electron/electron #49607 — Broken Desktop Audio Capture](https://github.com/electron/electron/issues/49607) — loopback audio regressions to check — LOW/MEDIUM
- [Electron session docs — setDisplayMediaRequestHandler](https://www.electronjs.org/docs/latest/api/session) — callback signature, `useSystemPicker` is macOS-only/experimental — HIGH
- [MDN getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia) — `AbortError` vs `NotAllowedError` semantics — HIGH

---
*Architecture research for: Electron screenshare request/cancel/restart lifecycle (Windows)*
*Researched: 2026-05-29*
