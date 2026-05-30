# Requirements: GoofCord — Windows Streaming Fixes

**Defined:** 2026-05-29 · **Current milestone:** v1.1 — Windows Screenshare Echo Fix (added 2026-05-30)
**Core Value:** On Windows, a user can start a screenshare, cancel the source picker, and start again — and the stream works — without the app getting stuck or requiring a restart.

## v1 Requirements

Requirements for this milestone. Each maps to a roadmap phase. All are verified manually on a Windows x64 CI build.

### Streaming Restart (STREAM) — Bug A (primary)

- [x] **STREAM-01**: On Windows, after cancelling the screenshare source picker, clicking "Go Live" / start-stream again re-opens the source picker (a picker window appears)
- [x] **STREAM-02**: On Windows, a screenshare that was cancelled and then restarted starts and streams normally, with no application restart required
- [x] **STREAM-03**: Cancelling the screenshare source picker shows no uncaught or visible JavaScript error in Discord (preserves the behaviour shipped in `710cfde`)
- [x] **STREAM-04**: Repeated cancel → retry cycles remain stable — the start-stream control keeps working after multiple cancellations, with no progressive wedging

### Windows Audio (AUDIO) — Bug B (related)

- [x] **AUDIO-01**: On Windows, when the user opts to share audio, a remote viewer hears the captured system/application audio
- [x] **AUDIO-02**: The Linux virtual-mic / Patchcord audio-track handling does not run on Windows and never strips the Windows `"loopback"` audio track

### Upstream Quality (UPST)

- [x] **UPST-01**: All fixes are surgical, minimal-divergence changes with no new dependencies — structured so they can be submitted as clean PRs to the upstream GoofCord repo

## v1.1 Requirements — Windows Screenshare Echo Fix

