# Approach 5: Windows built-in AEC / DSP offload

Research angle: use Microsoft's echo-cancellation infrastructure instead of
GoofCord's hand-rolled correlation-delay plus NLMS canceller.

## Position

The only Windows built-in component worth spiking for GoofCord's
endpoint-minus-self topology is the Voice Capture DSP exposed as
`CWMAudioAEC` / `CLSID_CWMAudioAEC`, and only in filter/transform mode where
the caller feeds both the capture stream and the reference stream.

The modern communications AEC APO path is not a viable direct solution for our
two loopback streams. It is wired into real capture endpoints and real render
endpoints, not arbitrary memory buffers. It can make a microphone cleaner in a
call; it cannot be asked to compute:

```text
endpoint loopback A - process-loopback reference B
```

without introducing a virtual device or driver-shaped shim.

Recommendation: run one focused native spike against `CWMAudioAEC` filter mode.
If it accepts our two synthetic loopback streams at a tolerable format and does
not wreck non-voice system audio, it could replace the fragile correlation lock
with Microsoft's mature delay/double-talk handling. If it only works in
source/device mode, mono low-rate voice mode, or with aggressive voice
processing that damages system audio, abandon this angle and keep cancellation
in GoofCord or a library such as WebRTC AEC3.

My confidence split:

- `CWMAudioAEC` can be instantiated and driven from Rust/COM: medium-high.
- `CWMAudioAEC` can accept two memory-fed streams in filter mode: medium.
- It preserves 48 kHz stereo screen-share audio well enough for product use:
  low-medium.
- Communications AEC APO can be repurposed for arbitrary loopback A/B streams:
  very low.

## Inputs and baseline

Baseline from RUN2:

- The current topology is proven: endpoint loopback A plus process-loopback
  INCLUDE of GoofCord B can run together, QPC alignment is bounded, and
  cancellation can reach about 30 dB when the delay search locks.
- The failure is lock reliability, not gross capture timing. `delay_locked=true`
  only about 10% of the time, while `alignment_delta_ms` stays stable around a
  few milliseconds.
- The current implementation emits a fixed transport contract:
  48 kHz, stereo, f32, 480 frames per chunk, 3840 bytes per chunk.
- The current Rust addon still has a single-session process-loopback EXCLUDE
  shape. The endpoint-self-cancel design requires a future multi-worker
  session with endpoint capture A, process INCLUDE reference B, and one output
  path.

Input availability note: in `/tmp/gc-spike-9991`, only
`SPIKE-RUN2-FINDINGS.md` was present. I read `ENDPOINT-LOOPBACK-DESIGN.md` and
`native/wasapi-loopback/src/lib.rs` from the main GoofCord workspace copy, and
searched for but did not find `SPIKE-RUN1-FINDINGS.md` by exact name. The RUN1
VAC finding used here is the one summarized in RUN2.

Local `windows` crate hints from quick greps:

- `CWMAudioAEC` is exposed in
  `Windows::Win32::Media::MediaFoundation` with GUID
  `745057c7-f353-4f2d-a7ee-58434477730e`.
- `AEC_CAPTURE_STREAM` and `AEC_REFERENCE_STREAM` are exposed in Media
  Foundation.
- `IMediaObject`, `IMediaBuffer`, `DMO_MEDIA_TYPE`, and
  `DMO_OUTPUT_DATA_BUFFER` are exposed under `Win32_Media_DxMediaObjects`.
- `IMFTransform`, `MFTEnumEx`, `MFT_CATEGORY_AUDIO_EFFECT`,
  `MFCreateSample`, and `MFCreateMemoryBuffer` are exposed under Media
  Foundation.
- `AudioCategory_Communications`,
  `IAcousticEchoCancellationControl`, `IApoAcousticEchoCancellation`, and
  `AUDIO_SIGNALPROCESSINGMODE_COMMUNICATIONS` are exposed, but that does not
  mean they are usable for arbitrary PCM buffers.
