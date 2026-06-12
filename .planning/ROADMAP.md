# Roadmap: GoofCord — Windows Streaming Fixes (Fork)

## Shipped / Completed Milestones
- ✅ **v1.0 Windows Streaming Fixes** — Phases 1-2 (2026-05-30)
- ✅ **v1.1 Windows Screenshare Echo Fix (#46)** — Phases 3-5 (2026-06-06) → [archive](milestones/v1.1-ROADMAP.md)
- ✅ **v1.2 Feature Viability Investigations** — Phases 6-9 (2026-06-07), investigate-only triage → [archive](milestones/v1.2-ROADMAP.md). 4 verdicts: INV-02 keybinds GO, INV-04 found a `main.ts` flag typo, INV-01 + INV-03 NO-GO.

Upstream PRs: #210 (Wayland xdg-portal-cancel re-open) · #211 (Windows echo fix, Closes #46).

## Active Milestone: v1.3 — Small Upstream-able Fixes

**Type:** Build. Two surgical, upstream-able fixes promoted from the v1.2 investigations, plus one optional stretch. Independent files (no inter-phase dependency). Keybinds + flag-typo verification is manual on a Windows x64 CI artifact.

| # | Phase | REQ | Touches |
|---|-------|-----|---------|
| 10 | Keybinds Non-Alphanumeric Fix | KEY-01 | `src/windows/main/preload/keybinds.ts` |
| 11 | Occluded-Window Flag Typo Fix | STREAM-05 | `src/main.ts` |
| 12 | cloudToken Encryption *(stretch, optional)* | SEC-01 | `src/settingsSchema.ts` |

### Phase 10 — Keybinds Non-Alphanumeric Fix (KEY-01)
**Goal:** Global keybinds bound to OEM/punctuation AND named/non-printable keys (Page Up, F-keys, arrows, Space, Enter) register and fire on Windows, finishing the named-key half of KEY-01 / upstream #179.
**Success criteria:**
1. `keybinds.ts` feeds venbind the literal key char (e.g. `]`, `;`) for OEM keys and the canonical venbind token (e.g. `pageup`, `f12`, `space`) for named keys instead of `String.fromCharCode(keyCode)` garbage.
2. Existing alphanumeric + punctuation binds still work (no regression) — proven by `bun test`.
3. `bun run check` passes; manual Windows CI verification of a named-key bind (e.g. Page Up) firing out-of-focus and focused.

**Plans:** 2 plans
Plans:
- [x] 10-01-PLAN.md — Add NAMED_KEYCODE_TOKENS + extract pure keybindShortcut module with bun:test coverage (autonomous) — done (8 tests green, `bun run check` ✓)
- [x] 10-02-PLAN.md — Point GoofCord at the fixed venbind (decision: github-ref) — done; **manual Windows CI verification still pending** (success criterion 3)

### Phase 11 — Occluded-Window Flag Typo Fix (STREAM-05)
**Goal:** The intended `disable-backgrounding-occluded-windows` Chromium switch is actually applied on Windows.
**Success criteria:**
1. `src/main.ts:67` uses the correct flag name (single `disable-`).
2. No change to the other two Windows anti-backgrounding switches.
3. `bun run check` passes; flag verified present in the launched switch set.

### Phase 12 — cloudToken Encryption (SEC-01) *(stretch / optional)*
**Goal:** The only cleartext secret (`cloudToken`) is encrypted at rest.
**Success criteria:**
1. `cloudToken` carries `encrypted: true` and round-trips through the existing `ENC:`/`PLAIN:` machinery.
2. Verified the token is not read before `decryptSettings()`; existing-plaintext-token migration is graceful.
3. Only proceeds with explicit user go-ahead (deferred by default).

## Backlog

### Phase 999.1: Windows audio — patchcord-parity capture backend (BACKLOG)

**Goal:** Grow the Windows WASAPI process-loopback addon from a fixed echo-fix into a patchcord-parity audio backend: honor `audioConfig.mode`/`pids`, support include/exclude of arbitrary apps, plus window capture and a selectable capture source. Wanted independent of upstream; also the substance of Milkshiift's PR #211 question ("same API as patchcord, include/exclude any apps, not just prevent echo").
**Requirements:** TBD
**Plans:** 0 plans

**Why now (context):** The win32 path (`tryStartWasapiLoopback()` in `src/modules/native/wasapiLoopback.ts`) hardcodes EXCLUDE-of-own-process-tree and ignores `audioConfig` entirely, while the Linux/patchcord path honors `mode`/`pids` (`src/windows/screenshare/screenshare.ts:94-114`). OBS Studio is the proof-of-feasibility precedent — it runs multiple concurrent process-loopback captures (one per app) in one process (verified against MS docs + OBS KB, 2026-06-10).

**Scope (tiered):**
1. **Honor `audioConfig.mode`/`pids` (Tier 1, low-risk):** single-app INCLUDE (`PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`) + single-app EXCLUDE. Parametrize the Rust addon to `start(mode, targetPid, onChunk)`; today's exclude-self echo fix becomes the "system" case. Pass `audioConfig` through `screenshare.ts` instead of the argless call.
2. **Multi-app INCLUDE:** run N concurrent process-loopback captures + mix in the addon (OBS-proven feasible). A spike only needs to confirm it works inside Electron's audio session — not whether it's possible.
3. **Windows app enumerator:** `IAudioSessionManager2` / `IAudioSessionEnumerator` → app name + PID, to populate a Windows audio-source picker (patchcord `listShareableNodes` equivalent — net-new surface).
4. **Dedicated window capture:** capture a specific window (à la OBS window capture).
5. **Selectable audio capture source / device:** fixes a real current bug — if a user routes audio through a **virtual audio cable**, exclude-self still echoes (the VAC loop isn't in GoofCord's process tree, so it re-enters the captured mix). Letting the user pick/exclude the source resolves it.

**Constraints / known limits (record so we don't re-discover):**
- Multi-EXCLUDE (system minus self minus arbitrary app X) is **not expressible** — `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS` takes one `TargetProcessId` + one mode. Multi-INCLUDE is the path.
- **Never** run endpoint loopback (Chromium `"loopback"`) alongside process loopback — that combination caused the CoreMessaging hard-crash (OBS independently warns to disable Desktop Audio when using per-app capture). Already avoided at `screenshare.ts:101-110`.
