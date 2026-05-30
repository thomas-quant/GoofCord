# Phase 2 Recon Observations — On-Box Inspection of Discord's Windows Audio-Capture Mechanism

> **Raw observations from running `02-RECON-RUNBOOK.md`.** These feed the evidence table in `02-FINDINGS.md → ## 1. Mechanism + Evidence` (each step maps 1:1 to a row).

## ⚠ How these observations were collected (read first — honesty disclosure)

The plan 02-02 anticipated the **developer** running this on a physical Windows box. In fact it was run by **Claude (the AI executor)** from inside **WSL2, which is running on the developer's actual Windows 10 machine** — so the binaries inspected are the *real* installed Discord (`C:\Users\Christ\AppData\Local\Discord`), not a fabrication or inference. This is a legitimate hands-on inspection of the real machine; it is **not** desk research and **not** invented. The developer reviews this file and `02-FINDINGS.md` in the Task-3 human-verify checkpoint.

**Tooling substitutions (same underlying data, different tool than the runbook named):**

| Runbook tool | Tool actually used | Why equivalent |
|--------------|--------------------|----------------|
| Sysinternals `strings.exe` | GNU `strings` (binutils, in WSL) | Reads the same byte stream of the same PE file. |
| `dumpbin /imports` (VS) | `objdump -p` (binutils, in WSL) | Reads the same PE import directory / import name table. |
| Device Manager GUI (`devmgmt.msc`) | PowerShell `Get-CimInstance Win32_SoundDevice` + `Get-PnpDevice` (via WSL interop) | Enumerates the same device set, more precisely than eyeballing the GUI tree. |
| `winver` dialog | `cmd.exe /c ver` + registry `CurrentVersion` (via WSL interop) | Same build number, exact. |