- The WMAAECMA property-key constants did not appear in the quick grep, so a
  Rust spike may need to define several `MFPKEY_WMAAECMA_*` GUID/property keys
  manually from the Windows SDK headers.

No network lookup, builds, git commands, or deep registry reading were used.

## The desired signal mapping

GoofCord's target is not traditional mic echo cancellation:

```text
traditional AEC:
  capture input   = microphone: local speech + speaker echo
  reference input = render stream sent to speakers
  output          = microphone with speaker echo removed

GoofCord endpoint-minus-self:
  capture input   = endpoint loopback A: all audio on selected render endpoint
  reference input = process-loopback B: GoofCord's own rendered audio
  output          = endpoint mix with GoofCord's contribution removed
```

This is still mathematically close to acoustic echo cancellation:

- A contains near-end content we want to preserve: game audio, browser audio,
  music, other system sounds on the selected endpoint.
- A also contains an echo-like component we want to remove: GoofCord voice
  playback after session volume, endpoint mixing, APOs, and buffering.
- B is the far-end reference for that component.

The unusual part is that both A and B are digital loopbacks, not a physical mic
and an application-owned render callback. That helps because the echo path is
mostly linear and stable. It hurts because Windows' built-in AEC APIs are
productized around microphones, capture endpoints, and communications devices.

## Candidate 1: Voice Capture DSP (`CWMAudioAEC`)

### Verdict

Spike-worthy. This is the only built-in path with a plausible direct mapping to
our two streams.

### Why this component is plausible

The Voice Capture DSP is the old Microsoft AEC / microphone-array / voice
capture component. It is historically exposed as a DMO through
`IMediaObject`, and `windows` 0.62.2 also exposes the `CWMAudioAEC` GUID and
the AEC stream identifiers from Media Foundation:

```text
AEC_CAPTURE_STREAM   = near/capture input
AEC_REFERENCE_STREAM = far/render reference input
```

Those names are exactly what we need if the DSP can run in filter mode:

```text
GoofCord endpoint A -> AEC_CAPTURE_STREAM
GoofCord self B     -> AEC_REFERENCE_STREAM
DSP output          -> GoofCord's existing JS transport
```

This path is conceptually different from the DMO's source mode. Source mode
lets the DSP open the microphone and render device itself. That mode is a dead
end for us. Filter mode is the interesting mode because GoofCord would own both
WASAPI captures and feed the DSP samples.

### Proposed mapping

Keep the existing future dual-capture design:

1. Capture A: endpoint loopback of the selected/default render endpoint.
2. Capture B: process-loopback INCLUDE of GoofCord's process tree.
3. Timestamp and QPC-align both streams as RUN2 already does.
4. Feed both streams to `CWMAudioAEC` rather than to the hand-rolled
   correlation-delay plus NLMS canceller.
5. Convert the DSP output back to the existing 48 kHz/stereo/f32/3840-byte
   transport contract.

For a Media Foundation style transform, the worker would look roughly like:

```text
CoInitializeEx(MTA)
MFStartup(...)
CoCreateInstance(CWMAudioAEC) -> IMFTransform
set source/filter mode properties
set AEC mode to SINGLE_CHANNEL_AEC
set input type 0 = capture format
set input type 1 = reference format
set output type  = processed capture format

for each aligned 10 ms frame:
  ProcessInput(AEC_REFERENCE_STREAM, reference sample B)
  ProcessInput(AEC_CAPTURE_STREAM, capture sample A)
  ProcessOutput(...) -> cancelled sample
  convert/remap to 48k/stereo/f32 chunk
```

For a DMO style transform, the same logical flow applies through
`IMediaObject::ProcessInput` and `IMediaObject::ProcessOutput`, but the Rust
plumbing is less pleasant because GoofCord must provide `IMediaBuffer`
implementations or wrappers.

### Required properties and modes

The spike should force the component out of device/source mode. The exact
property names may need manual definitions in Rust, but the intent is:

