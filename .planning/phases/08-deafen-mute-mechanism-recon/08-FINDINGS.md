# Phase 08 — Deafen/Mute Mechanism Recon (INV-03)

## Verdict: NO-GO

**BLUF:** When you deafen in GoofCord and "see" other audio attenuate/duck, that is **inherited Discord-web-in-Chromium behaviour, not anything GoofCord does**. GoofCord performs **zero** audio-graph manipulation for deafen / mute / volume — grep across the whole fork finds no `GainNode`, `AudioContext`, `setSinkId`, deafen, or per-user volume code at all (the single `mute` hit is an unrelated screenshare-audio-capture label). The behaviour comes from two things native Discord avoids but the web client cannot: (1) **Windows "communications" auto-ducking** — Windows automatically reduces the volume of all other applications by ~80% while a communications audio stream is active; Discord's *native* C++ media engine explicitly **circumvents** this, but the browser/Electron WebRTC path GoofCord wraps **cannot**, so the OS ducking is visible; and (2) the web client ramps voice gain (smooth fade) on deafen/undeafen rather than the native client's hard cut. Both are upstream Discord/Chromium behaviours. There is no clean, surgical, upstreamable change GoofCord could make — addressing it would require reclassifying Chromium's audio-stream category (no Electron API) or a native media engine (out of scope). Curiosity satisfied; nothing to build.

---

## 1. Current State (does this fork touch it?)

**Nothing here.** This fork's `src/` does not touch deafen, mute, per-user volume, or output audio gain in any way.

Evidence (grep, repo-wide, excluding `node_modules` / `ts-out` / `.git`):

- `deafen | selfDeaf | selfMute | attenuat | GainNode | AudioContext | setSinkId` → **0 hits** in `src/` and `build/`.
- `\bmute\b | \bgain\b | \bvolume\b` → exactly **one** hit:
  - `src/windows/screenshare/preload/preload.mts:224` → `i(isSystem ? "screenshare-audio-mute-desc" : ...)`.
  - This is a **localization key for the screenshare source-picker UI** ("Select applications to MUTE from the stream."), i.e. *excluding* an app from **screenshare audio capture**. It has nothing to do with user self-deafen/self-mute or output ducking.
- The matching lang strings (`assets/lang/en-US.json:40-51`, `ru.json`) are all `screenshare-audio-*` capture labels — same screenshare context.

Audio-adjacent code that *does* exist is all **screenshare capture**, not playback/deafen:
- `src/windows/main/preload/wasapiTransport.ts` — feeds a `MediaStreamTrackGenerator` from the WASAPI loopback addon (v1.1 screenshare *system-audio capture*).
- `src/windows/main/renderer/postVencord/screensharePatch.ts` — `getUserMedia` / `getDisplayMedia` patching for the **screenshare** stream.
- These are capture-side (what you *send* in a stream), never the receive/playback side that deafen affects. Rule them **out**.

**Reinforcing signal (the gotcha):** even the renderer bundles that *do* run Discord-facing logic (`postVencord.js` / `preVencord.js`) are **downloaded from upstream `Milkshiift/GoofCord` at runtime**, not built from this fork. And the actual mod is **vanilla Vencord `browser.js`** downloaded from `github.com/Vendicated/Vencord` (`src/settingsSchema.ts:218`). So deafen/voice UI behaviour is **Discord-web + Vencord**, definitionally not this fork's code.

---

## 2. Mechanism (GoofCord vs Vencord vs Discord-web)

**GoofCord:** Not involved. It is an Electron shell hosting the Discord **web** app; it adds no audio graph, no deafen hook, no volume code (Section 1).

**Vencord:** Not the cause by default. Vencord *does* have audio plugins — `VolumeBooster` (per-user/stream gain >200%), `NotificationVolume`, and various `FakeDeafen`/`FakeMute` plugins — but:
- They are **disabled by default**; Vencord ships plugins off until the user enables them, and that state lives in **Vencord's** config, not GoofCord's.
- GoofCord loads **stock** `browser.js` and pre-enables none of them (`src/settingsSchema.ts:216-228` lists only loader URLs, no plugin enablement).
- None would produce "deafen ducks other audio" as default behaviour. Rule **out** unless the user explicitly enabled one — worth a one-line check ("is VolumeBooster/any audio plugin enabled in Vencord settings?") but not the likely driver.

**Discord-web (the actual cause) — why web deafen shows attenuation native doesn't:**

Discord's own engineering blog states the desktop/mobile apps use "a single C++ media engine built on top of the WebRTC native library," while the **browser app relies on the browser's WebRTC implementation.** Two native-only capabilities are called out that directly explain the user's observation:

