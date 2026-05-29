# Stack Research

**Domain:** Electron desktop/screen capture + Windows system-audio (loopback) capture for a Discord client (GoofCord, a Vencord wrapper)
**Researched:** 2026-05-29
**Confidence:** HIGH (core API surface verified against Electron `main`-branch docs; some regression/behavioural detail is MEDIUM/LOW and flagged inline)

> **Scope note:** This is a *brownfield bug-fix* research pass, not a greenfield stack pick. The "stack" here is the Electron capture API contract the existing code already uses. The goal is to nail down the *exact, current* semantics of `setDisplayMediaRequestHandler`, `getDisplayMedia`, `desktopCapturer.getSources`, and Windows `audio: "loopback"` so the cancel/re-click and audio bugs can be fixed surgically and upstreamed. No new dependencies are recommended.

---

## Recommended Stack

### Core Technologies (already in use — confirmed correct)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Electron | 41.3.0 (Chromium 146, Node 24.14, V8 14.6) | Desktop shell + WebRTC/Chromium capture pipeline | Already pinned; this is the version the bug must be fixed against. All API claims below are checked against Electron `main`/41-line docs. |
| `session.setDisplayMediaRequestHandler` | Electron API (no separate version) | Main-process hook invoked when renderer calls `getDisplayMedia`; lets the app supply the chosen source via `callback({...})` | The *only* supported way to feed a custom source picker into `getDisplayMedia` in Electron. Correct choice; the bug is in *how* it's driven, not the choice of API. |
| `desktopCapturer.getSources` | Electron API | Enumerate `screen`/`window` capture sources (id, name, thumbnail) for the custom picker | Main-process only; returns a `Promise<DesktopCapturerSource[]>`. Correctly used in `fetchScreenshareData`. |
| `navigator.mediaDevices.getDisplayMedia` (renderer) | Web API via Chromium | Renderer entry point that triggers the handler and resolves to a `MediaStream` | Standard. Discord calls it; the existing monkeypatch wraps it. |
| `audio: "loopback"` (callback field) | Electron, **Windows-only** | Capture system audio alongside the video source on Windows | The documented, driver-free Windows loopback mechanism. Correctly used for the non-Linux audio path. |

### Supporting Libraries (existing — no change recommended)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `patchcord` | github:Milkshiift/patchcord | Linux PipeWire/PulseAudio audio routing | Linux only — the `hasPipewirePulse && platform === "linux"` branch. Out of scope for this Windows fix; do not touch. |
| `@vencord/types` | 1.14.1 | Types for `window.Vencord` / Discord internals in the renderer patch | Dev-only; relevant when editing `screensharePatch.ts`. |

### Development / Verification Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `.github/workflows/testBuild.yml` (Windows x64) | Produce a Windows artifact for manual repro | Only reliable way to test — there is no automated screenshare repro. Cancel → re-click and audio capture must be checked by hand on real Windows. |
| Electron docs (`docs/api/session.md`, `desktop-capturer.md`) on the matching version tag | Confirm callback shape per version | Pin doc reads to the `v41.*`/`main` tag, not "latest", since the audio/picker wording is version-sensitive. |

---

## The API Contract (the load-bearing part of this research)

### `session.setDisplayMediaRequestHandler(handler[, opts])` — verified signature (Electron `main`/41)

```
handler(request, callback)
  request:
    frame          WebFrameMain | null   // null if the frame navigated/was destroyed
    securityOrigin String
    videoRequested Boolean
    audioRequested Boolean
    userGesture    Boolean
  callback(streams)
    streams.video           Object {id, name} | WebFrameMain   (optional)
    streams.audio           String | WebFrameMain              (optional)
                              // string MUST be "loopback" or "loopbackWithMute"
                              // loopback => capture system audio — WINDOWS ONLY
    streams.enableLocalEcho Boolean (optional, default false)  // only meaningful when audio is a WebFrameMain
opts (optional, _macOS_ _Experimental_):
    useSystemPicker Boolean (default false)   // macOS 15+ ONLY (see warning below)
```
**Confidence: HIGH** — quoted from `electron/electron` `docs/api/session.md` (`main` branch, matches the 41 line).

