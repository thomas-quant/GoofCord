# 02-02 Summary — On-Box Inspection + Finalized Findings

**Plan:** 02-02 (wave 2) — Phase 2 Recon close-out
**Status:** Complete
**Tasks:** 3/3
**Requirements:** AUDIO-01, AUDIO-02 (investigated only — delivery deferred to a follow-on implementation phase)

## What was built

- `02-RECON-OBSERVATIONS.md` — raw on-box inspection results for all 7 runbook steps, with exact commands, tooling-substitution notes, and per-step provenance/confidence.
- `02-FINDINGS.md` (finalized) — mechanism verdict (§1), replication parameters (§2), evidence-based clean-room go/no-go (§3), recon-only attestation (§4). All `[depends on 02-02]` / `TO BE FILLED` slots resolved.

## Key finding

Discord on Windows uses the **public WASAPI Application Loopback API**, **dynamically loaded** with version-gating fallback — **not** a virtual-device driver. Mode is **EXCLUDE** process-tree (the echo fix). Clean-room verdict: **GO, conditional on Windows build ≥ 20348**. A future fix needs a small native addon (the public Microsoft `ApplicationLoopback` sample is the template); it is unreachable from Electron/Chromium JS. This is the input to the deferred D-06 decision.

Evidence (all hands-on, see `02-RECON-OBSERVATIONS.md`):
- `discord_voice.node`: `ActivateApplicationLoopbackForProcessTree`, `ActivateApplicationLoopbackFromPid`, `excludedSubtrees`, `Excluded`, `Failed to load mmdevapi for application loopback capture`, `audioses is too old for application loopback capture`, `loopback_controller.cpp` (`strings`).
- `mmdevapi.dll`/`audioses.dll` **absent** from the static import table; `LoadLibrary*`+`GetProcAddress` present (`objdump -p`) → dynamic resolution (corroborates use, Pitfall 3 resolved).
- No Discord-installed virtual audio device (PowerShell device enumeration).
- Windows build **19045.6466 (< 20348)** — below the API minimum; corrected a desk-research error in the 02-01 skeleton.

## Deviation (significant — disclosed)

Task 1 was planned as a **human-action** checkpoint (developer runs the runbook on a physical Windows box). In practice the executing environment is **WSL2 running on the developer's actual Windows 10 machine**, so Claude ran the inspection directly against the real installed Discord (`C:\Users\Christ\AppData\Local\Discord\app-1.0.9238`) using GNU `strings`/`objdump` (≡ Sysinternals `strings` / `dumpbin /imports`) and PowerShell device enumeration (≡ Device Manager) via WSL interop. This is a genuine hands-on inspection of the real machine, not fabrication or inference. The developer approved this provenance in the Task-3 human-verify checkpoint ("Yeah no, that's cool").

Honest gaps preserved, not papered over:
- **Step 6 (live PIDs):** Discord was not running and was not launched — recorded `not run / unknown`.
- **EXCLUDE mode:** confirmed at *symbol* level (`excludedSubtrees`/`…ForProcessTree`), not from a raw WASAPI enum value (a compiled integer invisible to `strings`).
- **Activation on this box:** the shipped mechanism is confirmed; whether it *activates* on build 19045 (< 20348) is not claimed (no live capture; Discord's own `audioses is too old` fallback suggests it may not).

## Verification

- Task 1 automated `<verify>`: PASS (`Result:` ×7, device/dumpbin/build present).
- Task 2 automated `<verify>`: PASS (0 × `TO BE FILLED IN 02-02`, 0 × `depends on 02-02`, `Verdict:` present, `clean-room` + `ApplicationLoopback` cited).
- Task 3 automated `<verify>`: PASS (zero `src/` changes, working + staged).
- Recon-only boundary: every phase-02 change is under `.planning/`; **no `src/` touched** ([UPST-01], D-02).
- Honesty cross-check: every `hands-on confirmed` tag in `02-FINDINGS.md` traces to a line in `02-RECON-OBSERVATIONS.md`.

## Self-Check: PASSED

## Notes

- AUDIO-01/AUDIO-02 remain **investigated-only** (delivery deferred); AUDIO-02's no-code-change conclusion (`getVirtmic()` null on Windows → Patchcord track-removal block never fires) is recorded in `02-FINDINGS.md` §4.1.
- The actual echo *fix* (native exclude-tree module vs. user-side workaround) is the deferred D-06 decision for a future implementation phase — out of scope here (recon only).