1. **"Circumvent auto-ducking behavior of the default communications device on Windows. Ducking, or volume attenuation, means that Windows automatically reduces volume of all applications when communications device is used."**
   - Windows' Sound → **Communications** tab defaults to *"Reduce the volume of other sounds by 80%"* whenever a communications-role audio stream is active.
   - Chromium (which GoofCord/Electron embeds) opens its WebRTC audio streams with the **communications** role, so Windows applies this ducking. The **native** Discord client suppresses it; the **web/Electron** client cannot. Result: when voice activity / deafen state changes, other apps' (and the OS mixer's) volume **visibly ducks** — exactly the "attenuation you can see" the user reports, and exactly what native Discord avoids.

2. **"Implement our own volume control to avoid changing your global operating system volume."** — native does its own mixing; the web client rides the browser's WebRTC stack.

Secondary contributor: the web client applies a **gain ramp (smooth fade)** to incoming voice when you deafen/undeafen, rather than the native client's instantaneous hard mute (widely noted as Discord-web's "deafen fade"). This is a per-user-voice *fade*, distinct from the OS-level ducking above, but also a pure web-client behaviour.

Either way the chain is: **OS / Chromium / Discord-web → not GoofCord.** The "differs from native" framing is the textbook native-vs-browser difference Discord itself documents.

---

## 3. Actionable? (and where would a change live)

**Not cleanly actionable.** There is no surgical, upstreamable GoofCord change here.

- **Windows communications ducking** is governed by the audio stream's *role/category* that **Chromium** assigns internally for WebRTC. Electron exposes **no API** (no `BrowserWindow`/`webContents`/session option, no reliable command-line switch) to reclassify those streams as multimedia instead of communications. So GoofCord cannot flip it from the app side.
- The only "fix" is an **OS user setting** (Sound → Communications → "Do nothing"), which is per-machine, owned by the user, and **must not** be silently changed by the app — and is not a code change anyway.
- Matching native Discord's behaviour would require a **native C++ media engine that circumvents WSAPI ducking** — categorically out of scope for a web-wrapper fork and not upstreamable as a "clean, minimal" PR (the milestone's bar).
- The Vencord plugins that touch volume already live **upstream in Vencord**, not in GoofCord; nothing for this fork to add there.

If anything were ever pursued, it would live nowhere in this fork's current surface — it's an Electron/Chromium-internals limitation, not a GoofCord module.

---

## 4. Recommendation

**NO-GO. Close as "inherited web-client behaviour; nothing for GoofCord to change."**

- The observation is **real and explainable**: GoofCord runs Discord-**web** inside Chromium; on Windows the OS communications auto-ducking (and the web client's deafen gain-fade) are visible because the **browser path cannot circumvent them**, whereas the **native** Discord client (custom C++ media engine) does. Discord's own engineering blog documents this exact native-vs-browser gap.
- **This fork touches none of it** — zero deafen/mute/volume/audio-graph code; the lone `mute` reference is a screenshare-capture label.
- **No upstreamable fix exists** that fits the fork's "clean, minimal, PR-ready" constraint. The lever (Chromium audio-stream category) isn't exposed by Electron; the alternative (native media engine) is out of scope; the OS-setting workaround isn't code.
- **Effort if ever revisited:** N/A for a code fix. The only zero-cost follow-ups are documentation-grade: (a) optionally confirm no audio Vencord plugin is enabled in the user's Vencord settings (~5 min, rules out the only non-default path), and (b) note in user-facing docs/FAQ that Windows communications ducking can be disabled via Sound → Communications → "Do nothing" for users who dislike it. Neither is a milestone deliverable.

**Curiosity resolved. Recommend no further phases.**

---

### Sources
- Discord Engineering — *How Discord Handles 2.5M Concurrent Voice Users using WebRTC* (native C++ media engine vs browser WebRTC; "Circumvent auto-ducking behavior of the default communications device on Windows"; "Implement our own volume control"): https://discord.com/blog/how-discord-handles-two-and-half-million-concurrent-voice-users-using-webrtc
- Discord Support — *How do I stop Discord from lowering my volume when someone else is talking?* (attenuation/ducking feature): https://support.discord.com/hc/en-us/articles/206342888
- Vencord plugins — VolumeBooster / NotificationVolume / FakeDeafen (audio plugins exist but are opt-in, not GoofCord defaults): https://vencord.dev/plugins
- Windows communications-device auto-ducking ("Reduce the volume of other sounds by 80%", default): Windows Sound → Communications tab behaviour, corroborated across vendor guides.

### Codebase evidence index
- `src/windows/screenshare/preload/preload.mts:224` — only `mute` hit (screenshare capture label, not deafen)
- `assets/lang/en-US.json:40-51` — `screenshare-audio-*` capture strings
- `src/settingsSchema.ts:216-228` — asset loader defaults: stock Vencord/PreVencord/PostVencord URLs, no audio plugin enablement
- `src/windows/main/preload/wasapiTransport.ts`, `src/windows/main/renderer/postVencord/screensharePatch.ts` — screenshare *capture* only; not playback/deafen
- Repo-wide grep `deafen|selfDeaf|selfMute|attenuat|GainNode|AudioContext|setSinkId` → 0 hits in `src/`