- `MFPKEY_WMAAECMA_DMO_SOURCE_MODE = FALSE`
  - Required. If this cannot be set, the component wants to open real devices
    and is not usable for our arbitrary loopbacks.
- `MFPKEY_WMAAECMA_SYSTEM_MODE = SINGLE_CHANNEL_AEC`
  - Prefer the least invasive AEC-only mode. Avoid microphone-array modes and
    avoid modes that intentionally add noise suppression or AGC if the API
    offers a choice.
- `MF_LOW_LATENCY = TRUE` on the transform attributes if accepted.
- Use explicit timestamps/durations on samples, based on the aligned 10 ms
  GoofCord timeline.

One key probe is whether `CWMAudioAEC` exposes `IMFTransform` directly on the
target OS. If not, use the DMO interface. The DMO is older and likely more
canonical for this component, but MFT samples/buffers are easier to drive from
Rust because Media Foundation exposes helpers such as `MFCreateSample` and
`MFCreateMemoryBuffer`.

### Format strategy

The current GoofCord transport is 48 kHz/stereo/f32. The Voice Capture DSP is a
voice component, so assume it may not accept that natively.

Spike order:

1. Try 48 kHz, mono, 16-bit PCM on A and B.
2. Try 32 kHz or 16 kHz, mono, 16-bit PCM if 48 kHz is rejected.
3. Only try f32 if enumeration says it is supported. Do not assume it.
4. Test whether stereo media types are accepted. Expect mono.

If only mono is supported, there are three possible product mappings:

- Mono duplicate:
  - Downmix A and B to mono, run one AEC, duplicate output to L/R.
  - Lowest integration cost.
  - Probably unacceptable for screen-share/system-audio fidelity.
- Two mono AEC instances:
  - Run one DSP instance for left and one for right.
  - Preserve stereo shape better.
  - Does not model cross-channel echo paths. If GoofCord voice is centered this
    may still work well enough.
- Hybrid residual canceller:
  - Use `CWMAudioAEC` on a mono monitor path only to estimate/refine delay or
    convergence, while a GoofCord DSP handles the final stereo cancellation.
  - This is more complex and probably not worth it unless the pure built-in
    path almost works.

My recommendation for the spike is two mono instances after proving one mono
instance works. Mono duplicate is acceptable only for a fast feasibility check.

### Delay and double-talk behavior

This is the main reason to try `CWMAudioAEC`.

The RUN2 failure mode is a delay-estimation and lock problem. Microsoft's AEC
stack should have mature logic for:

- render/capture delay tracking;
- reference buffering;
- adaptation gating when the reference is silent;
- double-talk handling, where unrelated near-end content exists while the
  reference is active;
- divergence prevention.

For GoofCord, "double-talk" means "other system audio is present while GoofCord
voice playback is also present". That maps well enough to AEC theory even
though the near-end signal is not a person speaking into a mic.

However, the DSP will not forgive a completely wrong timeline. GoofCord should
still do the RUN2 QPC alignment and feed monotonically timestamped 10 ms frames.
Do not rely on the DSP to absorb seconds of queue drift or unordered samples.
The built-in AEC should own the residual render-to-endpoint delay that the
current correlation search fails to find reliably.

### Fidelity risks

This is the largest risk.

Voice Capture DSPs are optimized for communications capture, not screen-share
audio fidelity. Even in an AEC-only mode, the component may:

- downmix to mono;
- force 16-bit PCM;
- high-pass or otherwise voice-shape the signal;
- apply noise suppression, AGC, VAD, residual echo suppression, or comfort
  noise with limited ability to disable it;
- suppress music/game audio as "noise" because our "near-end" stream is not a
  microphone speech stream;
- clip or pump when endpoint A contains high-energy non-speech content.

This means a successful "it cancels GoofCord voice" result is not enough. The
on-box check must include music/game/browser audio in A with B silent and with
B active. If the output sounds like a communications microphone instead of
system audio, this component is not product-usable even if ERLE is good.

### Latency estimate

