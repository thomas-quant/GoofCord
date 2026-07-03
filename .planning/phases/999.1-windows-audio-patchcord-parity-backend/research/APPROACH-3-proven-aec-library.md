# Approach 3: Replace DIY NLMS with a proven AEC library

Date: 2026-07-03

Role: researcher 3 / proven AEC library path.

Scope: design/proposal only. No implementation, build, git, or network work was
performed. The `/tmp/gc-spike-9991` snapshot contained `SPIKE-RUN2-FINDINGS.md`
but not `SPIKE-RUN1-FINDINGS.md`, `ENDPOINT-LOOPBACK-DESIGN.md`, or
`native/wasapi-loopback/src/lib.rs`; the endpoint design and checked-in addon
skeleton were read from the matching GoofCord workspace paths. RUN2 remains the
baseline for the failure mode.

## Executive recommendation

Use **WebRTC AudioProcessing AEC3** as the primary replacement for the
hand-rolled block-NLMS plus correlation delay search.

Fallback: **vendored SpeexDSP echo canceller** if AEC3 cannot be made to build
reproducibly inside the addon prebuild CI quickly.

Do not spend more spike time tuning the current DIY correlation/NLMS path. RUN2
already proves the signal topology works when the adaptive system locks: about
30 dB cancellation is reachable. The product problem is lock reliability,
double-talk behavior, and divergence control. Those are exactly the parts that
real AEC implementations have spent years hardening.

My opinionated path:

1. Put AEC3 behind a tiny Rust `AecEngine` abstraction in the native addon.
2. Keep the proven two-capture topology: endpoint loopback A plus GoofCord
   process-loopback INCLUDE reference B.
3. Use QPC timestamp alignment only as a bounded jitter/ordering layer.
4. Delete the correlation delay-lock gate and DIY NLMS adaptation from the
   shipping path.
5. Feed paired 10 ms frames to AEC3 and let AEC3 handle echo-path delay,
   adaptation gating, double-talk, residual echo, and reset behavior.

## What must not regress

From RUN2 and the endpoint design:

- Native endpoint loopback and native process loopback can run together without
  the CoreMessaging crash seen with Chromium loopback plus native capture.
- Never run Chromium `"loopback"` at the same time as any native WASAPI capture.
- Output to JS must remain exactly **48 kHz / stereo / f32 / 480 frames**:
  **3840 bytes per chunk**, about one chunk every 10 ms.
- The default Windows path is strict endpoint self-cancel. If A or B fails,
  fail closed to silence/no native audio rather than silently leaking plain
  endpoint audio or falling back to Chromium loopback.
- Endpoint selection must stay endpoint-scoped. Do not reintroduce broad
  all-endpoint capture that hears VAC/VoiceMeeter unless that endpoint is
  explicitly selected.
- Process-loopback INCLUDE/EXCLUDE keeps the effective **Windows 10 2004+**
  runtime floor. The addon should still load on older Windows builds and report
  unsupported when process loopback activation is absent.

## Option evaluation

### Option A: WebRTC AudioProcessing AEC3

Recommendation: **primary**.

What it is:

- WebRTC's modern acoustic echo canceller in the AudioProcessing module.
- API shape matches our topology: feed render/reverse stream B, then process
  capture/near stream A, in fixed 10 ms frames.
- Battle-tested in browsers and real-time communications stacks.

Delay handling:

- AEC3 has internal render-delay buffering, delay estimation, adaptation state,
  reset logic, and residual echo handling.
- We should still pre-align A and B by QPC enough to keep both streams in the
  same broad time neighborhood, but AEC3 should replace the flaky
  correlation-lock search.
- The current `delay_locked` boolean should become library state/metrics, not a
  hard gate that decides whether cancellation is allowed.

Double-talk and divergence:

- Strongest option here. AEC3 is designed for near-end speech while render echo
  is present. In GoofCord terms, "near-end" means desktop/game/system audio
  that must survive while GoofCord voice playback is removed.
- Its adaptation gating and nonlinear/residual echo suppression are the main
  reason to choose it over Speex or another local NLMS variant.
- Disable unrelated APM features: no AGC, no noise suppression, no high-pass
  filtering, no voice-specific gain features. We want echo cancellation only,
  because arbitrary desktop audio is not microphone speech.

