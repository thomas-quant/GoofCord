# Pitfalls Research

**Domain:** Electron custom screenshare picker (`session.setDisplayMediaRequestHandler`) — cancellation/restart lifecycle + Windows `"loopback"` audio capture
**Researched:** 2026-05-29
**Confidence:** MEDIUM-HIGH (Electron callback/lifecycle semantics: HIGH from official docs + multiple issue reports; Discord-renderer stuck-UI behavior: MEDIUM, inferred from code + cancellation-API gaps; Electron 38→41 Windows regressions: MEDIUM, no single confirmed regression matching this exact symptom)

> **Two target bugs this research must explain:**
> - **Bug A — "inert button":** After cancelling the picker, the second "start stream" click does nothing (no picker window appears).
> - **Bug B — "missing audio":** Windows system/app audio (`result.audio = "loopback"`) is not captured during screenshare.

---

## Critical Pitfalls

### Pitfall 1: Treating the cancel path as "fire callback({}) and forget" — leaving `getDisplayMedia` rejection to corrupt Discord's stream-start state (Bug A)

**What goes wrong:**
GoofCord's cancel path (`screenshare.ts:61-65` and the `closed` handler at `:118-123`) calls `callback({})`. An empty `streams` object means "no video track granted," so Electron/Chromium **rejects** the `getDisplayMedia()` promise in the renderer. The renderer patch (`screensharePatch.ts:24-31`) catches *any* rejection and re-throws a synthetic `NotAllowedError`. That stopped the uncaught-error crash (#196 / `710cfde`) — but the rejection still propagates into Discord's go-live flow. Discord's web client sets an internal "stream pending / starting" flag *before* it calls `getDisplayMedia`, and only clears that flag on the success path. A rejection it interprets as a hard permission denial (rather than a user cancel) can leave that flag latched, so the next "start stream" click is a no-op — Discord thinks a stream-start is already in flight and never re-enters the path that triggers `getDisplayMedia` (so the handler never fires and no picker window is created).

**Why it happens:**
There is **no first-class "user cancelled" signal** in Electron's `setDisplayMediaRequestHandler` API. The community has repeatedly hit this exact gap (electron/electron #47980: *"There is no other way to tell electron `setDisplayMediaRequestHandler()` and the waiting `getDisplayMedia()` that the selection was aborted"*). Developers improvise — `callback({})`, throwing, or never calling back — and each improvisation produces a *different-shaped* rejection. Browsers signal genuine user cancellation of the native picker with `NotAllowedError` (an `AbortError`-adjacent path Discord handles gracefully); a generic "no video" rejection is **not** the same code path inside Discord even after you relabel the DOMException name, because the timing and the surrounding go-live state machine differ.

**How to avoid:**
Make cancel look, to Discord, exactly like a normal native-picker cancel, *and* ensure no state is left latched:
- The renderer relabel to `NotAllowedError` is correct and should stay — but verify it is thrown **synchronously enough** that Discord's go-live reducer runs its `catch`/cleanup branch. Confirm Discord clears its "starting stream" state on a thrown `NotAllowedError`; if it only clears on `AbortError`, switch the synthetic exception's name to `"AbortError"` and re-test.
- On the main side, the cancel callback shape is the lever. Calling `callback({})` is the documented way to "grant nothing." Consider instead **not granting and letting the renderer be the single source of the rejection** — i.e. keep `callback({})` but make sure you only call it **once** (see Pitfall 3) and that the picker window is always torn down.
- Most importantly, **find and reset Discord's stream-start flag**. Even with a clean rejection, if the symptom persists, the latched state is on Discord's side. Options: dispatch the Flux action Discord uses to abort go-live, or null-and-reset whatever store flag (e.g. an `ApplicationStreamingStore` / go-live "pending" boolean) gates re-entry. This is the renderer-side state the PROJECT brief flags as "not being reset on cancel."

