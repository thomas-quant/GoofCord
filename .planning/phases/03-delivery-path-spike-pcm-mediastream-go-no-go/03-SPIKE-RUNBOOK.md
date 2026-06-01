# Phase 3 — Delivery-Path Spike Manual Test Runbook

**What this proves:** That a non-Discord audio track, reconstructed entirely in the
renderer, can be swapped into Discord's `getDisplayMedia` MediaStream and **heard by a
remote viewer** on a real Windows x64 CI artifact. This is the GO/NO-GO gate for the
Phase 4 native WASAPI echo fix (ECHO-01).

**Why this is manual (and cannot be an automated test):** The streamer cannot self-verify —
Electron/Discord mutes local echo of your own stream — so audible confirmation **requires a
second device/account as the listener** (RESEARCH §Pitfall 3). There is **no DevTools** on
the test box (60% keyboard, no F12), so all machine diagnostics go to a userData log file,
not the console. Verification is by hand against the Windows x64 CI artifact built by
`.github/workflows/testBuild.yml` — the sole verification vehicle (CLAUDE.md).

**The GO/NO-GO bar (read this first):**

- **GO** requires **BOTH**:
  - (a) the second-device viewer **audibly confirms** the distinctive injected beep/sweep, **AND**
  - (b) `screenshare-debug.log` shows `outbound-rtp` **audio** `packetsSent`/`bytesSent`
    **climbing** across ≥2 polls (the viewer-independent objective signal).
- **MSTG absent is NOT a NO-GO.** `mechanism=MSTG absent` followed by `mechanism=WebAudio
  success` + climbing `packetsSent` + viewer-audible = **GO via Web Audio** (MSTG simply
  refuted — a perfectly good outcome, RESEARCH §Pitfall 2).
- **NO-GO** only if **BOTH** the MSTG path **and** the Web Audio fallback fail to reach the
  viewer.
- **An empty/absent `screenshare-debug.log` at the reachability gate is a PACKAGING GAP, NOT
  a NO-GO** (RESEARCH §Pitfall 1) — see step 4.

> Run the steps **in order**. Step 4 (the `spike-loaded` packaging-reachability proof) MUST
> pass **before** you draw any audio conclusion. Record everything in the OBSERVATIONS
> section at the bottom — Task 3 (`03-FINDINGS.md`) reads it verbatim.

---

## Step 1 — Build the Windows x64 CI artifact

1. Open the repository on GitHub → **Actions** tab → **"Test build"** workflow
   (`.github/workflows/testBuild.yml`).
2. Click **Run workflow** (this workflow is `workflow_dispatch`-only). Select the branch that
   carries the spike commits (the `fix/windows-screenshare-cancel-restart` spike branch, or
   whichever branch Plans 01–02 landed on). Confirm.
3. Wait for the `win` job (`windows-latest`, `--x64`, `zip` target) to finish green.
4. On the completed run page, download the **`win-artifacts`** artifact (a `.zip` containing
   the packaged `dist/**/*.zip`).
