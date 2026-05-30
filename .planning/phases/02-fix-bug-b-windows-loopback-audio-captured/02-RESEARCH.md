# Phase 2: Fix Bug B — Windows Loopback Audio Captured - Research

**Researched:** 2026-05-30
**Domain:** Reverse-engineering recon — Windows per-process / system audio capture in the official Discord desktop client (the screenshare "echo" fix). Desk-research baseline for a hands-on DLL/Device-Manager inspection.
**Confidence:** HIGH on the public Microsoft WASAPI API surface and the inspection methodology; MEDIUM on "macOS uses a driver, Windows uses the in-OS API" inference; **LOW (unverified) on the specific claim that *Discord* uses process-loopback** — that is the exact question the human hands-on step exists to confirm.

> **This is a RECON phase. No GoofCord code is written and no prototype is built.** The single deliverable is a findings document. This research arms the planner to write two plans: (02-01) the hands-on recon investigation, and (02-02) authoring the findings document. The central goal is to establish the *publicly-documented baseline by desk research* so the developer's hands-on inspection of their own installed Discord becomes a **confirm/refute** step, not a discover-from-zero step.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01 — Bug B retargeted to ECHO.** Target is upstream [#46] ("People hear their voice from stream on non-Linux," confirmed on Windows 11, open): Chromium `"loopback"` captures the whole system mix *including* the Discord call → remote viewers hear themselves. NOT the "audio missing / stream-closes" symptom ([#185]).
- **D-02 — Phase 2 = RECON ONLY.** Deliverable is a findings document on Discord's Windows per-process audio-capture mechanism. No GoofCord code change and no prototype this phase.
- **D-03 — The `!win32` Patchcord-gate fix is shelved as the Bug-B deliverable.** It addresses "audio missing," not echo. Optional separable micro-fix only if a future diagnosis shows the Patchcord track-removal block actually fires on Windows (research says `getVirtmic()` returns null there, so it likely does not).
- **D-04 — Recon the official Discord client first; build nothing yet.** Inspect Discord's native audio modules/driver on Windows; identify the mechanism. Defer all GoofCord implementation decisions until understood.
- **D-05 — Clean-room boundary (LOCKED).** GoofCord's eventual implementation MUST be built from the **public Microsoft WASAPI Application Loopback API** (documented sample), **never copied** from Discord's proprietary DLL/driver. Reading Discord's DLL is permitted *to understand which approach they chose*, not to lift code. This research points to the public Microsoft sample as the clean-room source of truth, NOT Discord internals.
- **D-06 — Implementation path** (native WASAPI `EXCLUDE_TARGET_PROCESS_TREE` module / user-side separate-output-device workaround + docs / do-nothing-document-only) is decided AFTER recon, from evidence.
- **D-07 — Upstream-PR-able vs. fork-only** is decided AFTER recon.
- **D-08 — Viewer-side verification only** (future impl phase): verify only from the viewer (streamer's local playback is muted by design — Electron hardcodes `disable_local_echo=true`, [#37293]); WASAPI loopback delivers no samples unless audio is actively playing ([PortAudio #935], [Audacity #2356]) — keep audio playing.
- **D-09 — No DevTools on the Windows test box** (60% keyboard, no F12). Recon tooling must be CLI/GUI tools, not browser console. Any future renderer-side diagnostics route via IPC to a userData log file, not DevTools.

### Claude's Discretion

- Exact format/structure of the recon findings document.
- Which DLL-inspection tools to recommend (string/symbol scan, dependency walker, Device Manager check). The recon checklist in CONTEXT is the floor, not a script.

### Deferred Ideas (OUT OF SCOPE)

- Build the native Windows WASAPI exclude-process-tree module (the actual echo fix) — deferred until recon confirms the mechanism (D-04, D-06). Likely a milestone re-scope (new native dependency; feature, not bug-fix).
- User-side workaround + documentation (route Discord output to a separate audio device, e.g. VB-Cable / Steelseries Sonar). Decide vs. the module after recon (D-06).
- Upstream-PR vs. fork-only decision (D-07).
- [#185] "share-with-audio immediately closes" surgical fix — a *separate* fixable Windows bug; not this phase.
- Original AUDIO-01 / AUDIO-02 framing ("loopback track present / Patchcord `!win32` gate") — superseded as the Bug-B deliverable by the echo retarget.
- Planning-doc reconciliation (ROADMAP / REQUIREMENTS / PROJECT) — not a code task; tracked separately.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AUDIO-01 | On Windows, when the user opts to share audio, a remote viewer hears the captured system/application audio — **investigated only, delivery deferred** | Re-scoped to echo: the recon establishes *whether* Discord uses WASAPI process-exclusion (so the captured mix excludes Discord's own playback) vs. a virtual device. The findings doc determines the replication path; delivery is a future phase. |
| AUDIO-02 | The Linux virtual-mic / Patchcord audio-track handling does not run on Windows and never strips the Windows `"loopback"` audio track — **investigated only** | Superseded as the Bug-B deliverable (D-03). Verified by code read (`getVirtmic()` returns null on Windows) — kept only as a possible separable micro-fix, not this phase's goal. |
</phase_requirements>

## Summary

The user-facing "Bug B" is **echo**: when a Windows user shares system audio, Chromium's `audio: "loopback"` captures the entire default-endpoint mix — which includes Discord's own playback of the voice call — so remote viewers hear themselves. The only mechanism that captures system audio while *excluding* one app's output is **native WASAPI Application Loopback with process-tree exclusion** (`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`), which is unreachable from Electron/Chromium. This phase is a recon investigation to determine, with evidence, **how the official Discord client solves this on Windows** before GoofCord invests in a native module.

Desk research strongly establishes the *public baseline*: Microsoft's process-loopback API (Windows 10 build **20348+**) does exactly the exclude-tree capture the echo fix needs, and Discord's "experimental method to capture audio from applications" (Voice & Video settings) is the credible behavioural signature of an app-scoped capture path. On **macOS**, Discord ships a third-party Rogue Amoeba kernel/system-extension audio driver — a known fact — because macOS has no in-OS per-process loopback. On **Windows**, the in-OS API exists, which makes the "Discord uses the public WASAPI process-loopback API, no installed driver" hypothesis the most likely. **But this is an inference, not a confirmed fact** — the whole point of the hands-on step is to confirm/refute it by inspecting the developer's installed Discord.

**Primary recommendation:** Have the planner split work cleanly into (a) **desk-research-able facts the AI executor can write up now** (the public WASAPI API parameters, the exact symbols to grep for, the macOS-driver contrast, the Electron multi-process complication, the min-Windows-build/fallback story) and (b) **hands-on facts only the human can establish on their Windows box** (is there a Discord-installed virtual audio device in Device Manager; do Discord's audio DLLs import `ActivateAudioInterfaceAsync` / reference `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`; INCLUDE vs EXCLUDE; which PID/process-tree). The findings doc must tag every claim with **evidence provenance** (which tool, which DLL, which symbol) and **confidence** (`hands-on confirmed on my box` vs `desk-research / public report`), and must NOT overclaim a hands-on conclusion that was only desk-researched (the D-08/D-09 honesty theme).

## Architectural Responsibility Map

This is a recon phase producing a document, so "tiers" map to *evidence sources* and *who can produce each finding*.

| Capability (recon question) | Primary Source | Secondary Source | Rationale |
|------------------------------|----------------|------------------|-----------|
| What the public WASAPI exclude-tree API is + parameters | **Desk research (AI)** — Microsoft docs + sample | — | Fully public; no Discord access needed. Clean-room source of truth (D-05). |
| Min Windows build + fallback for older builds | **Desk research (AI)** — MS Requirements table | — | Authoritative: build 20348. |
| Electron audio runs in a separate process (PID-targeting complication) | **Desk research (AI)** — Chromium/Electron docs | Hands-on (Task Manager PID confirm) | Public fact; the *specific* PID to exclude is a future-impl detail. |
| Does Discord install a virtual audio device on Windows? | **Hands-on (human)** — Device Manager | Behavioural reports | Requires the developer's installed Discord. |
| Do Discord's audio DLLs import the process-loopback symbols? | **Hands-on (human)** — DLL string/import scan | — | Requires inspecting `%LocalAppData%\Discord\...\modules\` on the box. |
| INCLUDE vs EXCLUDE mode Discord uses | **Hands-on (human)** — symbol scan + behaviour | Desk inference (exclude = echo fix) | Confirmed only on the box; desk research says *which would be the echo fix*. |
| macOS-driver contrast (does Windows need a driver?) | **Desk research (AI)** — public reports | Hands-on (absence of a Windows driver) | macOS Rogue Amoeba driver is publicly documented; Windows absence is the confirm step. |
| Clean-room go/no-go recommendation | **Synthesis (both)** | — | Combines the public API (replicable) with the hands-on mechanism finding. |

## Standard Stack

> This phase ships **no code** and installs **no packages**. The "stack" here is (a) the public Microsoft API a *future* implementation would target (the clean-room reference, D-05) and (b) the free inspection tools the developer runs on their Windows box.

### The clean-room reference (what a FUTURE implementation would target — not built this phase)

| Component | Identifier | Purpose | Provenance |
|-----------|-----------|---------|------------|
| Activation entry point | `ActivateAudioInterfaceAsync` (`mmdeviceapi.h`, exported from `mmdevapi.dll`) | Async-activate a WASAPI `IAudioClient` for process-scoped loopback instead of an endpoint | [CITED: learn.microsoft.com/.../nf-mmdeviceapi-activateaudiointerfaceasync] |
| Magic device path | `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK` | Passed as `deviceInterfacePath` to request process-loopback activation (not a real endpoint) | [CITED: MS Q&A 1125409] |
| Activation params | `AUDIOCLIENT_ACTIVATION_PARAMS` with `ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` | Wraps the loopback request for the activation call | [CITED: learn.microsoft.com/.../ns-...-audioclient_activation_params] |
| Process filter | `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS { TargetProcessId, ProcessLoopbackMode }` | Names the PID to include/exclude and the mode | [CITED: learn.microsoft.com/.../ns-...-audioclient_process_loopback_params] |
| Mode enum | `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` / `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` (`audioclientactivationparams.h`) | INCLUDE = capture only that app's tree; **EXCLUDE = capture everything *except* that app's tree = the echo fix** | [VERIFIED: learn.microsoft.com Requirements table — enum names + min build 20348] |
| Runtime implementer | `AudioSes.dll` (`CMixerClient`) | The actual loopback client behind the activation; quirk: `GetMixFormat()`/`IsFormatSupported()` return `E_NOTIMPL` for the process-loopback device — callers hardcode a format (e.g. 2ch/16-bit/44100) | [CITED: MS Q&A 1125409] |
| Reference sample | Microsoft **ApplicationLoopback** (windows-classic-samples) | The clean-room implementation to copy *from* (D-05). CLI: `ApplicationLoopback <pid> excludetree out.wav` | [VERIFIED: learn.microsoft.com sample page — "requires Windows 10 build 20348 or later"] |

### Free Windows inspection tools (what the developer runs on their box — the hands-on step)

| Tool | Purpose | Admin? | Notes / Provenance |
|------|---------|--------|--------------------|
| **Device Manager** (`devmgmt.msc`) → *Sound, video and game controllers* + *Audio inputs and outputs* | Check for a Discord-installed virtual audio device | No (read-only view) | Presence ⇒ Discord uses a virtual-device approach (heavier, not cleanly GoofCord-replicable). Absence ⇒ supports the in-OS-API hypothesis. [ASSUMED — standard Windows tool] |
| **Sysinternals `strings.exe`** (or `strings64.exe`) | Dump ASCII+Unicode strings from a DLL; grep for symbol/string names | No | Best first pass — fast, no SDK needed. Use `strings -n 8 discord_voice.node \| findstr /I "ActivateAudioInterface PROCESS_LOOPBACK VIRTUAL_AUDIO_DEVICE"`. [VERIFIED: Sysinternals strings is the documented string-extraction tool] |
| **`dumpbin /imports`** (ships with Visual Studio / Build Tools "Developer Command Prompt") | List the exact functions a DLL imports from other DLLs — definitively shows if it imports `ActivateAudioInterfaceAsync` from `mmdevapi.dll` | No (read-only) | More authoritative than `strings` for *imports* (a string match could be incidental). `dumpbin /imports discord_voice.node \| findstr /I mmdevapi` then look for the function. [CITED: learn.microsoft.com /IMPORTS (DUMPBIN)] |
| **Dependencies** (lucasg/Dependencies — the modern open-source Dependency Walker) | GUI recursive view of imported/exported functions and dependency DLLs | No | GUI alternative for the developer who prefers not to use the CLI; resolves recursive deps `dumpbin` does not. [ASSUMED — widely-used free PE tool] |
| **PE-bear / CFF Explorer / PEview** (any free PE viewer) | Inspect the import table visually | No | Optional; same data as `dumpbin /imports`. [ASSUMED] |
| **Task Manager** (Details tab) / `tlist` | Find the PID(s) of Discord's processes and the Chromium/Electron "Audio Service" utility process | No | Needed to reason about *which* process tree a future exclude-capture must target. [CITED: MS sample uses Task Manager / tlist to get the PID] |

**Tooling note (honours D-09 — no DevTools / 60% keyboard):** every tool above is a standalone CLI or GUI app. None requires the browser console or function keys. `strings` and `dumpbin` are typed commands; Device Manager / Dependencies / Task Manager are clickable GUIs. None requires admin to *read* a DLL or *view* Device Manager (admin is only implicated if the developer chooses to install Discord's audio helper for the first time to observe the prompt — optional, and not required for the recon).

## Package Legitimacy Audit

> **Not applicable — this phase installs no packages and ships no code.** All tools recommended above are either Microsoft first-party (`dumpbin`, Device Manager, Task Manager), Microsoft Sysinternals (`strings`), or well-known open-source PE inspectors the developer already trusts (Dependencies). No npm/PyPI/crates install occurs. slopcheck gate: N/A.

If a *future* implementation phase (deferred, D-06) builds a native WASAPI module, the package-legitimacy gate runs then — not now.

## Architecture Patterns

### Recon evidence-flow diagram

```
                          DESK RESEARCH (AI executor — do now)
                          ┌─────────────────────────────────────────────┐
                          │ Microsoft docs: ActivateAudioInterfaceAsync,  │
                          │ AUDIOCLIENT_ACTIVATION_PARAMS,                 │
                          │ PROCESS_LOOPBACK_MODE_*  (build 20348+)        │
                          │ + ApplicationLoopback sample (clean-room ref)  │
                          │ + macOS Rogue-Amoeba-driver contrast           │
                          │ + Electron "Audio Service" separate process    │
                          └───────────────┬─────────────────────────────┘
                                          │ establishes the BASELINE
                                          ▼
        HANDS-ON (human, Windows box) ───────────────────►  CONFIRM / REFUTE
        ┌───────────────────────────────────────────┐
   [1]  │ Device Manager: Discord virtual device?    │──► driver-approach?  yes/no
        ├───────────────────────────────────────────┤
   [2]  │ %LocalAppData%\Discord\app-*\modules\      │
        │   discord_voice*, discord_krisp*, helpers  │
        │   ── strings / dumpbin /imports ──►         │──► symbols present?
        │   ActivateAudioInterfaceAsync (mmdevapi)?  │     PROCESS_LOOPBACK?
        │   VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK?    │     INCLUDE vs EXCLUDE?
        ├───────────────────────────────────────────┤
   [3]  │ Task Manager: Discord + Audio-Service PIDs │──► which tree to exclude?
        └───────────────────────┬───────────────────┘
                                │ each finding tagged: tool + DLL + symbol + confidence
                                ▼
                  ┌──────────────────────────────────────┐
                  │ FINDINGS DOC (02-02 deliverable)       │
                  │  mechanism + evidence                  │
                  │  replication parameters                │
                  │  clean-room go/no-go (from PUBLIC API) │
                  │  recon-only boundary honoured (D-05)   │
                  └──────────────────────────────────────┘
```

### Recommended findings-document structure (maps 1:1 to the 4 ROADMAP success criteria)

```
02-FINDINGS.md (or similar — name at planner's discretion, D-claude)
├── 1. Mechanism + Evidence            → SC-1
│     - Verdict: virtual-device driver | public WASAPI process-loopback | other | inconclusive
│     - Evidence table: each row = {claim, tool used, DLL/source, symbol/string, confidence}
│     - Device Manager result (driver present? screenshot/note)
├── 2. Replication Parameters          → SC-2
│     - INCLUDE vs EXCLUDE (and why EXCLUDE = echo fix)
│     - Which process tree Discord excludes (+ Electron separate-audio-process note)
│     - Min Windows build (20348) + fallback story for < 20348
├── 3. Clean-room Go/No-Go             → SC-3
│     - Can GoofCord replicate from the PUBLIC Microsoft API alone? (yes/no/conditional)
│     - Inputs to the deferred native-module vs. user-workaround decision (D-06)
│     - Explicit clean-room statement: built from MS sample, not Discord code (D-05)
└── 4. Recon-only Boundary Honoured    → SC-4
      - Attestation: no GoofCord source changed, no prototype built this phase
      - Provenance legend + confidence legend used throughout
```

### Pattern: evidence provenance + confidence tagging (the load-bearing convention)

Every factual claim in the findings doc carries two tags so a reviewer can verify it:

```
Provenance:  [tool: dumpbin /imports] [file: discord_voice-<ver>\discord_voice.node] [symbol: ActivateAudioInterfaceAsync]
Confidence:  [hands-on confirmed on my box]   ← the developer ran the tool and saw it
        or:  [desk-research / public report]  ← established from public sources only, NOT confirmed on the box
        or:  [inference]                       ← reasoned, not directly observed
```

**Why this matters:** the honesty trap (extends D-08/D-09) is writing "Discord uses EXCLUDE_TARGET_PROCESS_TREE" as a flat fact when it was only *inferred* from public reports. The two-tag convention forces the doc to distinguish "I saw the symbol in the DLL" from "this is what the public API would imply." The go/no-go recommendation (SC-3) must rest only on the *public* API (which is fully desk-confirmed and replicable), never on copied Discord internals (D-05).

### Anti-patterns to avoid

- **Lifting Discord's DLL code or strings into the doc as an implementation recipe.** Reading the DLL tells you *which approach* Discord chose; the *how* must come from the Microsoft sample (D-05). Quoting Discord's proprietary symbol layout as a build guide breaks the clean-room boundary and poisons any future upstream PR.
- **Reporting a desk-research inference as a hands-on finding.** If the developer didn't actually scan the DLL, the mechanism verdict is "desk-research / inconclusive — needs on-box confirmation," not "confirmed."
- **Treating a `strings` match as proof of use.** A string can appear without the symbol being imported/called. Corroborate a `strings` hit with `dumpbin /imports` (does it actually import the function?) before upgrading confidence.
- **Forgetting the Electron multi-process reality when reasoning about the PID.** A future module can't just exclude "the Discord window PID" — Chromium routes audio through a separate **Audio Service utility process**. Document this as an open replication detail, not a solved one.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Per-process / exclude-app audio capture on Windows (the future fix) | A custom audio mixer or a virtual audio cable driver | The **public WASAPI process-loopback API** via the Microsoft **ApplicationLoopback** sample | Microsoft ships the exact `EXCLUDE_TARGET_PROCESS_TREE` capability; reimplementing it (or installing a kernel driver like macOS does) is heavier and not cleanly upstreamable. Clean-room source of truth (D-05). |
| Determining the min Windows version / fallback | Guessing or testing build-by-build | The MS **Requirements table** (build **20348**) | Authoritative and already desk-confirmed; no on-box experimentation needed for this fact. |
| Identifying a DLL's imports | Eyeballing `strings` output and hoping | `dumpbin /imports` (definitive import table) | A string match is circumstantial; the import table is authoritative. |
| Capturing audio with no driver | Writing/installing a virtual device | The in-OS process-loopback API (no device install) | On Windows the API exists since 20348; macOS needs a driver *because it lacks this API* — that contrast is the whole reason Windows likely needs no driver. |

**Key insight:** the entire echo fix already exists as a documented, public Microsoft API. The recon's job is not to invent anything — it is to confirm Discord uses it (so GoofCord can confidently follow the *public* sample), and to surface the one genuine complication (Electron's separate audio process / which PID to exclude).

## Runtime State Inventory

> Included because the *eventual* fix touches runtime audio state, but **this phase is recon-only** — no code runs and no state is mutated. Documenting for the planner's awareness of what a future impl phase must handle; **none of this is changed in Phase 2.**

| Category | Items Found | Action Required (FUTURE phase only) |
|----------|-------------|--------------------------------------|
| Stored data | None — recon produces a document only. | None this phase. |
| Live service config | None this phase. (Future: a Windows capture module would hang off the existing `audioConfig.mode !== "none"` branch in `src/windows/screenshare/screenshare.ts:90` that currently sets `result.audio = "loopback"`.) | None this phase. |
| OS-registered state | The *recon* observes (does not register) whether Discord installed a virtual audio device. GoofCord registers nothing. | None this phase. A future virtual-device path (if chosen) would; the WASAPI-API path would not. |
| Secrets/env vars | None. (Existing native-module path overrides `GOOFCORD_PATCHCORD_PATH` / `GOOFCORD_VENBIND_PATH` are unrelated to this recon.) | None this phase. |
| Build artifacts | None — no build runs. | None this phase. |

**Nothing is mutated in Phase 2 — verified by D-02/D-04 (recon-only, build nothing).**

## Common Pitfalls

### Pitfall 1: Overclaiming a hands-on conclusion that was only desk-researched
**What goes wrong:** The findings doc states "Discord uses WASAPI `EXCLUDE_TARGET_PROCESS_TREE`" as fact when no one actually scanned the DLL — it was inferred from the macOS-driver contrast + the public API existing.
**Why it happens:** The desk-research baseline is *so* strong it feels like proof. The AI executor can fully establish the public API but **cannot** inspect the developer's Discord.
**How to avoid:** Two-tag every claim (provenance + confidence). The mechanism verdict stays `desk-research / inferred` until the human confirms it on-box. This is the direct extension of D-08/D-09's "don't overclaim verification."
**Warning signs:** A SC-1 verdict with no `[tool: …][file: …][symbol: …]` provenance row; confidence words ("clearly," "obviously") instead of a confidence tag.

### Pitfall 2: Breaking the clean-room boundary by mining Discord's DLL for implementation detail
**What goes wrong:** The doc quotes Discord's internal symbol arrangement or copies strings as a build recipe, contaminating a future upstream PR (D-05).
**Why it happens:** Once you're already in the DLL confirming *which* approach, it's tempting to also harvest *how*.
**How to avoid:** Reading the DLL answers exactly one question — include/exclude WASAPI vs. virtual device. The implementation recipe comes only from the Microsoft **ApplicationLoopback** sample. State this boundary explicitly in SC-3/SC-4.
**Warning signs:** The go/no-go (SC-3) cites a Discord internal as a how-to source instead of the MS sample.

### Pitfall 3: `strings` false positive treated as proof of use
**What goes wrong:** A symbol name appears in `strings` output (e.g. in a vendored header blob) but the DLL never actually imports/calls it; the doc concludes "Discord uses process-loopback."
**Why it happens:** `strings` matches text anywhere in the binary, including dead data.
**How to avoid:** Corroborate any `strings` hit with `dumpbin /imports` — does the DLL actually import `ActivateAudioInterfaceAsync` from `mmdevapi.dll`? Only then upgrade confidence.
**Warning signs:** A mechanism verdict resting solely on a `strings` grep with no import-table corroboration.

### Pitfall 4: Ignoring the Electron / Chromium separate-audio-process reality when reasoning about the PID
**What goes wrong:** The replication-parameters section (SC-2) says "exclude the Discord window PID," which would be wrong for a future module — Chromium plays audio from a separate **Audio Service utility process**, so excluding only the main window's tree might still capture (or miss) the call audio.
**Why it happens:** Intuition says "the app is one process."
**How to avoid:** Document that Chromium/Electron runs audio in a sandboxed Audio Service utility process (visible in Task Manager as "Utility: Audio Service"), so the right exclude target is the GoofCord/Electron process *tree* (parent + children), not just the window PID — and flag the exact PID resolution as a future-impl open detail. [CITED: Chromium services/audio; Electron sandbox docs]
**Warning signs:** SC-2 names a single PID with no mention of the audio-service process or process-tree semantics.

### Pitfall 5: Confusing the two Discord audio failure modes (echo vs. missing)
**What goes wrong:** The recon drifts back to "audio missing / stream closes" ([#185]) instead of the **echo** target ([#46]).
**Why it happens:** Most public troubleshooting content is about *missing* audio, not echo; search results are dominated by it.
**How to avoid:** Keep the target framed as echo (D-01): the question is "how does Discord capture system audio *while excluding its own call playback*," which only `EXCLUDE_TARGET_PROCESS_TREE` answers. Treat "missing audio" articles as noise.
**Warning signs:** Recon notes about device-selection / exclusive-mode fixes (those are missing-audio remedies, irrelevant to echo).

## Code Examples

> No GoofCord code is written this phase. These are the *reference* shapes the findings doc points at as the clean-room source (D-05) and the *commands* the developer runs. They are illustrative, from public sources — not to be implemented in Phase 2.

### The public exclude-tree activation shape (clean-room reference — Microsoft ApplicationLoopback)
```cpp
// Source: Microsoft ApplicationLoopback sample (windows-classic-samples) +
//         learn.microsoft.com audioclientactivationparams reference. PUBLIC / clean-room (D-05).
// The EXCLUDE mode is the echo fix: capture all system audio EXCEPT the named process tree.
AUDIOCLIENT_ACTIVATION_PARAMS params = {};
params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
params.ProcessLoopbackParams.TargetProcessId   = targetPid;                                  // the app to exclude
params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

// Activated against the magic device path, not a real endpoint:
ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                            __uuidof(IAudioClient), &propvariant_wrapping_params,
                            completionHandler, &asyncOp);
// Note: GetMixFormat()/IsFormatSupported() return E_NOTIMPL on this device — use a fixed format. (MS Q&A 1125409)
// Requires Windows 10 build 20348+.
```

### The hands-on DLL inspection commands (what the developer types on Windows)
```text
:: Source: Sysinternals strings + MS dumpbin docs. Run in the modules folder.
cd "%LocalAppData%\Discord"
dir /b /s app-*\modules\discord_voice*  app-*\modules\*krisp* app-*\modules\*audio*

:: 1) fast string pass (corroborate hits with imports before trusting):
strings -n 8 discord_voice.node | findstr /I "ActivateAudioInterface PROCESS_LOOPBACK VIRTUAL_AUDIO_DEVICE AUDIOCLIENT_ACTIVATION"

:: 2) authoritative import-table check (Developer Command Prompt for VS):
dumpbin /imports discord_voice.node | findstr /I "mmdevapi ActivateAudioInterfaceAsync"

:: 3) which process tree to reason about (Task Manager Details, or):
tasklist /v | findstr /I discord
```

### CLI shape of the reference sample (proves include vs exclude semantics)
```text
:: Source: Microsoft ApplicationLoopback sample page. PUBLIC.
ApplicationLoopback 1234 includetree Captured.wav   :: capture ONLY pid 1234 + children
ApplicationLoopback 1234 excludetree Captured.wav   :: capture EVERYTHING EXCEPT pid 1234 + children  <-- echo fix
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| System loopback captures the *entire* endpoint mix (`WASAPI_INCLUDE`-only, or Chromium `"loopback"`) → unavoidable echo | Per-process loopback with include/**exclude** tree filter via `ActivateAudioInterfaceAsync` + `AUDIOCLIENT_ACTIVATION_PARAMS` | Windows 10 build **20348** (released ~2021) | The exclude-tree mode is *the* mechanism that captures system audio without the app's own playback — the echo fix. Unreachable from Chromium/Electron, hence the need for a native module. |
| macOS: kernel/system-extension audio driver (Discord ships Rogue Amoeba ACE) | Windows: in-OS process-loopback API, **no driver install** (hypothesis) | n/a | The macOS-vs-Windows contrast is the strongest desk-research signal that Discord on Windows uses the public API, not an installed driver — to be confirmed on-box. |

**Deprecated / not the route:**
- Chromium `audio: "loopback"` / `"loopbackWithMute"` for the *echo* fix: captures whole mix, no per-app exclusion — this is precisely what causes Bug B, not a fix for it (milestone STACK.md, PITFALLS P5/P6).
- `getUserMedia({ chromeMediaSource: "desktop" })` legacy desktop-audio path: whole-mix, messier, prone to capturing the app's own output (milestone STACK.md).
- Installing a virtual audio cable / kernel driver on Windows: unnecessary given the in-OS API; heavier and not cleanly upstreamable.

## Assumptions Log

> Claims the planner / a future discuss-phase should treat as needing on-box confirmation before becoming locked facts.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Discord on Windows uses the public WASAPI process-loopback API (not an installed virtual-device driver) | Summary, State of the Art | If Discord actually installs a driver, the clean-room replication story changes (driver path is heavier / less upstreamable). **This is the central question the hands-on step exists to settle — it is correctly LOW confidence until then.** |
| A2 | Discord uses `EXCLUDE_TARGET_PROCESS_TREE` (not INCLUDE) | Replication parameters | If INCLUDE, Discord captures a chosen app rather than excluding itself — a different UX and a different replication target. Confirm via symbol scan + behaviour. |
| A3 | Discord's audio DLL is `discord_voice*.node` (and/or a `*krisp*` / audio-helper DLL) under `%LocalAppData%\Discord\app-*\modules\` | Inspection methodology | If the relevant code lives elsewhere (or is statically linked into the main binary), the developer must widen the scan. Low risk — the modules folder is the documented Discord layout. |
| A4 | macOS Discord ships the Rogue Amoeba Audio Capture Engine (kernel/system extension) | State of the Art | Used only as a *contrast* argument; if imprecise it weakens (but doesn't break) the "Windows needs no driver" inference. Publicly reported, MEDIUM confidence. |
| A5 | The free tools listed (`strings`, `dumpbin`, Dependencies) can read Discord's DLLs without admin | Standard Stack | If a DLL is locked/in-use, the developer copies it out first; trivially worked around. Very low risk. |
| A6 | A future module must exclude the Electron/GoofCord **process tree** (to also cover the separate Audio Service utility process), not just the window PID | Pitfall 4, SC-2 | If the audio actually renders from the window process on this Electron build, the exclude target is simpler. Flag as a future-impl open detail, not a Phase-2 blocker. |

## Open Questions (RESOLUTION PATHS DOCUMENTED)

1. **Does Discord install a Windows virtual audio device, or use the in-OS API?**
   - What we know: macOS needs (and Discord ships) a driver; Windows has the in-OS process-loopback API since build 20348. Discord exposes an "experimental method to capture audio from applications" toggle (behavioural signature of app-scoped capture).
   - What's unclear: whether the *current* Windows Discord build routes through the public API or a bundled device — desk research cannot see inside the installed DLLs.
   - Recommendation: **Hands-on (human)** — Device Manager check + `dumpbin /imports` on `discord_voice*.node`. This is the single highest-value on-box finding (resolves A1/A2).
   - Resolution path: → resolved by 02-02 Task 1 (hands-on, on-box confirm/refute).

2. **Which exact PID/process-tree would a future GoofCord module exclude?**
   - What we know: Chromium/Electron runs audio in a separate sandboxed "Audio Service" utility process; the GoofCord/Electron process tree (parent + children) is the natural exclude target.
   - What's unclear: on Electron 41.3.0 specifically, which process actually renders the call audio (main vs. audio-service child).
   - Recommendation: desk-research the architecture now (done); leave the precise PID resolution as a **future-impl open detail** in SC-2 — not a Phase-2 blocker.
   - Resolution path: → desk-research baseline in 02-01 Task 2; exact PID deferred as a future-impl detail.

3. **Is there any case where `EXCLUDE_TARGET_PROCESS_TREE` is unavailable (< build 20348)?**
   - What we know: API requires build 20348+. Older builds have only whole-endpoint loopback (no exclude) — no native echo fix.
   - What's unclear: how many real users run < 20348 (Win10 21H2/22H2 and all Win11 are ≥ 20348).
   - Recommendation: document the fallback story in SC-2: below 20348, the only options are the user-side separate-output-device workaround (D-06 deferred) or no system audio. Desk-research-able — already answered.
   - Resolution path: → resolved by 02-01 Task 2 (desk-research; build-20348 fallback written into the SC-2 section of 02-FINDINGS.md).

## Environment Availability

> The recon tools run on the **developer's Windows box**, not in this AI session. The AI executor cannot probe that machine. This table is what the *human plan (02-01)* must confirm available before the hands-on scan; it is not an AI-runnable probe.

| Dependency | Required By | Available (on AI host) | Verify on Windows box | Fallback |
|------------|-------------|------------------------|------------------------|----------|
| Installed Discord desktop client | DLL/Device-Manager inspection | ✗ (not on this host) | Developer confirms Discord installed under `%LocalAppData%\Discord` | None — the on-box steps are blocked without it; AI does the desk-research half regardless |
| Sysinternals `strings.exe` | DLL string scan | ✗ | Download from Sysinternals (no install) | `dumpbin`/Dependencies cover the same need |
| `dumpbin` (VS Build Tools) | Import-table check | ✗ | Confirm "Developer Command Prompt" / VS Build Tools present | Dependencies (lucasg) GUI, or PE-bear |
| Device Manager / Task Manager | Driver + PID checks | ✗ | Built into Windows | None needed |
| Windows build ≥ 20348 | (Future) running the WASAPI API | n/a | `winver` on the box | N/A this phase (recon only) |

**Blocking for the hands-on half:** the developer's Windows box with Discord installed. **Non-blocking:** the desk-research half (public API, methodology, parameters, contrasts) — the AI executor produces all of it without any machine access. The planner should structure 02-01 so the AI writes the desk-research baseline and the human slots in the confirm/refute results.

## Sources

### Primary (HIGH confidence)
- `https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-process_loopback_mode` — `PROCESS_LOOPBACK_MODE` enum names + **Requirements table: Minimum supported client Windows 10 Build 20348, header `audioclientactivationparams.h`**. (Authoritative; resolves the 20348-vs-20438 search discrepancy in favour of **20348**.)
- `https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/` — ApplicationLoopback sample; `includetree`/`excludetree` CLI; "requires Windows 10 build 20348 or later"; clean-room reference (D-05).
- `https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-activateaudiointerfaceasync` — `ActivateAudioInterfaceAsync` signature (entry point; `mmdeviceapi.h`).
- `https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params` — `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS { TargetProcessId, ProcessLoopbackMode }`.
- `https://learn.microsoft.com/en-us/cpp/build/reference/imports-dumpbin` — `dumpbin /imports` (authoritative import-table inspection).
- `.planning/research/STACK.md`, `.planning/research/PITFALLS.md` (P5/P6/P7), `.planning/research/SUMMARY.md` — milestone audio-API context (Chromium `"loopback"` = whole mix; `disable_local_echo`; viewer-side verification). Cited, not re-derived.
- GoofCord source: `src/windows/screenshare/screenshare.ts:90-98` (`audioConfig.mode !== "none"` → `result.audio = "loopback"`), `src/windows/main/renderer/postVencord/screensharePatch.ts` (`getVirtmic()` returns null on Windows). Direct read.

### Secondary (MEDIUM confidence)
- `https://learn.microsoft.com/en-us/answers/questions/1125409/...` — `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK` device path; `AudioSes!CMixerClient`; `GetMixFormat` returns `E_NOTIMPL` (use fixed format). Good corroborating grep targets.
- Chromium `services/audio` + Electron sandbox docs (separate sandboxed "Audio Service" utility process; PID-targeting complication). Verified via multiple sources.
- macOS Discord uses the Rogue Amoeba Audio Capture Engine (kernel/system extension) — the contrast that motivates the "Windows needs no driver" inference. Publicly reported.

### Tertiary (LOW confidence — flagged for on-box confirmation)
- General reports that Discord exposes an "experimental method to capture audio from applications" (Voice & Video settings) — behavioural signature of app-scoped capture; not a source-level confirmation.
- The central claim "Discord on Windows uses the public WASAPI process-loopback API" — **inference only, LOW confidence; the hands-on step exists to confirm/refute it** (A1).

## Metadata

**Confidence breakdown:**
- Public WASAPI clean-room API (parameters, symbols, min build 20348, exclude=echo-fix): **HIGH** — authoritative Microsoft docs, cross-confirmed.
- Inspection methodology (which tools, which symbols, which DLLs, no-admin, no-DevTools): **HIGH** — standard Windows tooling; tools verified against MS/Sysinternals docs.
- "Discord uses the public API, no driver, EXCLUDE mode": **LOW** — desk inference; explicitly the question the human hands-on step resolves (A1/A2).
- Electron separate-audio-process complication: **MEDIUM-HIGH** — public Chromium/Electron architecture; exact PID on Electron 41.3.0 left as future-impl detail.
- Findings-doc structure + provenance/confidence convention: **HIGH** — maps 1:1 to the 4 ROADMAP success criteria.

**Research date:** 2026-05-30
**Valid until:** ~2026-07-30 for the public Microsoft API (stable since 2021). The "what Discord currently ships" half is the on-box recon's job and may drift with Discord auto-updates — re-confirm at inspection time.

---
*Research for: Phase 2 — Windows loopback audio echo recon (GoofCord Windows Streaming Fixes fork)*
*Recon-only phase: no code written, no packages installed, no state mutated (D-02/D-04).*