**Warning signs:**
- Second "start stream" click produces **no picker window** (handler not invoked) — proves re-entry is blocked in the renderer *before* it reaches `getDisplayMedia`. If the handler *were* invoked, you'd at least see the window.
- A reload of Discord "fixes" it for exactly one more attempt — classic latched-flag signature.
- `console.log` in the handler (`screenshare.ts:97`) never prints on the second click.

**Phase to address:** Cancellation/restart phase (Bug A) — this is the primary hypothesis for the inert button.

---

### Pitfall 2: Assuming the bug is "Electron can't be used twice" — chasing an Electron bug that the evidence says isn't real (Bug A misdiagnosis)

**What goes wrong:**
There's a tempting issue title — electron/electron #39566 *"setDisplayMediaRequestHandler can't be used twice"* — that looks like a perfect match: handler set, stream captured, second time the callback is never called. Anchoring on it leads to a wrong fix (re-registering the handler each time, calling `setDisplayMediaRequestHandler(null)` between requests, recreating the session, etc.) that adds churn without fixing the symptom.

**Why it happens:**
The title pattern-matches the symptom. But the reporter **could not reproduce it in a clean Electron Fiddle** ("Tested in the Fiddle and couldn't reproduce the issue... will keep looking into my code") — i.e. it was **their own application state**, not an Electron defect. GoofCord registers the handler **once** at startup (`registerScreenshareHandler` → `setDisplayMediaRequestHandler` at `:97`) and never re-sets it, so "can't set it twice" doesn't even apply here. The handler is a persistent callback that fires every time the renderer calls `getDisplayMedia`; the problem is the renderer not *making* the second call, not Electron refusing to invoke a re-registered handler.

**How to avoid:**
- Do **not** re-register or null the handler between requests. Registering once is correct and matches Electron's design.
- Treat #39566's conclusion as evidence the defect is in the *consumer's* lifecycle state (Discord renderer + GoofCord's `activeRequests` map), which is exactly where Pitfalls 1 and 3 point.
- Prove the handler is alive on the second attempt with a log at the top of the handler before any other change.

**Warning signs:**
- A proposed fix involves `setDisplayMediaRequestHandler(null)` or re-calling the setter — stop; you're chasing #39566.

**Phase to address:** Cancellation/restart phase (Bug A) — diagnostic guardrail.

---

### Pitfall 3: Double-callback and "Object has been destroyed" from overlapping cleanup paths in the per-`webContents` request map (Bug A reliability)

**What goes wrong:**
GoofCord has **two** paths that delete the request and invoke the callback: the explicit select/cancel handler (`selectScreenshareSource`, `:54-87`) and the window `closed` handler (`:118-123`). The select handler does `activeRequests.delete(...)` *then* `callback({})` *then* `window.close()`. Closing the window fires the `closed` event; the `closed` handler guards with `if (activeRequests.has(wcId))` — so today the guard prevents a *second* callback. But this is fragile: any refactor that (a) reorders the delete after the close, (b) early-returns before deleting, or (c) adds an `await` between the `activeRequests.get` and the `delete` opens a window where **two callbacks fire for one request**, or where a callback fires for a `webContents`/window that has already been destroyed → `TypeError: Object has been destroyed`. Calling the Electron `callback` twice is undefined behavior and can itself wedge the next request.

**Why it happens:**
The cancel/close/select paths race because window teardown is asynchronous and the cleanup is spread across two handlers plus an event. The `frame.executeJavaScript` and the awaited `patchcordStart*` (`:68`, `:76`) introduce `await` points *after* the map entry is read but while the window may close (user clicks the OS close button mid-await), so the `closed` handler can run concurrently. The `frame` (`request.frame`, a `WebFrameMain`) can also be destroyed if Discord navigates/reloads while the picker is open, making `frame.executeJavaScript` reject (currently swallowed with `.catch(() => {})`, which is correct) or throw "Object has been destroyed" if not guarded.

