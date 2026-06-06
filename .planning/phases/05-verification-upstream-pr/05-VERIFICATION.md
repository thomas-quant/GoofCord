---
status: in_progress
phase: 05-verification-upstream-pr
requirement: UPST-02
updated: 2026-06-06
ci_run_rich: 27053219078
commit_rich: 5882491
detected_build: 10.0.19045
viewer_audible: true
echo_heard: false
---

# Phase 05 — Verification Report (#46 echo fix)

This report is captured in two halves to resolve the D-14 tension (stripping the
diagnostics removes the evidence logging): the **rich build** (instrumented,
pre-strip) is captured FIRST, here; the **final shipping shape** (stripped +
dependency-packaged) is re-confirmed in 05-06 (placeholder section below).

---

## Rich build (instrumented, pre-strip) — CAPTURED ✅

**Artifact under test:** CI run **27053219078** (`success`) →
https://github.com/thomas-quant/GoofCord/actions/runs/27053219078
**Built from:** commit `5882491` on `fix/windows-screenshare-cancel-restart`
(adds the `os.release()` build-number breadcrumb; in-CI Rust build of the
addon still present — the rich shape).
**Evidence source:** `…/AppData/Roaming/goofcord/screenshare-debug.log`
(WSL-readable; cumulative across runs — datums below are tied to the latest-run
signatures, **not** recollection).

### SC#1 — viewer-side ground truth (human-supplied)

The streamer cannot self-verify (Electron mutes local echo), so this is the
dispositive datum, reported by the user after the two-device test on the 19045
dev box (normal launch, native path, non-call audio playing on the streamer):

| Check | Result |
|-------|--------|
| Viewer **HEARS** shared desktop audio (capture works, not silence) | **YES** ✅ |
| Viewer hears **NO** Discord-call echo (EXCLUDE-tree works) | **YES — no echo** ✅ |
| Crash on share | **None** |

This re-confirms ECHO-01 (capture) + the exclude-tree echo suppression on the
**rich** build, viewer-side.

### Detected Windows build number — RESEARCH Q7 gap closed

The new breadcrumb logs `os.release()` at activation. Latest run:

```
2026-06-06T05:26:10.169Z wasapi build=10.0.19045
```

→ **Windows 10 build 19045**, comfortably above the WASAPI Application-Loopback
support floor (19041 / 2004). Previously unlogged anywhere (RESEARCH Q7 / Open
Question 2) — now captured from the shipped artifact itself. The line repeats
identically across every share in the session (05:23:20, 05:23:25, 05:24:10,
05:25:03, 05:26:10).

### Native branch activated (not the Electron loopback fallback, not the spike)

```
2026-06-06T05:26:10.173Z screenshare wcId=2 audio=none path=win32-wasapi-exclude-tree (addon sole capturer, no chromium loopback)
2026-06-06T05:26:10.173Z wasapi activation=ok hop1=messageport hop2=port-forward chunks=0
```

`path=win32-wasapi-exclude-tree` (the REAL native path) — **not** `spike-synthetic`
and **not** the chromium `"loopback"` fallback. Confirms the addon is the sole
capturer.

### EXCLUDE-tree PID discipline (ECHO-02) — root PID + Audio Service in subtree

```
2026-06-06T05:26:10.169Z wasapi exclude-root=19076 audioService=12280 procs=…,Audio Service:12280,Video Capture:7408,…
```

- **Excluded root PID:** `19076` (Electron main = `process.pid`).
- **Audio Service PID:** `12280` — present in the same `app.getAppMetrics()`
  process list, i.e. within the tree rooted at 19076 that
  `EXCLUDE_TARGET_PROCESS_TREE` removes. This is the mechanism that drops the
  call audio from the captured mix (no echo) while keeping the rest of the
  desktop mix (viewer still hears shared audio).
- Cross-confirmed in the earlier instance: `exclude-root=18528 audioService=19356`
  (05:23:20) — different PIDs, same subtree relationship.