The existing transport emits one 10 ms chunk. `CWMAudioAEC` likely wants
10 ms-ish frames, but exact internal buffering is opaque.

Budget expectations:

- Best case: one to three 10 ms frames of algorithmic buffering after our A/B
  alignment buffer.
- Acceptable for default mode: added latency under 70 ms over the current
  native transport.
- Hard fail for product default: sustained added latency above 100 ms, or
  variable latency that causes the MSTG feeder to stutter.

The spike must log input frame timestamp, output sample timestamp/duration if
available, queue depths, and wall-clock process time per frame.

### Rust/COM integration

This is feasible but not small.

Feature gates likely needed beyond the current addon:

- `Win32_Media_MediaFoundation`
- `Win32_Media_DxMediaObjects`
- `Win32_System_Com`
- possibly `Win32_Media_KernelStreaming` for mode constants

Implementation shape for a future spike:

- Keep COM objects on one DSP worker thread. Do not pass `IMFTransform` or
  `IMediaObject` across arbitrary Rust threads.
- Let capture workers push timestamped A/B chunks into bounded Rust queues.
- Let the DSP worker perform alignment, format conversion, DSP calls, and final
  f32 chunk emission.
- Preserve the single JS callback path. JS should never receive raw A and B.
- Add hard fail-closed behavior: if the DSP returns persistent errors, stops
  producing output, or reports stream changes we cannot handle, emit silence or
  stop native audio rather than leaking uncancelled endpoint audio.

The DMO path may require implementing an `IMediaBuffer` wrapper. That is more
COM boilerplate than algorithm work. The MFT path is cleaner if available:

- allocate `IMFSample`;
- allocate `IMFMediaBuffer`;
- copy input PCM bytes into the buffer;
- set sample time and duration;
- call `ProcessInput`;
- collect `MFT_OUTPUT_DATA_BUFFER` from `ProcessOutput`;
- lock output buffer and convert bytes back to f32.

### Availability

`CWMAudioAEC` predates the process-loopback API, so the component itself is not
the likely OS floor. GoofCord's floor is still the process-loopback reference B
path. The current addon already dynamically probes `ActivateAudioInterfaceAsync`
instead of relying on a hard version check; keep that pattern.

Practical availability policy:

- On Win10 2004+ / ApplicationLoopback-supported builds, dynamically probe both
  process-loopback and `CWMAudioAEC`.
- Treat `CWMAudioAEC` as optional. If activation or filter-mode setup fails,
  return "not supported" for this backend.
- Do not silently fall back from endpoint-self-cancel to plain endpoint loopback
  or Chromium loopback, because that leaks self audio.
- On Windows N/KN or systems with damaged Media Foundation components, expect
  `CWMAudioAEC` or MF startup to fail.

## Candidate 2: Communications AEC APO / audio category

### Verdict

Dead end for direct endpoint-minus-self.

### What it is good at

Windows can apply communications-oriented processing to microphone capture
streams. The local `windows` crate exposes relevant surface area:

- `AudioCategory_Communications`
- `AUDIO_SIGNALPROCESSINGMODE_COMMUNICATIONS`
- `IAcousticEchoCancellationControl::SetEchoCancellationRenderEndpoint`
- `IApoAcousticEchoCancellation`

This is the path an app would use when it wants a real microphone stream with
system AEC against a real render endpoint. It is useful for GoofCord's own
microphone capture path, not for screen-share system audio cancellation.

### Why it does not map to our streams

The APO sits in the Windows audio endpoint graph. It is not a general-purpose
two-input PCM function. Its model is:

```text
capture endpoint = actual microphone/audio input endpoint
render endpoint  = actual output endpoint used as AEC reference
output           = processed microphone stream
```

GoofCord needs:

```text
capture memory stream   = endpoint loopback A
reference memory stream = process-loopback B
output memory stream    = cancelled endpoint audio
```

There is no API in this path that says "here are two memory buffers; run the
system AEC on them". `SetEchoCancellationRenderEndpoint` takes an endpoint id,
not a PCM stream. The APO chooses the reference from the render endpoint graph.