Native clean-room implementation of the echo fix (upstream #46), building on the Phase 2 recon (`02-FINDINGS.md`). Verified manually on a real Windows build, **viewer-side** (second account/device) with audio actively playing. Native-only scope — the user-side workaround is explicitly NOT a deliverable.

### Echo Fix (ECHO) — Bug B implementation

- [ ] **ECHO-01**: On Windows, when a user screenshares with audio, remote viewers hear the shared system/application audio but do NOT hear the Discord call echoed back to them (#46)
- [ ] **ECHO-02**: The echo fix works on current Windows — Windows 10 version 2004 (build 19041) and later, and Windows 11 — using the in-OS WASAPI per-process-tree EXCLUDE loopback (confirmed functional on the maintainer's build 19045 by official Discord's echo-free behaviour there; the documented "20348" minimum is over-stated — see `02-FINDINGS.md §2.3 UPDATE`)
- [ ] **ECHO-03**: Existing screenshare/audio behaviour is preserved with no regression on Linux (patchcord), macOS, and on any Windows build where the per-process API is unavailable (graceful fallback to today's `"loopback"` behaviour — no crash, no worse than current)
- [ ] **ECHO-04**: The native capability is implemented clean-room from the public Microsoft ApplicationLoopback sample (MIT-licensed; copyright notice retained); no Discord code or proprietary symbol layout is used

### Upstream Quality (UPST) — v1.1

- [ ] **UPST-02**: The echo fix is upstream-PR-ready — native code ships via the existing prebuilt-`.node` pattern (venbind-style: a separate addon repo publishing per-platform prebuilds, copied by `copyNativeModules()`), the GoofCord-side diff is surgical, and any diagnostic instrumentation is stripped before the PR

## v2 Requirements

Deferred to a future milestone. Acknowledged but not in this roadmap.

### Windows Streaming (WSTRM)

- **WSTRM-01**: Additional Windows screenshare/streaming bugs beyond the cancel/restart + audio scope (open a new milestone if/when they surface)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| `useSystemPicker` / native Windows source picker | macOS-only in Electron 41; does not apply to Windows and adds upstream divergence (research: STACK/PITFALLS) |
| Per-application *INCLUDE* capture (sharing only one chosen app's audio) on Windows | Anti-feature for a bug-fix fork. NOTE: v1.1 DOES implement *EXCLUDE*-tree capture (capture everything except GoofCord's own tree — the echo fix). What stays out of scope is selectively sharing a single app's audio (INCLUDE-mode UI). |
| User-side separate-output-device workaround (VB-Cable / SteelSeries Sonar / VoiceMeeter) as a v1.1 deliverable | User EXPLICITLY rejected the workaround as a deliverable for this milestone — v1.1 is native-only. Sub-2004 (< 19041) builds fall back to today's `"loopback"` (graceful, covered by ECHO-03), not to a shipped workaround. (Supersedes the research SUMMARY.md "workaround-first" recommendation, which predates this decision.) |
| Re-registering / nulling the display-media handler as a "reset" | Anti-feature — handler is registered once; re-registration is the wrong fix and is unreproducible as a cause (research: ARCHITECTURE/PITFALLS) |
| Linux / macOS streaming behaviour changes | Fork is Windows-focused; must not regress these but won't chase them |
| New streaming features or picker UI redesign | This is a bug-fix fork, not a feature fork |
| Broad multi-bug Windows streaming campaign | Keep this milestone tight; revisit as a new milestone (see WSTRM-01) |
| Gratuitous new dependencies (semver libs, audio libs, etc.) | Fixes must stay minimal and upstream-able. EXCEPTION (v1.1): the native WASAPI echo-capture `.node` addon is one deliberate, upstream-justified native dependency, shipped via the existing prebuilt-`.node` pattern (like `venbind`/`patchcord`) — it is the mechanism, not a gratuitous add. This refines UPST-01's "no new dependencies". |

## Traceability

Which phases cover which requirements. Populated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| STREAM-01 | Phase 1 | Complete |
| STREAM-02 | Phase 1 | Complete |
| STREAM-03 | Phase 1 | Complete |
| STREAM-04 | Phase 1 | Complete |
| AUDIO-01 | Phase 2 | Complete |
| AUDIO-02 | Phase 2 | Complete |
| UPST-01 | Phase 1 | Complete |
| ECHO-01 | Phase 4 | Pending |
| ECHO-02 | Phase 4 | Pending |
| ECHO-03 | Phase 4 | Pending |
| ECHO-04 | Phase 4 | Pending |
| UPST-02 | Phase 5 | Pending |
| WSTRM-01 | — (v2 / future milestone) | Deferred |

**Note:** AUDIO-01 / AUDIO-02 "Complete" means the Phase 2 **recon/investigation** scope is complete (mechanism identified + documented in `02-FINDINGS.md`) — it does **not** mean the echo bug (#46) is fixed. The actual fix is implemented in milestone v1.1 (ECHO-01..04, Phase 4). (Re-scoped 2026-05-30.)

**Note:** UPST-01 (surgical, upstream-PR-able, no new dependencies) is a cross-cutting quality constraint owned by Phase 1. Its v1.1 counterpart UPST-02 (echo fix is upstream-PR-ready, native ships via the prebuilt-`.node` pattern, instrumentation stripped) is owned by Phase 5 and re-verified there.

**Note:** **Phase 3 (delivery-path spike) owns no requirement.** It is a deliberate GO/NO-GO de-risk gate (the user's explicit choice) that proves the PCM→MediaStream delivery path for ECHO-01 before the native investment; ECHO-01 itself is owned and delivered in Phase 4. The spike's deliverable is a written GO/NO-GO decision + a proven delivery path, not a shipped requirement.

**Note:** WSTRM-01 is a v2 requirement (see "v2 Requirements" above) — intentionally **not** in v1 scope and mapped to no v1 phase. It is listed here only so the body and traceability table stay in sync; it is deferred to a future milestone, not delivered.

**Coverage:**
- v1.0 requirements: 7 total — mapped to phases 1-2, all complete ✓
- v1.1 requirements: 5 total — ECHO-01..04 → Phase 4, UPST-02 → Phase 5; all mapped (Phase 3 is a de-risk gate owning no requirement) ✓
- v2 / deferred (not in scope): WSTRM-01

---
*Requirements defined: 2026-05-29*
*Last updated: 2026-05-30 — v1.1 (Windows Screenshare Echo Fix) traceability mapped: ECHO-01..04 → Phase 4, UPST-02 → Phase 5; Phase 3 spike owns no requirement*