**How to avoid:**
- **Single-owner cleanup.** Funnel all teardown through one function, e.g. `function finishRequest(wcId, result) { const req = activeRequests.get(wcId); if (!req) return; activeRequests.delete(wcId); try { req.callback(result); } catch {} if (!req.window.isDestroyed()) req.window.close(); }`. Call it from select, cancel, and `closed`. The `if (!req) return` guard makes the callback exactly-once by construction.
- **Delete-before-callback** ordering is already correct in `selectScreenshareSource` — preserve it. The map deletion is the idempotency token.
- Guard every `window`/`frame` access with `isDestroyed()` (the code already does for `window`; do the same conceptually for `frame` — the `.catch()` covers it).
- Snapshot `callback` and `window` into locals before any `await` (already done at `:59`) so a concurrent `closed` handler can't observe a half-mutated entry.

**Warning signs:**
- Intermittent `TypeError: Object has been destroyed` in main-process logs after closing/cancelling.
- Sporadic double-rejection or a stream that "starts then immediately stops."
- Memory growth in `activeRequests` (entries never deleted) if a path early-returns without cleanup — leaks the picker `BrowserWindow` and its callback closure per cancelled attempt.

**Phase to address:** Cancellation/restart phase (Bug A) — refactor cleanup into one path before touching anything else.

---

### Pitfall 4: Expecting `useSystemPicker` to sidestep the Windows cancel bug — it's macOS-only and does not apply here (Bug A non-fix)

**What goes wrong:**
A natural "just use the native picker and let Chromium handle cancel" instinct leads to enabling `useSystemPicker: true`. On Windows this does **nothing useful**: the option is gated to macOS (Sequoia / macOS 15+) in the implementing PRs. On Windows the custom handler still runs and the cancel/restart bug is unchanged. Worse, sprinkling `useSystemPicker` in could *appear* to work on a macOS test box and mask that Windows is untouched — and this fork explicitly must not chase macOS.

**Why it happens:**
Electron's docs describe `useSystemPicker` succinctly ("true if the available native system picker should be used... when available, it will be used and the media request handler will not be invoked") without loudly flagging it as macOS-only in the one-liner. The platform gating ("gate ScreenCaptureKitPicker to macOS 15 or higher") lives in the PR (#43581/#43679/#43680), not the prose.

**How to avoid:**
- Do not enable `useSystemPicker` as a fix for the Windows cancel bug. It cannot help on Windows in Electron 41.
- Keep the custom picker; fix the lifecycle/state (Pitfalls 1 & 3). This also keeps the diff upstream-friendly and surgical, per the PROJECT constraints.

**Warning signs:**
- A "fix" that only verifies on macOS.
- Assuming the native picker's built-in cancel handling is reachable on Windows.

**Phase to address:** Cancellation/restart phase (Bug A) — rule this out early.

---

### Pitfall 5: Granting `audio: "loopback"` without a valid video track / right shape — silent no-audio on Windows (Bug B, primary)

