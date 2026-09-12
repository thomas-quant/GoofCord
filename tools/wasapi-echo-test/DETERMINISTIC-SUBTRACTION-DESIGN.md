# Deterministic screenshare subtraction: design and acceptance gates

Status: research contract, **not a shipping capture mode**. The reliability changes on this branch do not enable subtraction.

## Goal and evidence boundary

User: "think of how we can deterministically subtract audio, as it's the goal."

- **Execution frame:** live whole-screen sharing of one selected render endpoint, preserving other apps while removing GoofCord's playback. No adaptive echo canceller or bundled virtual driver. End-to-end latency and the minimum acceptable suppression remain product thresholds; 60 dB below the isolated own signal is a proposed engineering gate, not an already agreed promise.
- **Condition:** the reference must represent only GoofCord's contribution to that same endpoint, with a known sample mapping and compatible gain/channel/processing domain. A mic/VAC stream that never reaches this endpoint must remain absent.
- **Variable roles:** endpoint PCM is the mix; process-INCLUDE PCM is the candidate own-audio reference; packet indices/timing establish correspondence. None is a directional predictor. A fitted gain or content-derived delay is an experimental estimate, not a Windows API guarantee.

The current recordings substitute VLC for Electron, contain mono-folded data, and were aligned offline. Rechecking the saved HDMI pair reproduced zero numerical residual for about 17 seconds at **lag +1024 frames, gain 1**. This establishes an exact correspondence for those saved mono samples only. It does not establish stereo, arbitrary effects/levels, silent starts, or live device changes. Realtek captures include uncontrolled other content and cannot by themselves certify an isolated own-audio residual.

## The identity we actually need

For endpoint E, let `S_E[n]` be other apps and `G_E[n]` GoofCord's own contribution **at the endpoint capture tap**. Then:

```text
C_E[n] = S_E[n] + G_E[n]
Y[n]   = C_E[n] - G_E[n] = S_E[n]
```

The arithmetic is deterministic. The unresolved part is whether the available reference `R` equals `G_E`, not whether subtraction works.

A global process-INCLUDE reference can instead be `R = G_E + G_F` for a second output F. Blindly subtracting it produces `S_E - G_F`: **new inverted call audio that was absent from the selected endpoint**. Endpoint-session enumeration can detect some such cases but is not atomic packet-level routing metadata and cannot certify a race-free reference.

Likewise, if a shared enhancement is nonlinear, `C_E = H(S_E + G_E)`, then generally `H(S_E + G_E) - H(G_E) != H(S_E)`. No fixed delay/scalar can undo that. Re-rendering through Sonar/VoiceMeeter adds a separate processing path; direct-render results must not be reported as covering it.

## Recommended next implementation: a native paired-capture experiment

1. **Capture two legs under one owner.** Plain loopback of resolved endpoint E, and INCLUDE of the Electron main process tree. Start/stop/error handling belongs to one native paired session. Do not route these two legs independently through JavaScript timers before subtraction.
2. **Preserve packet identity before rechunking.** For every packet record:

   ```text
   pairId, generation, leg, sequence,
   firstFrameIndex, frameCount, sampleRate, channelMask,
   qpc100ns, devicePosition, rawFlags, PCM
   ```

   `firstFrameIndex` counts frames read from the engine, not JS callbacks. Process-loopback DevicePosition is zero in the saved data; Chromium explicitly expects zero for that path. Never use it as the process leg's sample count.
3. **Make loss observable.** A bounded native queue may drop, but sequence/index gaps survive the drop. Never concatenate disjoint blocks and pretend their timestamps are adjacent. On discontinuity, timestamp error, queue loss, or format/route change, end the current generation and invalidate its alignment. Ordinary `SILENT` packets are valid zero samples; absence of packets is not proof of silence.
4. **Establish one sample mapping per generation.** Use packet-start index and packet-start QPC together, not a separately polled last timestamp. For equal rates `f`, matching packet times suggest:

   ```text
   R index j = C index i + (r0 - c0) + (qC - qR) * f / 10^7
   ```

   Here `r0/c0` are the local indices of the particular packets whose QPC values are `qR/qC`. A constant tap latency bias may still exist. The formula is a candidate mapping, **not proof that QPC specifies DSP phase to sub-sample accuracy**. Compare it against independently identifiable stereo test samples over many starts and hold-outs. Do not round to a 480-frame period: the saved HDMI alignment was 1024, not a multiple of 480.
5. **Subtract in the native sample domain.** Keep endpoint-paced indexed rings; pair equal-time ranges regardless of packet/chunk boundaries. Use a fixed mapping and unity gain initially. Buffer until both ranges are available; do not zero-fill a late reference and broadcast uncancelled call audio. Subtract before any limiter/clamp and before the output's single resample/downmix. Only then emit the existing 48 kHz / stereo / f32 transport blocks.
6. **Report incompatibility, do not auto-fit it away.** Non-unity or frequency-dependent path gain, changing fractional offset, or nonlinear residual means the unity-reference contract failed. A diagnostic may estimate the mismatch. The product must not silently become an adaptive canceller.

The current native statistics improvements provide coherent diagnostic snapshots. They are **not** this packet-associated transport; polling loses packet identity. Add a separate versioned diagnostic packet API rather than silently changing the product Buffer callback ABI.

### Silent start and safety state machine

```text
idle -> opening -> aligning -> verified-generation -> invalidated -> reopening
                   |                 |                  |
                   +---- timeout ----+---- error -------+--> audio unavailable
```

