# Phase 09 — Resource Usage / Electron Optimization Investigation (INV-04)

> Investigate-only spike (milestone v1.2). No source code is modified, nothing is implemented, the app is not run. Deliverable is this findings doc + verdict. NO feature code ships in v1.2 — this is the plan a future build milestone would execute.

## Verdict: PRIORITIZED GO/DEFER LIST

**BLUF — there are very few *safe* resource wins here, and the fork's whole reason to exist actively pushes resource usage UP.** GoofCord is a thin shell around the Discord web app + Vencord; the renderer (Discord's own JS) dominates RAM/CPU and the wrapper cannot cut that. The cheap, safe optimizations are *already applied* (Node compile cache, code-splitting, arRPC in a worker, default background-throttling on Linux/macOS, DOM/CSS optimizers). On **Windows specifically**, the app *deliberately* disables renderer backgrounding + timer throttling (`src/main.ts:62-68`) to keep screenshare/voice alive when minimized/occluded — i.e. it spends resources on purpose, and that is the v1.0/v1.1 mission. **Any "optimization" that touches `backgroundThrottling`, renderer backgrounding, site isolation, GPU/ANGLE, or V8 heap caps risks regressing streaming and must not ship blind.**

Top items actually worth a future build milestone:
1. **GO (measure-first, S):** Establish a Windows RAM/CPU baseline (idle / in-call / in-screenshare, foreground vs minimized-to-tray) before changing anything. This is the only honest prerequisite; the mission flags mean you cannot reason about wins without numbers.
2. **GO-ish (correctness, S — but it's a *streaming* item, not a resource win):** The `disable-disable-backgrounding-occluded-windows` switch (`src/main.ts:67`) is a **typo** — the real Chromium flag is `disable-backgrounding-occluded-windows` (Vesktop sets the correct name). Today it is a silent no-op. Fixing it *helps* stream stability but *raises* resource usage; surface it, don't silently "optimize" it away.
3. **DEFER (risky, M/L):** Scope the Windows un-throttling to *only while a call/screenshare is active* instead of always-global — the one genuinely app-relevant resource optimization, but it sits directly on the streaming path and needs manual Windows verification.

Everything else (V8 snapshots, `--max-old-space-size`/`--js-flags`, extra `disable-features`, process-model tweaks) is **DEFER or AVOID** — low ROI, high complexity, fork divergence, or streaming-regression risk.

---

## 1. Current State (flags & posture already applied)

### Chromium / V8 / process flags (all in `src/main.ts:setFlags()`)

| Flag / API | File:line | When | Effect | Resource direction |
|---|---|---|---|---|
| `module.enableCompileCache()` | `src/main.ts:12` | always | Node V8 compile cache for **main process** JS (caches bytecode to userData) | ↓ startup CPU (already done) |
| `app.disableHardwareAcceleration()` | `src/main.ts:24-27` | only if `hardwareAcceleration` config = false (default **true**) | HW accel ON by default | GPU on (good for video) |
| `disable-features=MediaSessionService,HardwareMediaKeyHandling` | `src/main.ts:38-41` | always | drops two media-integration services | ↓ minor |
| `enable-speech-dispatcher` | `src/main.ts:43-44` | always | speech dispatcher | neutral |
| `enable-features=PulseaudioLoopbackForScreenShare`; `disable-features+=Vulkan`; VA-API decode/encode features | `src/main.ts:46-60` | Linux, VA-API gated on `vaapi` config | Linux screenshare audio + HW video | neutral/↓ CPU |
| `enable-features=Vulkan` | `src/main.ts:63` | **Windows** | Vulkan rasterization backend | GPU |
| `disable-renderer-backgrounding` | `src/main.ts:65` | **Windows, always** | keeps backgrounded renderer at full process priority | **↑ resource (intentional, for streaming)** |
| `disable-background-timer-throttling` | `src/main.ts:66` | **Windows, always** | keeps timers at full resolution when backgrounded | **↑ resource (intentional)** |
| `disable-disable-backgrounding-occluded-windows` | `src/main.ts:67` | **Windows, always** | **TYPO → no-op.** Intended `disable-backgrounding-occluded-windows`. Occluded windows currently still throttle. | — (bug) |
| `CanvasOopRasterization`, `ignore-gpu-blocklist`, `enable-gpu-rasterization`, `enable-zero-copy`, `disable-low-res-tiling`, `disable-site-isolation-trials`, `enable-hardware-overlays=…`, `enable-native-gpu-memory-buffers` | `src/main.ts:70-81` | only if `performanceFlags` config = **true (default false)** | aggressive GPU/raster perf; `disable-site-isolation-trials` also cuts renderer process count | ↑ GPU use, ↓ process count — **opt-in, off by default** |
| `disable-gpu-compositing` | `src/main.ts:83-85` | only if `disableGpuCompositing` config (default false) | known screenshare-viewer-loading workaround | — |
| `force_high_performance_gpu` | `src/main.ts:87-89` | only if `forceDedicatedGPU` config (default false) | picks dGPU | ↑ power |

`enable-features` is otherwise **empty by default** (`src/main.ts:37`). Flags can be fully skipped with `--no-flags` (`src/main.ts:35`).

### Window / webPreferences posture

- **Main window** (`src/windows/main/main.ts:41-47`): `sandbox: true`, `spellcheck` from config, `enableBlinkFeatures` only `MiddleClickAutoscroll` when `autoscroll` on. **`backgroundThrottling` is NOT set** → Electron default `true` (Linux/macOS background-throttle normally; on Windows the global command-line switches above override it off process-wide).
- Settings window (`src/windows/settings/settings.ts:40-53`) is **destroyed on close** (`:79,:86`) — no lingering hidden renderer holding memory.
- Screenshare picker window (`src/windows/screenshare/screenshare.ts:128-158`) is created `show:false`, opened on demand, and **closed/torn down after each request** (`:37`, `finishRequest`). No persistent extra renderer.
- Discord voice popout reuses `sandbox: true`, no extra perf prefs (`src/windows/main/main.ts:144-148`).

### Process model

Standard multi-process Electron: 1 main + GPU process + utility processes + 1 renderer per site-instance. **Discord is effectively a single site, so renderer count is already low** (main renderer + transient popouts). No `--single-process`, no `--renderer-process-limit`, no process-reuse overrides. The only process-count lever present is `disable-site-isolation-trials`, gated behind the opt-in `performanceFlags`.

### Eager-vs-lazy loading (startup)

- `src/main.ts:30` lazy-imports `loader.ts` via dynamic `import()`.
- `src/loader.ts:26-29` runs asset management **concurrently** with `registerAllHandlers()`; awaits `app.whenReady()` in parallel.
- Post-window init is fire-and-forget (`void`): `updateAssets`, `checkForUpdate`, `initArrpc`, `startStyleWatcher` (`src/loader.ts:48-51`).
- `src/windows/main/main.ts:16-20` preconnects to Discord/gateway ("Shaves off ~100ms").
- **arRPC runs in a `worker_threads` Worker** (`src/modules/arrpc/arrpc.ts:20`), off the main thread — already isolated.

### Build / bundle posture (`build/build.ts`)

- Main process bundle: `splitting: true` (`:102`), `minify` default true (`:146`), `external: ["electron"]`, `target:"node"`.
- Preloads CJS, minified. Renderer scripts (`preVencord`/`postVencord`) `minify:false` (small, injected).
- No tree-shaking concerns flagged; dependency list is lean (`preact`, `picocolors`, a few github deps). Heavy mods (Vencord, themes) are **downloaded at runtime**, not bundled.

### Renderer-side optimizations (already on by default)

- **DOM optimizer** (`src/windows/main/renderer/preVencord/domOptimizer.ts`): defers `removeChild` for activity/gif/avatar/etc. elements. Default **on** (`settingsSchema.ts:296-300`).
- **Rendering optimizations** (`src/windows/main/preload/assets.ts:66-76`): injects `contain: strict` + `will-change` CSS on message list / channels / member list. Default **on** (`settingsSchema.ts:301-305`).

**Net:** the obvious, safe, cheap optimizations are already in place. The remaining surface is small and mostly mission-conflicted.

---

## 2. Options Survey (opportunities, safe vs risky, peer comparison)

### Peer comparison (verified from source)

- **Vesktop** (`src/main/index.ts`): sets `disable-renderer-backgrounding`, `disable-background-timer-throttling`, **`disable-backgrounding-occluded-windows`** (correct spelling), `autoplay-policy=no-user-gesture-required`, `disable-smooth-scrolling` (opt-in) — all platforms, always. Disables features `WinRetrieveSuggestionsOnlyOnDemand`, `HardwareMediaKeyHandling`, `MediaSessionService`, and **`CalculateNativeWinOcclusion` (Windows)**. HW-accel on by default; VA-API features when configured. → Vesktop's posture is *also* "spend resources to keep the app responsive," not "minimize footprint." It is **not** a leaner target to copy from.
- **Legcord/ArmCord**: no special built-in throttle flags; relies on user `~/.config/legcord-flags.conf` / `electron-flags.conf`. Community reports of high CPU after prolonged use and large RAM with mods — i.e. memory is driven by the **mods/web app**, not the shell. Confirms the renderer-dominates thesis.
- **Upstream GoofCord** (`Milkshiift/GoofCord` main `src/main.ts`): **identical** Windows block, including the same `disable-disable-backgrounding-occluded-windows` typo. So the typo is upstream, not fork-introduced — a clean, surgical, upstream-able fix candidate.

### Opportunities NOT already applied

| # | Opportunity | Expected impact | Peer precedent | Safe/Risky | Streaming-regression risk |
|---|---|---|---|---|---|
| O1 | **Measure first** — Windows RAM/CPU baseline (idle / in-call / in-screenshare, foreground vs tray) | none directly; unblocks everything else | standard | **Safe** | none (no code change) |
| O2 | **Fix `disable-disable-backgrounding-occluded-windows` typo** → `disable-backgrounding-occluded-windows` | *raises* resource use slightly; *improves* stream stability when window occluded | Vesktop sets the correct flag | Safe to change, but **resource-negative** | LOW-positive (helps streaming). It is a streaming-correctness item, not a resource win. |
| O3 | **Scope Windows un-throttling to active call/screenshare only** (drop the always-global switches; suppress throttling dynamically only while streaming/in-call) | ↓ CPU wakeups + battery when minimized to tray and *not* in a call — the only meaningful, mission-safe resource lever | none (Vesktop/GoofCord both stay always-on) | **Risky** | **HIGH** — sits exactly on the voice/screenshare path; must be manually verified on Windows (no auto-repro) |
| O4 | **V8 startup snapshot for main process** (electron-link + mksnapshot) | ↓ startup time, some shared "init-once" memory across processes | documented (RaisinTen experiment); not used by peers | **Risky/heavy** | indirect — adds build tooling, could break main-process init |
| O5 | **`--js-flags` / `--max-old-space-size` heap cap** | does NOT reduce baseline; only caps ceiling | none for Discord clients | **Avoid** | **HIGH** — capping renderer heap can OOM-crash during screenshare/WebRTC |
| O6 | **Additional `disable-features`** (e.g. mirror Vesktop's `WinRetrieveSuggestionsOnlyOnDemand`; consider `CalculateNativeWinOcclusion`) | marginal | Vesktop | Mixed | `CalculateNativeWinOcclusion` disable *raises* paint cost (it's a correctness/blank-window fix, not a saving); others marginal |
| O7 | **`backgroundThrottling: false` per-webContents instead of global switches** (more surgical than O3) | scopes throttle-suppression to main window only, not GPU/all renderers | — | Risky | MEDIUM-HIGH — known Electron blank-window / visibility-desync bugs when hidden (issues #42378, #50250); touches the streamed renderer |
| O8 | **Renderer process reduction** (`disable-site-isolation-trials`) | ↓ process count → ↓ RAM | already opt-in behind `performanceFlags` | Risky | MEDIUM — security tradeoff; already user-gated, don't make default |

**Honest framing:** O3/O7 are the *only* options that reduce footprint without contradicting the mission, and both are the riskiest to implement because they live on the streaming path. O1 (measure) is the real first step. O2 is worth surfacing but is a streaming fix that *costs* resources. O4–O6, O8 are low-ROI or risky.

---

## 3. Tech-Debt Cost

| Opportunity | Complexity | Maintenance | Fork divergence | Regression risk |
|---|---|---|---|---|
| O1 Measure baseline | S — manual runs, log to userData file (no DevTools on Windows box) | none | none | none |
| O2 Typo fix | S — one string | none | **reduces** divergence (matches Vesktop; fixable upstream) | low-positive (more streaming-stable) |
| O3 Dynamic un-throttle on call/share | M/L — needs a call/share active-state signal + Windows manual verify | ongoing (couples to Discord call detection / IPC) | new fork-only logic if not upstreamed | **HIGH** — core mission path |
| O4 V8 snapshot | L — new build step (electron-link/mksnapshot) | high; brittle across Electron bumps | **violates "no new build tooling" constraint** | medium |
| O5 Heap caps | S to add, but | — | — | **HIGH (OOM in stream)** — do not |
| O6 Extra disable-features | S | low | small | low–medium (occlusion one is resource-negative) |
| O7 Per-webContents throttling | M | medium | medium | MEDIUM-HIGH (Electron hidden-window bugs) |
| O8 Site-isolation off by default | S | low | already exists as opt-in | MEDIUM (security) |

---

## 4. Upstream-ability

Flag/posture changes are normally the *most* upstream-friendly kind of change (small, surgical, no API churn) — but the AI-averse maintainer bar (per project memory) means anything shipped needs **real Windows runtime numbers + mechanism**, not speculative flag-cargo-culting.

- **O2 (typo fix)** — most attractive upstream candidate: a genuine one-line correctness bug present in upstream `src/main.ts`, with Vesktop as precedent for the correct spelling. Easy to justify with a war-story (occluded-window stream throttling). Caveat: it *raises* resource use, so it is an upstream **streaming** PR, not a "resource optimization" PR.
- **O1 (measurement)** — not a PR; prerequisite analysis. Numbers gathered here would *strengthen* any later PR.
- **O3/O7** — only upstreamable if implemented cleanly and backed by before/after Windows measurements proving no stream regression. High bar; likely a milestone of its own.
- **O4/O5/O6/O8** — weak upstream candidates: tooling burden (O4), unsafe (O5), marginal (O6), or already user-gated (O8).

---

## 5. Recommendation & Prioritized Next Steps

**No feature code ships in v1.2 (investigate-only).** This is the plan a future build milestone would execute. The blunt conclusion: **resource optimization has low ROI for this app and partially conflicts with the fork's streaming mission.** Do not chase it blind; measure first, and treat anything touching throttling/backgrounding/GPU/WebRTC as streaming-risk.

| Opportunity | Impact (mem/CPU) | Streaming risk | Effort | Verdict |
|---|---|---|---|---|
| **O1 — Windows RAM/CPU baseline (measure first)** | enables everything | none | **S** | **GO (do first)** |
| **O2 — Fix `disable-...occluded-windows` typo** | small ↑ (it's a *streaming* fix) | LOW (positive) | **S** | **GO — but route to the streaming track, label as correctness, not a resource win** |
| O3 — Dynamic un-throttle only during call/share | the only real footprint win (tray-idle CPU/battery) | **HIGH** | **M/L** | **DEFER** — needs O1 numbers + careful Windows manual verify |
| O7 — Per-webContents `backgroundThrottling:false` | scopes throttle-suppression | MEDIUM-HIGH | M | DEFER (Electron hidden-window bugs) |
| O6 — Extra `disable-features` audit | marginal | low–med | S | DEFER (low ROI; one option is resource-negative) |
| O8 — Site-isolation off by default | ↓ RAM | MEDIUM (security) | S | **NO** — keep opt-in only |
| O4 — V8 main-process snapshot | ↓ startup | indirect | L | **DEFER/NO** — violates no-new-build-tooling; renderer dominates anyway |
| O5 — `--max-old-space-size`/`--js-flags` caps | none (caps ceiling) | **HIGH (OOM in stream)** | S | **NO** |

**Recommended next step (single):** run O1 — instrument a Windows build to log process RAM/CPU to a userData file (the Windows test box has no DevTools, per project memory) across idle / in-call / in-screenshare and foreground-vs-tray. Only with those numbers does any further work become justifiable; without them, "optimize Electron" is unfalsifiable on an app whose mission deliberately raises resource usage.

**Biggest risk to avoid:** touching `backgroundThrottling`, `disable-renderer-backgrounding`, `disable-background-timer-throttling`, site isolation, GPU/ANGLE, or V8 heap caps as a "saving" — every one of these can drop or corrupt screenshare/voice on Windows, which is the exact thing v1.0/v1.1 exist to protect. Manual Windows verification is mandatory before any such change ships.
