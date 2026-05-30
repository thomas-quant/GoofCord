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

_[Filled by Task 2 — desk research.]_

### 2.2 Which process tree Discord actually excludes

_[depends on 02-02 observations — the *actual* excluded tree is read from Discord on the box. Task 2 documents the Electron separate-audio-process complication that constrains a future GoofCord module; the specific tree Discord targets is a hands-on finding.]_

### 2.3 Minimum Windows build + fallback for older builds

_[Filled by Task 2 — desk research.]_

---

## 3. Clean-room Go/No-Go

> Maps to **ROADMAP Phase 2 Success Criterion 3** — a clear, evidence-based clean-room recommendation on whether GoofCord can replicate the mechanism from the public WASAPI API only (no copied Discord code), producing the go/no-go inputs for the deferred native-module-vs-workaround decision (D-06).

### 3.1 The public-API replication surface (clean-room source of truth, D-05)

_[Filled by Task 2 — desk research. States that the entire exclude-tree capability already exists as the public Microsoft ApplicationLoopback sample and that any go/no-go MUST rest only on the public API, never on copied Discord internals (D-05).]_

### 3.2 Final clean-room go/no-go verdict

_[depends on 02-02 mechanism finding — yes / no / conditional. This synthesis combines the public API (fully desk-confirmed and replicable) with the hands-on mechanism finding from Section 1. Do not assert a verdict until the human step resolves the mechanism.]_

---

## 4. Recon-only Boundary

> Maps to **ROADMAP Phase 2 Success Criterion 4** — recon-only boundary honoured: no GoofCord source changed and no prototype built in this phase; any future implementation stays clean-room and dependency-minimal. [UPST-01]

**Attestation:** No GoofCord source was changed and no prototype was built in this phase (recon only — D-02, D-04, [UPST-01]). All outputs land under `.planning/phases/02-fix-bug-b-windows-loopback-audio-captured/` only. No packages were installed and no build was run.

**Boundary check:** `git diff --name-only` shows zero changes under `src/`. (The only files this plan touches are `02-FINDINGS.md` and `02-RECON-RUNBOOK.md` under the phase directory.)

**Clean-room boundary (D-05, LOCKED):** Reading Discord's DLL in 02-02 is permitted only to learn *which approach* Discord chose (virtual device vs. public WASAPI process-loopback). It is **not** a source of implementation detail. Any future implementation recipe comes solely from the public Microsoft **ApplicationLoopback** sample — never from Discord's proprietary DLL/driver — to protect a future upstream PR and avoid licensing exposure.

### 4.1 AUDIO-02 — investigated-only conclusion

_[Filled by Task 2 — code-read note recording that AUDIO-02 needs no GoofCord code change for the Patchcord `!win32` path.]_
