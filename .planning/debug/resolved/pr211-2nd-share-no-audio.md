---
status: resolved
trigger: "PR #211 Windows screenshare audio regression: audio works on the FIRST screenshare (no echo, full system audio), but after the first screenshare is stopped, every subsequent screenshare has NO audio. WASAPI Application Loopback (EXCLUDE process-tree) via the wasapi-loopback native addon."
created: 2026-06-06
updated: 2026-06-06
slug: pr211-2nd-share-no-audio
---

> RESOLVED 2026-06-06: per-share feeder fix verified working by the user on a Windows
> test build (run 27056472801). Fix folded into PR #211 (force-pushed to 3 clean
> commits on pr/fix-windows-screenshare-echo; #210 confirmed out of scope). Clean
> #210-free build verified at run 27056758797.

# Debug: PR #211 — no audio on 2nd+ screenshare

## Symptoms

- Expected: every screenshare (with system audio) carries the EXCLUDE-tree loopback audio.
- Actual: share #1 = audio + no echo ✓. After stopping share #1, share #2+ = NO audio.
- Timeline: regression in the #46 echo-fix work. Observed on CI build run 27053219078
  (commit 5882491, the rich-diagnostics build — an ancestor of current HEAD).
- Repro: start screenshare w/ system audio → works → stop → start again → silent.
- Logs: stale (the build-27053219078 log only captures a single session / app restart,
  not a within-session stop→restart cycle).

## Current Focus

hypothesis: The renderer-side feeder in `src/windows/main/preload/wasapiTransport.ts` is a
  page-lifetime SINGLETON whose primitives are one-shot. It is created once at install and
  permanently destroyed by `teardown()` on the first share's end; the
  `__goofcordWasapiTransportInstalled` guard then blocks any rebuild, so share #2 has a dead
  feeder.
next_action: refactor feeder to per-share Session; verify on a fresh Windows test build.

## Evidence

- timestamp 2026-06-06: `installWasapiTransport()` runs once per page (guard
  `__goofcordWasapiTransportInstalled`, wasapiTransport.ts). It creates a single
  `MediaStreamTrackGenerator` (`gen`), a single `writer = gen.writable.getWriter()`, and a
  single `drainTimer = setInterval(...)`.
- `teardown()` (fired by the swapped track / video track `ended`) does `clearInterval(drainTimer)`,
  `writer.releaseLock()`, `port.close()`. All three are irreversible for that gen/writer.
- A `MediaStreamTrackGenerator` track, once `.stop()`ed/ended by Discord at share end, cannot be
  revived. On share #2 the swap seam re-adds the SAME dead `gen` track → silent.
- Main process IS re-entrant: `tryStartWasapiLoopback()` (wasapiLoopback.ts) calls
  `stopWasapiLoopback()` then builds a FRESH `MessageChannelMain` + posts a fresh port each call.
- Native addon IS re-entrant: `start()` (native/wasapi-loopback/src/lib.rs) returns Ok(true) when
  a session exists, else spawns a fresh capture thread; `stop()` does `guard.take()` → `SESSION = None`,
  so a `start()` after `stop()` activates a new session within the same process.
- ⇒ On share #2 chunks DO arrive and fill `ring`, but the dead `drainTimer` never drains it and the
  dead `gen` track produces no audio. Confirmed by code path; no runtime log needed.
- Tested build (commit 5882491) has the byte-identical singleton structure (gen/writer/drainTimer
  created once; teardown clears them; idempotence guard blocks reinstall) → the observed regression
  IS this bug, unchanged in current HEAD.

## Eliminated

- hypothesis: native addon can't restart within one process — ELIMINATED (lib.rs start/stop are
  idempotent + re-entrant; `stop()` leaves SESSION=None so the next `start()` spawns a new thread).
- hypothesis: main process doesn't re-post the port / reuses a closed port — ELIMINATED
  (`tryStartWasapiLoopback` creates a new MessageChannelMain and posts port2 every call).

## Resolution

root_cause: Page-lifetime singleton feeder (track generator + writer + drain timer) is destroyed on
  the first share's teardown and never rebuilt (idempotence guard blocks re-install), so every share
  after the first feeds a dead generator → no audio.
fix: Refactor `installWasapiTransport` so the per-share feeder (gen, writer, drain timer, ring) lives
  in a `Session` minted fresh on each forwarded PCM port. Install (swap seam + port listener +
  readiness handshake) stays once-per-page. `teardown(signalMain)` is idempotent and only signals the
  main process to stop native capture on a real share-end (not on supersede).
verification: fresh Windows test build → start share w/ system audio (audio + no echo) → stop →
  start again → audio present on share #2+. (Add userData-log diagnostics only if by-ear fails.)
files_changed: src/windows/main/preload/wasapiTransport.ts