Rust/Windows integration:

- Prefer a **small C ABI shim** compiled into the `wasapi-loopback` `.node`,
  rather than exposing C++ templates/classes to Rust.
- Rust calls functions such as:
  - `gc_aec_create(sample_rate, channels)`
  - `gc_aec_reset(reason)`
  - `gc_aec_process(render_interleaved_f32, capture_interleaved_f32, out_interleaved_f32)`
  - `gc_aec_get_stats(...)`
  - `gc_aec_destroy(...)`
- Internally, the shim deinterleaves/interleaves as needed and calls WebRTC APM:
  process B as the reverse/render stream, then process A as the capture stream.
- First CI proof should try a stereo APM configuration. If the wrapper exposes
  only mono-cleanly or stereo behavior colors content, run two independent mono
  AEC3 instances, one per channel. Cross-channel endpoint matrixing can be a
  second pass.

Build feasibility:

- Harder than SpeexDSP. This is the major risk.
- Do **not** depend on a system-installed WebRTC library or DLL.
- Do **not** pull Chromium or full WebRTC with GN/depot_tools as part of
  GoofCord's app build.
- Put the complexity in the addon prebuild repo only. GoofCord already consumes
  `wasapi-loopback` as a committed/prebuilt optional dependency; its
  `bun run build` should remain unchanged.
- Viable build paths, in preferred order:
  1. Use a Rust `webrtc-audio-processing` wrapper only if a Windows/MSVC bundled
     build is proven in the addon CI.
  2. Vendor a known standalone WebRTC APM/AEC3 source snapshot plus a thin C
     shim and compile it statically from `build.rs`.
  3. Use CMake from `windows-latest` if the source tree already has a reliable
     CMake build; otherwise use the `cc` crate with explicit source lists.
- The first AEC3 task should be a **CI build spike**, not API polishing. If
  `bun x napi build --release --target x86_64-pc-windows-msvc` cannot produce
  one static `.node` without extra runner setup, switch to SpeexDSP.

Latency/CPU:

- AEC3 is designed for real-time 10 ms processing.
- Target: process one 480-frame stereo chunk in under 2 ms on the Windows test
  box, and keep the canceller worker below 5% of one modern desktop core.
- Added latency should come only from the A/B alignment buffer plus one output
  frame. Target 20-50 ms added latency; hard cap 70 ms unless on-box testing
  proves the endpoint path needs more.

Licensing:

- WebRTC is BSD-style, but vendoring APM source brings third-party notices.
- The addon repo must update `NOTICE` and include all retained WebRTC/third-party
  license text in the package. Avoid GPL/LGPL transitive code.

Main landmines:

- APM is voice-oriented. If AEC3 residual suppression audibly damages game/music
  audio, disable every non-AEC module and test AEC3's lowest-suppression mode.
- Stereo preservation is non-negotiable. If one stereo APM instance downmixes or
  suppresses oddly, run two mono instances initially and document that
  cross-channel endpoint APOs may leave residual echo.
- Direct WebRTC source builds can become a dependency swamp. Time-box the CI
  proof.

### Option B: SpeexDSP echo canceller

Recommendation: **fallback**.

What it is:

- Mature C echo canceller, historically based on MDF/frequency-domain adaptive
  filtering.
- Simple C ABI and small source footprint.

Delay handling:

- Speex does **not** solve our delay problem as completely as AEC3.
- It does not provide AEC3-style robust delay estimation for an arbitrary
  endpoint/render path.
- The practical fallback design is to keep QPC alignment, add a conservative
  fixed reference delay/buffer, and give Speex a long enough tail to cover the
  stable WASAPI engine delay. This avoids the current correlation lock search,
  but it is not truly delay-agnostic.
- Speex's asynchronous playback/capture API introduces internal buffering
  around the playback reference; budget that explicitly.

Double-talk and divergence:

- Better than our local NLMS because it is a mature echo canceller with
  frequency-domain adaptation and residual echo support.
- Weaker than AEC3 for double-talk and nonlinear residual suppression.
- Optional Speex preprocessor echo suppression may help residual GoofCord voice,
  but it can also affect non-voice desktop audio. Treat it as a measured option,
  not default magic.