5. **Unzip twice if needed:** the downloaded `win-artifacts.zip` contains the electron-builder
   `*.zip`; extract that inner zip to a folder, e.g. `C:\goofcord-spike\`. You should end up
   with an unpacked app folder containing `GoofCord.exe`.

> The spike ships **inside this artifact** in the packaged `ts-out/` preload bundle (Plan 02
> verified `spike-loaded`/`MediaStreamTrackGenerator`/`outbound-rtp` are present in
> `ts-out/windows/main/preload/preload.js`). It does **NOT** live in the runtime-downloaded
> `postVencord.js` (that is fetched from upstream `main` and contains zero spike markers).

---

## Step 2 — Locate the `screenshare-debug.log` (your only diagnostics channel)

The spike writes all machine-readable diagnostics here (there is **no DevTools** on this box):

```
%APPDATA%\goofcord\screenshare-debug.log
```

This is `app.getPath("userData")` on Windows, i.e. `C:\Users\<you>\AppData\Roaming\goofcord\`.

- **Portable-mode exception:** if a folder named `goofcord-data` exists next to `GoofCord.exe`,
  the app runs in portable mode and userData is that folder instead (`utils.ts:16-18`). In that
  case the log is `<app-folder>\goofcord-data\screenshare-debug.log`.
- The file is **append-only** and created on first write. To watch it live in a terminal
  (PowerShell):

```powershell
Get-Content -Wait "$env:APPDATA\goofcord\screenshare-debug.log"
```

  (Use the portable path instead if you are running portable.) Keep this window open through
  the whole test — every `spike-loaded`, `mechanism=…`, and `stats outbound-rtp …` line lands
  here.

> **Tip:** delete (or rename) any stale `screenshare-debug.log` before launching so you start
> from a clean file and there's no ambiguity about whether lines are from this run.

---

## Step 3 — Launch the artifact with the spike gate ON

The spike is **off by default** (the normal Windows `"loopback"` path is byte-identical when
off). Turn it on with the env var (or the `--delivery-spike` flag). Pick ONE:

**Option A — env var (PowerShell), one line:**

```powershell
$env:GOOFCORD_DELIVERY_SPIKE = "1"; & "C:\goofcord-spike\GoofCord.exe"
```

**Option B — env var (cmd.exe):**

```bat
set GOOFCORD_DELIVERY_SPIKE=1 && "C:\goofcord-spike\GoofCord.exe"
```

**Option C — argv flag (no env var needed):**

```powershell
& "C:\goofcord-spike\GoofCord.exe" --delivery-spike
```

(Adjust the path to wherever you unpacked `GoofCord.exe` in Step 1.)

> The gate is read in the **main process** (`process.env.GOOFCORD_DELIVERY_SPIKE === "1"` OR
> `--delivery-spike` in argv) and forwarded to the renderer over the `goofcord` contextBridge —
> the sandboxed renderer has no `process.env`, so launching with the var set is the only way to
> arm the spike.

Let the app finish launching and log in to Discord.

---

## Step 4 — PACKAGING-REACHABILITY GATE (do this BEFORE any audio test)

This proves the spike code actually shipped and ran. **Do not proceed to the audio test until
this passes.**

1. Open / tail `screenshare-debug.log` (Step 2).
2. Confirm it contains a **`spike-loaded`** line, with the logged Chromium version, e.g.:

   ```
   2026-06-01T07:10:00.000Z spike-loaded chrome=146.0.768x
   ```

   (If Chromium's version couldn't be read it logs a userAgent fallback — either form proves
   the spike ran.)
3. Also note the **mechanism probe** line, which answers SC#2 (is `MediaStreamTrackGenerator`
   present in Electron 41.3.0's Chromium?). One of:

   ```
   mechanism=MSTG present        ← Insertable Streams audio generator available
   mechanism=MSTG absent (typeof undefined)   ← refuted; will fall back to Web Audio
   ```

**Decision at this gate:**

- **`spike-loaded` present →** reachability proven. Continue to Step 5.
- **Log is EMPTY or ABSENT →** the spike code never ran. This is a **PACKAGING GAP, NOT a
  NO-GO** (RESEARCH §Pitfall 1). **STOP the audio test.** Report it back so Plan 02's packaged
  injection is fixed (e.g., the gate didn't read, the `webFrame.executeJavaScript` injection
  didn't fire, or the var wasn't actually set). Re-check that you launched with the gate ON
  (Step 3) before concluding it's a packaging gap.

> Distinguish the two failure shapes: **empty log = code never executed (packaging gap)** vs.
> **log present but stats flat = code ran, track didn't reach the viewer (a real result)**.

---

## Step 5 — Second-device audible test (SC#1)

The **streamer cannot self-verify** — Electron mutes local echo of your own stream
(RESEARCH §Pitfall 3). You need a second account on a second device as the listener.

1. **Streamer box (the Windows artifact):** join a Discord voice channel / call and start a
   **screenshare WITH audio** (share a window or screen and enable "Share sound" / audio).
   The spike's synthetic source plays continuously, so you don't need any real audio playing.
2. **Second device/account:** join the **same** voice channel / call as a **viewer** and
   **watch the stream with sound on.**
3. **Listen on the second device** for the **distinctive injected beep/sweep** (a ~440→660 Hz
   periodic beep/sweep — deliberately obvious, NOT a flat tone, NOT silence, NOT a system
   sound). The question to answer: *"Do I, the remote viewer, hear MY injected test tone?"*
4. **Keep the stream live for ~30s+** so several `getStats()` polls (every ~2s) accumulate in
   the log and the viewer has ample time to confirm.

> If the viewer is unsure, the climbing `packetsSent` from Step 6 is the objective tie-breaker —
> but the viewer's ear is the primary SC#1 truth.

---

## Step 6 — getStats corroboration (SC#2)

While the stream is still live (and afterward, from the saved log):

1. Read `screenshare-debug.log` for `outbound-rtp` **audio** stat lines, e.g.:

   ```
   2026-06-01T07:10:30.000Z stats outbound-rtp audio packetsSent=512 bytesSent=40960 ssrc=...
   2026-06-01T07:10:32.000Z stats outbound-rtp audio packetsSent=612 bytesSent=49080 ssrc=...
   ```

2. Confirm across **≥2 polls** that `packetsSent` and `bytesSent` are **CLIMBING** (increasing
   over time). Climbing counters prove audio is actually leaving the peer connection,
   independent of whether the viewer reports hearing it.
3. Also note the track corroboration lines:

   ```
   track kind=audio readyState=live muted=false
   ```

   `readyState=live` and `muted=false` corroborate that a live, unmuted audio track is attached
   to the sender.

> If `packetsSent` is **flat** or there is **no `outbound-rtp audio` entry**, the sender may
> have been captured before injection or via a different seam (Discord may use `replaceTrack`
> on a pre-created transceiver). Keep the stream live longer (stats climb only once the
> connection is fully negotiated) — the poll also scans `getSenders()` each cycle. Note this in
> OBSERVATIONS either way.

---

## Step 7 — Record raw observations

Fill in the OBSERVATIONS section below **verbatim from what you saw/heard** — do not
interpret, just record. Task 3 (`03-FINDINGS.md`) turns these into the written GO/NO-GO
verdict. Paste the actual relevant `screenshare-debug.log` lines.

---

## OBSERVATIONS — fill this in after running the test

> Paste real values / log lines. Leave a field blank only if it was genuinely not reached.

**Environment**

- Windows build/version (e.g. `winver` → `Windows 10 22H2 19045.xxxx`): `__________`
- GoofCord artifact / CI run number or URL: `__________`
- Launch method used (env var A/B or flag C): `__________`
- Portable mode? (yes/no — was there a `goofcord-data` folder?): `__________`

**Step 4 — Reachability gate**

- `spike-loaded` line present? (yes/no): `__________`
- Logged `chrome=` version (or userAgent fallback): `__________`
- Mechanism probe line (`mechanism=MSTG present` / `mechanism=MSTG absent …`): `__________`
- If log was empty/absent → PACKAGING GAP (describe; do not call it NO-GO): `__________`

**Step 5 — Viewer-audible (SC#1)**

- Did the SECOND-DEVICE viewer hear the distinctive injected beep/sweep? (yes/no/unsure): `__________`
- Which mechanism succeeded? (`MSTG` / `WebAudio` — from the log): `__________`
- Notes (clarity, distinguishable from Discord audio, any dropouts): `__________`

**Step 6 — getStats corroboration (SC#2)**

- `outbound-rtp audio` entry found? (yes/no): `__________`
- `packetsSent` climbing across ≥2 polls? (yes/no — paste the values): `__________`
- `bytesSent` climbing? (yes/no — paste the values): `__________`
- `track ... readyState=` / `muted=` line: `__________`

**Errors / anomalies**

- Any `mechanism=… failed err=…` or other error lines in the log? (paste): `__________`

**Pasted relevant `screenshare-debug.log` lines:**

```
(paste here)
```

**One-line verdict you observed (Task 3 will formalize this):**

- [ ] **GO** — viewer heard it AND `packetsSent` climbing (name the mechanism: `____`)
- [ ] **NO-GO** — BOTH MSTG and Web Audio failed to reach the viewer
- [ ] **PACKAGING GAP** — `spike-loaded` absent; fix Plan 02 injection and re-run (NOT a NO-GO)
