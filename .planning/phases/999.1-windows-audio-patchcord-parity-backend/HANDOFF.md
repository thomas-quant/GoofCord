# HANDOFF — 999.1 Windows audio: patchcord-parity capture backend

**Status:** Not started. Scope captured, public commitment made, work not yet begun.
**Created:** 2026-06-14
**Backlog:** ROADMAP.md → Phase 999.1 (commit `f03b1b0`)

---

## Why this exists / the commitment

On **PR #211** (the Windows echo fix, Closes #46), the maintainer Milkshiift asked:

> "Is there anything stopping this from having the same API as patchcord, and the ability to exclude and include any apps, not just prevent echo?"

We replied (https://github.com/Milkshiift/GoofCord/pull/211#issuecomment-4674732486) that it's possible, that the current code is an intentional MVP, that we can't promise a literal 1:1 of patchcord's API but can get functionally close, and — crucially — **"already chipping away at some of it, so i'll follow up with a pr."**

We are not actually working on it yet. This handoff exists so we can start and make that statement true. It's also wanted independently of upstream.

---

## What we promised vs. what's true (don't over-claim)

- Promised: include/exclude any app, multi-app via per-app capture + mixing, follow-up PR.
- Honest limits already stated publicly: not 1:1 with patchcord's API; can't exclude *specific* apps from a full-system share (single exclude target only).
- **Do not** open the follow-up PR until the user explicitly says so (see memory: "Don't open upstream PRs until instructed"). Build it clean first.

---

## Current state (the MVP we shipped)

The Windows path is a deliberately narrow echo fix:

- `src/windows/screenshare/screenshare.ts:94-114` — 3-way audio gate inside the `selectScreenshareSource` handler:
  - **Linux:** `patchcordStartSystem(pids)` / `patchcordStartApp(pids)` — honors `audioConfig.mode` + `audioConfig.pids`.
  - **Windows:** `tryStartWasapiLoopback()` — **called with NO args**; always EXCLUDEs GoofCord's own process tree. Ignores `mode`/`pids` entirely.
  - **Else:** `result.audio = "loopback"` (Chromium endpoint loopback).
- `src/modules/native/wasapiLoopback.ts` — main-process wrapper. Addon contract: `start(excludeRootPid, onChunk): boolean` (false = unsupported, never throws), `stop()`. PCM → `MessageChannelMain` → renderer feeder.
- `src/windows/main/preload/wasapiTransport.ts` — page-main-world feeder: rebuilds the track with `MediaStreamTrackGenerator` and swaps it into `getDisplayMedia`.
- Addon repo: `github:thomas-quant/wasapi-loopback`, `src/lib.rs` (single file). `activate_exclude_tree(pid)` @217 uses `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` @230. `pub fn start(exclude_root_pid, on_chunk) -> bool` @461, `pub fn stop()` @533. Hardcoded **48000 Hz / 2ch / f32**, **480-frame / 3840-byte** chunks (~10 ms). Ships a prebuilt `win32-x64` `.node` via one `optionalDependencies` line.

---

## What ALREADY EXISTS that we build on (de-risks the work)

1. **The shared contract.** `AudioConfig` is defined at `src/windows/screenshare/preload/preload.mts:14-16`:
   ```ts
   interface AudioConfig { mode: "none" | "system" | "app"; pids: number[] }
   ```
   It already flows renderer → `selectScreenshareSource` IPC → handler. The Linux path consumes it; the Windows path just throws it away.

2. **The picker UI is already built** (`preload.mts`): a `audioMode` segmented control (none/system/app, @208) and a per-app checklist `#audio-apps-list` populated by `renderAudioApps(payload.audioNodes, s.audioConfig.pids)` (@241). **We do not need to build the audio UI from scratch.**

3. **The only reason "app" mode is dead on Windows:** `fetchScreenshareData` (`screenshare.ts:44`) sets `audioNodes = patchcordList()` on Linux and **`[]` on everything else**. Fill `audioNodes` on win32 and the existing UI lights up automatically.

So the parity work is mostly: (a) a Windows enumerator to populate `audioNodes`, (b) make `tryStartWasapiLoopback` honor `audioConfig`, (c) addon INCLUDE mode + multi-capture mixing.

---

## The work, tiered

### Tier 1 — honor `audioConfig`, single-app include/exclude (low risk)
- **Addon (`lib.rs`):** parametrize `start(mode, target_pid, on_chunk)`; add `activate_include_tree` using `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` alongside the existing exclude variant.
- **Wrapper (`wasapiLoopback.ts`):** `tryStartWasapiLoopback(audioConfig)` — `"system"` → EXCLUDE `process.pid` (today's echo fix becomes the system case); `"app"` (one pid) → INCLUDE that pid's tree.
- **Handler (`screenshare.ts:101`):** pass `audioConfig` through instead of the argless call.
- Result: include/exclude of a single chosen app. Answers most of the maintainer's question.

### Tier 2 — multi-app INCLUDE (feasible, needs one spike)
- WASAPI takes **one process tree per capture**, so multi-app = **N concurrent INCLUDE captures + mix in the addon** into one PCM stream.
- **Proven feasible:** OBS runs multiple per-app process-loopback captures concurrently in one process (verified vs MS docs + OBS KB, 2026-06-10).
- **The only spike needed:** confirm N concurrent process-loopback `IAudioClient`s are stable *inside Electron's audio session* (not whether it's possible at all — it is). See landmines re: CoreMessaging.

### Tier 3 — Windows enumerator + wire to existing UI
- New Win32 surface (the addon has none): `IAudioSessionManager2` / `IAudioSessionEnumerator` → `{ app name, PID }`. This is patchcord's `listShareableNodes` equivalent.
- Feed it into `fetchScreenshareData` so `audioNodes` is non-empty on win32 → existing checklist UI works.
- Consider restart-survival (process-loopback binds to a PID; if the app restarts the capture won't follow). Linux patchcord solves this with a name-learning matcher (`patchcord.ts` `createMatcher`); a Windows analog needs session re-enumeration. Not needed for the exclude-self echo case.

### Also wanted (from the user, beyond the maintainer's ask)
- **Dedicated window capture** (à la OBS window capture).
- **Default = capture ONLY the active audio output (render) endpoint** *(firm requirement, 2026-07-03)*. The default capture mode must bind to whatever render device the system/Discord is actually outputting to (e.g. speakers), and capture *exclusively* from that endpoint. Rationale: if capture is broad (all endpoints / process-loopback that sweeps in extra render devices), a **virtual audio cable** endpoint gets pulled into the mix → **echo or unintended audio capture** (the VAC loop isn't in GoofCord's process tree, so exclude-self doesn't stop it re-entering). Binding to the single in-use output endpoint by default sidesteps this entirely.
  - **Reference implementation to study: OBS.** OBS's per-endpoint / WASAPI output capture picks a specific render device and loopback-captures only that — mirror how it (a) enumerates render endpoints, (b) identifies the default/in-use one, and (c) does endpoint (device) loopback rather than blanket process loopback for this default path. Contrast with the process-loopback path (Tiers 1–2) and keep them distinct capture modes.
- **Selectable audio capture source/device.** The user-facing counterpart to the default above: let the user pick/exclude the render endpoint explicitly. Same root bug (VAC echo); the default handles the common case, the selector handles the rest. *(Candidate to split into its own bug ticket — it's a present defect, not just future polish.)*

---

## Verified constraints & landmines (don't re-discover these)

- **No native multi-EXCLUDE.** `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS` = one `TargetProcessId` + one mode. "System minus self minus app X" is not expressible. Multi-INCLUDE is the path.
- **Never run endpoint loopback + process loopback together.** Chromium `"loopback"` alongside the addon caused the **CoreMessaging hard-crash** on system-audio shares. Already avoided at `screenshare.ts:101-110`; preserve that. OBS independently warns to disable Desktop Audio when using per-app capture.
- **Format is hardcoded** 48k/stereo/f32 because the process-loopback device returns `E_NOTIMPL` from `GetMixFormat`/`IsFormatSupported`; the engine converts via `AUTOCONVERTPCM`. Multi-capture mixing must respect this format.
- **OS floor:** Win10 2004 / Build 20348+. Addon already resolves `ActivateAudioInterfaceAsync` dynamically and falls back gracefully — keep that.
- **MS sample bugs to avoid when adding INCLUDE/multi-capture** (our crate is based on the MS ApplicationLoopback sample): rapid Start→Stop access-violation before reaching Capturing state; Win11 22H2 `GetBuffer` pointer-invalidation crash; 49-day `uint32` overflow.
- **Per-app capture gaps:** some apps' audio doesn't capture cleanly (OBS cites Valorant / CoD in-game voice).

---

## Key files

| File | Role |
|---|---|
| `src/windows/screenshare/screenshare.ts` | Audio gate (`:94-114`), `fetchScreenshareData` (`:44`, the `audioNodes` gap), `finishRequest` |
| `src/windows/screenshare/preload/preload.mts` | `AudioConfig` type (`:14-16`), picker UI (segmented control `:208`, app checklist `:241`) |
| `src/modules/native/wasapiLoopback.ts` | Main-process addon wrapper; `tryStartWasapiLoopback`, `stopWasapiLoopback`, `shouldInjectWasapiTransport` |
| `src/windows/main/preload/wasapiTransport.ts` | MSTG feeder + getDisplayMedia track swap |
| `src/modules/native/patchcord.ts` | Reference for the API shape to mirror (`patchcordStartSystem/App`, `createMatcher` restart-survival) |
| `thomas-quant/wasapi-loopback` `src/lib.rs` | The Rust addon — `activate_exclude_tree` (`:217`), `start` (`:461`), `stop` (`:533`) |

patchcord API to mirror (functionally): `AudioSharePatchbay` { `hasPipeWire`, `listShareableNodes`, `ensureVirtualSink`, `routeNodes`, `clearRoutes`, `dispose` } + `graphChanged`/`monitorDied` events. (Mechanism differs: patchcord = virtual OS device; ours = injected MediaStreamTrack. Match the interface, not the plumbing.)

---

## Recommended first steps

1. **Spike Tier 2 concurrency first** — it's the only real unknown and it gates the multi-app promise. Build a throwaway: 2-3 concurrent INCLUDE captures in the addon inside an Electron build, confirm no CoreMessaging crash, mix to one f32 stream. If it holds, the rest is mechanical.
2. **Then Tier 1** (smallest shippable win; could even be its own PR: single-app include/exclude).
3. **Then Tier 3** enumerator → existing UI lights up.
4. Treat the VAC-echo / source-selection as a parallel track (possibly its own bug ticket).

Proper GSD entry when ready: `/gsd-discuss-phase 999.1` → `/gsd-plan-phase 999.1`. Promote out of backlog with `/gsd-review-backlog`.

---

## Build / verify discipline (project rules — do not violate)

- **CI-only builds. NEVER build locally to "verify."** Push the branch to `origin` (fork), then `gh workflow run testBuild.yml --repo thomas-quant/GoofCord --ref <branch>` (the `--repo` flag is required; `gh` defaults to upstream). Produces the `win-artifacts` portable zip. Applies to GoofCord *and* the Rust addon (let its `windows-latest` CI produce the prebuilt `.node`).
- **No DevTools on the Windows test box** (60% keyboard, no F12). Route diagnostics to a userData log file, not console.
- **Renderer-bundle caveat:** `postVencord.js`/`preVencord.js` download from upstream at runtime; fork edits to renderer scripts may silently not run. Keep spike/feature code in preload-injected (ts-out) paths and grep `app.asar` for the marker before any CI test.
- `bun run fmt` reformats 90+ files repo-wide — never run it on a surgical change. Hand-match style.

---

## References

- PR #211 maintainer question + our reply: https://github.com/Milkshiift/GoofCord/pull/211
- OBS Application Audio Capture (multi-source precedent): https://obsproject.com/kb/application-audio-capture-guide
- MS `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS`: https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params
- MS `ActivateAudioInterfaceAsync`: https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-activateaudiointerfaceasync
- patchcord (API to mirror): https://github.com/Milkshiift/patchcord