### Creative attempts and why they fail

Attempt: open endpoint loopback A as a communications capture stream.

- Loopback capture from a render endpoint is not a microphone capture endpoint.
- The capture APO chain that owns AEC is not expected to attach to render
  loopback clients.
- Even if a call succeeds, the reference endpoint would be the full render
  endpoint, which means the system could try to cancel all endpoint audio from
  A, not just GoofCord's process-loopback B.

Attempt: tell the APO to use the selected render endpoint as reference.

- That reference is A's source endpoint, not B.
- It cannot isolate GoofCord's contribution, so it is the wrong reference.

Attempt: render B to a dummy endpoint and pass that endpoint id as the AEC
reference.

- A real physical endpoint would make B audible or interfere with user audio.
- A silent/null endpoint requires a virtual audio driver or virtual cable.
- That reintroduces the driver/VAC class of solution the endpoint-loopback
  design is trying to avoid.
- The capture side still wants a capture endpoint, not our endpoint loopback A
  memory stream.

Attempt: create a virtual microphone fed by A and a virtual render endpoint fed
by B, then let Windows AEC process that virtual microphone.

- Technically conceivable.
- It is a driver/device product, not a GoofCord native addon spike.
- It adds install/admin/signing/device-routing risk and breaks the clean
  "no virtual cable required" direction.

Conclusion: do not spend spike time here unless a separate goal appears for
enhancing real microphone capture.

## Candidate 3: Media Foundation audio-effect MFT enumeration

### Verdict

Useful as discovery and fallback plumbing, but probably the same `CWMAudioAEC`
answer.

The local crate exposes `MFT_CATEGORY_AUDIO_EFFECT` and `MFTEnumEx`. A spike can
enumerate audio-effect MFTs and look for `CWMAudioAEC` or a newer Microsoft AEC
transform. This is worth doing because Windows installations can differ.

But do not assume a newer magic MFT exists that accepts arbitrary A/B f32 stereo
buffers. Most Windows audio effects are endpoint/APO components, hardware/driver
bound, or intended for Media Foundation topologies rather than standalone
low-latency DSP use.

Recommended use:

- First try direct `CoCreateInstance(CWMAudioAEC)`.
- Also enumerate `MFT_CATEGORY_AUDIO_EFFECT` and log any Microsoft AEC-looking
  transforms by friendly name/CLSID.
- If a transform exposes two audio input streams and one output stream, run the
  same synthetic A/B probe.
- Do not make product behavior depend on a transform found only on one test
  machine until CI/on-box coverage proves it exists broadly.

## Candidate 4: DirectSound capture FX AEC

### Verdict

Dead end.

The local Windows bindings expose legacy DirectSound AEC constants and
`IDirectSoundCaptureFXAec`. That path is tied to DirectSound capture buffers and
capture devices. Like the communications APO path, it is designed for microphone
capture, not arbitrary endpoint loopback memory streams. It also adds legacy API
surface without solving our reference problem.

Do not spike this for endpoint-minus-self.

## Feasibility summary

| Component | Direct A/B memory-stream mapping | Likely fidelity | Integration cost | Recommendation |
| --- | --- | --- | --- | --- |
| Voice Capture DSP `CWMAudioAEC` filter mode | Plausible | Risky, likely mono/S16/voice-tuned | Medium-high | Spike first |
| Voice Capture DSP source mode | No | Mic-output only | Medium | Dead end |
| Communications AEC APO | No | Good for mic, wrong output | High if forced | Do not pursue |
| Media Foundation audio-effect enumeration | Maybe discovers same component | Unknown | Medium | Use only as probe |
| DirectSound AEC | No | Mic-output only | Medium | Do not pursue |

## Pros vs the DIY NLMS path

Potential advantages if `CWMAudioAEC` filter mode works:

- Mature adaptive delay handling, likely the exact area where RUN2 fails.
- Built-in double-talk/adaptation gating rather than hand-tuned correlation
  thresholds.
