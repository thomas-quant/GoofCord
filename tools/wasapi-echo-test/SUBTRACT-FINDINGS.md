# Endpoint loopback minus own-process loopback is exact — measured 2026-09-06

Harness: `subtract-test.mjs` (+ numpy analysis of `--dump` output). Addon at `0a8d607`
(`addon-under-test.node`, CI build). Box: Win10 19045, Realtek Speakers (default, 48 kHz,
Realtek APO chain assigned), NVIDIA HDMI `PL2470H` (48 kHz, stock Microsoft APOs), VB-Cable
`CABLE Input` (48 kHz, 24-bit, no APOs). Listen-to-this-device OFF throughout (997 Hz cable tone
absent from every Speakers endpoint capture, 12–18 dB *below* the noise reference).

## Why this test exists

Ground truth from the user, 2026-09-06: with the June 6 `#211` build (process loopback,
EXCLUDE own tree) User B no longer hears themselves but **still hears User A's mic through the
virtual cable**. Native Discord: User B hears neither. So Discord's whole-screen capture is
device-scoped (cable-immune) *and* self-excluding, and `#211` is only the second.

No single WASAPI primitive has both properties (`DEVICE-SCOPE-FINDINGS.md`, endpoint-bound
EXCLUDE falsified 2026-07-13, Chromium `restrictOwnAudio` inert). The remaining candidate is the
Discord-shaped one: **capture the default render endpoint (device-scoped) and subtract an
in-engine copy of our own render stream**. Discord has that copy because it owns its audio
device module. We can get one from the engine itself: `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`
of our own tree. Whether that is *exact* — arithmetic, not an adaptive canceller — is what was
measured.

Four sessions run concurrently on the keyed-session addon:

| leg | capture | role |
|---|---|---|
| A  | process loopback, EXCLUDE(bogus pid) | everything, any device |
| B1 | process loopback, INCLUDE(VLC → CABLE Input, 997 Hz) | reference for the process-vs-process pairing |
| C  | endpoint loopback of the chosen render device | what the user hears |
| B2 | process loopback, INCLUDE(VLC → that device) | stand-in for "our own tree" |

VLCs are launched out of tree via WMI. Content: pure tones, and 90 s of pink noise
(`noise-spk.wav`, −20 dBFS) for broadband runs. Alignment: brute-force integer-lag correlation
(the addon's polled DevicePosition/QPC pairs do not share an origin between endpoint and
process legs, so they cannot seed it — see caveats).

## Results

### ep pairing (C − B2): endpoint loopback minus process INCLUDE

