# Phase 2: Fix Bug B — Windows Loopback Audio Captured - Context

**Gathered:** 2026-05-30
**Status:** Ready for planning — ⚠️ **RE-SCOPED during discussion (see Phase Boundary)**

<domain>
## Phase Boundary

**This phase was re-scoped during discussion.** It is no longer a surgical code fix. Phase 2 is now a **recon / reverse-engineering investigation** with a single deliverable: a **findings document** describing exactly **how the official Discord desktop client captures per-process / system audio on Windows without echoing the call back to viewers**.

**In scope (this phase):**
- Determine Discord's Windows audio-capture mechanism by inspecting its shipped native modules/driver and observed behaviour.
- Identify whether Discord uses (a) an installed virtual audio device driver, or (b) the public **WASAPI Application Loopback** API with **process-tree exclusion** (`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`), or something else.
- Document the minimum Windows version, the process-tree/PID targeting detail (which process Discord excludes), and what it would take for GoofCord to replicate it from the **public Microsoft API** (clean-room).
- Produce a findings doc that lets a future phase decide the implementation path with evidence.

**Explicitly NOT in this phase:**
- No GoofCord code change. No prototype. No native module build. (All deferred — see Deferred Ideas.)
- The implementation path (native WASAPI module vs. user-side workaround vs. documentation) is **decided after recon**.
- The upstream-PR-able vs. fork-only decision is **decided after recon**.