- Reduced chance of NLMS divergence when B is silent or intermittent.
- No need to design partitioned-block NLMS, residual echo suppression, or
  sophisticated hangover logic ourselves.
- May converge faster after device changes or GoofCord playback restarts.

Costs and risks:

- Opaque behavior. If it distorts, suppresses, or pumps system audio, there may
  be no knob to fix it.
- Format mismatch. It may force mono, S16, or low sample rates.
- Harder deterministic debugging. We cannot inspect filter coefficients or
  delay estimates unless the component exposes metrics.
- COM/MF/DMO boilerplate and manual property keys add implementation risk.
- Availability and behavior may vary by Windows edition and installed media
  components.
- It remains a microphone/voice algorithm being repurposed for endpoint mix
  subtraction.

Most important comparison: the DIY path has proven 30 dB cancellation when
locked, and its output fidelity can stay exactly 48 kHz/stereo/f32. The Windows
AEC path may solve locking and double-talk but may lose fidelity. That is the
tradeoff the spike must resolve.

## Proposed spike design

This is a design/proposal only, not implementation.

### Phase A: component probe

Write a small Rust-only probe inside the native addon crate or a scratch binary
on a future branch:

1. `CoInitializeEx(COINIT_MULTITHREADED)`.
2. `MFStartup` if using MFT APIs.
3. `CoCreateInstance(CWMAudioAEC, CLSCTX_INPROC_SERVER)`.
4. Try `cast::<IMFTransform>()`.
5. Try `cast::<IMediaObject>()`.
6. Log supported input stream count, output stream count, media types, and
   whether filter/source mode properties can be set.

Pass/fail gates:

- Pass if the component can be put in non-source/filter mode with two inputs.
- Fail if it insists on opening real devices.
- Fail if it only exposes a source-like output and no reference input.

### Phase B: synthetic offline A/B test

Before wiring live WASAPI, feed generated PCM:

- A = clean music/test tone/noise + delayed/filtered B.
- B = speech-like sample or chirp.
- Output should preserve the clean component while reducing B.

This isolates the component from WASAPI timing. It answers:

- Does the DSP remove the reference at all?
- What frame size does it need?
- Does it require reference samples before capture samples?
- Does it produce output continuously?
- How much latency does it add?
- Does it mangle non-speech A?

Metrics:

- ERLE/reduction for the injected B component.
- Residual correlation with B.
- RMS change of the clean near-end component when B is silent.
- Output delay in frames.
- Error/stream-change events.

### Phase C: live GoofCord topology

Only after Phase B passes:

```text
endpoint loopback A       -> format converter -> AEC capture input
process INCLUDE self B    -> format converter -> AEC reference input
AEC output                -> format converter -> 48k/stereo/f32 chunks
existing JS transport     -> MSTG feeder
```

Keep the RUN2 QPC timestamp queues. Replace only the cancellation worker. Do
not change endpoint/process capture activation in the same experiment unless
required.

Start with diagnostic strictness:

- emit silence during warmup;
- fail closed if B stalls;
- fail closed if the DSP stops outputting;
- log enough to distinguish "B silent" from "AEC failed".

Required new logs:

- `endpoint_rms_db`
- `reference_rms_db`
- `output_rms_db`
- `estimated_or_measured_added_latency_ms`
- `aec_backend = cwmaudioaec_mft | cwmaudioaec_dmo`
- `aec_format = rate/channels/sample_type`
- `frames_in_a`, `frames_in_b`, `frames_out`
- `queue_depth_a`, `queue_depth_b`
- `output_underflows`, `dsp_errors`, `stream_changes`
- optional quality metrics if the component exposes them

### Phase D: stereo decision

If one mono instance works:

1. Try two mono instances, L and R separately.
2. Compare against mono duplicate.
3. Test centered GoofCord voice, left-biased voice, right-biased voice, and
   endpoint spatial enhancements if available.