#### Callback semantics — what each form *does*

| You call | Result in renderer `getDisplayMedia` | Notes |
|----------|--------------------------------------|-------|
| `callback({ video: {id, name} })` | Resolves with a video-only `MediaStream` | `id` is a `DesktopCapturerSource.id` (`screen:…` / `window:…`). The existing code's `{ video: { id, name, width: 9999, height: 9999 } }` works; extra width/height are ignored by the contract (constraints come from the renderer). |
| `callback({ video: {…}, audio: "loopback" })` | Resolves with video **+ system-audio** track (Windows) | The supported Windows loopback path. **Requires a video source** — see audio section. |
| `callback({})` (empty object) | **Rejects** `getDisplayMedia` — request is *denied* | This is the de-facto "deny/cancel" signal. It is the right primitive for cancellation. **HIGH** that it rejects; **MEDIUM** on the exact `DOMException.name` Chromium emits (community reports describe a non-`NotAllowedError` rejection, which is exactly why the existing renderer patch re-maps it). |
| `callback({ video: undefined, audio: "loopback" })` | **Throws in the main process**: `"video must be a WebFrameMain or DesktopCapturerSource"` | Confirmed regression class (issue #45517, Electron 34/35). Never pass `audio` without a valid `video`. The current code avoids this (audio only set when `id` is truthy), but keep it that way. |
| Handler throws, or never calls `callback` | `getDisplayMedia` hangs / unhandled rejection; subsequent requests can stall | Issue #47980 / #45517. The handler MUST call `callback` exactly once on every path, including errors. |

**Confidence: HIGH** on "must call callback exactly once" and on the `undefined video` throw; **MEDIUM** on the precise rejection `name` for `callback({})`.

#### Resetting / re-arming the handler

- `setDisplayMediaRequestHandler(null)` resets to default. **HIGH.**
- The handler set on `session.defaultSession` is **persistent** — it stays installed across requests. You do **not** need to re-register it per stream, and re-registering it (as `registerScreenshareHandler` does defensively with `removeHandler` for the IPC channels) is fine but is *not* what re-arms a new `getDisplayMedia` call. **HIGH.**
- **Implication for the cancel/re-click bug:** the handler itself is not "consumed" by a request. A second `getDisplayMedia` call from the renderer *will* re-invoke the same handler — *if* the renderer actually issues a second call. This strongly points the bug at **renderer-side (Discord) stream-start state not being reset**, not at the main-process handler being torn down. See Pitfalls in the cross-file research; STACK-level conclusion below.

### `navigator.mediaDevices.getDisplayMedia(opts)` (renderer) — rejection taxonomy

| Rejection `name` | Meaning (per WebRTC/Chromium) | How a caller (Discord) should treat it |
|------------------|-------------------------------|----------------------------------------|
| `NotAllowedError` | User/permission denied capture | Treated as a clean cancel — **swallowed silently**, UI returns to idle, ready to retry. This is why the existing fix re-throws cancellation as `NotAllowedError`. |
| `NotReadableError` | Hardware/OS lock prevented access to a device | Often surfaced as an error toast; may be retried |
| `AbortError` | Any other failure not covered above | Generic failure; behaviour varies by caller |
| Generic / non-standard | What raw Electron `callback({})` tends to surface | Discord may not recognise it as cancellation → uncaught error (the original #196 symptom) |

**Confidence: HIGH** on the standard names/semantics (MDN, WebRTC spec); **MEDIUM** on "Discord swallows `NotAllowedError` and re-arms its own button" — that is inferred from how browsers behave and from the existing fix's intent, and should be the prime thing verified manually on Windows.

**Key insight for the re-click bug:** mapping cancellation to `NotAllowedError` is the *correct* contract-level choice (it's exactly what real browsers throw on cancel). If a second click still does nothing after that, the problem is almost certainly **Discord's own renderer state machine** treating the stream-start as still in-flight (it never sees a state transition that re-enables the button), *or* the wrapper resolving/rejecting on a path Discord doesn't expect. Resetting/short-circuiting cleanly in the renderer patch (ensure exactly one resolve/reject, no swallowed-then-stuck promise) is the lever, not the main-process handler.

### `desktopCapturer.getSources(options)` — verified

```
desktopCapturer.getSources({
  types: ["screen", "window"],          // required
  thumbnailSize?: { width, height },    // default 150x150; {0,0} skips thumbnails
  fetchWindowIcons?: boolean            // default false
}) -> Promise<DesktopCapturerSource[]>
```
- **Main process only.** Returns a Promise (the old callback form is removed). **HIGH.**
- `DesktopCapturerSource`: `{ id, name, thumbnail (NativeImage), display_id, appIcon }`. `id` format: `screen:Z:0` / `window:XX:YY`. **HIGH.**
- The existing `fetchScreenshareData` usage is correct. The `initialPromise` pre-fetch + `refreshScreenshareSources` reuse pattern is a reasonable perf optimisation and not implicated in the cancel bug.
- **Windows-specific note:** Chromium on Windows 11 24H2+ is migrating screen capture to **Windows Graphics Capture (WGC)** (replacing the older DXGI duplicator) for HDR/perf. This is mostly transparent but is the kind of capture-stack change that can alter window-capture availability and timing across the 38→41 range. **MEDIUM** (vendor blog + Chromium tracking, not Electron-specific repro).

---

## Windows `audio: "loopback"` — requirements & limitations

| Requirement / Limitation | Detail | Confidence |
|--------------------------|--------|------------|
| Windows only | `"loopback"`/`"loopbackWithMute"` are documented as "currently only supported on Windows". On Linux this is correctly replaced by patchcord; on macOS it is unsupported. | HIGH (session.md) |
| Must request **video** too | `getDisplayMedia({ audio: true, video: false })` throws `NotSupportedError`; loopback only works attached to a granted video source. Renderer must request `video: true` (or video + audio). | HIGH (community + repo issues; consistent across sources) |
| `loopback` vs `loopbackWithMute` | Both capture system audio; `loopbackWithMute` additionally mutes local playback while capturing. `enableLocalEcho` is the *WebFrameMain* analogue and does not apply to the `"loopback"` string. | HIGH (session.md wording) |
| Captures **whole system** audio, not per-app | The Windows `"loopback"` mechanism captures the system mix, not a single application. There is no per-application audio isolation on this path (that's what patchcord/venmic do on Linux). Don't promise per-app audio on Windows via this API. | MEDIUM (issue #25120 + lib docs) |
| Min Electron for loopback to work at all | >= 31.0.1. 41 is well past this. | MEDIUM (electron-audio-loopback docs) |
| **Silent-stream regression risk (38→41)** | A class of "loopback returns silence / `Can't wrap SharedImage as VideoFrame`" bugs appears when the paired video is 0×0. Reported broken at Electron 40.1.0 vs working at 35.1.2 (issue #49607 — *reported on macOS*, but the failure mode is the loopback/SharedImage pipeline and worth ruling out on Windows). Workaround: use a non-zero video size (e.g. 4×4) for audio-only intent. **For GoofCord this means: when audio is requested, ensure the video track that carries it is a real, non-degenerate source — don't let constraints collapse it.** | MEDIUM/LOW — flag for manual verification on the Windows artifact |
| Feedback-loop caveat | System loopback includes the app's *own* output (e.g. other call participants), which can create echo. Discord normally handles this app-side; just be aware when validating audio quality. | MEDIUM (issue #25120) |

---

## Electron 38 → 41 changes/regressions relevant to Windows screenshare

| Area | What changed / risk | Confidence | Action |
|------|---------------------|------------|--------|
| Chromium bump | 41 = Chromium 146 / Node 24.14 / V8 14.6. Each Chromium bump can shift `getDisplayMedia` rejection wording and capture timing. | HIGH (release notes) | Treat rejection `name` as Chromium-dependent; the renderer patch normalising to `NotAllowedError` insulates against this — keep it. |
| Loopback / SharedImage silence (#49607) | Loopback silence with degenerate video; reported 40.x vs 35.x. | MEDIUM/LOW | Verify Windows audio with a non-zero video size; rule this out before assuming a GoofCord-only bug. |
| `video: undefined` + `audio` throw (#45517) | Passing audio with no/empty video throws in main on 34/35; behaviour persists as a contract rule. | HIGH | Never set `audio` unless a valid `video` source exists (current code already guards this). |
| Cancellation/unhandled-rejection handling (#47980) | Electron has *no* first-class "user cancelled" signal; cancel is expressed by `callback({})` and the app must map it. Unhandled handler exceptions hang future requests. | HIGH | Ensure handler calls `callback` exactly once on every path (it does), and the renderer maps the resulting rejection to `NotAllowedError` (it does). |
| IPC callback empty-event crash (#48992 / #48987) | "crash when creating event object for ipc events" fixed on the 39-line (Nov 2025). Not screenshare-specific but touches IPC callback plumbing the picker relies on. | LOW | Just be aware; 41.3.0 should already include the fix. |
| `useSystemPicker` | Still gated to **macOS 15+** and the whole `opts` object is tagged `_macOS_ _Experimental_` on the 41 line. **There is no Windows native-picker support via `useSystemPicker` in Electron 41.** | HIGH (session.md verbatim) | **Do NOT adopt `useSystemPicker` for the Windows fix** (see What NOT to Use). |

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Keep the custom `setDisplayMediaRequestHandler` picker | `useSystemPicker: true` (native OS picker) | **Not on Windows** — Electron 41 only supports it on macOS 15+. Even on macOS it bypasses the custom handler and loses GoofCord's resolution/framerate/audio UI. Not upstream-appropriate for this Windows fix. |
| `audio: "loopback"` (Windows) | `getUserMedia({ audio: { chromeMediaSource: "desktop", … } })` desktop-audio constraint | Legacy desktop-audio path; messier, prone to capturing the app's own output (#25120), and not the documented modern route. Avoid. |
| `desktopCapturer.getSources` for the picker UI | Direct `chromeMediaSourceId` constraints in renderer | The renderer cannot use `deviceId`/source selection directly with `getDisplayMedia`; the handler is the supported channel. Keep current design. |

## What NOT to Use / Do

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `useSystemPicker: true` to "fix" Windows | macOS 15+ only in Electron 41; no-op or wrong on Windows, and not upstream-friendly for a Windows bug | Keep the custom picker; fix the state-reset on cancel |
| Calling `callback` with `audio` but no/`undefined` `video` | Throws `"video must be a WebFrameMain or DesktopCapturerSource"` in main (#45517) | Only attach `audio: "loopback"` when a real video source `id` exists (current guard is correct) |
| Letting the handler ever return without calling `callback`, or throwing out of it | Hangs `getDisplayMedia`; stalls *future* requests (#47980) — a likely contributor to "second click does nothing" | Call `callback` exactly once on every branch (cancel → `callback({})`, error → `callback({})`); never throw |
| Re-throwing/raw-surfacing the cancel rejection to Discord | Discord doesn't recognise the generic Electron rejection → uncaught error (#196) | Map cancellation to `DOMException("…","NotAllowedError")` in the renderer patch (already done) |
| Assuming the *main-process handler* is what's stuck on re-click | The handler on `defaultSession` persists and is re-invoked per call; it is not consumed | Investigate **renderer/Discord stream-start state** + ensure the patched `getDisplayMedia` resolves/rejects exactly once and doesn't leave a hung promise |
| Degenerate (0×0) video when only audio is wanted | Triggers SharedImage/silent-stream class bugs in recent Chromium (#49607) | Use a real, non-zero video source for the loopback carrier |

## Stack Patterns by Variant

**If the second-click-does-nothing bug reproduces with the handler clearly being re-invoked (add a log in the handler):**
- The main-process side is fine; the stuck state is in Discord's renderer stream-start flow.
- Fix in `screensharePatch.ts` / renderer: guarantee the wrapped `getDisplayMedia` always settles exactly once, and that cancellation rejects as `NotAllowedError` *without* leaving a pending GoofCord-side promise (e.g. patchcord stop) that blocks the next attempt.

**If the handler is NOT re-invoked on the second click (no log fires):**
- Discord never re-issued `getDisplayMedia` → its button/flux state thinks a stream-start is still pending.
- Look at the `STREAM_CLOSE`/stream-start dispatch path and ensure the cancelled attempt produces the state transition Discord needs to re-enable the button.

**If Windows audio is silent but video works:**
- Confirm a non-zero video source carries the `"loopback"` track (rule out #49607-class regression).
- Confirm `audio: "loopback"` is actually being set (the `audioConfig.mode !== "none"` + non-Linux branch in `screenshare.ts`).
- Confirm the renderer patch isn't stripping the loopback audio track (the patchcord block removes audio tracks only when a virtmic `id` is found — ensure that doesn't fire on Windows).

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| Electron 41.3.0 | Chromium 146 / Node 24.14 / V8 14.6 | `audio: "loopback"` supported; `useSystemPicker` macOS-15-only |
| `audio: "loopback"` | Electron >= 31.0.1 | Loopback non-functional below this; 41 is fine |
| `desktopCapturer.getSources` | Electron (Promise-only) | Callback form removed years ago; current code already Promise-based |

## Sources

- `electron/electron` `docs/api/session.md` (`main` branch, matches 41 line) — `setDisplayMediaRequestHandler` signature, `loopback`/`loopbackWithMute` "Windows only", `useSystemPicker` "macOS 15+ only" `_macOS_ _Experimental_`. **HIGH**
- electronjs.org `/docs/latest/api/desktop-capturer` + `structures/desktop-capturer-source` — `getSources` options, return type, `id` format, main-process-only, WGC/macOS caveats. **HIGH**
- electron/electron #47980 "setDisplayMediaRequestHandler must handle exceptions and user cancellation" — no native cancel signal; unhandled rejection hangs future requests. **HIGH**
- electron/electron #45517 "Unhandled rejection…" — `video: undefined` + `audio` throws `"video must be a WebFrameMain or DesktopCapturerSource"` (34/35). **HIGH**
- electron/electron PRs #43581/#43679/#43680 — `useSystemPicker` added in Electron 32/33, **macOS only**. **HIGH**
- electron/electron #49607 "Broken Desktop Audio Capture" — loopback silence / SharedImage, 40.1.0 broke vs 35.1.2 (reported macOS; failure mode is the loopback pipeline). **MEDIUM/LOW**
- electron/electron #25120 — Windows desktop audio captures system mix incl. app's own output; no per-app isolation. **MEDIUM**
- alectrocute/electron-audio-loopback (README) — must request `video: true`, Electron >= 31.0.1, Win10+/macOS12.3+/Linux. **MEDIUM**
- MDN getUserMedia + WebRTC error taxonomy — `NotAllowedError` vs `NotReadableError` vs `AbortError`. **HIGH**
- releases.electronjs.org / Electron blog — Electron 41 = Chromium 146 / Node 24.14 / V8 14.6. **HIGH**
- windowslatest / Chrome for Developers — Windows Graphics Capture (WGC) migration for getDisplayMedia on Win11 24H2+. **MEDIUM**

---
*Stack research for: Electron Windows screen + loopback-audio capture (GoofCord bug-fix)*
*Researched: 2026-05-29*