### N-API ABI smoke (SC#5 / Open Q1) — loads under Electron 41.3.0

```
2026-06-06T05:26:10.167Z [sync] addon require begin …\ts-out\native\wasapi-loopback-win32-x64.node
2026-06-06T05:26:10.169Z [sync] addon require ok
2026-06-06T05:26:10.169Z wasapi smoke: loaded under electron napi ok
2026-06-06T05:26:10.172Z [sync] start() returned ok=true
```

The `.node` requires + exports check passes under Electron's N-API (not just
bare Node) — an ABI mismatch would have surfaced here, not on a wasted
second-device round-trip.

### Stream health — chunk counts

```
2026-06-06T05:26:10.367Z wasapi swap-seam injected reconstructed audio track (chunks=17)
2026-06-06T05:26:11.188Z wasapi activation=ok … chunks=100
…
2026-06-06T05:26:59.188Z wasapi activation=ok … chunks=4900
```

Steady ~100 chunks/s (480-frame / ~10 ms f32 chunks, 3840 bytes each) climbing
monotonically to 4900+ over ~49 s — a healthy, continuous capture→MessageChannel
→MSTG-feeder→viewer stream. The renderer swap-seam confirms the reconstructed
track was injected (chunks=17, ~200 ms after start).

### Cross-reference

Consistent with the prior verified signature in `04-03-SUMMARY.md` (CI
`27044504559`): same `path=win32-wasapi-exclude-tree`, same hop topology, same
chunk cadence — the build-number breadcrumb is the only added line.

### Observation — "needed restart once" (NOT a native-path failure)

The user noted the app **needed a restart once** during testing ("idk why").
The log fully accounts for this and clears the echo fix:

- The first app instance (PID **18528**, launched 05:23:06) served **six**
  successive shares — `wcId` 2 → 3 → 4 → 5 → 6 → 8 (re-clicks / cancel-restart
  cycles) — and **every one logged `activation=ok` + `path=win32-wasapi-exclude-tree`**
  with chunks flowing. This is the Bug-A cancel/restart robustness holding up.
- A fresh instance (PID **19076**, 05:26:00) — the restart — activated `ok` just
  as cleanly.
- **No** `threw`, `load failed`, `activation=unsupported`, `stop threw`, crash,
  or `NotAllowedError` line appears **anywhere** in the entire 05:2x test window.

Conclusion: the restart was a renderer/Discord-UI–level hiccup of undetermined
origin, **not** a failure of the WASAPI echo-fix path (which activated `ok` on
all 7 shares across both instances). Crucially, **restart recovered cleanly** —
exactly the milestone Core Value ("if everything else fails, restarting a stream
after cancelling must work"). Flagged as an open watch-item for the 05-06 final
re-confirm; if it recurs there, characterize whether it correlates with a
specific cancel timing. It does **not** block the echo fix.

---

## Final shipping shape (stripped + dependency-packaged) — RE-CONFIRM PENDING ⏳

*Placeholder — completed in 05-06 (D-14 step 3 + D-15 + D-16).*

After 05-03 (strip all diagnostics + ECHO-03 fallback guard) and 05-04/05-05
(published `optionalDependencies` addon, in-CI Rust build removed), a final
Windows x64 CI artifact of the **shipping** shape will be re-verified:

- [ ] SC#1 re-confirm: viewer hears desktop audio + no echo on the **stripped**
      build (no debug log to lean on — viewer-side ground truth only).
- [ ] ECHO-03 / D-11: forced native-unavailable / `--no-wasapi` run falls back to
      Electron `"loopback"` and the viewer still hears audio (graceful fallback,
      no silence, no crash).
- [ ] D-15: Linux (patchcord) and macOS paths non-regressed (byte-identical
      `"loopback"` path when native addon absent).
- [ ] "Restart once" watch-item re-checked.
