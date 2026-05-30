# Phase 2 Findings — How Discord Captures Per-Process / System Audio on Windows (the echo fix)

**Bug B (retargeted):** the **echo** symptom — upstream [#46]. On Windows, Chromium `audio: "loopback"` captures the *entire* default-endpoint mix, which includes Discord's own playback of the call, so remote viewers hear themselves. (D-01)

**Phase intent:** RECON ONLY (D-02/D-04). This document is the single deliverable. It establishes the publicly-documented baseline by desk research so the developer's hands-on inspection of their *own* installed Discord (in plan 02-02) becomes a fast **confirm/refute** step, not a discover-from-zero step. **No GoofCord code is changed, no prototype is built, and no packages are installed this phase.**

**Status of this document:**
- **Sections filled now (02-01, desk research):** the public WASAPI process-loopback API surface, the minimum Windows build + fallback story, the macOS-driver contrast, and the Electron multi-process complication.
- **Sections to be filled in 02-02 (hands-on, on the developer's Windows box):** the mechanism *verdict*, the per-claim evidence rows, INCLUDE-vs-EXCLUDE, the actual excluded process tree, and the final clean-room go/no-go *conclusion*.

The hands-on slots below are deliberately left as clearly-marked unfilled placeholders. **Do not pre-fill any hands-on conclusion from inference** (Pitfall 1; the D-08/D-09 honesty theme). The mechanism verdict is the central question the human step resolves.

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
| `hands-on confirmed on my box` | The developer ran the tool and saw it. **Reserved for 02-02.** |
| `desk-research / public report` | Established from public sources only, not confirmed on the box. |
| `inference` | Reasoned, not directly observed. |

---

## 1. Mechanism + Evidence

> Maps to **ROADMAP Phase 2 Success Criterion 1** — record Discord's Windows per-process audio-capture mechanism (installed virtual audio driver vs. public WASAPI Application Loopback `EXCLUDE_TARGET_PROCESS_TREE`), backed by concrete evidence.

**Verdict: [TO BE FILLED IN 02-02 FROM HANDS-ON OBSERVATIONS — one of: virtual-device driver | public WASAPI process-loopback | other | inconclusive]**

Do **not** pre-fill this verdict from inference. The desk-research baseline (Section 3, and the macOS contrast below) makes "Discord uses the public WASAPI process-loopback API, no installed driver" the *most likely* hypothesis — but that is `[inference]` / LOW confidence (RESEARCH.md A1/A2; Pitfall 1). The verdict only becomes a stated fact once the developer runs the runbook (`02-RECON-RUNBOOK.md`) and the Evidence table below is populated from on-box observations.

### Evidence table

> One row per runbook inspection step. Each row is filled in 02-02 from the developer's raw observations — the runbook result slots map 1:1 to these rows. **Leave empty until the human step runs.**

| Claim | Tool used | DLL / source | Symbol / string | Confidence |
|-------|-----------|--------------|-----------------|------------|
| _[TO BE FILLED IN 02-02 — runbook step 2: Device Manager virtual-device present?]_ | | | | |
| _[TO BE FILLED IN 02-02 — runbook step 3: `strings` pass for process-loopback symbols]_ | | | | |
| _[TO BE FILLED IN 02-02 — runbook step 4: `dumpbin /imports` corroboration (`ActivateAudioInterfaceAsync` from `mmdevapi`)]_ | | | | |
| _[TO BE FILLED IN 02-02 — runbook step 5: INCLUDE vs EXCLUDE]_ | | | | |
| _[TO BE FILLED IN 02-02 — runbook step 6: Discord / Audio-Service process tree]_ | | | | |
| _[TO BE FILLED IN 02-02 — runbook step 7: Windows build (≥ 20348?) via `winver`]_ | | | | |

### Device Manager result

_[TO BE FILLED IN 02-02 FROM HANDS-ON OBSERVATIONS — is a Discord-installed virtual audio device present under *Sound, video and game controllers* / *Audio inputs and outputs*? Present ⇒ supports virtual-device-driver verdict; absent ⇒ supports in-OS-API verdict. depends on 02-02 observations.]_

### Honesty guardrail for this section

A `strings` hit alone is **not** proof of use (Pitfall 3/5): a symbol name can appear in a binary without being imported or called. A `strings` hit must be corroborated by `dumpbin /imports` (does the DLL actually import the function from `mmdevapi.dll`?) before its confidence is upgraded. Until the human step runs, no Discord-mechanism claim in this section may be tagged `hands-on confirmed`.

---

## 2. Replication Parameters

> Maps to **ROADMAP Phase 2 Success Criterion 2** — the parameters needed to replicate from the public Microsoft API: INCLUDE-vs-EXCLUDE mode, which process tree Discord excludes (accounting for Electron running audio in a separate process), the minimum Windows build (20348+), and the fallback story for older builds.

_Desk-research-able sub-points are filled by Task 2. Hands-on-dependent sub-points are marked `[depends on 02-02 observations]`._

### 2.1 INCLUDE vs EXCLUDE — and why EXCLUDE is the echo fix

The public WASAPI process-loopback API takes a `ProcessLoopbackMode` that selects which audio is captured relative to a named process tree:

- `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` — capture **only** the named process and its child processes.
- `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` — capture **everything except** the named process tree.

The **EXCLUDE** mode is the echo fix. Bug B's echo is caused by capturing the *whole* endpoint mix — which includes Discord's own playback of the call (so viewers hear themselves). EXCLUDE-tree captures all system audio *except* the call client's process tree, removing the call playback from the captured stream while keeping the rest of the desktop audio. The Microsoft sample's CLI makes this concrete: `ApplicationLoopback <pid> excludetree out.wav` captures everything except that PID + children. `[desk-research: RESEARCH.md "Standard Stack — clean-room reference"; learn.microsoft.com audioclientactivationparams PROCESS_LOOPBACK_MODE enum; ApplicationLoopback sample]` — confidence: `desk-research / public report` (HIGH on the public API).

This capability is **unreachable from Electron/Chromium.** Chromium's `audio: "loopback"` (and `"loopbackWithMute"`) only exposes whole-endpoint-mix capture with no per-process exclusion — which is exactly what produces the echo, not a fix for it. `[desk-research: milestone STACK.md / PITFALLS P5-P6; RESEARCH.md "State of the Art"]` — confidence: `desk-research / public report`.

### 2.2 Which process tree Discord actually excludes

The *actual* process tree Discord excludes is a hands-on finding: `[depends on 02-02 observations]` — it is read from Discord on the developer's box (runbook step 5 + step 6).

**Desk-research complication that constrains a future GoofCord module (Electron multi-process / PID resolution):** Chromium/Electron does **not** play audio from the main window process. Audio is routed through a separate, sandboxed **"Audio Service"** utility process (visible in Task Manager as `Utility: Audio Service`). A future GoofCord exclude-capture module therefore cannot simply "exclude the GoofCord window PID" — the correct exclude target is the GoofCord/Electron **process tree** (parent + children, which is what `EXCLUDE_TARGET_PROCESS_TREE` semantics provide), so the separate Audio Service utility process is covered too. `[desk-research: RESEARCH.md Open Question 2 + Pitfall 4; PITFALLS.md Pitfall 4; Chromium services/audio + Electron sandbox docs]` — confidence: `desk-research / public report` (MEDIUM-HIGH on the architecture). The **exact PID/process on Electron 41.3.0 specifically** (which process actually renders the call audio — main vs. audio-service child) is flagged as a **future-impl open detail**, not a Phase-2 blocker. `[inference]` — confidence: `inference`.

### 2.3 Minimum Windows build + fallback for older builds

- **Minimum Windows build: 20348.** The `PROCESS_LOOPBACK_MODE` enum and the process-loopback activation require **Windows 10 build 20348 or later** (header `audioclientactivationparams.h`); the Microsoft ApplicationLoopback sample page states the same minimum. `[desk-research: RESEARCH.md "Standard Stack — clean-room reference" (VERIFIED row); learn.microsoft.com Requirements table; ApplicationLoopback sample page]` — confidence: `desk-research / public report` (HIGH; authoritative MS docs, cross-confirmed). In practice all Windows 11 builds and Windows 10 21H2/22H2 are ≥ 20348.
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

_[depends on 02-02 mechanism finding — yes / no / conditional. This synthesis combines the public API (fully desk-confirmed and replicable, Section 3.1) with the hands-on mechanism finding from Section 1. Do not assert a verdict until the human step resolves the mechanism.]_

---

## 4. Recon-only Boundary

> Maps to **ROADMAP Phase 2 Success Criterion 4** — recon-only boundary honoured: no GoofCord source changed and no prototype built in this phase; any future implementation stays clean-room and dependency-minimal. [UPST-01]

**Attestation:** No GoofCord source was changed and no prototype was built in this phase (recon only — D-02, D-04, [UPST-01]). All outputs land under `.planning/phases/02-fix-bug-b-windows-loopback-audio-captured/` only. No packages were installed and no build was run.

**Boundary check:** `git diff --name-only` shows zero changes under `src/`. (The only files this plan touches are `02-FINDINGS.md` and `02-RECON-RUNBOOK.md` under the phase directory.)

**Clean-room boundary (D-05, LOCKED):** Reading Discord's DLL in 02-02 is permitted only to learn *which approach* Discord chose (virtual device vs. public WASAPI process-loopback). It is **not** a source of implementation detail. Any future implementation recipe comes solely from the public Microsoft **ApplicationLoopback** sample — never from Discord's proprietary DLL/driver — to protect a future upstream PR and avoid licensing exposure.

### 4.1 AUDIO-02 — investigated-only conclusion

A code read of `src/windows/main/renderer/postVencord/screensharePatch.ts` confirms `getVirtmic()` (~lines 4-20) returns null on Windows — there is no `GoofCord-Virtual-Mic` device on Windows — so the Patchcord audio-track-removal block (~lines 62-85) does not execute there. Because that block never fires on Windows, it cannot strip the Windows `"loopback"` audio track; therefore **AUDIO-02 is investigated and needs no GoofCord code change for that specific path.** `[desk-research / code read: screensharePatch.ts getVirtmic() / Patchcord track-removal block; RESEARCH.md "Phase Requirements" AUDIO-02 row; CONTEXT.md D-03]` — confidence: `desk-research / public report`.

This is a recorded investigated-only conclusion (D-03), not an implementation. The shelved `process.platform !== "win32"` Patchcord-gate micro-fix remains optional and separable — pursued only if a *future* on-box diagnosis ever shows the track-removal block actually firing on Windows (current evidence says it does not). It is **not** this phase's goal and adds no code task here.
