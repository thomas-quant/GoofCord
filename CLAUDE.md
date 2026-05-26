# GoofCord — working notes (screenshare investigation)

> Handoff doc for an in-progress task. Owner usually runs GoofCord on **Windows 10 x64**;
> this Linux box (CachyOS, **KDE Wayland**) is just where we've been developing/testing.
> **This file is local working notes — do NOT include it in any upstream PR.**

## What we're fixing

Two issues reported by the user, mapped to existing upstream issues:

1. **#196 — JS error when backing out of the screenshare picker.** ✅ FIXED (see below).
2. **#46 — desktop audio echo on Windows.** ⛔ WON'T FIX. The maintainer (owner) already
   declared it out of scope: no Electron/Chromium API to capture per-window audio on Windows.
   Workaround: route Discord's voice output to a different device than loopback captures.
   Do not attempt a PR for this.

## The #196 fix (DONE)

- Branch: `fix/screenshare-cancel-js-error`, commit **`f61fb67`** (one file:
  `src/windows/screenshare/screenshare.ts`).
- Root cause (verified empirically against Electron 41.3.0): cancelling the picker called
  the displayMedia callback with `callback({})`. In Electron 41 that **throws synchronously
  in the main process** (`"Video was requested, but no video stream was provided"`). Inside
  the `capturerWindow.once("closed")` handler that surfaces as an **uncaught main-process
  exception** (the error dialog the user saw) and aborts cleanup.
- Fix: cancel with **`callback(undefined)`** instead (both cancel paths — the `!id` branch
  and the `once("closed")` handler). It does NOT throw and still rejects `getDisplayMedia`
  cleanly with `AbortError`. Confirmed with a standalone Electron harness.
- Status: typecheck (`bun run check`), lint (`bun run lint`), build all pass. Committed +
  pushed to the fork. **PR not opened yet** — waiting on Windows verification.

## Verified vs still-open

- ✅ #196 crash is gone (user confirmed: no error on close/restart, on Linux).
- ❓ **Re-share stall + "Share screen with Electron" pre-window** turned out to be a
  **Wayland-only** thing, NOT caused by our fix and NOT in the #196 scope:
  - On a Wayland session, screen capture MUST go through the XDG/PipeWire **portal** — an OS
    consent dialog no app can remove. `--ozone-platform=x11` does NOT help (it changes the
    window backend, not the capture backend; portal still fires — logs showed
    `ScreenCastPortal failed: 2`).
  - On PipeWire, `desktopCapturer.getSources()` returns a single generic source, so GoofCord's
    custom picker is redundant on Wayland → you get GoofCord's picker AND the portal.
  - None of this exists on **Windows** (no portal), which is the user's real OS — so this is
    likely a non-issue there. **Next step: user tests #196 fix on Windows.**
  - Possible (separate, maintainer's call) Wayland UX improvement: detect Wayland and skip
    GoofCord's redundant picker, letting the portal be the sole picker. Tradeoff: loses the
    resolution/framerate/audio settings UI on Wayland. NOT decided — do not implement without
    asking.

## Next steps (resume here)

1. User runs the **Windows build** and re-tests: start screenshare → open picker → cancel
   (Escape and the X button) → confirm no JS error → start screenshare again (should work).
2. If clean on Windows → open the PR to `Milkshiift/GoofCord` from commit **`f61fb67` only**
   (just the `screenshare.ts` change), referencing "Closes #196". Do NOT include this
   CLAUDE.md, the CI branch, or any debug logging.
3. The Windows test build is already built — see "Fork / CI" below for the artifact link.

## Environment / how to run here

- `bun` is at `~/.bun/bin/bun` (installed via the official script; not on default PATH —
  prefix `export PATH="$HOME/.bun/bin:$PATH"`). No global node_modules originally; run
  `bun install` to populate.
- Electron's binary postinstall didn't run under bun; it was extracted manually to
  `node_modules/.bun/electron@41.3.0/node_modules/electron/dist/` with `path.txt` = `electron`.
  If it breaks again, re-extract the cached zip from `~/.cache/electron/<hash>/`.
- Launch dev build: `bun run build --dev` then
  `./node_modules/.bin/electron ./ts-out/main.js --dev`.
- Dev build uses user-data dir `~/.config/Electron` (NOT `~/.config/goofcord`); the Discord
  login persists there across relaunches. It also shows up as "Electron" in the OS portal.
- Single-instance lock: a `kill -9` leaves a stale `~/.config/Electron/SingletonLock` that
  blocks the next launch (exits 1 with no output). Remove `Singleton*` if so.

## Fork / CI

- GitHub account in use: **thomas-quant**. Fork: `https://github.com/thomas-quant/GoofCord`.
- Branches on the fork:
  - `fix/screenshare-cancel-js-error` → the clean fix (`f61fb67`). **This is the PR branch.**
  - `ci/win-test-build` + fork's `main` → contain a Windows-only `testBuild.yml` tweak used
    to produce a Windows artifact fast. NOT for the PR.
- Windows artifact (built from the fix): run
  `https://github.com/thomas-quant/GoofCord/actions` → "Test build" → `win-artifacts` zip.
- `assets/*.js` are committed renderer bundles; the dev build rebuilds them with this
  machine's path baked in — never commit that churn (always `git restore assets/`).