**Why the re-scope (the crux):** The user-facing Windows "Bug B" the owner actually cares about is the **echo** symptom (upstream [#46]: viewers hear *their own* voice), not "audio missing." Echo is caused by Chromium's `"loopback"` capturing the **entire default-endpoint mix**, which includes Discord's playback of the call. The only mechanism that captures system audio while *excluding* Discord's own output is **native WASAPI Application Loopback with process exclusion** — unreachable from Electron/Chromium. So the original surgical `process.platform !== "win32"` Patchcord-gate fix does **not** deliver this; it addresses a *different* symptom ("audio missing / track stripped"). Before investing in a native module, the owner chose to **recon how Discord solves it** first.

**⚠️ Conflicts this creates (must be reconciled — see confirm step):**
- Supersedes the **ROADMAP Phase 2 goal** ("surgical `!win32` loopback gate") and **Success Criteria** (AUDIO-01/02 as written are about a *present-but-stripped* loopback track, not echo).
- Contradicts **REQUIREMENTS.md → Out of Scope** ("Per-application audio capture on Windows") and **PROJECT.md** framing ("bug-fix fork, not a feature fork"; "no new dependencies"; "upstream-PR-able").
- These planning docs need updating (ROADMAP phase goal+criteria, REQUIREMENTS, PROJECT) so they reflect the recon-then-feature direction.

</domain>

<decisions>
## Implementation Decisions

### Target symptom & scope pivot
- **D-01 — Bug B retargeted to ECHO.** The target is upstream [#46] ("People hear their voice from stream on non-Linux" — confirmed on Windows 11, still open), i.e. `"loopback"` captures the whole system mix including the Discord call → remote viewers hear themselves. This is NOT the "audio missing / stream-closes" symptom ([#185]).
- **D-02 — Phase 2 = RECON ONLY.** Deliverable is a findings document on Discord's Windows per-process audio-capture mechanism. No GoofCord code change and no prototype this phase (user chose "Recon Discord only, no prototype yet").
- **D-03 — The `!win32` Patchcord-gate fix is shelved as the Bug-B deliverable.** It addresses "audio missing," not echo. Keep it only as an optional, separable micro-fix *if* a future diagnosis shows the Patchcord track-removal block actually fires on Windows (research says `getVirtmic()` returns null there, so it likely does not). It is not this phase's goal.

### Recon approach
- **D-04 — Recon the official Discord client first; build nothing yet.** Inspect Discord's native audio modules/driver on Windows and identify the mechanism (installed virtual audio driver vs. public WASAPI Application Loopback process-exclusion). Defer all GoofCord implementation decisions until the mechanism is understood.
- **D-05 — Clean-room boundary (LOCKED).** GoofCord's eventual implementation MUST be built from the **public Microsoft WASAPI Application Loopback API** (documented sample), **never copied** from Discord's proprietary DLL/driver. Reading Discord's DLL is permitted *to understand which approach they chose*, not to lift code — this protects any future upstream PR and avoids licensing exposure.

### Deferred decisions (resolved AFTER recon, from evidence)
- **D-06 — Implementation path** (native WASAPI `EXCLUDE_TARGET_PROCESS_TREE` module **/** user-side separate-output-device workaround + docs **/** do-nothing/document-only) is decided after recon.
- **D-07 — Upstream-PR-able vs. fork-only** is decided after recon, based on how invasive the real implementation turns out to be (user chose "Decide after the spike").

### Verification (applies to the future implementation phase, not recon)
- **D-08 — Viewer-side verification is available.** User has a 2nd Discord account on a separate device to confirm "viewers no longer hear themselves." Two gotchas that MUST be respected when that phase comes:
  - Verify **only from the viewer** — the streamer's local playback is muted by design (Electron hardcodes `disable_local_echo=true`, [#37293]); listening on the streaming box gives a false result.
  - WASAPI loopback **delivers no samples unless audio is actively playing** on the endpoint during the test ([PortAudio #935], [Audacity #2356]) — keep audio playing or you'll misread silence as "broken."
- **D-09 — No DevTools on the Windows test box** (60% keyboard, no F12 — see project memory `windows-verification-no-devtools`). This **corrects Phase 1's D-03 DevTools assumption.** Any renderer-side diagnostics in a future implementation phase must route via IPC to the userData `screenshare-debug.log` file (extends Phase 1 **D-02**), not DevTools.

### Carried forward from Phase 1 (still apply to any future Windows build)
- **Phase 1 D-01:** one combined Windows CI build per round-trip, instrumentation + change as distinct commits (CI round-trips are scarce).
- **Phase 1 D-02:** main-process probes append to a userData `screenshare-debug.log` (packaged NSIS build has no attached console).
- **Phase 1 D-04:** strip all instrumentation before any upstream PR (UPST-01).

### Claude's Discretion
- Exact format/structure of the recon findings document.
- Which DLL-inspection tools to recommend (string/symbol scan, dependency walker, Device Manager check) — the recon *checklist* below is the floor, not a script.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### The retargeted bug + ecosystem prior art (read first)
- `https://github.com/Milkshiift/GoofCord/issues/46` — **THE target.** Echo on non-Linux/Windows; viewers hear their own voice. Maintainer Milkshiift: *"just simple audio capture Chromium provides … no Electron/Chromium API to capture audio of specific windows … native audio capturing akin to venmic but for Windows is way out of scope."* Also lists the user-side workaround (route Discord output to a separate device).
- `https://github.com/Milkshiift/GoofCord/issues/185` — **Related, deprioritized.** Windows "share screen with system audio doesn't launch" — stream closes instantly when audio is on; audio-off works. This is the *surgically-fixable* symptom (grant-shape / immediate-end), separable from echo. Maintainer asked reporter to retest 2.2.0; unresolved.
- `https://github.com/Milkshiift/GoofCord/issues/204` — Linux-only no-sound (PipeWire). Contrast case; not our platform.
- Vesktop (same problem, **unsolved upstream** — evidence the echo fix is genuinely hard): `https://github.com/Vencord/Vesktop/issues/789`, `/657`, `/1059`, `/569`, `/772`.

### The candidate mechanism (public, clean-room)
- `https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/` — Microsoft **ApplicationLoopback** sample. `ActivateAudioInterfaceAsync` + `AUDIOCLIENT_ACTIVATION_PARAMS` with `PROCESS_LOOPBACK_MODE_INCLUDE_/EXCLUDE_TARGET_PROCESS_TREE`. `ApplicationLoopback <pid> excludetree` = capture everything except a process tree = the echo fix. **Requires Windows 10 build 20348+.**
- `https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording` — WASAPI loopback recording docs.
- `https://github.com/alectrocute/electron-audio-loopback` — de-facto Electron loopback reference. Whole-mix only — demonstrates the limitation GoofCord currently hits.

### Electron audio API context
- `https://github.com/electron/electron/issues/37293` — Electron hardcodes `disable_local_echo=true`; local playback muted during capture (the streamer-side "mirage").
- `https://github.com/electron/electron/issues/45517` — unhandled rejection / malformed grant shape (`video` must be valid); relevant to [#185]'s immediate-close.
- `https://github.com/electron/electron/issues/49607` — desktop audio capture regression in 40.1.0 (**macOS-centric** — do not over-attribute to a Windows regression; see PITFALLS Pitfall 7).
- `https://github.com/electron/electron/issues/46369` — Win11 renderer crash on the **legacy** `chromeMediaSourceId` path (NOT GoofCord's `setDisplayMediaRequestHandler` path).

### Verification gotchas (for the future impl phase)
- `https://github.com/PortAudio/portaudio/issues/935`, `https://github.com/audacity/audacity/issues/2356` — WASAPI loopback yields no samples when nothing is playing. Keep audio playing during verification.

### Milestone research (already on disk)
- `.planning/research/PITFALLS.md` — **Pitfalls 5, 6, 7** are Bug B: loopback needs valid video track / track-arrival check (P5), `disable_local_echo`/`loopbackWithMute` "mirage" + viewer-side verification (P6), don't over-attribute to an Electron regression (P7). Includes the "Looks Done But Isn't" checklist.
- `.planning/research/SUMMARY.md` — executive synthesis incl. the Phase 2 research flag.
- `.planning/research/STACK.md` — Electron audio API contract (`audio:"loopback"`/`"loopbackWithMute"` "Windows only"; `useSystemPicker` macOS-only).
- `.planning/research/FEATURES.md` — "definition of fixed" behaviours.

### Code targets (for understanding the current Windows audio path; not changed this phase)
- `src/windows/main/renderer/postVencord/screensharePatch.ts` — `getVirtmic()` (`:4-20`) returns null on Windows (no `GoofCord-Virtual-Mic` device), so the Patchcord track-removal block (`:62-85`) should not fire there; the `audio:"loopback"` track Electron returns is the whole-system-mix that causes echo. `STREAM_CLOSE` FluxDispatcher cleanup (`:90-104`) + the `GoofCord.stopPatchcord`/`stopVenmic` bridge are the integration pattern a future Windows module would mirror.
- `src/windows/screenshare/screenshare.ts` — `result.audio = "loopback"` granted for non-Linux when `audioConfig.mode !== "none"` (`:90-100`); whole-mix, no exclude capability via Electron.

### Prior phase + project context
- `.planning/phases/01-fix-bug-a-cancel-then-restart-works/01-CONTEXT.md` — Phase 1 D-01..D-04 environment decisions (CI build strategy, userData log file, instrumentation cleanup).
- git `710cfde` — the cancellation→`NotAllowedError` fix (Phase 0/upstream); Phase 1 fix `88baaf2`.
- Project memory `windows-verification-no-devtools` — no F12/DevTools on the test box; route diagnostics to a userData log file.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Native-module + IPC bridge pattern already exists for Linux audio.** `patchcord` (PipeWire/PulseAudio per-app capture) is wired via `src/modules/native/patchcord.ts`, exposed to the renderer as `GoofCord.stopPatchcord` and consumed in `screensharePatch.ts`. A future Windows WASAPI module would slot into this exact shape (native addon → main IPC → renderer bridge → `STREAM_CLOSE` teardown). The build already resolves platform-specific `.node` binaries via the `nativeModulePlugin` (`GOOFCORD_PATCHCORD_PATH` / `GOOFCORD_VENBIND_PATH` overrides) — a Windows audio `.node` could follow the same convention.
- **userData `screenshare-debug.log`** writer pattern from Phase 1 (D-02) is the diagnostics channel for any future Windows build (no DevTools available).

### Established Patterns
- **Per-app audio capture is the Linux feature, absent on Windows.** Linux gets per-app via Patchcord/venmic; Windows currently has only whole-mix `"loopback"`. The recon's purpose is to determine whether a Windows analog (WASAPI process-exclusion) is viable — i.e., the missing leg of an existing pattern, not a new architecture.
- `audioConfig.mode` ("none" / "system" / "app") already flows from the picker UI into `selectScreenshareSource`; a future Windows exclude-capture path would hang off the same `mode !== "none"` branch that currently sets `result.audio = "loopback"`.

### Integration Points
- The eventual Windows capture module (if built) replaces/augments the `result.audio = "loopback"` grant for Windows and/or post-processes the stream's audio track in `screensharePatch.ts`, mirroring how the Linux `getVirtmic()` path swaps in the virtual-mic track. **This phase touches none of it — recon only.**

</code_context>

<specifics>
## Specific Ideas

**Recon checklist (the floor for the findings doc):**
1. **Locate Discord's native audio modules:** `%LocalAppData%\Discord\app-<ver>\modules\` — examine `discord_voice-*` (voice engine `.node`/`.dll`), `discord_krisp`, and any audio-helper DLLs.
2. **Check for an installed driver:** Device Manager → *Sound, video and game controllers* — look for a Discord-installed virtual audio device (the "audio helper / driver" the #46 commenter described; first-use reportedly needs admin). Presence ⇒ Discord uses a virtual-device approach (heavier, not GoofCord-replicable cleanly).
3. **String/symbol-scan the audio DLLs** for: `ActivateAudioInterfaceAsync`, `AUDIOCLIENT_ACTIVATION_PARAMS`, `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`. Presence ⇒ Discord uses the **public WASAPI process-loopback** API ⇒ directly replicable from the Microsoft sample (clean-room).
4. **Determine include vs. exclude:** does Discord EXCLUDE its own process tree (capture everything else) or INCLUDE a chosen app? **Exclude-tree** is the echo fix.
5. **Identify the right PID/process tree:** Electron runs audio I/O in a separate process from the window thread (search-confirmed complication) — document which process hosts GoofCord's voice/audio output so a future module excludes the correct tree.
6. **Record the minimum Windows version** and the fallback story for < build 20348.

**"See how Discord does it" was the user's explicit preferred first step** — over speculatively building a module — because it de-risks the whole direction cheaply.

</specifics>

<deferred>
## Deferred Ideas

- **Build the native Windows WASAPI exclude-process-tree module** — the actual echo fix. Deferred until recon (D-04) confirms the mechanism and the prototype/build is greenlit (D-06). This is a future phase and a likely **milestone re-scope** (new native dependency; feature, not bug-fix).
- **User-side workaround + documentation** — route Discord's output to a separate audio device (VB-Cable / Steelseries Sonar, per #46 comments) so the captured mix excludes the call. Zero-code alternative to a native module; decide vs. the module after recon (D-06).
- **Upstream-PR vs. fork-only decision** (D-07) — deferred to post-recon.
- **[#185] "share-with-audio immediately closes" surgical fix** — a *separate*, genuinely fixable Windows audio bug (grant-shape / immediate-end). Diagnosable via `stream.getAudioTracks()` + observing whether the stream closes on audio-enable. Could be its own small phase if it affects the owner's setup; not this phase.
- **Original AUDIO-01 / AUDIO-02 framing** ("loopback track present / Patchcord `!win32` gate") — superseded as the Bug-B deliverable by the echo retarget. Revisit only if the owner also wants the "missing-audio" path covered.
- **Planning-doc reconciliation** — update ROADMAP (Phase 2 goal + success criteria), REQUIREMENTS (AUDIO-01/02 + Out-of-Scope), and PROJECT (fork identity) to reflect recon-then-feature. Recommended via `/gsd-phase` and a milestone review (see confirm step). Not a code task.

None of the above expand *this* phase's (recon) scope — they are the explicitly-deferred downstream steps.

</deferred>

---

*Phase: 2-fix-bug-b-windows-loopback-audio-captured*
*Context gathered: 2026-05-30*
