# Phase 2 Findings — How Discord Captures Per-Process / System Audio on Windows (the echo fix)

**Bug B (retargeted):** the **echo** symptom — upstream [#46]. On Windows, Chromium `audio: "loopback"` captures the *entire* default-endpoint mix, which includes Discord's own playback of the call, so remote viewers hear themselves. (D-01)

**Phase intent:** RECON ONLY (D-02/D-04). This document is the single deliverable. It establishes the publicly-documented baseline by desk research so the developer's hands-on inspection of their *own* installed Discord (in plan 02-02) becomes a fast **confirm/refute** step, not a discover-from-zero step. **No GoofCord code is changed, no prototype is built, and no packages are installed this phase.**

**Status of this document: FINALIZED (02-02 complete).**
- **Desk-research baseline (02-01):** the public WASAPI process-loopback API surface, the minimum Windows build + fallback story, the macOS-driver contrast, and the Electron multi-process complication.
- **Hands-on findings (02-02):** the mechanism *verdict*, the per-claim evidence rows, INCLUDE-vs-EXCLUDE, the excluded-process-tree finding, the Windows build, and the final clean-room go/no-go *conclusion* — all populated from a real on-box inspection.

> **Provenance of the hands-on findings (disclosure):** the on-box inspection (runbook 02-02) was executed by **Claude from inside WSL2 running on the developer's actual Windows 10 machine** — inspecting the *real* installed Discord (`C:\Users\Christ\AppData\Local\Discord\app-1.0.9238`), using GNU `strings`/`objdump` (≡ Sysinternals `strings` / `dumpbin /imports`) and PowerShell device enumeration (≡ Device Manager). Raw results, exact commands, and tooling-substitution notes are in **`02-RECON-OBSERVATIONS.md`**. Every `hands-on confirmed` claim below traces to a line there. The developer verifies this in the Task-3 human-verify checkpoint (honesty guardrail, Pitfall 1).

---

## Legends (apply to every substantive claim below)

> **Every substantive claim in this document MUST carry both a Provenance tag and a Confidence tag.** This is the load-bearing convention (RESEARCH.md "evidence provenance + confidence tagging"). It forces the doc to distinguish "I saw the symbol in the DLL" from "this is what the public API would imply."

### Provenance legend (where the claim came from)

| Tag | Meaning |
|-----|---------|
| `[hands-on: tool / DLL / symbol]` | The developer ran a tool on their box and observed it directly (names the tool used, the file inspected, and the symbol/string seen). |
| `[desk-research: source]` | Established from public sources only (Microsoft docs, public reports, milestone RESEARCH.md) — **NOT** confirmed on the box. |
| `[inference]` | Reasoned from other facts, not directly observed. |

### Confidence legend (how strongly the claim is supported)

| Tag | Meaning |
|-----|---------|
| `hands-on confirmed on my box` | A tool was run on this machine and the result observed directly (02-02; see `02-RECON-OBSERVATIONS.md`). |
| `desk-research / public report` | Established from public sources only, not confirmed on the box. |
| `inference` | Reasoned, not directly observed. |

---

## 1. Mechanism + Evidence

> Maps to **ROADMAP Phase 2 Success Criterion 1** — record Discord's Windows per-process audio-capture mechanism (installed virtual audio driver vs. public WASAPI Application Loopback `EXCLUDE_TARGET_PROCESS_TREE`), backed by concrete evidence.

**Verdict: public WASAPI process-loopback (the Windows Application Loopback API), dynamically loaded — NOT a virtual-device driver.**

`discord_voice.node` carries the Application Loopback code path: it resolves `ActivateAudioInterfaceAsync` at runtime (via `LoadLibrary`/`GetProcAddress` on `mmdevapi.dll`/`audioses.dll`, which are absent from its static import table) and drives it through Discord's own `ActivateApplicationLoopbackForProcessTree` / `ActivateApplicationLoopbackFromPid` wrappers. No Discord-installed virtual audio device exists on the box. The `strings` evidence is corroborated by the `objdump` import table (the dynamic-load strings explain the missing static import — Pitfall 3 resolved in favour of "used, dynamically"). `[hands-on: strings + objdump / discord_voice.node / ActivateApplicationLoopback* + ActivateAudioInterfaceAsync + LoadLibrary/GetProcAddress; PowerShell device enum]` — confidence: `hands-on confirmed on my box`.

**Caveat (not observed):** this is confirmed from the *binary* Discord ships, not from a live capture. Discord was not running, so runtime behaviour (step 6) was not observed, and no audio test was run (out of scope, D-02). On *this* box (build 19045 < 20348, §2.3) Discord's own `audioses is too old for application loopback capture` fallback may mean the path does not activate — the shipped mechanism is confirmed; its activation on sub-20348 builds is not.

### Evidence table

> One row per runbook inspection step. Each row is filled in 02-02 from the developer's raw observations — the runbook result slots map 1:1 to these rows. **Leave empty until the human step runs.**

| Claim | Tool used | DLL / source | Symbol / string | Confidence |
|-------|-----------|--------------|-----------------|------------|
| No Discord-installed virtual audio device (only third-party NVIDIA Broadcast / VB-Cable / Virtual Desktop present) | PowerShell `Get-CimInstance Win32_SoundDevice` + `Get-PnpDevice` (≡ Device Manager) | Windows device set | — (absence of any Discord device) | hands-on confirmed on my box |
| Application-loopback symbols present in the voice engine | `strings -n 5` | `discord_voice.node` | `ActivateApplicationLoopbackForProcessTree`, `ActivateApplicationLoopbackFromPid`, `Failed to load mmdevapi for application loopback capture`, `Application loopback capture started for pid`, `loopback_controller.cpp` | hands-on confirmed on my box (circumstantial alone; corroborated below) |
| API resolved **dynamically**, not statically imported | `objdump -p` (≡ `dumpbin /imports`) | `discord_voice.node` | `mmdevapi.dll` & `audioses.dll` absent from import table; `LoadLibrary*` + `GetProcAddress` present | hands-on confirmed on my box |
| **EXCLUDE** process-tree mode (the echo fix) | `strings -n 5` | `discord_voice.node` | `ActivateApplicationLoopbackForProcessTree`, `excludedSubtrees`, `Excluded` | hands-on confirmed on my box (symbol-level; not a raw enum value) |
| Discord / Audio-Service process tree (live PIDs) | PowerShell `Get-Process` | — | Discord **not running** at inspection time | not run / unknown |
| Windows build below the 20348 API minimum | `cmd.exe /c ver` + registry | `CurrentVersion` | `10.0.19045.6466` (Win10 Home 22H2) — **< 20348** | hands-on confirmed on my box |

### Device Manager result

**Absent — no Discord-installed virtual audio device.** Enumerating audio devices (PowerShell `Get-CimInstance Win32_SoundDevice` + `Get-PnpDevice`, equivalent to Device Manager's *Sound, video and game controllers* / *Audio inputs and outputs*) returned NVIDIA HD Audio, Realtek HD Audio, USB Audio Device, Blue Snowball, and the third-party virtual devices NVIDIA Broadcast / VB-Audio Virtual Cable / Virtual Desktop Audio — **none installed by Discord**. Absence of a Discord device supports the in-OS-API verdict and rules out a Discord virtual-device driver. `[hands-on: PowerShell Get-CimInstance Win32_SoundDevice + Get-PnpDevice / Windows device set]` — confidence: `hands-on confirmed on my box`.

### Honesty guardrail for this section (how it was applied)

A `strings` hit alone is **not** proof of use (Pitfall 3/5): a symbol name can appear in a binary without being imported or called. The corroboration was done: `objdump -p` (≡ `dumpbin /imports`) showed `mmdevapi.dll`/`audioses.dll` are **not** statically imported — but the `strings` evidence (`LoadLibrary*`, `GetProcAddress`, `Failed to get address of ActivateAudioInterfaceAsync`, `Failed to load mmdevapi for application loopback capture`) shows the API is resolved **dynamically at runtime**, which is why it is not in the static import table. So the import-table check *corroborates* dynamic use rather than refuting it, and the mechanism verdict is tagged `hands-on confirmed`. The one dimension not observed (live PIDs, step 6 — Discord not running) is tagged `not run / unknown`, not inferred.

---

## 2. Replication Parameters

> Maps to **ROADMAP Phase 2 Success Criterion 2** — the parameters needed to replicate from the public Microsoft API: INCLUDE-vs-EXCLUDE mode, which process tree Discord excludes (accounting for Electron running audio in a separate process), the minimum Windows build (20348+), and the fallback story for older builds.

_Desk-research baseline (02-01) and the hands-on findings (02-02) are both filled in below; each claim carries its provenance + confidence tag._

### 2.1 INCLUDE vs EXCLUDE — and why EXCLUDE is the echo fix

The public WASAPI process-loopback API takes a `ProcessLoopbackMode` that selects which audio is captured relative to a named process tree:

- `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` — capture **only** the named process and its child processes.
- `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` — capture **everything except** the named process tree.

The **EXCLUDE** mode is the echo fix. Bug B's echo is caused by capturing the *whole* endpoint mix — which includes Discord's own playback of the call (so viewers hear themselves). EXCLUDE-tree captures all system audio *except* the call client's process tree, removing the call playback from the captured stream while keeping the rest of the desktop audio. The Microsoft sample's CLI makes this concrete: `ApplicationLoopback <pid> excludetree out.wav` captures everything except that PID + children. `[desk-research: RESEARCH.md "Standard Stack — clean-room reference"; learn.microsoft.com audioclientactivationparams PROCESS_LOOPBACK_MODE enum; ApplicationLoopback sample]` — confidence: `desk-research / public report` (HIGH on the public API).

This capability is **unreachable from Electron/Chromium.** Chromium's `audio: "loopback"` (and `"loopbackWithMute"`) only exposes whole-endpoint-mix capture with no per-process exclusion — which is exactly what produces the echo, not a fix for it. `[desk-research: milestone STACK.md / PITFALLS P5-P6; RESEARCH.md "State of the Art"]` — confidence: `desk-research / public report`.

**Hands-on confirmation that Discord uses EXCLUDE:** `discord_voice.node` exposes `ActivateApplicationLoopbackForProcessTree` plus the keys `excludedSubtrees` / `Excluded` — i.e. capture-everything-except-a-process-tree, the EXCLUDE path. (A PID-targeted variant, `ActivateApplicationLoopbackFromPid`, also exists.) This is symbol-level evidence, not a read of the raw WASAPI enum value (a compiled integer, invisible to `strings`). `[hands-on: strings / discord_voice.node / ActivateApplicationLoopbackForProcessTree + excludedSubtrees]` — confidence: `hands-on confirmed on my box (symbol-level)`.

### 2.2 Which process tree Discord actually excludes

**Hands-on finding:** Discord's loopback wrapper is process-**tree** scoped, not single-PID scoped — `discord_voice.node` exposes `ActivateApplicationLoopbackForProcessTree` and `excludedSubtrees` (step 5). The *live* process layout (which concrete PIDs / whether a separate "Audio Service" utility process was present) was **not observed** — Discord was not running at inspection time and was not launched (step 6, `not run / unknown`). So the *mode* (exclude a process tree) is hands-on confirmed at symbol level; the *specific runtime PIDs Discord excludes* are not. `[hands-on: strings / discord_voice.node / ActivateApplicationLoopbackForProcessTree + excludedSubtrees; live PIDs not observed]` — confidence: `hands-on confirmed on my box (mode); not run / unknown (live PIDs)`.

**Desk-research complication that constrains a future GoofCord module (Electron multi-process / PID resolution):** Chromium/Electron does **not** play audio from the main window process. Audio is routed through a separate, sandboxed **"Audio Service"** utility process (visible in Task Manager as `Utility: Audio Service`). A future GoofCord exclude-capture module therefore cannot simply "exclude the GoofCord window PID" — the correct exclude target is the GoofCord/Electron **process tree** (parent + children, which is what `EXCLUDE_TARGET_PROCESS_TREE` semantics provide), so the separate Audio Service utility process is covered too. `[desk-research: RESEARCH.md Open Question 2 + Pitfall 4; PITFALLS.md Pitfall 4; Chromium services/audio + Electron sandbox docs]` — confidence: `desk-research / public report` (MEDIUM-HIGH on the architecture). The **exact PID/process on Electron 41.3.0 specifically** (which process actually renders the call audio — main vs. audio-service child) is flagged as a **future-impl open detail**, not a Phase-2 blocker. `[inference]` — confidence: `inference`.

### 2.3 Minimum Windows build + fallback for older builds

- **Minimum Windows build: 20348.** The `PROCESS_LOOPBACK_MODE` enum and the process-loopback activation require **Windows 10 build 20348 or later** (header `audioclientactivationparams.h`); the Microsoft ApplicationLoopback sample page states the same minimum. `[desk-research: RESEARCH.md "Standard Stack — clean-room reference" (VERIFIED row); learn.microsoft.com Requirements table; ApplicationLoopback sample page]` — confidence: `desk-research / public report` (HIGH; authoritative MS docs, cross-confirmed).
  - **⚠ Correction to the 02-01 desk-research claim (hands-on):** the skeleton stated "all Windows 11 builds and Windows 10 21H2/22H2 are ≥ 20348." That is **wrong for Windows 10** — retail Windows 10 (incl. 21H2/22H2) tops out at the **19041–19045** build family, which is **below 20348**. Build 20348 is the Windows Server 2022 / "Iron" line; on the consumer side the API arrives with **Windows 11 (22000+)**. The inspection box here is **Windows 10 Home 22H2 = build 19045.6466 (< 20348)**, so it does **not** meet the API minimum. This is consistent with Discord shipping the path behind a dynamic load + the fallback string `audioses is too old for application loopback capture`. `[hands-on: cmd.exe ver + registry / build 19045.6466]` — confidence: `hands-on confirmed on my box`. **Implication:** a future GoofCord native module must treat build ≥ 20348 (effectively Windows 11) as a hard precondition and degrade gracefully below it.
- **Fallback for builds < 20348:** the exclude-tree mode is **unavailable**. Older builds have only whole-endpoint loopback (no per-process exclusion) — i.e. no native echo fix. The only options below 20348 are (a) the **user-side separate-output-device workaround** (route Discord's output to a separate audio device, e.g. VB-Cable / SteelSeries Sonar, so the captured mix excludes the call — deferred D-06) or (b) no system audio. `[desk-research: RESEARCH.md Open Question 3; #46 user-side workaround comments]` — confidence: `desk-research / public report`.

---

## 3. Clean-room Go/No-Go

> Maps to **ROADMAP Phase 2 Success Criterion 3** — a clear, evidence-based clean-room recommendation on whether GoofCord can replicate the mechanism from the public WASAPI API only (no copied Discord code), producing the go/no-go inputs for the deferred native-module-vs-workaround decision (D-06).

### 3.1 The public-API replication surface (clean-room source of truth, D-05)

The entire exclude-tree capability already exists as the **public Microsoft ApplicationLoopback sample** (windows-classic-samples) — the clean-room source of truth (D-05). Any GoofCord go/no-go MUST rest only on this public API, **never** on copied Discord internals. Reading Discord's DLL in 02-02 answers only *which approach* Discord chose; the *how* comes solely from the Microsoft sample (Pitfall 2; D-05). `[desk-research: RESEARCH.md "Standard Stack — clean-room reference"; learn.microsoft.com ApplicationLoopback sample]` — confidence: `desk-research / public report` (HIGH).

The public symbol surface a future implementation would target (named here for reference only — **not** lifted from Discord, and not an implementation recipe in this phase):

| Public symbol | Role |
|---------------|------|
| `ActivateAudioInterfaceAsync` (`mmdeviceapi.h`, exported from `mmdevapi.dll`) | Async-activates a WASAPI `IAudioClient` for process-scoped loopback instead of a real endpoint. |
| `AUDIOCLIENT_ACTIVATION_PARAMS` (with `ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`) | Wraps the loopback request for the activation call. |
| `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS { TargetProcessId, ProcessLoopbackMode }` | Names the PID and the include/exclude mode. |
| `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK` | The "magic" device path passed to `ActivateAudioInterfaceAsync` (not a real endpoint). |
| `GetMixFormat()` / `IsFormatSupported()` return `E_NOTIMPL` on this device | Known quirk — callers must hardcode a fixed format (e.g. 2ch / 16-bit / 44100). |

`[desk-research: RESEARCH.md "Standard Stack — clean-room reference" + "Code Examples"; learn.microsoft.com mmdeviceapi / audioclientactivationparams; MS Q&A 1125409]` — confidence: `desk-research / public report` (HIGH on the public API surface).

### 3.2 macOS-driver contrast

On **macOS**, Discord ships a third-party Rogue Amoeba Audio Capture Engine (a kernel / system-extension audio driver) **because macOS has no in-OS per-process loopback API.** On **Windows**, the in-OS process-loopback API exists (since build 20348), which is the strongest desk-research signal that Discord on Windows likely uses the public API and needs **no installed driver** — but this is the inference the hands-on step exists to confirm (A1). `[desk-research: RESEARCH.md "State of the Art" / Sources Secondary; publicly reported]` — confidence: `desk-research / public report` (MEDIUM).

### 3.3 Final clean-room go/no-go verdict

**Verdict: GO — conditional (clean-room replication is viable; the condition is build ≥ 20348, effectively Windows 11).**

The hands-on finding (Section 1) removes the central uncertainty: Discord uses the **public WASAPI Application Loopback API**, not a proprietary virtual-device driver or any private interface. Because the mechanism *is* the public API, GoofCord can replicate it from the **public Microsoft `ApplicationLoopback` sample alone**, with **no clean-room violation** — reading `discord_voice.node` told us only *which approach* Discord chose; the *how* comes solely from the Microsoft sample (D-05). `[hands-on: Section 1 evidence]` + `[desk-research: Section 3.1 public API]` — confidence: `hands-on confirmed on my box` (mechanism) / `desk-research / public report` (replication surface).

Inputs to the deferred D-06 decision (native WASAPI module vs. user-side workaround vs. document-only):
- **A native module is unavoidable.** The exclude-tree API is unreachable from Electron/Chromium JS (§2.1) — replication needs a small C++/native addon (the Microsoft sample is the template), built against the existing `venbind`-style native-addon path. This is the cost side of D-06.
- **Build gate is real and was hit on the test box.** The API requires build ≥ 20348; the inspection machine (19045) is below it (§2.3). The module must detect the build and degrade gracefully — exactly as Discord does (`audioses is too old…`). Below the gate, fall back to the **user-side separate-output-device workaround** (§2.3) or no system audio.
- **Exclude target = the GoofCord/Electron process tree**, not a single window PID, to cover Chromium's separate Audio Service utility process (§2.2). The exact runtime PID layout on Electron 41.3.0 is a future-impl open detail (live PIDs were not observed here).
- **Boundary:** do not lift Discord's symbol layout (`ActivateApplicationLoopbackForProcessTree`, `excludedSubtrees`, etc.) into the implementation as a recipe — those are observations of *which* API, used here only to confirm the approach; the build recipe is the public sample (Pitfall 2; D-05).

---

## 4. Recon-only Boundary

> Maps to **ROADMAP Phase 2 Success Criterion 4** — recon-only boundary honoured: no GoofCord source changed and no prototype built in this phase; any future implementation stays clean-room and dependency-minimal. [UPST-01]

**Attestation:** No GoofCord source was changed and no prototype was built in this phase (recon only — D-02, D-04, [UPST-01]). All outputs land under `.planning/phases/02-fix-bug-b-windows-loopback-audio-captured/` only. No packages were installed and no build was run.

**Boundary check:** `git diff --name-only` shows zero changes under `src/`. (The only files this plan touches are `02-FINDINGS.md` and `02-RECON-RUNBOOK.md` under the phase directory.)

**Clean-room boundary (D-05, LOCKED):** Reading Discord's DLL in 02-02 is permitted only to learn *which approach* Discord chose (virtual device vs. public WASAPI process-loopback). It is **not** a source of implementation detail. Any future implementation recipe comes solely from the public Microsoft **ApplicationLoopback** sample — never from Discord's proprietary DLL/driver — to protect a future upstream PR and avoid licensing exposure.

### 4.1 AUDIO-02 — investigated-only conclusion

A code read of `src/windows/main/renderer/postVencord/screensharePatch.ts` confirms `getVirtmic()` (~lines 4-20) returns null on Windows — there is no `GoofCord-Virtual-Mic` device on Windows — so the Patchcord audio-track-removal block (~lines 62-85) does not execute there. Because that block never fires on Windows, it cannot strip the Windows `"loopback"` audio track; therefore **AUDIO-02 is investigated and needs no GoofCord code change for that specific path.** `[desk-research / code read: screensharePatch.ts getVirtmic() / Patchcord track-removal block; RESEARCH.md "Phase Requirements" AUDIO-02 row; CONTEXT.md D-03]` — confidence: `desk-research / public report`.

This is a recorded investigated-only conclusion (D-03), not an implementation. The shelved `process.platform !== "win32"` Patchcord-gate micro-fix remains optional and separable — pursued only if a *future* on-box diagnosis ever shows the track-removal block actually firing on Windows (current evidence says it does not). It is **not** this phase's goal and adds no code task here.