Rust/Windows integration:

- Easiest native path:
  - vendor SpeexDSP C sources into the addon repo;
  - compile them statically from `build.rs` with the `cc` crate;
  - expose a tiny Rust FFI wrapper around `SpeexEchoState`.
- Speex public echo APIs are commonly `spx_int16_t` oriented. If the chosen path
  uses int16, convert f32 to int16 inside Rust/C and convert output back to f32
  before the JS boundary. The external 3840-byte f32 contract must not change.
- If a float API is available in the vendored version, prefer it, but do not
  block the fallback on that.

Build feasibility:

- High. C sources plus `cc` should work under MSVC in `bun x napi build` without
  external system dependencies.
- Much smaller binary/build-time risk than WebRTC.

Latency/CPU:

- Should fit the 10 ms cadence with a 100-200 ms tail on one modern CPU core.
- Async API buffering plus our alignment buffer likely adds about 20-50 ms.
- CPU should be profiled, but this is much less risky than a naive time-domain
  50-140 ms stereo NLMS.

Licensing:

- SpeexDSP uses a permissive Xiph/BSD-style license. Include the license in the
  addon package and `NOTICE`.

Main landmines:

- Delay is still the weak point. Speex is a good fallback because it is robust
  and buildable, not because it fully removes the delay-estimation problem.
- Int16 conversion can clip or quantize if not scaled conservatively.
- Residual echo suppression may be voice-tuned and can damage music/game audio.

### Option C: local partitioned-block frequency-domain adaptive filter

Recommendation: **not primary; emergency fallback only**.

What it is:

- Replace time-domain block NLMS with a partitioned-block frequency-domain
  adaptive filter using a long tail, overlap-save, leakage, adaptation freeze,
  and divergence reset logic.
- Could use pure-Rust crates such as an FFT crate, but the AEC behavior remains
  our responsibility.

Delay handling:

- A long partitioned filter can absorb a fixed echo-path delay inside its tail,
  which reduces dependence on explicit correlation search.
- It still needs robust reference activity detection, double-talk detection,
  step-size control, and reset heuristics.

Double-talk and divergence:

- Only as good as we implement. This is too close to the current failure mode.
- It may be appropriate later if AEC3 damages non-voice audio and Speex cannot
  handle stereo/latency, but it should not be the next default path.

Rust/Windows integration:

- Best build story: pure Rust, no C/C++ toolchain beyond the current addon.
- Worst algorithm risk: we would still be designing an AEC, just in the
  frequency domain.

Licensing:

- Depends on selected Rust crates; prefer MIT/Apache-2.0.

Main landmine:

- It is "DIY, but fancier." RUN2 says DIY adaptation is the weak link. Avoid
  repeating that unless library integration fails.

## Proposed addon architecture

Introduce an internal engine boundary:

```rust
trait AecEngine {
    fn reset(&mut self, reason: AecResetReason);
    fn process_10ms(
        &mut self,
        render_ref_b: &[f32], // 480 * 2 interleaved
        endpoint_a: &[f32],   // 480 * 2 interleaved
        out: &mut [f32],      // 480 * 2 interleaved
    ) -> AecStats;
}
```

Primary implementation: `WebRtcAec3Engine`.

Fallback implementation: `SpeexDspEchoEngine`.

Keep the rest of the native pipeline library-independent:

- Capture worker A: endpoint loopback of selected/default render endpoint.
- Capture worker B: process-loopback INCLUDE of GoofCord's process tree.
- Canceller worker:
  - receives timestamped 480-frame chunks from A and B;
  - uses QPC timestamps/ring depth to pair streams within a bounded window;
  - feeds paired 10 ms frames to `AecEngine`;
  - emits exactly one 3840-byte f32 chunk per output frame to the existing JS
    `ThreadsafeFunction`.

The canceller worker should emit silence during warmup and reset windows rather
than leaking uncancelled endpoint audio in the strict default mode.

## Concrete `lib.rs` change-set

Design-level changes against the RUN2 architecture and checked-in addon shape:

1. Replace the current DIY `BlockNlms`/delay-search path with `AecEngine`.
2. Preserve the dual-capture topology proven in RUN2:
   - endpoint capture A;
   - GoofCord process INCLUDE capture B;
   - one cancelled output stream.