4. Choose two-instance stereo only if it preserves non-GoofCord audio and gives
   meaningful self cancellation on both channels.

If two-instance stereo leaves too much residual due to cross-channel processing,
do not add a complex hybrid. At that point WebRTC AEC3 or a better GoofCord DSP
is probably a cleaner path.

## CI and on-box verification

CI can prove buildability and basic COM shape; it cannot prove audio quality.

CI checks for a future implementation:

- Windows build with added `windows` feature gates.
- Unit test or smoke test that creates the DSP object if available and logs
  whether `IMFTransform` and/or `IMediaObject` are supported.
- Synthetic offline A/B test that does not require real audio devices. Mark it
  skipped if the component is absent rather than failing all CI on images that
  lack the media component.
- No network or registry dependency beyond normal build inputs.

On-box verification is mandatory:

1. Confirm endpoint A plus process INCLUDE B still run concurrently without
   CoreMessaging crashes.
2. Verify the selected/default endpoint excludes VAC/VoiceMeeter endpoints as
   RUN1/RUN2 require.
3. Play GoofCord/Discord voice only:
   - B has strong RMS;
   - A contains that voice;
   - output reduces it consistently, not just in short windows.
4. Play non-GoofCord system audio only:
   - B is silent/low;
   - output should be nearly identical to A;
   - no AGC pumping, voice-band filtering, mono collapse unless explicitly
     accepted.
5. Play both:
   - output preserves system audio while removing GoofCord voice.
6. Repeat start/stop and second-share tests.
7. Test endpoint enhancements on/off if the machine exposes them.
8. Test default endpoint changes and GoofCord playback-device changes.
9. Record A/B/out WAV snapshots for offline listening and metrics.

Success bar:

- cancellation active whenever `reference_rms_db` shows real GoofCord audio,
  not only 10% of heartbeats;
- no negative-divergence windows like RUN2's occasional "made it worse" cases;
- self voice reduction comparable to the good RUN2 lock windows, ideally
  10-30 dB depending on content;
- non-GoofCord audio remains screen-share quality;
- added latency below 70 ms over current native path;
- output contract remains 3840-byte 48 kHz/stereo/f32 chunks.

## Dead-end criteria

Stop pursuing Windows built-in AEC if any of these are true:

- `CWMAudioAEC` cannot be driven in filter mode with caller-provided capture and
  reference streams.
- It requires actual microphone/render endpoint device indexes.
- It rejects all acceptable formats and only supports low-rate mono voice that
  is unacceptable for screen-share audio.
- It applies unavoidable AGC/noise suppression/voice shaping that audibly
  damages non-GoofCord system audio.
- It cannot process 10 ms-ish frames without high or unstable latency.
- Its behavior differs materially across the Windows machines we care about.
- A virtual device is required to feed B as a render reference.

If those happen, the result is still useful: it tells the team that Windows'
built-in AEC is not a general-purpose DSP primitive for endpoint-minus-process
subtraction. Then effort should return to a deterministic GoofCord-owned DSP or
a portable AEC library.

## Final recommendation

Run exactly one built-in-AEC spike, centered on `CWMAudioAEC` filter mode.

Do not chase the communications AEC APO for this problem. It cannot consume our
two loopback streams. Do not build a virtual endpoint workaround unless the
product direction changes to allow driver/device installation.

The spike should answer four questions in order:

1. Can `CWMAudioAEC` be put in non-source/filter mode?
2. Can A map to `AEC_CAPTURE_STREAM` and B map to `AEC_REFERENCE_STREAM`?
3. Can it run at a format/latency compatible with 48 kHz stereo output?
4. Does it cancel GoofCord self audio without damaging unrelated system audio?

If the answer to all four is yes, it is the strongest answer to RUN2's 10%
lock problem because Windows would own delay tracking and double-talk handling.
If any answer is no, call this angle a dead end and spend the next iteration on
WebRTC AEC3 or a simpler deterministic delay-plus-adaptive-filter design with
better observability.
