# Feature Research

**Domain:** Screenshare source selection / cancellation / restart UX in an Electron Discord client (GoofCord, wrapping Vencord) on Windows
**Researched:** 2026-05-29
**Confidence:** HIGH (cancel→restart contract, Windows loopback audio); MEDIUM (Discord renderer state-machine internals — verified by behaviour and the closest comparator Vesktop, not Discord source)

> Scope note: This is a brownfield **bug-fix** milestone, not a feature build. "Features" below describe the EXPECTED, correct behaviour of the screenshare flow so we can define what "fixed" means. The two target behaviours are: (1) cancelling the source picker cleanly aborts and lets the user immediately start again, and (2) Windows system/app audio is captured when the user opts in. Differentiators are explicitly out of scope for this milestone and listed only to mark the boundary against scope creep.

## The Core Contract: cancel → restart (testable)

This is the heart of the bug. State it precisely.

**Standard browser/Discord behaviour when a user cancels a `getDisplayMedia()` prompt:**

1. The user clicks the share button → app calls `navigator.mediaDevices.getDisplayMedia({ video: …, audio: … })` (inside a user-gesture / transient-activation context).
2. The user dismisses/cancels the picker without choosing a source.
3. **The returned promise REJECTS with `DOMException("…", "NotAllowedError")`.** This is the standard signal browsers raise for both "permission denied" and "user dismissed the chooser" (MDN). Discord's web client recognises `NotAllowedError` as a benign cancellation and swallows it silently — no error toast, no broken stream. (HIGH — MDN; matches the codebase fix comment in `screensharePatch.ts`.)
4. **The host client resets its own "start stream" UI state synchronously in the promise's catch/finally.** Because the call must originate from a user gesture, Discord does not keep a latched "in-flight" flag after the promise settles; the next click is a fresh gesture that calls `getDisplayMedia()` again. (MEDIUM — inferred from web semantics + Vesktop comparator.)
5. **A second click immediately re-opens the picker and a normal stream can start.** No restart required.

**The contract, as an acceptance test:**

> GIVEN a screenshare has not started
> WHEN the user opens the source picker and cancels it (button, window close, Esc)
> THEN `getDisplayMedia()` rejects with `NotAllowedError`, Discord shows no error, the start-stream control returns to its idle/clickable state,
> AND WHEN the user clicks start again
> THEN the picker window appears again and a source can be selected and streamed — with no app restart.

**Where GoofCord currently diverges (the bug):** The `NotAllowedError` re-throw (`710cfde`) fixed step 3's crash, but the second click produces **no picker at all** (`PROJECT.md` Active). The cross-app cancel contract is provably workable with GoofCord's exact pattern — **Vesktop, the canonical Vencord Electron client, signals cancel with the same `callback({})` and re-opens fine** because its handler holds no per-request state across invocations. So the defect is in GoofCord's *per-request lifecycle*, not in the browser/Discord contract:

- `setDisplayMediaRequestHandler` stores per-request state in `activeRequests` keyed by `webContents.id` and registers a `capturerWindow.once("closed", …)` that also calls `callback({})`.
- On cancel via `selectScreenshareSource(null, …)`, the entry is deleted and the window `.close()`d — but the `closed` handler then fires. It is guarded by `activeRequests.has(wcId)`, so the callback is not double-invoked *in that path*. The stuck-second-click symptom points at residual state that survives a cancel: a `webContents.id` collision/reuse, an `initialPromise` left pending, or the renderer-side Discord stream-start flag never clearing because the rejection arrives via a path Discord doesn't treat as a reset. (MEDIUM — this is the hypothesis to validate in implementation; consistent with Electron issues [#47980](https://github.com/electron/electron/issues/47980) and [#39566](https://github.com/electron/electron/issues/39566).)

**Key Electron-level facts that constrain the fix (HIGH):**