3. Keep QPC alignment queues, but narrow their job:
   - order chunks;
   - bound jitter;
   - drop stale chunks;
   - provide a coarse initial render/capture neighborhood.
4. Remove the correlation-derived `delay_locked` gate from the output path.
   Log AEC library metrics instead.
5. Add reference observability that RUN2 explicitly lacked:
   - `reference_rms_db`;
   - `endpoint_rms_db`;
   - `output_rms_db`;
   - `erle_db` or `reduction_db`;
   - `aec_processing_ms`;
   - `aec_reset_count`;
   - `aec_state`;
   - A/B ring depths and drop counters.
6. Reset the AEC engine on:
   - endpoint change;
   - process reference restart;
   - underrun/overrun beyond threshold;
   - sample discontinuity;
   - severe residual/divergence event;
   - start/stop of a new share.
7. Treat reference silence explicitly:
   - if B is low-energy, do not adapt aggressively;
   - output A normally because there is no GoofCord self-audio to remove;
   - log the B level so "no cancellation needed" is distinguishable from
     "cancellation failed."
8. Preserve strict failure behavior:
   - if A fails, no audio;
   - if B fails, stop A and no audio;
   - if the engine fails catastrophically, fail closed or emit silence while
     attempting one bounded reset.
9. Keep all public output chunks exactly 3840 bytes.
10. Keep `stop()` bounded and idempotent, but update session ownership to cover:
    - A worker join handle;
    - B worker join handle;
    - canceller worker join handle;
    - shared stop event/token;
    - AEC engine state owned by the canceller worker.

If the current spike export is `startEndpointMinusSelf(self_pid, log_path,
on_chunk)`, keep that shape for the next spike. The endpoint design's broader
exports can still come later; do not mix API expansion with the AEC library
proof unless required.

## Concrete Cargo/build change-set

For AEC3:

- Add a vendored dependency directory to the addon repo, not GoofCord's app repo,
  for example `vendor/webrtc-audio-processing/` plus `vendor/gc_aec3_shim/`.
- Add `build-dependencies`:
  - `cc` if compiling explicit C/C++ sources directly, or
  - `cmake` only if the vendored library has a stable CMake build on
    `windows-latest`.
- Keep `napi-build = "2"` and continue calling `napi_build::setup()`.
- Extend `build.rs` to:
  - compile the C ABI shim and APM/AEC3 sources as a static library;
  - use MSVC-compatible flags such as C++17, exception settings required by the
    vendor, optimization, and `NOMINMAX`;
  - emit `cargo:rerun-if-changed` for the vendor/shim sources;
  - link only system libraries available on Windows runners.
- Add a Rust module such as `src/aec/webrtc_aec3.rs` that declares the C ABI and
  owns create/reset/process/destroy safely.
- Update `package.json`/package files in the addon repo so the vendor source,
  licenses, and NOTICE material are included for source builds.
- Keep the addon build command unchanged:
  `napi build --release --target x86_64-pc-windows-msvc`.
- Keep GoofCord app CI unchanged: it should consume the committed
  `wasapi-loopback-win32-x64.node` optional dependency and only assert packaging
  presence.

For SpeexDSP fallback:

- Add `vendor/speexdsp/`.
- Compile C sources from `build.rs` with `cc`.
- Add `src/aec/speex.rs` around the small FFI surface.
- Use the same `AecEngine` trait, logs, and session behavior, so switching
  between AEC3 and Speex does not affect the WASAPI topology or JS transport.

Do not add a runtime DLL dependency for either path. The published artifact
should remain one `.node` prebuild.

## Pros and cons versus DIY NLMS

Pros:

- Removes the observed weakest component: flaky correlation delay lock plus
  fragile local NLMS adaptation.
- AEC3 brings real delay handling, double-talk logic, adaptation gating,
  residual echo handling, and reset behavior.
- Keeps RUN2's proven endpoint-minus-reference mechanism and fixed transport
  contract.
- Gives better diagnostics: reference energy and engine state make "nothing to
  cancel" visible.
- Allows strict failure handling without shipping a half-locked canceller.

Cons:

