---
phase: 05-verification-upstream-pr
plan: 06
subsystem: verification
tags: [verification, two-device, echo-fix, fallback, non-regression, shipping-shape]

requires:
  - phase: 05
    plan: 05
    provides: the final stripped/dependency-packaged Windows artifact (run 27054703843) this plan re-confirms
provides:
  - Completed 05-VERIFICATION.md (rich + final shipping-shape + fallback + Linux/macOS non-regression)
  - SC#1 re-confirmed on the shipping shape; D-11/D-15 fallback proven; D-16 non-regression documented
affects: [05-07]

requirements: [UPST-02]
status: complete
tasks_completed: 2
tasks_total: 2
---

# 05-06 — Final shipping-shape re-confirm + non-regression

## Task 1 (checkpoint:human-verify) — two-device re-confirm on the FINAL artifact ✅
User tested the final stripped/dependency-packaged build (CI run 27054703843) on the
Windows 19045 dev box, second-device viewer, non-call audio playing:

- **Run 1 (native, default):** viewer hears desktop audio, **no echo**, no crash → ECHO-01
  re-confirmed on the shipping shape (SC#1).
- **Run 2 (`--no-wasapi` fallback):** viewer hears audio, **echo present**, no crash → the
  Electron `"loopback"` fallback is graceful (audio not silence, no crash); echo is the
  expected un-fixed baseline (D-15).
- **Run 3 (injected-but-unsupported guard):** skipped — not reproducible on a supported
  19045 box; covered by code inspection (the `if (!activePort) return stream` gate), not faked.

**A/B significance:** native = no echo, loopback = echo → the echo suppression is dispositively
attributable to the WASAPI EXCLUDE-tree path (the #46 fix), nothing else.

## Task 2 (auto) — completed report + non-regression ✅
- Filled the "Final shipping-shape re-confirm" section of `05-VERIFICATION.md`: the run table,
  A/B significance, the ECHO-03 guard-by-inspection, build#/PIDs/native-line (from the rich
  build — identical code path; shipping build is silent by design), and app.asar packaging (V4).
- **Runtime strip proof:** the two shipping-build runs added **zero** lines to
  `screenshare-debug.log` (still 599 lines, last entry 05:26:59 from the rich build) → the strip
  holds at runtime.
- **Non-regression (D-16):**
  - **Linux** (verified on this box): echo fix triple-gated off-Windows (`screenshare.ts:101`,
    `wasapiLoopback.ts:103` + `:79`); `bun install` exit 0 (win32-only optionalDependency resolves
    without breaking, inert on Linux — no `wasapi-loopback-linux-x64.node` exists); `bun run build`
    exit 0; patchcord path byte-identical.
  - **macOS** (code inspection, no Mac hardware — stated plainly, not faked): same win32 gates +
    `os:["win32"]`/electron-builder packaging exclude the win32/linux `.node`.

## Acceptance
- [x] `grep "win32-wasapi-exclude-tree"` → present
- [x] `grep "no Mac hardware"` → present
- [x] Report records build#, native-path line, both PIDs, viewer ground truth, D-11+D-15 fallback,
      05-05 run id — each citing a log signature

## Self-Check: PASSED
SC#1 complete: a real Windows build, viewer-verified (audio + no echo), fallback proven, Linux/macOS
non-regression documented without faked hardware.