- There is **no first-class cancel API** for `setDisplayMediaRequestHandler`. The two ways to end the request are: call `callback({})` (no video) → `getDisplayMedia()` rejects; or throw inside the handler → unhandled rejection / hang. The handler **must** resolve the callback exactly once per request, on every path including window-close. ([#47980](https://github.com/electron/electron/issues/47980))
- If the callback is never called (or an exception escapes the handler), the next request's callback "simply won't be called anymore, making the app wait forever" — i.e. a **silent stuck picker on the second attempt**, exactly the reported symptom. ([#47980](https://github.com/electron/electron/issues/47980), [#39566](https://github.com/electron/electron/issues/39566))
- The handler itself stays registered for the app lifetime; it re-fires per request. Re-registration is not required and not the fix. (Electron `session` docs.)

## Feature Landscape

### Table Stakes (Must Work — the definition of "fixed")

Expected behaviour that MUST work. Missing/broken = product feels broken (and is, today).

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Cancel cleanly aborts the request | Every screen-capture UI lets you back out without consequences | LOW–MEDIUM | Callback resolved exactly once with `{}` on every cancel path (button, window-close, Esc); rejects `getDisplayMedia` as `NotAllowedError`. |
| `NotAllowedError` on cancel (not a generic/uncaught error) | Discord's web client only treats `NotAllowedError` as a benign cancel | LOW | Already shipped (`710cfde`). Keep — it matches MDN's standard. |
| No error toast / crash on cancel | Cancelling is a normal action, not a failure | LOW | Depends on the `NotAllowedError` mapping above. |
| **Immediate restart after cancel** (re-click re-opens picker) | A cancel must not poison future requests | MEDIUM | **The core remaining bug.** Requires all per-request state (`activeRequests` entry, pending `initialPromise`, picker window, renderer stream-start flag) to be fully torn down on cancel so the next `getDisplayMedia` is a clean request. |
| Source picker lists screens + windows with thumbnails | Users must see and choose what to share | LOW | Already works (`desktopCapturer.getSources` with thumbnails). |
| Selecting a source starts the stream | Primary happy path | LOW | Already works. |
| Single callback invocation per request | Electron contract; double-callback corrupts state | LOW | Guard `closed` vs `selectScreenshareSource` so the callback fires exactly once. Currently guarded by `activeRequests.has(wcId)` — verify no path double-fires or skips. |
| Windows system/app audio captured when user opts into audio | If the user toggles audio on, audio must actually be in the stream | MEDIUM | `result.audio = "loopback"` in the handler **AND** the renderer's `getDisplayMedia({ audio: true })`. Both are required (see Dependencies). |
| Audio toggle in the picker (on/off) | Users decide per-stream whether to share audio | LOW | Already present (`audioConfig.mode`). Must map to `audio:true` + `loopback` on Windows. |

### Differentiators (OUT OF SCOPE this milestone — boundary markers only)

Listed to prevent scope creep. PROJECT.md explicitly excludes new streaming features.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Resolution / framerate / content-hint controls | Power-user quality tuning | — | Already exists (`screensharePatch.ts` applies constraints). Don't extend; don't regress. |
| Refresh sources button | Update thumbnails without reopening | — | Already exists (`refreshScreenshareSources`). On Wayland it skips re-fetch to avoid re-triggering the portal — Windows-irrelevant but must not regress. |
| Per-application audio selection (PipeWire/patchcord) | Granular Linux audio | — | Linux-only path; out of scope, must not regress. |
| Live preview of selected source | Confidence before going live | HIGH | Not present; explicitly defer. |

### Anti-Features (Behaviours that BREAK the host client's state machine — must NOT do)

These are the failure modes to design *against*. Each maps to a way Discord/Electron's screenshare state gets stuck.

| Anti-Feature | Why It Seems OK / Why Requested | Why Problematic | Correct Alternative |
|--------------|---------------------------------|-----------------|---------------------|
| Resolving the callback more than once per request | "Make sure cancel is handled in both close and select" | Second invocation hits a consumed request → Electron internal state desyncs → next request's callback never fires (the stuck second click). | Resolve exactly once; delete the `activeRequests` entry *before* calling the callback; guard the `closed` handler so it no-ops if the entry is gone. |
| Letting the callback never be called / throwing out of the handler | Looks like "just bail on error" | `getDisplayMedia` hangs forever; subsequent requests' callbacks stop firing; can persist across sessions. ([#47980](https://github.com/electron/electron/issues/47980), [#39566](https://github.com/electron/electron/issues/39566)) | Always call `callback({})` in a `try/finally`/close handler so every path settles the promise. |
| Swallowing the cancellation in the renderer so Discord never sees a rejection | "Avoid the error toast by not rejecting" | Discord's start-stream flag stays latched "in-flight" → re-click is ignored → no picker. This is the likely current symptom. | Reject `getDisplayMedia` with `NotAllowedError` so Discord runs its own reset path. Don't resolve with an empty/track-less stream. |
| Resolving `getDisplayMedia` with a stream that has no video track | "Return something instead of failing" | A video-less display stream is invalid; Discord either errors or enters a bad stream state. `getDisplayMedia` requires a video track. | On cancel, reject — never resolve a track-less stream. |
| Re-registering / nulling `setDisplayMediaRequestHandler` between requests as a "reset" | Mirrors advice for handler swaps | The handler is meant to live for the app lifetime; tearing it down mid-flight is itself a documented cause of "can't be used twice". ([#39566](https://github.com/electron/electron/issues/39566)) | Register once; keep it stateless across requests; reset only per-request state. |
| Leaving the picker `BrowserWindow` or its `initialPromise` alive after cancel | "Reuse the window / the prefetch" | Stale window/promise tied to an old `webContents.id` can collide with or shadow the next request. | Close the window and clear `initialPromise` on every terminal path. |
| Suppressing/handling cancel only in the custom picker without rejecting upstream | Keeps the picker self-contained | Custom picker is "done" but Discord's button never resets — the exact regression introduced after `710cfde`. | The picker's cancel must propagate all the way to a `getDisplayMedia` rejection. |
| Capturing audio without the user opting in | "Just always include system audio" | Privacy surprise; can also change track negotiation unexpectedly. | Only set `audio:"loopback"` when the user's audio toggle is on AND `getDisplayMedia` requested `audio:true`. |

## Windows system/application audio — expected behaviour (HIGH)

What "audio works on Windows when the user opts in" means concretely:

1. **Renderer must request audio.** The patched `getDisplayMedia` call must include `audio: true` in its options when the user wants audio. This is the signal that tells Electron/Chromium to allocate an audio track and defer routing to the main process. Without `audio: true` in the request, **no audio track is created even if the handler sets `loopback`** — the audio is silently dropped. (HIGH — multiple sources; confirmed Electron flow.)
2. **Handler returns loopback.** On Windows, the main-process handler sets `result.audio = "loopback"` (or `"loopbackWithMute"` to also mute local playback). This is GoofCord's existing Windows path. (HIGH — Electron `desktopCapturer`/`session` docs; matches Vesktop's `if (choice.audio && process.platform === "win32") streams.audio = "loopback"`.)
3. **Result:** the returned `MediaStream` contains a real system-audio track (not a silent buffer — silence is a macOS-specific caveat, not Windows). The renderer should set `audioTrack.contentHint = "music"` (already done) and leave the loopback track in place — it must NOT strip it the way the Linux virtmic path does.
4. **Windows loopback captures all system output** (no built-in per-app exclusion in Electron; [#25120](https://github.com/electron/electron/issues/25120) closed as not-planned). That's expected; per-app isolation is the Linux/patchcord domain, out of scope here.
5. **Verification:** the started stream's `stream.getAudioTracks()` is non-empty and a listener actually hears desktop audio. The most likely current defect is a missing/mismatched `audio:true` in the request, or the loopback track being removed/overwritten by the virtmic branch on a platform check.

**The likely Windows-audio bug shape:** the picker's audio toggle sets `audioConfig.mode !== "none"` → handler sets `result.audio = "loopback"`, but the renderer-side `getDisplayMedia` call does not pass `audio: true` (or Discord's own request omits it), so Chromium never creates the track. Fix must guarantee the request and the handler agree.

## Feature Dependencies

```
Immediate restart after cancel
    └──requires──> Callback resolved exactly once on every cancel path
                       └──requires──> Per-request state fully torn down on cancel
                                          (activeRequests entry + initialPromise + picker window)
    └──requires──> getDisplayMedia rejects with NotAllowedError
                       └──requires──> Renderer maps Electron's empty-callback rejection to NotAllowedError  (DONE, 710cfde)
                       └──enables──> Discord resets its own start-stream UI state

Windows system audio captured
    └──requires──> handler sets result.audio = "loopback"            (main process)
    └──requires──> getDisplayMedia called with audio:true            (renderer)   [BOTH required — neither alone works]
    └──conflicts──> Linux virtmic track-replacement branch (must be platform-gated so it never strips the loopback track on Windows)

Single callback invocation  ──enables──>  Immediate restart after cancel
Double callback invocation  ──breaks──>   the Electron request state machine (anti-feature)
```

### Dependency Notes

- **Restart requires single, complete teardown:** the second-click failure is the visible proof that *some* per-request state isn't reset. The callback contract (exactly once, every path) and full teardown are the two halves of the fix.
- **Restart requires a real rejection:** if Discord never receives a `NotAllowedError` (because the renderer swallowed it or resolved empty), its internal "going live" flag stays set and the re-click is ignored. The renderer-side rejection is load-bearing for the host's reset.
- **Windows audio is an AND, not an OR:** `audio:true` (renderer request) **and** `audio:"loopback"` (handler) must both be present. This is the single most common cause of "audio toggle does nothing" on Windows.
- **Linux audio path conflicts with Windows loopback:** the virtmic branch in `screensharePatch.ts` stops/removes audio tracks and adds a virtmic track. That must remain Linux-only; on Windows it must leave the loopback track untouched.

## MVP Definition (what "fixed" ships with)

### Launch With (the fix)

- [ ] Cancel resolves the handler callback exactly once on every path (select-null, window close, Esc) — *closes the stuck-second-click bug*.
- [ ] Full per-request teardown on cancel (delete `activeRequests` entry, drop `initialPromise`, close picker window) — *the state that wasn't being reset*.
- [ ] `getDisplayMedia` rejects with `NotAllowedError` on cancel so Discord resets its start-stream state — *keep `710cfde`, verify it actually triggers Discord's reset*.
- [ ] Re-click after cancel re-opens the picker and starts a normal stream, no restart — *the acceptance test above*.
- [ ] Windows: user audio opt-in produces a real audio track (renderer `audio:true` + handler `loopback`, Linux branch not stripping it).

### Add After Validation

- [ ] (none — bug-fix milestone; new features are explicitly out of scope per PROJECT.md.)

### Future Consideration

- [ ] Defer everything in PROJECT.md "Out of Scope" (broader Windows streaming campaign, new quality UI, architecture rewrite).

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Immediate restart after cancel (single-callback + teardown) | HIGH | MEDIUM | P1 |
| `NotAllowedError` on cancel → Discord reset | HIGH | LOW (mostly done) | P1 |
| Windows system audio on opt-in (`audio:true` + `loopback`) | HIGH | MEDIUM | P1 |
| No crash / no error toast on cancel | HIGH | LOW (done) | P1 |
| Source list + thumbnails + select | HIGH | LOW (done) | P1 (don't regress) |
| Quality / refresh / Linux audio | MEDIUM | — | P3 (don't regress, don't extend) |

## Comparator Analysis (closest references)

| Behaviour | Vesktop (Vencord's official Electron client) | Browser / Chromium standard | GoofCord (target) |
|-----------|----------------------------------------------|-----------------------------|-------------------|
| Cancel signal to Electron | `callback({})` on no-choice / no-sources | n/a (native picker rejects) | `callback({})` — same pattern; must fire once, every path |
| getDisplayMedia rejection on cancel | rejects (renderer modal rejects "Aborted"; empty callback → reject) | `NotAllowedError` | `NotAllowedError` (keep `710cfde`) |
| Re-open after cancel | Works — handler is stateless across requests | Works — fresh gesture | Must work — fix per-request teardown |
| Windows system audio | `streams.audio = "loopback"` only when user toggles audio (win32) | `getDisplayMedia({audio:true})` native loopback | `audio:"loopback"` + renderer `audio:true` |
| Picker re-registration | Registered once for app lifetime | n/a | Keep registered once; reset per-request state only |

**Takeaway:** GoofCord already mirrors Vesktop's working pattern at the surface. The divergence — and therefore the bug — is in GoofCord's extra per-request bookkeeping (`activeRequests`, `initialPromise`, the `closed` handler) and possibly an `audio:true` mismatch, not in the cross-app cancel contract.

## Sources

- MDN — `MediaDevices.getDisplayMedia()` (NotAllowedError on cancel; video track required; user-gesture requirement): https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia (HIGH)
- Electron issue #47980 — "setDisplayMediaRequestHandler must handle exceptions and user cancellation" (no first-class cancel API; uncaught exception → hang / callback never fires again): https://github.com/electron/electron/issues/47980 (HIGH)
- Electron issue #39566 — "setDisplayMediaRequestHandler can't be used twice" (callback silently not firing on second request; state not reset): https://github.com/electron/electron/issues/39566 (HIGH)
- Electron `session` docs — `setDisplayMediaRequestHandler` callback shape (`video`, `audio: "loopback" | "loopbackWithMute"`, `enableLocalEcho`, `useSystemPicker`): https://www.electronjs.org/docs/latest/api/session (HIGH)
- Electron `desktopCapturer` docs — recommended handler callback example: https://www.electronjs.org/docs/latest/api/desktop-capturer (HIGH)
- Vencord/Vesktop `src/main/screenShare.ts` — `callback({})` on cancel; `streams.audio = "loopback"` for win32 (canonical comparator): https://github.com/Vencord/Vesktop/blob/main/src/main/screenShare.ts (MEDIUM — fetched summary)
- Vencord/Vesktop `ScreenSharePicker.tsx` — modal rejects "Aborted" on dismiss; Windows "Stream With Audio" toggle: https://github.com/Vencord/Vesktop/blob/main/src/renderer/components/ScreenSharePicker.tsx (MEDIUM)
- Electron issue #25120 — Windows desktop audio capture / no per-app exclusion (loopback captures all system audio): https://github.com/electron/electron/issues/25120 (MEDIUM)
- electron-audio-loopback (loopback/loopbackWithMute semantics, Electron >= 31, `getDisplayMedia` needs video:true): https://github.com/alectrocute/electron-audio-loopback (MEDIUM)
- GoofCord codebase: `src/windows/screenshare/screenshare.ts`, `src/windows/main/renderer/postVencord/screensharePatch.ts`, `.planning/PROJECT.md` (HIGH — primary)

---
*Feature research for: Electron Discord-client screenshare cancel/restart + Windows audio (bug-fix milestone)*
*Researched: 2026-05-29*
