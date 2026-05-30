# Phase 2 Recon Runbook — Windows On-Box Inspection of Discord's Audio-Capture Mechanism

**Run this in plan 02-02 on your own physical Windows box.** It is an ordered, copy-pasteable checklist. Each step gives the exact tool, the exact command or GUI click-path, the exact strings/symbols to look for, and a blank `Result:` slot you fill with what you actually observed. Your filled-in results drop straight into the **`02-FINDINGS.md` → `## 1. Mechanism + Evidence`** evidence table (each step below maps 1:1 to a row there).

**Goal (Bug B = echo, [#46]):** determine how the official Discord client captures system/app audio on Windows *without* echoing the call back to viewers — i.e. is it (a) an installed virtual audio device driver, or (b) the public WASAPI Application Loopback API with process-tree exclusion (`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`), or (c) something else.

---

## Honesty rules (read before you start)

- **Record only what you actually observed.** A step you did NOT run stays `not run / unknown` — never inferred or filled in from what "should" be there (Pitfall 1).
- **A `strings` match is NOT proof of use** (Pitfall 3/5). A symbol name can sit in a binary as dead data without ever being imported or called. **You MUST corroborate any `strings` hit with `dumpbin /imports`** (step 4) — does the DLL actually import the function from `mmdevapi.dll`? — *before* you upgrade your confidence from "saw the string" to "the DLL uses it".
- **Clean-room boundary (D-05):** reading the DLL answers only *which approach* Discord chose. Do NOT copy Discord's strings/symbol layout into the findings doc as an implementation recipe — the *how* comes only from the public Microsoft ApplicationLoopback sample.
- **Tool note (D-09):** every tool below is a standalone CLI or GUI app. **No browser DevTools, no F12.** None requires admin to read a DLL or view Device Manager (admin is only implicated if you choose to install Discord's audio helper for the first time to observe the prompt — optional, not required for recon).

For each step, fill **both** slots so your raw observation maps cleanly into the FINDINGS evidence row:
- **Result:** — what you saw (present/absent, the exact line(s) of output, the build number, etc.).
- **Provenance/Confidence:** — e.g. `[hands-on: dumpbin /imports / discord_voice.node / ActivateAudioInterfaceAsync]` + `hands-on confirmed on my box`.

---

## Step 1 — Locate Discord's native audio modules

Discord ships its native audio code under `%LocalAppData%\Discord\app-*\modules\`. Enumerate the relevant modules (voice engine, Krisp noise-suppression, audio helpers):

```bat
cd "%LocalAppData%\Discord"
dir /b /s app-*\modules\discord_voice*  app-*\modules\*krisp*  app-*\modules\*audio*
```

Note the exact paths of any `discord_voice*` `.node`/`.dll`, `discord_krisp*`, and audio-helper DLLs — you will inspect these in steps 3 and 4. (If the relevant code is statically linked into the main binary and nothing shows here, widen the scan to the top-level Discord install folder.)

- **Result:** _(list the module paths you found, e.g. `...\app-1.0.xxxx\modules\discord_voice-1\discord_voice.node`)_ ____________________
- **Provenance/Confidence:** `[hands-on: dir / %LocalAppData%\Discord\app-*\modules\ / <files listed>]` + `hands-on confirmed on my box`

---

## Step 2 — Device Manager: check for a Discord-installed virtual audio device

Open Device Manager and look for any audio device Discord may have installed:

```bat
devmgmt.msc
```

In **Device Manager** (`devmgmt.msc`), expand:
- **Sound, video and game controllers**
- **Audio inputs and outputs**

Look for a Discord-installed virtual audio device / "audio helper" driver. **Present** ⇒ supports a virtual-device-driver mechanism (heavier, not cleanly GoofCord-replicable). **Absent** ⇒ supports the in-OS public-WASAPI-API hypothesis.

- **Result:** _(virtual audio device present or absent? name it if present)_ ____________________
- **Provenance/Confidence:** `[hands-on: Device Manager / Sound,video and game controllers + Audio inputs and outputs]` + `hands-on confirmed on my box`
- **Maps to FINDINGS:** Section 1 → "Device Manager result".

---

## Step 3 — Fast string pass with Sysinternals `strings`

Get a quick (but NOT authoritative — see honesty rules) read of whether the process-loopback symbol names appear anywhere in the audio DLLs. Download `strings.exe` from Sysinternals (no install needed), then, in the modules folder from step 1:

```bat
strings -n 8 discord_voice.node | findstr /I "ActivateAudioInterface PROCESS_LOOPBACK VIRTUAL_AUDIO_DEVICE AUDIOCLIENT_ACTIVATION"
```

Repeat for any other audio DLLs found in step 1. Record which of these strings appear: `ActivateAudioInterface`, `PROCESS_LOOPBACK`, `VIRTUAL_AUDIO_DEVICE`, `AUDIOCLIENT_ACTIVATION`.

**Reminder:** a hit here is circumstantial only — you MUST corroborate it with `dumpbin /imports` in step 4 before trusting it.

- **Result:** _(which symbol strings appeared, in which DLL)_ ____________________
- **Provenance/Confidence:** `[hands-on: strings -n 8 / <dll> / <symbols seen>]` + `desk-research / public report` until corroborated, then upgrade after step 4.

---

## Step 4 — Authoritative import-table check with `dumpbin /imports`

This is the **authoritative** check (a string match could be incidental; the import table is definitive). Open a **Developer Command Prompt for VS** (ships `dumpbin` with Visual Studio / Build Tools), then, in the modules folder:

```bat
dumpbin /imports discord_voice.node | findstr /I "mmdevapi ActivateAudioInterfaceAsync"
```

If `discord_voice.node` imports `ActivateAudioInterfaceAsync` from `mmdevapi.dll`, the DLL actually *uses* the public WASAPI process-loopback activation path. **A `strings` hit (step 3) must be corroborated by this import-table check before you upgrade confidence** to "the DLL uses it".

GUI alternative if you prefer not to use the CLI: open the DLL in **Dependencies** (lucasg/Dependencies — the modern open-source Dependency Walker) and inspect the imported functions / dependency DLLs for `mmdevapi.dll` → `ActivateAudioInterfaceAsync`. PE-bear / CFF Explorer / PEview show the same import table.

- **Result:** _(does it import `ActivateAudioInterfaceAsync` from `mmdevapi.dll`? exact line)_ ____________________
- **Provenance/Confidence:** `[hands-on: dumpbin /imports / discord_voice.node / ActivateAudioInterfaceAsync from mmdevapi.dll]` + `hands-on confirmed on my box`

---

## Step 5 — Determine INCLUDE vs EXCLUDE

From the symbols seen (steps 3-4) and observed behaviour, determine which process-loopback mode Discord uses:

- `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` — capture everything **except** a process tree (this is **the echo fix**).
- `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` — capture **only** a chosen app's tree.

If neither symbol is present (and no import in step 4), the mechanism is likely NOT public process-loopback — note that and revisit step 2 (virtual device) / widen the scan.

- **Result:** _(EXCLUDE / INCLUDE / neither observed)_ ____________________
- **Provenance/Confidence:** `[hands-on: strings + dumpbin / <dll> / PROCESS_LOOPBACK_MODE_*]` + `hands-on confirmed on my box`

---

## Step 6 — Enumerate Discord + Chromium "Audio Service" PIDs

Enumerate Discord's processes to reason about *which* process tree a future GoofCord exclude-capture module would target. Remember Electron/Chromium runs audio in a separate sandboxed **"Audio Service"** utility process — so the right exclude target is the GoofCord/Electron process *tree*, not just the window PID.

```bat
tasklist /v | findstr /I discord
```

Or use **Task Manager** → **Details** tab and look for the Discord processes plus any `Utility: Audio Service` process. Note which process renders the call audio if you can tell.

- **Result:** _(Discord PIDs, and whether a separate Audio Service process is present)_ ____________________
- **Provenance/Confidence:** `[hands-on: tasklist /v / Task Manager Details]` + `hands-on confirmed on my box`

---

## Step 7 — Record the Windows build

The public process-loopback API requires **Windows 10 build 20348 or later**. Record your build:

```bat
winver
```

Read the build number from the `winver` dialog. Is it **≥ 20348**? (All Windows 11 and Windows 10 21H2/22H2 are.)

- **Result:** _(build number; ≥ 20348? yes/no)_ ____________________
- **Provenance/Confidence:** `[hands-on: winver]` + `hands-on confirmed on my box`

---

## Out-of-scope context: verification caveats for the FUTURE implementation phase

These are **not** part of this recon (no audio test is run in Phase 2). Noted only so they aren't forgotten when a future implementation phase verifies an actual fix (D-08):

- **Verify only from the viewer** (a second account / second device). The streamer's local playback is muted by design — Electron hardcodes `disable_local_echo=true` ([#37293]) — so listening on the streaming box gives a false result.
- **Keep audio actively playing during any test.** WASAPI loopback delivers no samples when nothing is playing ([PortAudio #935], [Audacity #2356]); silence would be misread as "broken".

---

## How your results feed the findings doc

Each step above maps to a row in `02-FINDINGS.md → ## 1. Mechanism + Evidence`:

| Runbook step | FINDINGS evidence row |
|--------------|------------------------|
| Step 2 | Device Manager virtual-device present? |
| Step 3 | `strings` pass for process-loopback symbols |
| Step 4 | `dumpbin /imports` corroboration |
| Step 5 | INCLUDE vs EXCLUDE |
| Step 6 | Discord / Audio-Service process tree |
| Step 7 | Windows build (≥ 20348?) |

Once filled, the mechanism **Verdict** placeholder in Section 1 can be replaced with the evidence-backed conclusion (one of: virtual-device driver | public WASAPI process-loopback | other | inconclusive), and the final clean-room go/no-go in Section 3.3 can be synthesized. Until then, those slots stay unfilled (Pitfall 1).
