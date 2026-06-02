# Phase 4: Native Clean-Room Exclude-Tree Addon + Integration - Context

**Gathered:** 2026-06-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the clean-room WASAPI process-tree **EXCLUDE** loopback `.node` addon and wire it into `screenshare.ts`'s Windows audio branch via the Phase 3-proven delivery path, so a remote viewer hears shared desktop/app audio but **NOT** the Discord call echoed back (#46 / ECHO-01..04).

**IN scope:**
- The clean-room native addon (Rust + napi-rs + `windows` crate) performing WASAPI process-tree EXCLUDE loopback of GoofCord's own Electron process tree.
- The **main→renderer→main-world PCM transport** — the named Phase 3 residual risk (#1). This is the focus of this discussion.
- Additive 3-way gate in `screenshare.ts` (Linux patchcord → Windows native exclude-tree → existing `"loopback"` fallback).
- Exclude-target PID resolution (GoofCord/Electron root via `app.getAppMetrics()`, covering the Audio Service child).
- Packaging into the Windows artifact (`copyNativeModules()` entry + `nativeModulePlugin` glob match + electron-builder inclusion + CI packaging assertion).
- Graceful fallback to today's `"loopback"` where the per-process API is unavailable.
- In-Electron smoke verification of the addon (not just bare Node).

**OUT of scope (this phase):**
- End-to-end milestone verification, instrumentation stripping, and shaping the upstream PR + separate published addon repo — **Phase 5**.
- A/V sync polish beyond a bounded-latency best-effort (see T4).
- Linux/macOS behaviour changes (must not regress).
- User-side separate-output-device workaround (explicitly rejected, native-only milestone).

### Carried forward — LOCKED, do NOT re-derive or re-ask

These were decided in prior phases / requirements and are FIXED inputs to planning:

- **Native-only** — user-side workaround is not a deliverable (REQUIREMENTS, Out of Scope).
- **Clean-room boundary (D-05, LOCKED):** implement solely from the public Microsoft `ApplicationLoopback` sample (MIT, copyright notice retained); never from Discord code or its symbol layout (`ActivateApplicationLoopbackForProcessTree`, `excludedSubtrees`, …). Hardcode a fixed `WAVEFORMATEX` (no `GetMixFormat` — returns `E_NOTIMPL` on the loopback device). Dynamic `LoadLibrary`/`GetProcAddress` load (not static link) so the `.node` loads everywhere and *activates* selectively. (ECHO-04)
- **Mode = EXCLUDE process-tree**; exclude target = GoofCord/Electron **root PID** via `app.getAppMetrics()` so the separate "Audio Service" utility child is covered (02-FINDINGS §2.2). (ECHO-02)
- **Toolchain = Rust + napi-rs + `windows` crate**, venbind-style prebuilt `.node` (research HIGH confidence; SUMMARY.md:22-28).
- **Delivery seam = MSTG reconstruction → `getDisplayMedia` swap at `screensharePatch.ts:79-84` → viewer** (Phase 3 GO, 03-FINDINGS). The MSTG→Web-Audio reconstruction + swap seam are the KEPT Phase 3 seed; the synthetic beep generator + `getStats`/`addTrack`-wrap instrumentation are THROWN AWAY.
- **Effective build floor ≈ Win10 2004 / 19041+** (NOT the documented 20348; corrected in 02-FINDINGS §2.3 UPDATE). The native path IS locally verifiable; sub-2004 is a minor graceful-fallback detail (ECHO-03).
- **Verification is manual** on a Windows x64 CI artifact, **viewer-side** (second device/account) with non-call audio actively playing; diagnostics → userData `screenshare-debug.log` (no DevTools — 60% keyboard).

### This discussion's focus

Only **one** gray area was selected: the **native→renderer PCM transport** (residual risk #1). The other three surfaced gray areas (addon home & build, capture↔renderer format contract, build-support detection) were left to research/planning with the recommended defaults recorded under Open Questions below.
</domain>

<decisions>
## Implementation Decisions

### Transport — sequencing (T1)
**Decision:** **Spike the transport first, then wire the real addon.** Phase 4 begins with a transport spike: a **main-process synthetic PCM source** (a trivial tone — no WASAPI yet) shipped over the **real** chunked-transferable transport → main-world MSTG reconstruction → swap seam → second-device viewer-audible on a Windows x64 CI artifact. Only after that GO does the real WASAPI addon get built and swapped in behind the same transport.
**Rationale:** Phase 3 was renderer-only (no IPC), so the transport — both hops — is the last unproven half of the make-or-break path. Isolating it with a synthetic main-process source (exactly as Phase 3 isolated the renderer half with a synthetic in-page source) means a NO/GO turns on the transport alone, not on native code that doesn't exist yet. Mirrors the user's Phase 3 de-risk instinct.
**Implications:** The plan must front-load a transport-spike task with its own viewer-side CI verification before the addon-build tasks. The synthetic main-process tone is throwaway (like the Phase 3 beep); the transport plumbing it proves is the KEEP. Reuse the `GOOFCORD_DELIVERY_SPIKE`-style env gate / `screenshare-debug.log` pattern.

### Transport — hop-1: main process → renderer (T2)
**Decision:** **`MessageChannelMain` → transferred `MessagePortMain`.** Main creates a `MessageChannelMain`, transfers one port to the renderer; the addon's napi **threadsafe callback** batches ~10 ms chunks and delivers them with `port.postMessage(buf, [buf])` (transferable ArrayBuffer — zero-copy) on a **dedicated** channel, out-of-band of the busy `ipcMain` router.
**Rationale:** Canonical Electron high-throughput-audio pattern; cleanest backpressure/ordering story; zero-copy transferables; does not congest normal IPC traffic.
**Implications:** Honors the locked rule — **never** per-frame `ipcRenderer.send` of raw PCM (ARCHITECTURE.md:250-253). Batch at ~10 ms / 480-frame granularity (Phase 3 cadence), not per audio callback. Needs a one-time port handshake at stream start and teardown on `STREAM_CLOSE`.

### Transport — hop-2: preload (isolated world) → page MAIN WORLD (T3)
**Decision:** **Research question with a default + fallback.** `webContents.postMessage` lands the port in the **preload/isolated world**, but the MSTG + swap seam run in the page **main world** (Phase 3 confirmed: `process` undefined → main world via `webFrame.executeJavaScript`). **Default:** forward the `MessagePort` from preload into the main world via `window.postMessage(msg, origin, [port])` (zero-copy port→port; the pattern Electron's own docs prescribe for high-throughput data) so PCM never touches the isolated-world JS heap. **Fallback:** if Electron 41.3.0 won't transfer a `MessagePort` through `window.postMessage` into the `executeJavaScript`-injected main world, land PCM in the preload and invoke a main-world callback via the existing `goofcord`/`GoofCord` contextBridge (structured-clones each chunk — ~100 small copies/sec, cheap at ~400 KB/s, just not zero-copy).
**Rationale:** Zero-copy port forwarding is the most efficient and is blessed by Electron docs for exactly this case, but its viability through the injected main world on this exact build is unverified — so it must be proven, not assumed. The transport spike (T1) exercises the real path, so it settles this empirically.
**Implications:** Researcher confirms MessagePort-transfer-to-main-world support on Electron 41.3.0; planner builds the spike to try the default and record which mechanism worked in `screenshare-debug.log`. Whichever is chosen must keep the isolated world out of any per-chunk hot loop beyond an unavoidable forward, and stay upstream-PR-friendly.

### Transport — backpressure / buffering policy (T4)
**Decision:** **Bounded buffer, latency-first.** A small fixed ring (~tens of ms): **drop-oldest** on overflow, **silence / last-frame fill** on underrun. When capture rate and MSTG consumption drift, bounded latency wins over perfect fidelity.
**Rationale:** Live screenshare audio tolerates a rare glitch under stress far better than growing latency; a bounded buffer also keeps A/V drift from creeping (A/V sync is otherwise deferred to a best-effort). Predictable memory.
**Implications:** Pick a concrete ring depth from observed cadence (Phase 3 used ~10 ms / 480-frame chunks). The buffer can live on either side of hop-1 (Rust-side or main-JS-side) — planner's call; the *policy* (bounded, drop-oldest, silence-fill) is fixed.

### Claude's Discretion / open for research
- **Hop-2 mechanism (T3)** — default = forward the port; fallback = contextBridge callback. Settled by the spike.
- **Buffer location & exact ring depth (T4)** — planner's call within the bounded/latency-first policy.
- **Chunk batching size/cadence** — start from Phase 3's ~10 ms / 480-frame; tune if the spike shows underrun/drift.
- **Addon→main-JS delivery shape** (napi ThreadsafeFunction push vs. pull/`read`), the start/stop + format control channel — not discussed; planner/researcher to choose (push via ThreadsafeFunction is the natural fit for a WASAPI event-driven capture loop).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase goal, requirements & locked decisions
- `.planning/ROADMAP.md` — Phase 4 goal + Success Criteria SC#1–SC#5 (the full integration contract: 3-way gate, PID resolution, clean-room boundary, packaging, in-Electron smoke).
- `.planning/REQUIREMENTS.md` — ECHO-01..04 (owned by Phase 4) + UPST-02 (Phase 5) + the Out-of-Scope table (native-only; the one justified native dependency).
- `.planning/PROJECT.md` — Key Decisions table (D-05 clean-room LOCKED; D-06 native-only; verification constraints).

### Proven delivery path + carried residual risk (the direct upstream of this phase)
- `.planning/phases/03-delivery-path-spike-pcm-mediastream-go-no-go/03-FINDINGS.md` — GO verdict; the proven path (`MSTG → getDisplayMedia swap at screensharePatch.ts:79-84 → viewer`); KEEP/THROWAWAY split; **Residual risk #1 (main→renderer transport, the focus here)**, #2 (Audio-Service PID), #3 (`getStats` blind spot — capture Discord's real sender via `replaceTrack`/transceiver, not `addTrack`).
- `.planning/phases/03-delivery-path-spike-pcm-mediastream-go-no-go/03-CONTEXT.md` — Phase 3 decisions: PCM format (48k/stereo/f32), swap-seam reuse, env-gate precedent, transport-as-residual-risk.

### Clean-room recon (the native capture contract)
- `.planning/phases/02-fix-bug-b-windows-loopback-audio-captured/02-FINDINGS.md` — §2.1 EXCLUDE-vs-INCLUDE; §2.2 exclude the Electron process tree (Audio Service child); §2.3 + **§2.3 UPDATE** (build floor ≈19041, not 20348); §3.1 public WASAPI symbol surface + fixed `WAVEFORMATEX` / `GetMixFormat → E_NOTIMPL`; §3.3 clean-room GO.

### Research (toolchain, integration index, anti-patterns)
- `.planning/research/ARCHITECTURE.md` — renderer track-swap integration index; **IPC-throughput anti-pattern at lines 250-253 (never per-frame `ipcRenderer.send`)**; env-override precedent (~line 185).
- `.planning/research/SUMMARY.md` — Rust + napi-rs + `windows` crate 0.62.2 toolchain (lines 22-35); venbind-is-the-template; the `.node`-not-packaged silent-fallback pitfall (line 84); PID resolution via `app.getAppMetrics()`.
- `.planning/research/PITFALLS.md` — viewer-side verification protocol (second device + audio playing); CI-packaging pitfall; logging-must-not-ship.
- `.planning/research/STACK.md` — verify-via-CI-artifact constraint; maintainer's box is Win10 19045.

### Code seams (see Code Context below)
- `src/windows/main/renderer/postVencord/screensharePatch.ts` — the swap seam (L79-84) + `STREAM_CLOSE` teardown (L90-104).
- `src/windows/screenshare/screenshare.ts` — Windows audio branch (`result.audio = "loopback"`, L98).
- `src/modules/native/venbind.ts` + `src/modules/native/patchcord.ts` — native-addon wrapper + `app.getAppMetrics()` precedent.
- `build/build.ts` (`copyNativeModules()`, L168-232) + `build/nativeImport.ts` (`nativeModulePlugin` glob) — packaging pipeline.
- `.github/workflows/testBuild.yml` — the Windows x64 CI artifact the spike + fix are verified on.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Phase 3 kept seed** — the MSTG→Web-Audio reconstruction of a live audio `MediaStreamTrack` and the `getDisplayMedia` swap-seam shape. Phase 4 feeds real PCM into the MSTG feeder instead of the synthetic generator.
- **`venbind.ts`** — the exact wrapper precedent for a per-platform prebuilt `.node`: `import path from "native-module:../../../assets/native/venbind-*.node"`, `require(path)`, `--no-venbind` guard, `load-attempted` flag, threadsafe callback into the renderer (`startKeybinds((id, keyup) => mainWindow.webContents.send(...))`). The WASAPI wrapper mirrors this shape (but ships PCM over a `MessagePortMain`, not `webContents.send`).
- **`patchcord.ts`** — `app.getAppMetrics().find(p => p.name === "Audio Service")?.pid` is the precedent for resolving the Audio-Service PID; the EXCLUDE addon resolves the **root** Electron PID/tree instead so the whole tree (incl. Audio Service) is excluded.
- **`copyNativeModules()` + `nativeModulePlugin`** — the 3-stage native pipeline (prebuild in `node_modules`/`assets/native` → `copyNativeModules()` entry → glob name match). Add a `wasapi-loopback` `modules[]` entry mirroring venbind's naming exactly (`wasapi-loopback-win32-x64.node`) + a CI packaging assertion.
- **`GOOFCORD_*_PATH` env override + `GOOFCORD_DELIVERY_SPIKE` gate** — precedent for both the dev/CI `.node` path override and the spike's env gate.
- **`screenshareDebug.ts` (Phase 3)** — userData `screenshare-debug.log` writer + `appendScreenshareDebug<IPCHandle>` — reuse for transport-spike + native-branch diagnostics.

### Established Patterns
- Native addons are **consumed prebuilt**, never compiled in GoofCord's Bun build (the "no new build tooling" constraint). The addon is built in its own repo's CI on `windows-latest`.
- The renderer "replace the audio track" pattern already exists (patchcord branch, L62-85): stop/`removeTrack` existing audio → `addTrack` the reconstructed one. The native branch reuses this exact shape.
- Diagnostics go to `screenshare-debug.log`, NOT DevTools.

### Integration Points
- **`screenshare.ts:90-100`** — the Windows audio branch. Today `result.audio = "loopback"`. Phase 4 adds the native exclude-tree branch as an additive 3-way gate ahead of the `"loopback"` fallback; on the renderer side the captured PCM track replaces the `"loopback"` audio track at the swap seam.
- **`screensharePatch.ts:79-84`** — the swap seam where the MSTG-reconstructed track is added (the proven Phase 3 injection point).
- **`screensharePatch.ts:90-104`** — `STREAM_CLOSE` is where capture stop + transport teardown hook in.
- **Main-process addon host** — a new `wasapiLoopback.ts` under `src/modules/native/` (venbind-style) owns the `.node` load, the capture lifecycle, PID resolution, and the `MessageChannelMain` port.
</code_context>

<specifics>
## Specific Ideas

- The transport spike should be a near-exact structural echo of the Phase 3 spike, with the synthetic source moved from the renderer to the **main process** and shipped over the real `MessagePortMain` transport — same env-gate, same `screenshare-debug.log` evidence discipline, same second-device viewer-audible ground truth.
- The spike must record in `screenshare-debug.log` which hop-2 mechanism worked (port-forward vs. contextBridge fallback) so the decision is auditable without DevTools.
- Batch ~10 ms / 480-frame chunks; transfer ArrayBuffers (zero-copy); bounded ring with drop-oldest / silence-fill.
</specifics>

<deferred>
## Deferred Ideas

- **A/V sync polish** — Phase 4 targets a bounded-latency best-effort (T4); precise audio/video lip-sync compensation is not a goal for the echo-fix MVP.
- **Separate published addon repo + `optionalDependencies` + per-platform prebuild CI** — ROADMAP Phase 5 SC#4 owns shaping this for publication (see Open Questions for how Phase 4 obtains a binary in the meantime).
- **In-app sender telemetry via `replaceTrack`/transceiver capture** (residual risk #3) — only if Phase 4 wants in-app stats; the viewer-audible check is the ground truth either way.

None — discussion stayed within phase scope.
</deferred>

<open_questions>
## Open Questions (unpicked gray areas — recommended defaults for the researcher/planner)

The user picked only the transport area; these three were surfaced but deferred to research with the defaults below. Researcher: validate or override these.

1. **Addon home & how Phase 4 obtains a real `.node`.**
   - **Recommended default:** keep the Rust crate **in-repo (or a sibling dir) during Phase 4**, build the `.node` on the Windows CI runner and load it via a **`GOOFCORD_WASAPI_LOOPBACK_PATH` env override** (mirrors `GOOFCORD_VENBIND_PATH`/`GOOFCORD_PATCHCORD_PATH` + the Phase 3 env-gate). **Defer** splitting it into a separate published venbind-style repo + `optionalDependencies` to **Phase 5** (ROADMAP Phase 5 SC#4 explicitly owns "the separate prebuilt-`.node` addon repo").
   - **Rationale:** Phase 4 needs a real binary to verify on CI *without* first standing up a published npm package; env-override matches existing patterns.
   - **Research:** confirm whether the addon `.node` is best built inside the existing `testBuild.yml` job vs. committed prebuilt; confirm N-API load under Electron 41.3.0 (in-Electron smoke, not bare Node — SC#5).

2. **Capture↔renderer format contract.**
   - **Recommended default:** the **addon emits exactly 48 kHz / stereo / float32** (the Phase 3 renderer contract) so the renderer needs **no** conversion — converting in Rust before transport if the loopback device forces another format.
   - **Research:** does the WASAPI process-loopback device accept a 48k/stereo/IEEE-float `WAVEFORMATEX`, or force 16-bit PCM (the MS sample often uses 16-bit)? If forced to 16-bit, the f32 conversion lives in the addon. Confirm the fixed `WAVEFORMATEX` to hardcode (no `GetMixFormat` — `E_NOTIMPL`).

3. **Build-support detection / fallback trigger (ECHO-03).**
   - **Recommended default:** **try-activate-and-catch** — attempt the dynamic `LoadLibrary`/`ActivateAudioInterfaceAsync` process-loopback activation; on failure, report "unsupported" and fall through to today's `"loopback"`. Mirrors Discord's runtime `audioses is too old…` fallback. **Avoid a hardcoded OS build-number gate** (02-FINDINGS §2.3 showed the documented 20348 is wrong; the runtime probe is robust to the real ~19041 floor).
   - **Research:** confirm the exact activation failure signature to catch and the log line for `screenshare-debug.log` (activation result + excluded root PID + Audio-Service PID in the subtree — ECHO-02).
</open_questions>

---

*Phase: 4-native-clean-room-exclude-tree-addon-integration*
*Context gathered: 2026-06-02*
