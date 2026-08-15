# Whole-screen capture harness — run of 2026-07-28

Artifact: `out-whole-screen.wav` (6.00 s, 48 kHz, stereo, float→int16).
Harness: `whole-screen-test.mjs` @ `89fa4e0`, EXCLUDE-self against `process.pid`.

## Verdict: INCONCLUSIVE — the protocol was not executed. Re-run required.

The three phases are statistically indistinguishable, so the differential test that the
harness is built around has nothing to differentiate.

| phase (analysed window) | wideband | speech band | peak | L/R corr | voiced | median F0 |
|---|---|---|---|---|---|---|
| 1 SILENCE (0.3–2.0 s)    | −40.6 dBFS | −50.1 dBFS | −24.8 dBFS | +0.989 | 50 % | 119 Hz |
| 2 VOICE ONLY (2.3–4.0 s) | −39.4 dBFS | −48.4 dBFS | −24.9 dBFS | +0.995 | 62 % | 97 Hz  |
| 3 AUDIO ONLY (4.3–6.0 s) | −39.0 dBFS | −47.5 dBFS | −24.9 dBFS | +0.994 | 67 % | 106 Hz |

    wideband:    voice/silence = 1.1x (+1.2 dB)   audio/silence = 1.2x (+1.6 dB)
    speech band: voice/silence = 1.2x (+1.7 dB)   audio/silence = 1.3x (+2.6 dB)
    -> harness branch either way: INCONCLUSIVE (audio < 3x gate)

Peak agrees to 0.1 dB across all three phases. Nothing the operator did moved the capture.
Measured with the corrected pitch detector described below; the speech-band and voiced columns
are the new metrics, backfilled onto this run.

## What the run actually was

The file is 287520 frames = 5.9900 s: 6.000 s minus a 10 ms tail, with a 31.3 ms digital-silence
block at the head (activation ramp) and **no splices** — sample-to-sample discontinuities are all
at the local signal level, none are clicks. So packets flowed continuously and the invocation was
`whole-screen-test.mjs 2`, i.e. **2 s per phase, not the 6 s default**. After the harness's 300 ms
guard that leaves 1.7 s per phase — a handful of syllables. Too short to carry a verdict even if
the protocol had been followed.

Phase 3 shows no desktop audio: level, spectrum and stereo width are unchanged from phase 1. Either
nothing was played or it was inaudible. Without that baseline there is nothing to judge phase 2
against, which is exactly the case the harness's own `audioOverFloor < 3` branch catches.

## What is in the capture anyway

Two components, both present throughout all three phases:

1. **A constant low-frequency floor.** Single largest spectral peak is **50.25 Hz carrying 10.75 %
   of total energy** — UK mains hum, plus rumble below 120 Hz that dominates 70–99 % of energy in
   many frames. Constant across phases. This is the analog/VAC path's noise floor, not content.
2. **An intermittent voice-band component.** Speech-band (300–3400 Hz) energy swings from 0.0 % to
   96.3 % between 250 ms blocks, with a pitch that *wanders* over 93–110 Hz rather than locking to
   a harmonic. A hum does not modulate like that; a talking human does. 50–67 % of 50 ms frames are
   voiced, which survives the pitch-detector fix below — so this is real pitched content, not the
   mains floor being misread.

The whole capture is **mono**: L/R correlation +0.994, side channel 25 dB below mid. Music and game
audio are essentially never that correlated; a single mic fanned out to both channels is.

## The one real finding, and its limit

Something **outside GoofCord's process tree** is continuously rendering a mono, voice-band signal
into an EXCLUDE-self capture. By construction that content cannot be our own output. Mono + voice
band + always-on is the exact shape of a transparent virtual audio cable looping the mic back to
the speakers.

That is suggestive, **not proof**. The phase contrast that would have proven it never happened, and
the voice-band component appears in the "play nothing, say nothing" baseline just as strongly as in
the voice phase — so this run cannot separate "the mic reaches the capture" from "the operator was
talking the whole time" or "some other app was playing speech". It does not license the
`CONFIRMED` branch's conclusion.

## Why the metric would have been weak even with a clean run

The harness compares **wideband RMS** against the phase-1 floor. Here the floor is dominated by
50 Hz mains at −40 dBFS, which swamps the thing being measured: speech landing 20 dB down in the
300–3400 Hz band barely moves wideband RMS. The ratio gates (`>4x` confirm, `<3x` inconclusive) are
calibrated for a floor that is actually quiet. On this rig it isn't.

## Changes made for the re-run

`whole-screen-test.mjs` now:

- **refuses phases under 5 s** (`MIN_PHASE`) instead of silently accepting `2`;
- judges on **speech-band (300–3400 Hz) RMS**, high-passed away from the mains floor, and reports
  wideband alongside it;
- reports **L/R correlation and voiced-frame fraction** per phase, so the verdict rests on signal
  shape rather than level alone — a mono voiced source is identifiable even at low level;
- carries a **pitch detector that does not mistake mains hum for a voice**. The first version did:
  a 50 Hz sine never completes a period inside the 70–400 Hz search range, so its slowly-decaying
  autocorrelation lobe pinned the maximum to the range boundary and scored a pure hum as *100 %
  voiced at exactly 400 Hz*. On a rig whose entire noise floor is mains hum that would have tripped
  the new baseline gate on every run. Candidate peaks are now only accepted after the
  autocorrelation has dipped below 0.2. Verified: 110 Hz sawtooth → 100 % voiced @ 110.1 Hz,
  white noise → 0 %, 50 Hz hum → 0 %;
- band-limits with cascaded biquads measured at **−62 dB @ 50 Hz, −0.1 dB @ 1 kHz**;
- **gates on the baseline**: if phase 1 already carries speech-band energy or voiced frames, it says
  the floor is contaminated and to redo, rather than dividing by a bad number;
- writes **per-phase WAVs** plus `whole-screen-run.json` (per-phase stats, chunk timing, addon path,
  pid), so a run can be re-analysed later without the console scrollback.

## Re-run

From WSL, with the addon copied via `cp -L` (bun's symlinked store is unreadable to Windows node):

    powershell.exe -Command "cd 'E:\backup\code\personal\GoofCord\tools\wasapi-echo-test'; & 'C:\Program Files\nodejs\node.exe' whole-screen-test.mjs 8"

Phase 3 must be **loud and obviously audible** — music, not a quiet video. Phase 1 must be genuinely
silent, including no typing near the mic. Phase 2: talk continuously for the full 8 s.