**What goes wrong:**
On Windows, `result.audio = "loopback"` (`screenshare.ts:81`) only yields a working audio track when the request is a normal **video + audio** display-media grant with a *valid* video source. The authoritative community pattern (alectrocute/electron-audio-loopback, the de-facto reference, Electron ≥ 31.0.1) **always requests `{ video: true, audio: true }`** and only afterward strips the video track when audio-only is wanted. Audio-only / `video: false` paths are widely reported to throw `NotSupportedError` or silently produce no audio. If the granted `video` source is malformed/undefined, you also risk `TypeError: video must be a WebFrameMain or DesktopCapturerSource` and an unhandled rejection (electron/electron #45517). GoofCord does grant a video source (`{ video: { id, name, ... } }`), so the more likely failure is that the loopback track is delivered but then **dropped or never wired into the outgoing stream** (see Pitfall 6), or that the host renderer never iterates the captured `audioTracks`.

**Why it happens:**
Chromium implements system-audio loopback as a *rider on the display capture*, not as a standalone capture. The docs only show `callback({ video: sources[0], audio: 'loopback' })` — video and audio together — and never document an audio-only loopback. Developers assume `audio: "loopback"` is independent and forget that the audio track arrives **on the same `MediaStream`** as video and must be explicitly handled.

**How to avoid:**
- Keep granting a real video source alongside `audio: "loopback"` (current code does this — good).
- In the renderer (`screensharePatch.ts`), **confirm the loopback audio track actually arrives**: log `stream.getAudioTracks()` on Windows after `getDisplayMedia` resolves. If empty, the grant shape or Electron build is the problem; if present, the bug is downstream (track dropped / not forwarded to Discord's RTC sender).
- Do **not** call `audioTrack.stop()` / `removeTrack` on the loopback track on Windows. Note the Patchcord branch (`screensharePatch.ts:78-83`) stops and removes **all** audio tracks to swap in the virtual mic — that branch is Linux-only (`getVirtmic` returns null on Windows because there's no `GoofCord-Virtual-Mic` device), so it should not fire on Windows. **Verify** `getVirtmic()` returns null on Windows; if a stale device label matches, the loopback track would be stopped and removed → silent stream. This is a concrete candidate for Bug B.
- Set a sensible `contentHint` on the audio track (code sets `"music"` at `:59`) — fine; don't let constraint application drop it.

**Warning signs:**
- `stream.getAudioTracks().length === 0` on Windows after a loopback grant.
- Viewers see video but hear nothing; no error in renderer console.
- The Linux Patchcord track-removal block runs on Windows (log inside the `if (id)` branch).

**Phase to address:** Windows audio phase (Bug B) — verify track arrival first, then forwarding.

---

### Pitfall 6: Loopback `disable_local_echo` / `loopbackWithMute` confusion — audio captured but muted locally, or echo, leading to "no audio" misdiagnosis (Bug B, secondary)

**What goes wrong:**
Electron hardcodes `disable_local_echo = true` for display-media audio (electron/electron #37293): while a `"loopback"` capture is active, the **user's own speakers are muted** for the captured source. Two failure modes follow:
1. The *streamer* hears their own audio cut out and concludes "audio isn't working," when in fact the remote viewers receive it fine. This is a **misdiagnosis** of Bug B, not a capture failure.
2. If you switch to `"loopback"` (not `loopbackWithMute`) expecting local playback to continue, behavior may not match the hardcoded flag, causing inconsistent results across versions.
`loopbackWithMute` is the variant that *intentionally* mutes local playback while capturing; plain `"loopback"` is documented to "capture system audio" with passthrough, but the hardcoded `disable_local_echo=true` muddies whether passthrough actually occurs.

**Why it happens:**
The `loopback` vs `loopbackWithMute` distinction is under-documented; Electron's own implementation pins `disable_local_echo`, and there's an open feature request to expose it. Developers test by listening on the streaming machine and mistake local muting for capture failure.

**How to avoid:**
- **Test Bug B from the viewer side** (a second account / second machine), never by listening on the streaming machine — local echo is suppressed by design.
- Be deliberate about `"loopback"` vs `"loopbackWithMute"`. For Discord screenshare, `"loopback"` (current code) is the right choice — you want viewers to hear system audio. Don't switch to `loopbackWithMute` unless you specifically want to also mute local playback.
- Document this in any upstream PR so reviewers/users don't reopen it as "audio broken."

**Warning signs:**
- "No audio" reports that only come from the streamer, never from viewers.
- Local system sounds go quiet exactly when the stream starts and return when it stops.

**Phase to address:** Windows audio phase (Bug B) — establish a viewer-side verification protocol before code changes.

---

### Pitfall 7: Assuming an Electron 38→41 regression broke Windows loopback — over-attributing to a version bump (Bug B diagnostic)

**What goes wrong:**
GoofCord pins Electron 41.3.0. It's tempting to attribute Bug B to a recent Electron regression and either downgrade or wait for an upstream fix. The evidence does **not** support a clean, confirmed Windows-`"loopback"` regression in the 38→41 window: the loud recent audio regressions are **macOS** (CoreAudio Tap / ScreenCaptureKit; e.g. #49607 desktop audio silent on macOS in 40.1.0, backported fixes for macOS in 41.x) and a Windows **renderer crash** with `getUserMedia` + `chromeMediaSourceId` (#46369, BadMessage 263) that is a *crash*, not silent-no-audio, and is the legacy `chromeMediaSource` path, not the `setDisplayMediaRequestHandler` `"loopback"` path GoofCord uses. Misattributing wastes a phase on version archaeology.

**Why it happens:**
Recent Electron releases did churn audio capture (macOS CoreAudio Tap enablement, backports to 41) and the changelogs are noisy, so "it's probably a regression" feels plausible. But the churn was macOS-centric; Windows `"loopback"` via display-media has been stable since ~Electron 31.

**How to avoid:**
- Treat "Electron regression" as a *last* hypothesis, after verifying track arrival (Pitfall 5) and the Patchcord-track-removal check.
- If you must test a version hypothesis, pin a known-good older 41.x or a 35.x in a CI build and compare the **viewer-side** result — don't trust local playback (Pitfall 6).
- Avoid downgrading Electron as a fix; it conflicts with the "upstream-friendly, minimal" constraint and the security posture in CONCERNS.md (already on an older series).

**Warning signs:**
- A fix plan that starts with "bisect Electron versions" before any track-level logging.
- Citing the macOS #49607 silence regression as if it applied to Windows.

**Phase to address:** Windows audio phase (Bug B) — diagnostic ordering guardrail.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| `callback: (res: any) => void` typed `any` in `ActiveRequest` | Avoids importing Electron's `Streams` type | Compiler can't catch a malformed cancel/grant shape (the exact class of bug behind #45517) | Never — type it as `Electron.Streams` to make the empty-`{}` vs `{video,audio}` shapes explicit |
| Two cleanup paths (select handler + `closed` event) guarded only by `activeRequests.has` | Works today | Fragile to reordering → double-callback / "Object has been destroyed" (Pitfall 3) | Only until the cancel/restart fix; consolidate into one `finishRequest()` |
| Passing screenshare settings via `window.screenshareSettings` global + `executeJavaScript` | Quick cross-context handoff | Stale global persists if picker reopens/reloads (CONCERNS.md fragile area); can leak into the *next* stream after a cancel | Never for new code — use IPC; but out of this milestone's scope unless it's implicated in the stuck state |
| Synthetic `NotAllowedError` to silence Discord on cancel | Stopped the uncaught crash (#196) | If Discord's go-live state only resets on `AbortError`, this masks the crash but leaves the latched flag (Bug A) | Acceptable as the relabel mechanism; revisit the exception **name** if state doesn't reset |
| Swallowing `frame.executeJavaScript(...).catch(() => {})` | Avoids crash if frame destroyed | Hides genuine settings-injection failures (stream starts at wrong quality) | Acceptable for destroyed-frame safety; consider logging in dev |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| `setDisplayMediaRequestHandler` callback | Calling `callback({})` and assuming it cleanly "denies" with a recognizable cancellation | `{}` grants nothing → renderer rejection; relabel to `NotAllowedError`/`AbortError` AND reset the consumer's pending state. Call the callback **exactly once** |
| `setDisplayMediaRequestHandler` callback | Calling `callback({ video: undefined, audio: 'loopback' })` when no source | Throws `TypeError: video must be a WebFrameMain or DesktopCapturerSource` → unhandled rejection (#45517). Never grant audio without a valid video source |
| `request.frame` (`WebFrameMain`) | Calling `frame.executeJavaScript` after Discord navigated/reloaded | Guard with try/catch or `.catch()` (code does); treat a destroyed frame as a cancel |
| Windows `"loopback"` audio | Expecting audio-only (`video:false`) loopback | Always grant video + `"loopback"`; strip video track later only if audio-only is needed (and not on the streaming path) |
| Discord go-live state | Resetting only main-process `activeRequests` and assuming Discord re-tries | Reset Discord's renderer-side "stream starting/pending" store flag too; main-side cleanup alone doesn't re-arm the renderer |
| Local verification of loopback | Listening on the streaming machine | Verify from a second viewer — `disable_local_echo=true` mutes local playback by design (#37293) |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Leaked `activeRequests` entries on early-return cancel paths | `activeRequests` grows; picker `BrowserWindow` + callback closures never GC'd | Single `finishRequest()` that always deletes the map entry | Every cancelled attempt that doesn't hit cleanup; noticeable after many cancels in one session |
| `desktopCapturer.getSources` with thumbnails on every (re)open | Slow picker open with many windows/screens | Already mitigated via `initialPromise` prefetch + Wayland refresh skip; keep thumbnail size small (320×180 is fine) | High monitor/window counts |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Granting capture without validating `request.frame`/`securityOrigin` | Any frame could trigger system-audio + screen capture | For a Discord-only client this is low-risk, but the handler grants unconditionally; acceptable here, note it in the upstream PR |
| Loopback captures **all** system audio (not per-app) on Windows | Captures audio from unrelated apps (notifications, other calls) into the stream | Document the behavior; per-app capture is the Linux Patchcord feature, not available via Windows `"loopback"` |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Inert "start stream" after cancel (Bug A) | User thinks the app is broken; must restart Discord/app | Reset stream-start state on cancel so the next click re-opens the picker |
| Streamer hears their own audio mute and assumes capture failed (Bug B mirage) | False bug reports; user disables audio sharing | Communicate that local echo is suppressed during capture; verify via viewer |
| No feedback when picker is cancelled | User unsure whether cancel "took" | A clean cancel that immediately re-arms is the fix; no extra UI needed |

## "Looks Done But Isn't" Checklist

- [ ] **Cancel path:** After cancel, a *second* "start stream" actually re-opens the picker — verify the handler logs on the second click, not just that no error is thrown.
- [ ] **Single callback:** The Electron `callback` is invoked **exactly once** per request across select/cancel/close races — verify no double-callback under "click source while OS-closing the window."
- [ ] **No destroyed-object errors:** Cancelling by clicking the window's OS close button (not the in-UI cancel) is clean — verify the `closed` handler path.
- [ ] **Loopback track arrives:** On Windows, `stream.getAudioTracks().length > 0` after a loopback grant — verify with a log, not by ear.
- [ ] **Patchcord block doesn't run on Windows:** `getVirtmic()` returns null on Windows so the audio-track removal loop never executes — verify.
- [ ] **Viewer hears audio:** Confirmed from a second account/machine, not on the streaming box.
- [ ] **No state leak across streams:** After cancel→start→stop→start, quality settings and audio are correct (no stale `window.screenshareSettings`).
- [ ] **Linux/macOS not regressed:** Patchcord (Linux) and any macOS path still work after the cancel-cleanup refactor.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Latched Discord stream-start state (Bug A) | LOW | Identify the go-live "pending" store flag; dispatch the abort/reset action on cancel. Until found, a Discord reload is the user workaround |
| Double-callback / Object destroyed (Pitfall 3) | LOW | Consolidate teardown into one `finishRequest()`; the map-delete guard makes callback exactly-once |
| Loopback track stopped by Patchcord block on Windows (Bug B) | LOW | Gate the track-removal loop on `process.platform !== "win32"` or on a confirmed virtmic device |
| Mistaking local echo muting for no-audio (Bug B mirage) | LOW | Re-verify from a viewer; no code change needed |
| Wrongly attributing to Electron 38→41 regression | MEDIUM | Revert version archaeology; return to track-level logging |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 1 — Cancel corrupts Discord stream-start state | Cancellation/restart (Bug A) | Second "start stream" opens picker; handler logs fire |
| 2 — Misdiagnosing as Electron "can't be used twice" | Cancellation/restart (Bug A) | Confirm handler still invoked on 2nd attempt; no re-register added |
| 3 — Double-callback / stale request map | Cancellation/restart (Bug A) | No "Object has been destroyed"; exactly-once callback under races |
| 4 — `useSystemPicker` won't help Windows | Cancellation/restart (Bug A) | Fix verified on Windows, not macOS; no `useSystemPicker` added |
| 5 — Loopback needs valid video / track dropped | Windows audio (Bug B) | `getAudioTracks().length > 0` on Windows; Patchcord block doesn't run |
| 6 — `disable_local_echo` / loopbackWithMute confusion | Windows audio (Bug B) | Viewer-side audio confirmed; `"loopback"` (not mute variant) retained |
| 7 — Over-attributing to Electron regression | Windows audio (Bug B) | Track logging done before any version test |

## Sources

- **Electron official docs — `session.setDisplayMediaRequestHandler`** (callback `streams` shape; `audio` can be `"loopback"`/`"loopbackWithMute"`, "currently only supported on Windows"; `useSystemPicker` "macOS Experimental", handler not invoked when system picker used): https://www.electronjs.org/docs/latest/api/session — HIGH
- **Electron official docs — `desktopCapturer`** (`callback({ video: sources[0], audio: 'loopback' })` shows video+audio together; macOS audio caveats): https://www.electronjs.org/docs/latest/api/desktop-capturer — HIGH
- **electron/electron #47980** — *"setDisplayMediaRequestHandler must handle exceptions and user cancellation"* (no first-class cancel signal; throwing → unhandled rejection + hang; Electron 32.3.1): https://github.com/electron/electron/issues/47980 — HIGH (confirms the API gap behind Bug A)
- **electron/electron #45517** — *Unhandled rejection in setDisplayMediaRequestHandler* (`video: undefined` → `TypeError: video must be a WebFrameMain or DesktopCapturerSource`; Electron 34.x–35.x): https://github.com/electron/electron/issues/45517 — HIGH
- **electron/electron #39566** — *"setDisplayMediaRequestHandler can't be used twice"* (reporter could NOT reproduce in a Fiddle → it was app state, not Electron; Electron 26.x): https://github.com/electron/electron/issues/39566 — HIGH (key: rules out an Electron-side double-use bug)
- **electron/electron #37293** — *Expose disable_local_echo flag* (Electron hardcodes `disable_local_echo=true`; local speakers mute during loopback capture): https://github.com/electron/electron/issues/37293 — HIGH (explains Bug B "mirage")
- **electron/electron #49607** — *Broken Desktop Audio Capture* (silent audio regression in Electron 40.1.0, **macOS**; video track required; 0×0 → 4×4 workaround): https://github.com/electron/electron/issues/49607 — MEDIUM (relevant context, but macOS not Windows)
- **electron/electron #46369** — *Renderer crash Error 263 on Windows 11* (`getUserMedia` + `chromeMediaSourceId` → BadMessage `DESKTOP_CAPTURER_INVALID_OR_UNKNOWN_ID`; legacy path, a crash not silence): https://github.com/electron/electron/issues/46369 — MEDIUM
- **electron/electron PR #43581 / #43679 / #43680** — *system picker support* (`useSystemPicker` gated to macOS 15+; `cancelCallback` added; handler bypassed when picker used): https://github.com/electron/electron/pull/43581 — HIGH (confirms macOS-only → Pitfall 4)
- **alectrocute/electron-audio-loopback** (de-facto reference: request `{ video:true, audio:true }`, then `track.stop()` + `removeTrack` to drop video; Windows 10+; **Electron ≥ 31.0.1 required**; `loopbackWithMute` option): https://github.com/alectrocute/electron-audio-loopback and https://alec.is/posts/bringing-system-audio-loopback-to-electron/ — HIGH
- **GoofCord source** — `src/windows/screenshare/screenshare.ts` (cancel `callback({})`, dual cleanup, `activeRequests` map, `audio:"loopback"`), `src/windows/main/renderer/postVencord/screensharePatch.ts` (synthetic `NotAllowedError`, Patchcord track removal), `src/windows/main/renderer/preVencord/patches/screenshare.ts` (quality patch), `.planning/PROJECT.md`, `.planning/codebase/CONCERNS.md` — HIGH (direct read)

---
*Pitfalls research for: Electron custom screenshare picker cancellation/restart + Windows loopback audio (GoofCord fork)*
*Researched: 2026-05-29*
