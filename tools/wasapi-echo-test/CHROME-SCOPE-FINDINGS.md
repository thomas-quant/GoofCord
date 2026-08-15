# What Chromium's `getDisplayMedia` system audio actually captures — 2026-08-15

Harness: `chrome-scope/` (`server.py` + `index.html`). Three tones, one 8 s capture, Goertzel
analysis. Browser: **Brave** (`C:\Program Files\BraveSoftware\...`) — Chrome is **not installed on
this machine**, so the user's original friend test and `chrome.har` were Brave too. Brave is
Chromium and does not patch the WASAPI loopback path, but note the distinction before reading
Chromium source for exact behaviour.

    440 Hz  <- VLC       -> Speakers (default endpoint)   control: does capture work at all
    997 Hz  <- VLC       -> CABLE Input (the VAC)         tests DEVICE scope
   1600 Hz  <- the page  -> Brave's own audio             tests SELF-exclusion

Share: **Entire Screen + "Share system audio"**, the same thing the user demoed to their friend.

## Discord asks Chromium for nothing special

From the HAR's `web.js`, `DesktopInput.get()` verbatim:

```js
let i = {
  audio: t && { echoCancellation: !1, noiseSuppression: !1, autoGainControl: !1 },
  video: { ...e, frameRate: 30 }
};
return new e6(await navigator.mediaDevices.getDisplayMedia(i), n)
```

No `systemAudio`, no `suppressLocalAudioPlayback`, no `selfBrowserSurface`, no `restrictOwnAudio`
(that string appears in **zero** Discord bundles). The only `applyConstraints` in the bundle sets
video width/height for quality. **There is no Discord trick to copy** — everything observed is
Chromium's default behaviour.

## Results

| tone | source | `restrictOwnAudio` unset | `restrictOwnAudio: true` |
|---|---|---|---|
| 440 Hz | VLC → Speakers | **−15.1 dB** present | **−24.5 dB** present |
| 997 Hz | VLC → CABLE Input | **−99.0 dB** absent | **−89.3 dB** absent |
| 1600 Hz | the page → Brave itself | **−18.4 dB** present | **−25.6 dB** present |

Reported track settings, both runs:
`{"deviceId":"loopback","restrictOwnAudio":false,"channelCount":2,"sampleRate":48000,...}`

Whole-file spectra show exactly **two** significant peaks in each run — 440 Hz (44.0% / 26.1% of
total power) and 1600 Hz (17.1% / 8.4%) — and nothing at 997 Hz. The between-run level differences
are **spectral leakage**, not noise: the tones land at 440.1/1600.3 Hz rather than exactly on-bin,
so a fixed-frequency Goertzel loses energy and the apparent floor rises. RMS envelopes are flat and
identical (−16 dBFS) across both runs.

## Three verdicts

1. **Chromium is DEVICE-SCOPED.** The VAC tone is rejected by ~84 dB relative to the control, in
   both runs. `deviceId: "loopback"` is the default render endpoint. This is why the user's friend
   never heard VLC → CABLE Input.
2. **Chromium does NOT self-exclude.** Its own 1600 Hz tone is the second-largest component of the
   capture. This is exactly the pre-#211 GoofCord behaviour that *causes* upstream #46.
3. **`restrictOwnAudio` is silently ignored.** Requested `true`, `getSettings()` returns `false`,
   and the page's own tone is still captured at full strength. Same failure shape as the
   2026-07-13 endpoint-EXCLUDE falsification: accepted, reported, ignored.

## This corrects DEVICE-SCOPE-FINDINGS §5

§5 asked how Chromium could be device-scoped *and* self-excluding, and speculated that if it were,
it would be a better fix than per-app INCLUDE. **It is not both.** It is device-scoped with no
self-exclusion at all.

The friend never heard their own voice for a reason outside the capture scope — the browser's audio
was evidently not landing on the captured default endpoint at the time (device routing), not
because Chromium filtered it.

## Consequence for the fix

Nobody has both properties:

| | device scope | self-exclusion |
|---|---|---|
| Chromium loopback (old GoofCord, Discord web) | ✅ VAC-immune | ❌ none → #46 echo |
| WASAPI process loopback (#211) | ❌ VAC leaks | ✅ excludes own tree |

Switching GoofCord back to Chromium's path would trade the VAC echo for the original
everyone-hears-themselves echo. **`SYNTHESIS.md`'s goal-(b) "IMPOSSIBLE" verdict survives this
test** — the one candidate escape hatch (`restrictOwnAudio`) does not function.

## Loose end — CLOSED

The remaining question was whether `restrictOwnAudio` was absent, ignored, or merely gated. All
three vehicles were tried in Brave 151: plain constraint at acquisition, `{exact: true}` (rejected
outright — `getDisplayMedia` refuses *all* exact constraints, so that test was unusable),
`applyConstraints` on a live track (resolved as a no-op), and
`--enable-features=RestrictOwnAudio` in a separate profile with the flag confirmed on the browser
process and 7 children. `getSettings()` returned `false` every time.

Per the Intent to Ship the Finch feature is `RestrictOwnAudio`, has no `about://flags` entry, ships
enabled for all users, and is **unsupported on Linux and ChromeOS**. Per MDN it filters audio
originating from the *capturing document*.

**Electron settles it — see `ELECTRON-SCOPE-FINDINGS.md`.** Electron 41.3.0 / Chromium 146 is
equally inert, with and without the switch, so this is not a Brave patch, and GoofCord cannot reach
self-exclusion through Chromium's loopback. Goal (b) stays closed.

## Reproducing

    python3 chrome-scope/server.py 8765
    # open http://localhost:8765/index.html  (add ?restrict=1 for the constraint variant)
    # click Start -> Entire Screen -> tick "Share system audio"