| endpoint | content | lag | gain | residual |
|---|---|---|---|---|
| **PL2470H (HDMI)** | pink noise, 17 s | 1024 | 1.000000 | **exactly zero — every sample, every band** |
| Speakers (Realtek) | 440 Hz tone, 8 s | −480 | 0.98937 | 77 dB null at the tone |
| Speakers (Realtek) | pink noise, 20 s | 1440 | 1.0014 | see below |
| CABLE Input | pink noise, 20 s | 6720 (cable's internal buffer) | 1.0054 | 67–69 dB null above 4 kHz |

The Speakers noise run first read as a 14 dB broadband residual. It was not a mismatch:
**Spotify was rendering to Speakers during the runs** (session enumerated; leftover has an 8.8 dB
crest factor and music-shaped spectrum). The same third stream is recoverable from the process
path, `A − B1 − B2`, and the two leftovers are the *same signal*: coherence 1.000 at 100 Hz,
500 Hz, 2 kHz and 6 kHz. Their difference — the true endpoint-tap vs process-tap mismatch on the
Realtek endpoint — is:

| band | mismatch below the leftover | absolute |
|---|---|---|
| 50–200 Hz | 65 dB | −117 dBFS |
| 200–900 Hz | 48 dB | −98 dBFS |
| 1.1–4 kHz | 43 dB | −99 dBFS |
| 4–8 kHz | 45 dB | −106 dBFS |
| 8–12 kHz | 41 dB | −106 dBFS |
| 12–20 kHz | 34 dB | −104 dBFS |

Transfer function C/B2 on Speakers (Welch, 8192): |H| flat within ±0.04 dB from 100 Hz to
20 kHz, phase within ±0.4°, fractional delay −0.002 samples. So the Realtek APO chain is a
near-transparent linear stage, not a limiter or dynamics processor at these levels. On an
endpoint without it (HDMI) the two taps are the same bytes.

### pp pairing (A − B1): process EXCLUDE minus process INCLUDE

997 Hz null 42–65 dB per segment across runs; never exact. `A − B2` (noise) by band only
9–27 dB — but that residual is dominated by Spotify + the 997 tone, so it does **not** show the
multi-stream process-loopback path is inexact. Not needed for the product design; parked.

### Stability

Within-run: the integer lag held for the full window in every run (per-10 s segment nulls flat;
HDMI exactly zero across 17 s). Cross-run: the lag differs every start (−480, 960, 1440, −868
on Speakers) — it is a start-order artefact, so it must be found per session, not hardcoded.
Drift, 85 s run on Speakers with −40 dBFS pink noise (`noise-quiet.wav`): the residual
fractional delay between the endpoint tap and the process tap, from the cross-spectrum phase
slope over 9–18 kHz (robust to additive third-stream content), was +0.0007, +0.0073, +0.0015 and
+0.0036 samples at 0 s, 20 s, 40 s and 60 s. No drift at the 0.01-sample level over a minute:
the two taps share the engine clock. The null-depth columns of that run are NOT usable — Spotify
plus at least one more stream not on Speakers were rendering, so the third-stream removal trick
from the 20 s run did not separate cleanly (residual differences of −2 to +5 dB in most segments,
24/40 dB in the one segment where the extra stream went quiet). Repeat with nothing else playing
before quoting a long-run null.

## What this establishes

1. **Endpoint loopback of a render device is, on this box, the sample-exact sum of the process
   loopback INCLUDE streams rendering to it**, at a fixed integer lag and unity gain — bit-for-bit
   on an APO-free endpoint, and within −100 dBFS on the Realtek endpoint with its stock APO chain.
2. Therefore `endpoint(default) − INCLUDE(own tree)` is deterministic subtraction: one integer
   lag, no gain fit, no convergence, no adaptive filter, no calibration signal. The reference is
   engine-generated, so it stays exact under any content, and it adds at most the lag as latency
   (10–30 ms on this box).
3. The result is device-scoped (cable audio that never reaches the endpoint is absent) **and**
   self-free — the pair `SYNTHESIS.md` called impossible, and the pair Discord evidently has.

## Caveats and gates before this is a product path

- **Lag discovery.** Correlation at start works with any non-silent own audio; at share start
  GoofCord may be silent. Either inject a short inaudible probe into our own render at start, or
  fix the timestamp path: `GetBuffer`'s QPCPosition is comparable across streams but the addon's
  polled stats are torn pairs without a packet index. Carry (packet frame index, DevicePosition,
  QPC) per packet and derive the lag from QPC; the 960/1440 lags are exact multiples of the
  engine period, so a QPC-derived lag rounded to the period is likely exact.
- **DATA_DISCONTINUITY** on the endpoint leg (`discont=1` at start in every run). Re-derive the
  lag after any discontinuity flag on either leg.
- **Third streams are untouched by construction** (Spotify survived at −39 dBFS in every run,
  which is the point), but a third stream *inside our own tree* is subtracted twice only if it
  also renders elsewhere — Electron renders to the default device only.
- **Own audio routed off-device.** INCLUDE(own tree) contains our streams wherever routed. If a
  user per-app-routes GoofCord to a different device, subtraction injects an inverted copy.
  Detect: enumerate our own sessions across endpoints; if any is not on the captured endpoint,
  disable subtraction (fall back to plain `#211`).
- **Default device change / format change** → re-open both legs and re-align
  (`IMMNotificationClient`).
- **Realtek "enhancements" enabled** (loudness EQ, bass boost) would make the endpoint tap
  non-linear. On this box they are inert (H flat). Detectable per stream via
  `IAudioEffectsManager` on 22H2+; otherwise gate on a runtime residual check: if the null
  against our own reference drops below ~30 dB, disable subtraction rather than emit garbage.
- **Listen-to-this-device ON** puts the mic on the endpoint. That is "what you hear" and would be
  captured; Discord's endpoint capture would capture it too. Out of scope; document it.
- **Windows 11 24H2** adds `AUDCLNT_STREAMOPTIONS_POST_VOLUME_LOOPBACK`; irrelevant here since the
  process tap is pre-endpoint-volume too and the measured gain is unity.
- Measured on ONE box. Repeat on a Win11 machine and on a non-Realtek default endpoint before
  claiming generality.
