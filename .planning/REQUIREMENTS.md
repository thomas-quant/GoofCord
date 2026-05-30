# Requirements: GoofCord — Windows Streaming Fixes

**Defined:** 2026-05-29
**Core Value:** On Windows, a user can start a screenshare, cancel the source picker, and start again — and the stream works — without the app getting stuck or requiring a restart.

## v1 Requirements

Requirements for this milestone. Each maps to a roadmap phase. All are verified manually on a Windows x64 CI build.

### Streaming Restart (STREAM) — Bug A (primary)

- [x] **STREAM-01**: On Windows, after cancelling the screenshare source picker, clicking "Go Live" / start-stream again re-opens the source picker (a picker window appears)
- [x] **STREAM-02**: On Windows, a screenshare that was cancelled and then restarted starts and streams normally, with no application restart required
- [x] **STREAM-03**: Cancelling the screenshare source picker shows no uncaught or visible JavaScript error in Discord (preserves the behaviour shipped in `710cfde`)
- [x] **STREAM-04**: Repeated cancel → retry cycles remain stable — the start-stream control keeps working after multiple cancellations, with no progressive wedging

### Windows Audio (AUDIO) — Bug B (related)

- [ ] **AUDIO-01**: On Windows, when the user opts to share audio, a remote viewer hears the captured system/application audio
- [ ] **AUDIO-02**: The Linux virtual-mic / Patchcord audio-track handling does not run on Windows and never strips the Windows `"loopback"` audio track

### Upstream Quality (UPST)

- [x] **UPST-01**: All fixes are surgical, minimal-divergence changes with no new dependencies — structured so they can be submitted as clean PRs to the upstream GoofCord repo

## v2 Requirements

Deferred to a future milestone. Acknowledged but not in this roadmap.

### Windows Streaming (WSTRM)

- **WSTRM-01**: Additional Windows screenshare/streaming bugs beyond the cancel/restart + audio scope (open a new milestone if/when they surface)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| `useSystemPicker` / native Windows source picker | macOS-only in Electron 41; does not apply to Windows and adds upstream divergence (research: STACK/PITFALLS) |
| Per-application audio capture on Windows | `"loopback"` captures the whole system mix only; per-app capture is not supported by the mechanism |
| Re-registering / nulling the display-media handler as a "reset" | Anti-feature — handler is registered once; re-registration is the wrong fix and is unreproducible as a cause (research: ARCHITECTURE/PITFALLS) |
| Linux / macOS streaming behaviour changes | Fork is Windows-focused; must not regress these but won't chase them |
| New streaming features or picker UI redesign | This is a bug-fix fork, not a feature fork |
| Broad multi-bug Windows streaming campaign | Keep this milestone tight; revisit as a new milestone (see WSTRM-01) |
| New dependencies (semver libs, audio libs, etc.) | Fixes must stay minimal and upstream-able |

## Traceability

Which phases cover which requirements. Populated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| STREAM-01 | Phase 1 | Complete |
| STREAM-02 | Phase 1 | Complete |
| STREAM-03 | Phase 1 | Complete |
| STREAM-04 | Phase 1 | Complete |
| AUDIO-01 | Phase 2 | Pending |
| AUDIO-02 | Phase 2 | Pending |
| UPST-01 | Phase 1 | Complete |

**Note:** UPST-01 (surgical, upstream-PR-able, no new dependencies) is a cross-cutting quality constraint. It is owned by Phase 1 for traceability but is re-verified as a success criterion in Phase 2 as well.

**Coverage:**
- v1 requirements: 7 total
- Mapped to phases: 7 ✓
- Unmapped: 0 ✓

---
*Requirements defined: 2026-05-29*
*Last updated: 2026-05-29 after roadmap creation (traceability populated)*