If QPC/index mapping is validated to work without source content, silence is ordinary zero data and needs no probe. If that validation fails, there is no justified content-free alignment yet. A one-time broadband marker or correlation of natural own audio can test the candidate mechanism, but adds startup calibration and cannot be described as "no calibration". Do not inject a supposedly inaudible probe without user opt-in: low amplitude/ultrasonic does not guarantee inaudibility or coverage of the processing domain.

While unverified or invalidated, keep video and **mute share audio**, with an explicit reason. Neither plain endpoint capture (call echo) nor global EXCLUDE-self (captures off-device VAC content) preserves this mode's promise. Offer those as explicitly different user choices, never automatic silent scope changes.

Bounded buffering is required, but a fixed holdback is not automatically sufficient: an unannounced routing/effect change can precede its notification. A universally fail-closed guarantee needs the change generation associated with the samples or a controlled render path. State this limitation rather than claiming a notification alone prevents every leak.

## What should certify compatibility?

`C - R` contains the wanted third-party content. A large residual during normal sharing is therefore **not** evidence of failed cancellation. Conversely, a quiet tone residual does not certify broadband equivalence. We cannot generically validate exact cancellation from an arbitrary two-signal mixture alone.

Use a controlled Electron test, not a convenient residual threshold on production content:

- Own signal: independently seeded stereo broadband sequences rendered by Electron's real Audio Service; add real WebRTC playback after the deterministic source test.
- Other signal: separately known stereo content on E, absent from the own tree. Compare output to its own target-domain reference, not to zero.
- Off-device signal: independently identifiable content on F; it must remain absent.
- Freeze alignment/gain on a calibration block; score a disjoint hold-out using **unity gain** separately from fitted diagnostics.
- Measure per-channel broadband RMS/max error and spectra. Do not fold L/R together: opposite-polarity leakage can cancel in mono.
- Log exact format, endpoint IDs, app/endpoint gain and mute state, enhancements, OS/Electron/addon versions, packet metadata and loss counters. Save immutable per-run manifests.
- Repeat silent start/resume, repeated share cycles, sustained playback, default/explicit endpoint changes, Audio Service respawn, volume/ducking changes, 44.1/48 kHz and non-stereo endpoints, enhancements, and GoofCord output moved to F.

Initial support should be only the domain actually verified (for example native 48 kHz stereo with no inter-tap nonlinear processing). No unconditional claim of handling arbitrary Windows output devices follows from the present HDMI recording.

## Implication check: timing precision is load-bearing

For a sine at frequency `f`, subtracting a copy shifted by `delta` samples at sample rate `Fs` leaves an amplitude ratio:

```text
|residual/reference| = 2 * |sin(pi * f * delta / Fs)|
```

At 48 kHz, a 0.01-sample error leaves approximately **-37.7 dB at 10 kHz**, not a 60 dB null. A proposed 60 dB gate requires error below roughly **0.000764 samples at 10 kHz** (0.000382 at 20 kHz). These are deterministic calculations, not statistical confidence intervals. A test reporting "no drift resolved at 0.01 samples" is insufficient for that suppression claim.

By contrast, an actual fixed **integer** sample identity can cancel exactly without estimating fractions. The experiment should prove that identity, rather than demand implausibly precise wall-clock estimation. One ppm of uncompensated rate difference slips about 2.88 frames per minute at 48 kHz: a short stationary-looking run is not a long-duration guarantee.

## If the packet mapping / reference contract fails

The stronger architecture is a render-side reference owned at the same engine tap/sample domain as the captured mix. A pre-decoder or Web Audio reference is not automatically such a tap: Chromium resampling, volume, mixing and endpoint effects can still intervene. Achieving the correct tap may require an Electron/Chromium native audio integration, with considerably more maintenance than this addon. Even a raw render tap does not solve unknown nonlinear post-mix processing.

Do not switch to this larger architecture until the paired-packet experiment answers the cheaper question. Do not conclude it is universally impossible merely because a particular timestamp path fails. The useful result is a precise support boundary and the specific missing API guarantee.

## Corrections to historical conclusions

- The July endpoint-bound EXCLUDE "PROVEN" handoff was superseded by later tests reporting that the filter was ignored; an activation HRESULT is not content-filter proof. Do not restore that path from old implementation briefs.
- "Subtraction is necessarily adaptive AEC" is retracted for matching sample-domain copies. Deterministic subtraction is the current goal, but compatibility remains to be established.
- "Separate clients necessarily drift" and its opposite "same engine guarantees identical samples" are both too broad. Clock relationship and sample-domain identity are separate claims.
- The September HDMI result is retained; its generalization to any content/device/Electron state is not.

## Public references checked

- [Microsoft IAudioCaptureClient::GetBuffer](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudiocaptureclient-getbuffer): packet-start timing, 100 ns QPC units, flags, and buffer lifetime.
- [Microsoft loopback recording](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording): software engine copy vs hardware loopback pin; not a universal identical-tap guarantee.
- [Microsoft IAudioClock::GetPosition](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclock-getposition): correlate position with GetFrequency; stream positions are not directly interchangeable.
- [Chromium WASAPI input implementation](https://chromium.googlesource.com/chromium/src/+/main/media/audio/win/audio_low_latency_input_win.cc): expects process-loopback DevicePosition == 0; handles unreliable timestamps. Its fallback timing is suitable for media delivery, not evidence of sample-exact cancellation.
- [Chromium WASAPI output implementation](https://chromium.googlesource.com/chromium/src/+/main/media/audio/win/audio_low_latency_output_win.cc): render clock/padding and conversion lie below page-level audio references.