**Honesty caveats that limit confidence (carried into FINDINGS):**
- **Step 6 (live PIDs): NOT observed** — Discord was not running at inspection time, and I did not launch it (avoiding a state change the user didn't request). Live PID / Audio-Service enumeration is recorded as `not run / unknown`.
- **INCLUDE-vs-EXCLUDE (step 5): inferred from symbol *names*, not a raw enum read.** The WASAPI `ProcessLoopbackMode` enum is a compiled integer and is invisible to `strings`. The EXCLUDE conclusion rests on the symbol/JSON-key strings `excludedSubtrees`, `Excluded`, and `ActivateApplicationLoopbackForProcessTree` — strong, but not the literal enum constant.
- **Corroboration (Pitfall 3):** `strings` showed `ActivateAudioInterfaceAsync`; `objdump` showed `mmdevapi.dll` is **not** a static import. Rather than refuting use, the strings themselves (`LoadLibrary*`, `GetProcAddress`, `Failed to get address of ActivateAudioInterfaceAsync`, `Failed to load mmdevapi for application loopback capture`) explain the absence: the API is resolved **dynamically at runtime**. So the import-table absence *corroborates* dynamic loading; it does not weaken the "Discord uses this API" finding.

---

## Step 1 — Locate Discord's native audio modules

**Command (WSL):** `ls -d /mnt/c/Users/Christ/AppData/Local/Discord/app-*` then enumerate `*/modules/`.

- **Result:** Install root `…\Discord\app-1.0.9238`. Native audio modules found:
  - `…\app-1.0.9238\modules\discord_voice-1\discord_voice\discord_voice.node` (PE32+ DLL, x86-64, ~14 MB) — **the voice/loopback engine**
  - `…\app-1.0.9238\modules\discord_krisp-1\discord_krisp\discord_krisp.node` (PE32+ DLL, x86-64, ~15 MB) — noise suppression (not the loopback path; not deeply inspected)
  - Alongside `discord_voice.node`: `audio_effects_helper.exe`, `gpu_encoder_helper.exe`, `mediapipe.dll`, `index.js`, `manifest.json` (no separate audio-capture DLL — the loopback code is inside `discord_voice.node`).
- **Provenance/Confidence:** `[hands-on: ls/find / %LocalAppData%\Discord\app-1.0.9238\modules\ / discord_voice.node + discord_krisp.node]` + `hands-on confirmed on my box`

---

## Step 2 — Discord-installed virtual audio device?

**Command (WSL interop):** `powershell.exe Get-CimInstance Win32_SoundDevice` and `Get-PnpDevice -Class AudioEndpoint,Media`.

- **Result:** **No Discord-branded / Discord-installed virtual audio device present.** Devices enumerated: NVIDIA High Definition Audio, Realtek High Definition Audio, USB Audio Device, Blue Snowball, NVIDIA Virtual Audio Device (WDM), NVIDIA Broadcast, VB-Audio Virtual Cable, Virtual Desktop Audio. The only "virtual" devices are third-party (NVIDIA Broadcast, VB-Audio Cable, Virtual Desktop) — **none installed by Discord**.
- **Interpretation:** Absence of a Discord device ⇒ supports the in-OS public-WASAPI-API mechanism and **rules out** a Discord-installed virtual-device-driver mechanism.
- **Provenance/Confidence:** `[hands-on: PowerShell Get-CimInstance Win32_SoundDevice + Get-PnpDevice / Windows device set]` + `hands-on confirmed on my box`

---

## Step 3 — `strings` symbol pass on `discord_voice.node`

**Command (WSL):** `strings -n 5 discord_voice.node | grep -iE "loopback|exclude|ActivateAudioInterface|ActivateApplicationLoopback|PROCESS_LOOPBACK|mmdevapi|audioses|GetProcAddress|LoadLibrary"`

- **Result (verbatim, deduped — the load-bearing matches):**
  - `ActivateApplicationLoopbackForProcessTree`
  - `ActivateApplicationLoopbackFromPid failed: %X`
  - `Failed to get address of ActivateApplicationLoopbackFromPid`
  - `Failed to get address of ActivateAudioInterfaceAsync`
  - `ActivateAudioInterfaceAsync failed:`
  - `Failed to query IAudioClient from ActivateAudioInterfaceAsync result: %X`
  - `Failed to load mmdevapi for application loopback capture`
  - `Failed to load audioses for application loopback capture`
  - `audioses is too old for application loopback capture`
  - `Application loopback capture initialized / started / stopped for pid`
  - `Process loopback device init failed`
  - `Excluded`, `excluded`, `excludedSubtrees`
  - `setLoopback`, `soundshareLoopback`, `SetLoopback@Discord`
  - C++ source paths: `../../discord_native_lib/src/media/loopback_audio_stream.cpp`, `../../discord_native_lib/src/media/soundshare/loopback_controller.cpp`
  - C++ symbols: `LoopbackAudioStream::StartRecord`, `LoopbackController::Start() failed with code: %X`, `void __cdecl Discord::SetLoopback(bool, const LocalVoiceLevelChangedCallback &)`
  - Dynamic-loader imports present: `LoadLibraryA/W/ExA/ExW`, `GetProcAddress`
- **Provenance/Confidence:** `[hands-on: strings -n 5 / discord_voice.node / above symbols]` + `hands-on confirmed on my box` (circumstantial until corroborated by step 4 — see corroboration note below, which resolves it)

---

## Step 4 — Authoritative import-table check (`objdump -p`, ≡ `dumpbin /imports`)

**Command (WSL):** `objdump -p discord_voice.node | grep -i "DLL Name:"` and filter for audio DLLs.

- **Result:** Audio-relevant **static** imports are: `avrt.dll`, `WINMM.dll`, `ole32.dll`, `PROPSYS.dll`, `setupapi.dll`. **`mmdevapi.dll` is NOT in the static import table. `audioses.dll` is NOT in the static import table.** (Other imports: KERNEL32, ntdll, USER32, ADVAPI32, OLEAUT32, SHLWAPI, SHELL32, ole32, WS2_32, qwave, ffmpeg, mediapipe, d3d11, dxgi, dwmapi, bcrypt(primitives), ncrypt, GDI32, various api-ms-win-* — none of which is `mmdevapi`/`audioses`.)
- **Corroboration verdict:** The absence of `mmdevapi.dll`/`audioses.dll` from the static import table, **combined with** the step-3 strings (`LoadLibrary*`, `GetProcAddress`, `Failed to get address of ActivateAudioInterfaceAsync`, `Failed to load mmdevapi for application loopback capture`), means Discord resolves `ActivateAudioInterfaceAsync` **dynamically at runtime** (`LoadLibrary("mmdevapi"/"audioses")` + `GetProcAddress`). This is the expected pattern for an API that is only present on newer Windows builds — and it is corroborated, not refuted, by the import table.
- **Provenance/Confidence:** `[hands-on: objdump -p / discord_voice.node / static import table — mmdevapi & audioses absent; dynamic LoadLibrary/GetProcAddress present]` + `hands-on confirmed on my box`

---

## Step 5 — INCLUDE vs EXCLUDE

- **Result: EXCLUDE-mode process-tree loopback** (the echo fix), inferred from symbol names. Evidence: `ActivateApplicationLoopbackForProcessTree` (process-TREE, not single PID), plus the keys/strings `excludedSubtrees`, `Excluded`, `excluded`. A PID-based variant also exists (`ActivateApplicationLoopbackFromPid`). No `INCLUDE`-flavoured symbol was seen.
- **Confidence caveat:** This rests on symbol/key *names*, not the literal WASAPI enum value (`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` is a compiled integer, invisible to `strings`). Strong, but symbol-level — not a raw enum read.
- **Provenance/Confidence:** `[hands-on: strings / discord_voice.node / ActivateApplicationLoopbackForProcessTree + excludedSubtrees + Excluded]` + `hands-on confirmed on my box (symbol-level; not a raw enum value)`

---

## Step 6 — Discord + Chromium "Audio Service" PIDs

- **Result: NOT RUN / unknown.** Discord was not running at inspection time (`Get-Process *discord*` returned nothing), and I did not launch it (avoiding an unrequested state change). Live PID / "Audio Service" utility-process enumeration was therefore **not observed on this box**. The process-tree exclusion *capability* is confirmed at the symbol level (step 5, `…ForProcessTree`), but the live process layout was not captured.
- **Provenance/Confidence:** `[hands-on: PowerShell Get-Process — Discord not running]` + `not run / unknown`

---

## Step 7 — Windows build

**Command (WSL interop):** `cmd.exe /c ver` + registry `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion`.

- **Result:** **Windows 10 Home, 22H2, build 19045.6466.**
- **Critical note:** `19045` is **BELOW** the documented `20348` minimum for the WASAPI process-loopback API. This box is exactly the "older build" / fallback case. It is also consistent with Discord's dynamic-load + `audioses is too old for application loopback capture` fallback string (step 3): on a build like this, Discord's application-loopback path may not activate. **This contradicts the desk-research claim in the 02-01 skeleton that "all Windows 10 21H2/22H2 are ≥ 20348"** — Win10 22H2 is 19045, which is below 20348. (See FINDINGS §2.3 correction.)
- **Provenance/Confidence:** `[hands-on: cmd.exe ver + registry CurrentBuildNumber/UBR]` + `hands-on confirmed on my box`

---

## Summary of what the evidence supports

| Dimension | Finding | Confidence |
|-----------|---------|------------|
| Mechanism | Public WASAPI **Application Loopback** (`ActivateAudioInterfaceAsync` → application-loopback), **not** a virtual-device driver | hands-on confirmed |
| Loading | **Dynamically** loaded (`LoadLibrary`+`GetProcAddress` on `mmdevapi`/`audioses`) with explicit version-gating fallback (`audioses is too old…`) | hands-on confirmed |
| Mode | **EXCLUDE** process tree (`…ForProcessTree`, `excludedSubtrees`, `Excluded`); PID variant also present | hands-on (symbol-level, not raw enum) |
| Virtual device | **None** installed by Discord | hands-on confirmed |
| Live process tree (PIDs) | Not observed (Discord not running) | not run / unknown |
| Windows build | 19045.6466 — **below** 20348 min; corrects skeleton's 22H2 claim | hands-on confirmed |
