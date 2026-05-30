# Feature Research

**Domain:** Windows screenshare system-audio echo fix for an Electron/Vencord Discord client (bug-fix fork meant for upstream) — milestone v1.1, upstream GoofCord [#46]
**Researched:** 2026-05-30
**Confidence:** HIGH on user-facing behavior + peer approaches (public reports cross-confirmed); HIGH on build-coverage facts (carried from reconned `02-FINDINGS.md`, not re-derived); MEDIUM on the exact failure modes of the unbuilt native path (no on-box ≥20348 verification yet — D-08)

> **Supersedes the v1.0 FEATURES.md** (cancel→restart bug, dated 2026-05-29 — that work is now in PROJECT.md "Validated"). This document covers the **v1.1 echo fix** only.
>
> **Scope note:** the *mechanism* is already reconned and LOCKED — Discord uses the public WASAPI Application Loopback API (`EXCLUDE_TARGET_PROCESS_TREE`, min build 20348); Chromium `audio:"loopback"` only captures the whole endpoint mix (the echo cause). See `02-FINDINGS.md §1–§3`. This document does **not** re-derive the mechanism. It defines the *user-facing behavior of a working fix*, compares the three candidate delivery approaches (D-06), categorizes features to prevent scope creep, and recommends the minimum shippable fix.

---

## Definition of "Fixed" (the target behavior)

A working echo fix produces exactly this, with nothing more:

1. **Viewer hears desktop/app audio, NOT the call echoed.** A remote viewer of the stream hears the streamer's game/app/system audio, but does **not** hear the voices of people in the call (including their own voice) played back. This is the entire bug ([#46]).
2. **Streamer does nothing special.** The streamer enables "share system audio" exactly as today (the existing `audioConfig.mode !== "none"` picker path, `screenshare.ts:90`). No new toggle, no per-stream configuration, no manual device juggling for the common case.
3. **Works for the common case.** On a supported Windows build, the default-device system-audio share is echo-free out of the box. Edge cases (multiple output devices, sub-floor builds) degrade gracefully, not silently-wrong.
4. **No regression elsewhere.** Linux (patchcord/venmic per-app capture) and macOS paths are untouched; cancel→restart (Phase 1) still works; non-audio screenshare unaffected.

This is the yardstick for "table stakes" below: anything not required to produce behaviors 1–4 is a differentiator or an anti-feature.

---

## The three candidate approaches (D-06) — UX / setup burden / failure modes / build coverage

| Dimension | (a) Native WASAPI exclude-tree `.node` addon | (b) User-side separate-output-device workaround (docs only) | (c) Hybrid (native ≥20348, documented workaround below) |
|-----------|----------------------------------------------|-------------------------------------------------------------|----------------------------------------------------------|
| **User experience** | Invisible. Streamer shares system audio as today; echo just gone. Matches OBS "Application Audio Capture" and what Discord itself does. | Streamer must route GoofCord/Discord output to a *separate* audio device (VB-Cable / SteelSeries Sonar / VoiceMeeter) so the captured *default*-device mix no longer contains the call. Ongoing mental overhead; easy to misconfigure. | Invisible on supported builds; documented manual workaround surfaced only when the native path can't run. |
| **Setup burden (user)** | None (ships in the build). | HIGH — install + configure a third-party virtual-audio tool, set Discord/GoofCord output device, set per-app routing, re-verify after every audio-device change. Vendor guides exist (SteelSeries "Stream without echo") but it's a real config project. | None on supported builds; HIGH only as the explicit fallback. |
| **Setup burden (dev / upstream)** | HIGH — new native C++ addon built from the Microsoft `ApplicationLoopback` sample, wired through the existing `venbind`/`patchcord` `.node` → main-IPC → renderer-bridge path; resolve the GoofCord/Electron **process tree** to exclude (incl. the separate Audio Service utility process, `02-FINDINGS.md §2.2`); hardcode a fixed audio format (`GetMixFormat`→`E_NOTIMPL`). New dependency surface to upstream. | LOW — a docs/README/settings-note PR. Zero code, zero native dependency. | HIGH — native code **plus** build-detection + graceful-degrade + the fallback docs. Largest surface. |
| **Failure modes** | (1) Build < 20348 → API absent, must detect-and-degrade (mirror Discord's `audioses is too old…`). (2) Wrong exclude target → still echoes or drops desktop audio (cf. OBS #9669: process-tree mode caught the wrong tree). (3) No samples when nothing is playing → misread as "broken" (verify with audio playing — D-08). (4) Fixed-format mismatch. (5) **Cannot be verified on the maintainer's box** (Win10 19045 < 20348) — needs Windows-11 CI + a second device, viewer-side. | (1) User never finds/follows the docs → bug persists for them. (2) Mis-routing → no system audio at all, or partial echo. (3) Some virtual-cable tools add latency/quality loss. **No code failure modes — it's all user-config.** | Union of (a) + (b), plus the detection-boundary itself becoming a bug (wrong build gate → silently runs the wrong path). |
| **Windows-build coverage** | **≥ 20348 only** (effectively Windows 11). **Zero coverage below** — retail Win10 incl. 21H2/22H2 tops out at 19045 < 20348 (`02-FINDINGS.md §2.3`). | **All builds**, including Win10 19045 and the maintainer's own box. Build-independent. | Best-of-both *on paper*: native ≥20348, documented workaround < 20348 — but only if both halves actually ship and the gate is correct. |
| **Upstream-fit (surgical bug-fix fork)** | Tension: a **new native dependency + feature-sized addon** in a fork that bills itself "bug-fix, not feature; no new deps." Defensible (matches Discord/OBS; slots into the existing native-addon pattern) but the largest upstream ask and the hardest to review/verify. | Strongest fit for "surgical + upstream-able": documents a known-good workaround, zero new code/deps, can't regress anything. Matches what upstream GoofCord ([#46]) and Vesktop already effectively do. | Native-sized review cost; the documented fallback is the part that's actually low-risk. |

**Net:** native is the only approach that satisfies all four "Definition of Fixed" behaviors *for free* on the common case — but it is feature-sized, can't be locally verified, and covers only ≥20348. The workaround is genuinely surgical/upstream-able and covers all builds, but fails behavior #2 ("streamer does nothing special") and behavior #3 ("works for the common case") because it offloads work to the user. The hybrid is the only approach that doesn't leave a population uncovered, at the cost of being the largest surface.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features required to satisfy the "Definition of Fixed." Missing any of these = the fix doesn't count as fixing [#46].

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Viewer no longer hears the call echoed when sharing system audio | This *is* [#46] — the whole point | MEDIUM (native) / LOW (workaround docs) | Native: exclude the GoofCord/Electron **process tree**, not a single PID (`02-FINDINGS.md §2.2`). Workaround: route call output to a separate device. |
| Desktop/game/app audio still reaches the viewer | A fix that kills *all* audio is a regression, not a fix | MEDIUM | Native EXCLUDE-tree keeps everything except the call tree. The failure mode is excluding too much (cf. OBS #9669). |
| Streamer enables audio share exactly as today | No new ritual for the common case | LOW | Hang off the existing `audioConfig.mode !== "none"` branch (`screenshare.ts:90`); don't add picker UI. |
| Graceful behavior on builds < 20348 | The native API simply isn't there below the floor; must not crash or silently echo | LOW–MEDIUM | Detect build; degrade (documented workaround or fall back to today's whole-mix `"loopback"`), mirroring Discord's `audioses is too old…`. **Required regardless of approach** if any native code ships. |
| No regression on Linux / macOS / cancel→restart | Cross-platform + Phase-1 fix must stay intact | LOW | Windows-only branch; never touch the patchcord/venmic Linux path or the `getVirtmic()` flow. |
| Viewer-side verification path independent of the dev box | Maintainer's box is 19045 (< 20348); local listening is muted by `disable_local_echo` | MEDIUM | Windows-11 CI artifact + second device, audio actively playing (D-08; `02-FINDINGS.md §2.3`). |

### Differentiators (Competitive Advantage)

Genuinely beyond "remove the echo." For a bug-fix fork these are **stretch at most**, and several drift toward anti-features (next section). Listed for completeness so the roadmap can consciously *not* build them.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Native fix that's invisible (no user config) on supported builds | Parity with Discord-native and OBS; "just works" | HIGH | The only approach that fully satisfies behavior #2/#3. This is the *differentiator vs. the workaround*, not vs. doing nothing. |
| Hybrid coverage (native ≥20348 + documented workaround below) | No user population left uncovered | HIGH | Coverage win, but largest surface and the broadest upstream ask. |
| A surfaced one-line note/log when the build is sub-floor pointing at the workaround | Turns a silent failure into an actionable hint | LOW | Borderline differentiator; cheap. Routes via the userData log (no DevTools — D-09) or a docs link, **not** a new settings screen. |

### Anti-Features (Commonly Requested, Often Problematic — DO NOT BUILD)

These are the scope-creep traps. The milestone explicitly forbids feature growth (PROJECT.md Out of Scope: "New streaming features … this is a bug-fix fork").

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Per-app / per-window audio-capture picker UI | "Let me choose which apps' audio to stream" | A whole new feature + UI surface; INCLUDE-tree semantics + UX; far beyond removing echo; maintainer called Windows native per-app capture "way out of scope" ([#46]) | Ship EXCLUDE-tree of GoofCord only (or the workaround). No app-selection UI. |
| New audio quality / bitrate / format options | "While we're in the audio path…" | Unrelated to the echo; expands the diff; the process-loopback device forces a *fixed* format anyway (`GetMixFormat`→`E_NOTIMPL`) | Hardcode the sample's fixed format; expose nothing. |
| INCLUDE-mode "capture only this app" capture | Mirrors OBS/Discord app-streaming | Different feature (additive capture, not echo removal); OBS #9669 shows it captures the wrong tree when launched as a child — extra failure mode | Use EXCLUDE-tree (the echo fix) only. |
| Settings toggle to enable/disable the fix | "Give users control" | The fix should be the default correct behavior; a toggle implies the buggy mode is a supported choice and doubles the test matrix | No toggle. Fix is on; degrade automatically below the build floor. |
| Bundling/installing a virtual-audio driver (VB-Cable etc.) inside GoofCord | "Make the workaround automatic" | Installs a system-wide kernel/virtual device (admin, uninstall hygiene, support burden); exactly the heavyweight macOS-style driver path the recon ruled out for Windows | If using the workaround, *document* user-installed tools; never bundle/install one. |
| Rewriting the screenshare audio architecture | "Do it properly" | PROJECT.md forbids it ("fixes should be surgical and upstream-friendly") | Slot a Windows branch into the existing native-addon → IPC → `STREAM_CLOSE` teardown pattern. |
| Chasing the *missing-audio* symptom ([#185]) or Linux no-sound ([#204]) | "Fix all the audio bugs" | Different bugs, different mechanisms; dilutes a tight milestone | Keep them separate (already deferred — CONTEXT D-03, Deferred Ideas). |

---

## How Peers Handle This (public reports)

| Peer | Approach chosen | Build coverage | Outcome / gotchas (public) |
|------|-----------------|----------------|----------------------------|
| **Vesktop** (Vencord's Electron client — closest analog) | **Do nothing.** The identical echo bug is reported repeatedly and **closed wontfix / upstream / not-planned**: #789 (Win11, closed wontfix, labeled `upstream`/Electron), #657 (Linux, closed "not planned"), plus #569, #772, #918. | n/a | Strong signal the echo fix is genuinely hard and that the *easy* path (the one a fork would default to) is "punt to Electron." Confirms native is non-trivial; confirms doing nothing is the common-but-unsatisfying outcome. |
| **Upstream GoofCord** ([#46]) | **Document the user-side workaround.** Maintainer Milkshiift: it's "just simple audio capture Chromium provides … no Electron/Chromium API to capture audio of specific windows … native audio capturing akin to venmic but for Windows is way out of scope." Lists routing Discord output to a separate device. | All builds | The fork's *upstream baseline*. The workaround is the accepted status-quo answer; a native addon would be a notable expansion of upstream's stated scope (informs D-07). |
| **OBS Studio** ("Application Audio Capture", née `bozbez/win-capture-audio`) | **Native WASAPI process-loopback addon** — the proof that native is the real fix. | Win10 2004+/Win11 in practice; underlying API officially Win11 / build ≥20348 | Gotchas: (1) #9669 — INCLUDE-tree captured OBS itself when OBS was a child of the launching app (the "exclude/include the *right* tree" trap → for us, exclude the whole GoofCord/Electron tree incl. the Audio Service process). (2) "no DataAvailable event if nothing is playing" → verify with audio playing. (3) the feature sat in **beta** a long time — native process-loopback is fiddly to get production-solid. |
| **SteelSeries Sonar / VB-Audio (VB-Cable, VoiceMeeter)** | **The user-side separate-output-device workaround**, vendor-documented (SteelSeries has an explicit "Setup Sonar to Stream with Discord *Without Echo*" guide). | All builds | Proves the workaround is real and works on every build — but it's a multi-step config the *user* owns, with latency/quality caveats on some cables. This is exactly approach (b). |

**Reading:** the ecosystem has tried all three. Vesktop = do-nothing (unsatisfying). Upstream GoofCord = document the workaround (low-effort, all-builds, but offloads work). OBS = native (the real fix, but feature-sized, fiddly, build-gated). **No peer has shipped a clean, invisible, all-builds fix — because one doesn't exist** (the API floor is real).

---

## Feature Dependencies

```
[Echo removed for viewer]                       <- the bug (#46)
    ├──(native path)──> [WASAPI exclude-tree .node addon]
    │                        └──requires──> [Windows build >= 20348]
    │                        └──requires──> [correct exclude target = GoofCord/Electron PROCESS TREE
    │                                         incl. Audio Service utility process]  (02-FINDINGS §2.2)
    │                        └──requires──> [build-detection + graceful degrade below floor]
    │                        └──requires──> [Win11 CI + 2nd-device viewer-side verification, audio playing] (D-08)
    └──(workaround path)──> [user routes call output to a separate audio device]
                                 └──requires──> [user-installed virtual-audio tool + docs]  (no code)

[Hybrid] = [native path]  ⊕  [workaround path as the < 20348 fallback]   (both halves must ship)

[Per-app capture UI]      ──conflicts──> [surgical bug-fix scope]            (anti-feature; do not build)
[Quality/format options]  ──conflicts──> [fixed-format process-loopback device]  (E_NOTIMPL; anti-feature)
```

### Dependency Notes

- **Native path requires build ≥ 20348:** the `PROCESS_LOOPBACK_MODE` enum + activation don't exist below it; this is why *any* native ship also needs a graceful-degrade leg (so it doesn't crash/echo on 19045). The two are inseparable.
- **Native path requires excluding the whole process *tree*, not one PID:** Chromium routes audio through a separate sandboxed Audio Service utility process; excluding only the window PID would still capture the call (OBS #9669 is the cautionary public precedent). Exact PID layout on Electron 41.3.0 is a known *future-impl open detail*, not a blocker.
- **Native path requires a verification path that bypasses the dev box:** the maintainer's machine (19045) cannot run the API at all, and local listening is muted by `disable_local_echo` — verification *must* be Win11 CI + a second device, viewer-side, with audio actively playing (D-08).
- **Workaround path has no code dependency:** it's a docs/README/settings-note change — precisely why it's the surgical-fork-friendly option and a safe fallback leg of the hybrid.
- **Anti-features conflict with scope, not with each other:** per-app UI / quality options / toggles are individually plausible but each breaks "surgical bug-fix, not a feature fork" (PROJECT.md).

---

## MVP Definition

### Launch With (v1.1) — Minimum Shippable Fix for [#46]

**The single minimum that closes [#46] with zero scope risk is the documented workaround alone** — surgical, all-builds, upstream-able, and matching what upstream already recommends. The native addon is the *better* fix but is feature-sized, build-gated, and locally unverifiable — so it should be a *consciously-scoped* addition on top, not assumed into the MVP floor. Recommended order:

- [ ] **Document the separate-output-device workaround** — short README/docs note (VB-Cable / SteelSeries Sonar / VoiceMeeter), doubling as the < 20348 fallback. **This is the minimum standalone fix.** Zero code, all builds, fully upstream-able.
- [ ] **Native WASAPI EXCLUDE-tree `.node` addon (Windows ≥ 20348)** — the only approach that satisfies behaviors #1–#3 invisibly; built clean-room from the Microsoft `ApplicationLoopback` sample (D-05), slotted into the existing `venbind`/`patchcord` native-addon → IPC → `STREAM_CLOSE` pattern. Excludes the GoofCord/Electron **process tree**. *(Scope this consciously — it's the feature-sized part.)*
- [ ] **Graceful degrade below build 20348** — detect build; fall back to the documented workaround (or today's `"loopback"`); never crash, never silently echo. **Non-optional the moment any native code ships.**
- [ ] **Viewer-side verification on Windows 11 CI + a second device, audio playing** (D-08) — the only way to confirm the native path given the dev-box floor.

### Add After Validation (v1.x)

- [ ] Native addon, **if** the workaround-only ship proves insufficient *and* Win11 CI verification lands — trigger: users on ≥20348 want the invisible fix.
- [ ] A surfaced sub-floor hint (log line / docs link) — trigger: support reports of silent echo on old builds.

### Future Consideration (v2+) — explicitly deferred / likely never

- [ ] Per-app INCLUDE-capture or a capture picker — only as a separate milestone; it's a feature, not this bug fix (maintainer-flagged out of scope).
- [ ] The [#185] missing-audio fix and [#204] Linux no-sound — separate bugs, separate phases.

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Echo removed for the viewer (the bug itself) | HIGH | — (varies by path) | P1 |
| Documented separate-output-device workaround | MEDIUM (all builds, user-effort) | LOW | P1 (minimum shippable) |
| Graceful degrade below build 20348 | HIGH (no crash/silent-echo) | LOW–MEDIUM | P1 *(if any native code ships)* |
| Viewer-side Win11-CI verification path | HIGH (it's how we know it works) | MEDIUM | P1 *(if native)* |
| Native WASAPI exclude-tree addon (≥20348) | HIGH (invisible, common-case) | HIGH | P2 (better fix; build-gated, unverifiable locally) |
| Sub-floor hint (log/docs link) | LOW–MEDIUM | LOW | P3 |
| Per-app capture UI / quality options / toggle | LOW (and off-scope) | HIGH | P3 — **do not build** (anti-features) |

**Priority key:** P1 = must-have to close [#46] without scope creep · P2 = better fix, scope it consciously · P3 = nice-to-have / explicitly excluded.

## Competitor Feature Analysis

| Feature | Vesktop | Upstream GoofCord (#46) | OBS Studio | Our Approach (recommended) |
|---------|---------|--------------------------|------------|-----------------------------|
| Echo removed | No (wontfix/upstream) | No code — documents workaround | Yes (native process-loopback) | Document workaround (P1 floor) + optional native addon (P2) |
| Per-app / per-window capture | No | "Way out of scope" (maintainer) | Yes (INCLUDE-tree, beta a long time) | **No** — anti-feature |
| Build coverage | n/a (unfixed) | All builds (workaround) | Win10 2004+/Win11 (API ≥20348) | Workaround = all builds; native = ≥20348 only |
| New UI / quality knobs | No | No | Source-level config | **No** — keep it surgical |
| Verification | n/a | n/a | OBS preview | Win11 CI + 2nd device, audio playing (D-08) |

## Sources

- `https://github.com/Milkshiift/GoofCord/issues/46` — the target bug; maintainer "native … for Windows is way out of scope"; user-side workaround. (HIGH — primary; quote carried from CONTEXT canonical refs / `02-FINDINGS.md`.)
- `https://github.com/Vencord/Vesktop/issues/789` — closest peer; identical echo, **closed wontfix / `upstream`(Electron)**, Win11. (HIGH)
- `https://github.com/Vencord/Vesktop/issues/657` — peer echo report (Linux), **closed "not planned."** (HIGH)
- `https://github.com/Vencord/Vesktop/issues/569`, `/772`, `/918` — additional Vesktop echo / system-audio reports (corroborating "unsolved upstream"). (MEDIUM)
- `https://obsproject.com/kb/application-audio-capture-guide` + `https://github.com/bozbez/win-capture-audio` — OBS native per-process WASAPI capture (proof native is the real fix); Win10 2004+/Win11. (HIGH)
- `https://github.com/obsproject/obs-studio/issues/9669` — OBS process-tree gotcha (INCLUDE captured OBS's own tree when launched as a child) → "exclude the *right* tree" lesson. (HIGH)
- `https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/` — clean-room reference; "requires Windows 10 build 20348 or later." (HIGH; carried from recon, not re-derived)
- `https://support.steelseries.com/hc/en-us/articles/35145998503181-Setup-Sonar-to-Stream-with-Discord-Without-Echo` + VB-Audio (VB-Cable/VoiceMeeter) — vendor-documented separate-output-device workaround, all builds. (MEDIUM)
- `https://github.com/naudio/NAudio/blob/master/Docs/WasapiLoopbackCapture.md` — "no DataAvailable when nothing playing" gotcha (corroborates D-08 verify-with-audio-playing). (MEDIUM)
- Project recon: `.planning/phases/02-fix-bug-b-windows-loopback-audio-captured/02-FINDINGS.md §1–§3`, `02-CONTEXT.md` (D-06/D-08), `02-RESEARCH.md`. (HIGH — mechanism/build facts carried, not re-derived)

---
*Feature research for: Windows screenshare echo fix (GoofCord v1.1, upstream #46)*
*Researched: 2026-05-30*