- AEC3 has real build risk on Windows/MSVC.
- WebRTC APM is voice-oriented and may need careful configuration to avoid
  damaging music/game/system audio.
- Binary size and CI time will increase.
- Stereo/cross-channel behavior must be proven, not assumed.
- Speex fallback is easier to build but does not fully solve unknown delay.

## Risks and landmines

- **Chromium loopback plus native WASAPI:** still forbidden. If native A, B, or
  self-cancel starts, do not set Chromium `result.audio = "loopback"`.
- **Contract drift:** all native paths must output 3840-byte 48k/stereo/f32
  chunks. Any int16/planar/internal format conversion stays inside Rust/C++.
- **CI-only builds:** GoofCord app CI should not start compiling WebRTC. The
  addon repo produces the prebuilt `.node`; GoofCord packages it.
- **Windows floor:** endpoint capture may exist earlier, but self-cancel needs
  process-loopback INCLUDE, so treat Windows 10 2004+ as the functional floor.
- **AEC over-suppression:** AEC3/Speex may decide some desktop audio is echo.
  Test with music/game/audio plus Discord voice, not voice-only clips.
- **Reference silence:** RUN2 lacked B-level metrics. Without `reference_rms_db`
  the team will keep misreading idle periods as cancellation failure.
- **Process tree identity:** confirm B really includes the Electron audio
  service child for GoofCord playback. If not, the best AEC library will receive
  the wrong reference.
- **Endpoint APOs/nonlinear effects:** EQ and loudness APOs may leave residual
  echo even with AEC3. Log residual and reset behavior, but do not chase perfect
  cancellation under nonlinear enhancement chains in the first pass.
- **Licensing:** vendored WebRTC/Speex license notices must ship with the addon.

## CI verification

Addon CI should verify build/package mechanics:

1. Run `bun install --frozen-lockfile`.
2. Run `bun x napi build --release --target x86_64-pc-windows-msvc` or the
   existing equivalent addon build script.
3. Assert the produced file is named `wasapi-loopback-win32-x64.node`.
4. Inspect dependencies with `dumpbin /dependents` or equivalent and fail if an
   unexpected non-system DLL is required.
5. Run a synthetic offline AEC test if the library can run without WASAPI:
   - generate B as noise/speech-like audio;
   - create A as delayed/filtered/scaled B plus unrelated "near" audio;
   - process 10 ms frames;
   - assert meaningful ERLE after convergence and no divergence during
     near-only/double-talk windows.
6. Package the prebuild into `prebuilds/windows-x86_64/` and let GoofCord CI
   continue its current packaged-addon presence assertion.

## On-box verification

The Windows test box is mandatory. CI cannot prove runtime audio behavior.

Minimum run matrix:

- Default endpoint self-cancel, Discord/GoofCord voice playback present.
- Same run with B silent to verify output stays as endpoint audio and logs show
  low reference energy.
- Double-talk: play game/music/system audio while GoofCord voice is present.
- VAC/VoiceMeeter on a separate endpoint to confirm endpoint scoping still
  excludes it.
- Repeated start/stop and second-share behavior.
- Default render endpoint change while sharing.
- Process-loopback unavailable/old Windows behavior if a suitable VM exists:
  addon loads, activation reports unsupported, no crash.

Pass criteria:

- No CoreMessaging crash.
- No concurrent Chromium loopback with native capture.
- Every emitted chunk is 3840 bytes.
- Reference-active windows show sustained cancellation, target >20 dB ERLE or
  reduction where the reference is clearly present.
- No negative reduction/divergence bursts like RUN2's 63 worsening heartbeats.
- B-silent windows are classified as "no reference" rather than "lock failed."
- Per-frame AEC processing normally stays under 2 ms.
- Canceller worker stays under 5% of one modern desktop CPU core.

## Final recommendation

Choose **WebRTC AEC3** first because it attacks the exact RUN2 failure:
unreliable delay lock, weak double-talk behavior, and occasional divergence.
Time-box the Windows/MSVC build proof. If AEC3 does not produce a single static
`.node` in the addon CI without turning the repo into a Chromium/WebRTC build
project, fall back to **SpeexDSP** and keep the same `AecEngine` boundary so the
WASAPI topology and JS transport do not churn again.
