# Windows endpoint-loopback default design

Date: 2026-07-03

Scope: design-stage investigation for milestone 999.1. No Rust or TypeScript
implementation is included here.

## 1. OBS reference findings

Reference source: obsproject/obs-studio `plugins/win-wasapi`.

OBS has three source types in `win-wasapi.cpp`: `Input`, `DeviceOutput`,
and `ProcessOutput`. The endpoint design to mirror is `DeviceOutput`, not
`ProcessOutput`.

OBS also registers endpoint output capture and process output capture as
separate source types: `wasapi_output_capture` and
`wasapi_process_output_capture`. GoofCord should mirror that separation at the
backend API level.

Render endpoint enumeration:

- `enum-wasapi.cpp` `GetWASAPIAudioDevices_` creates an
  `IMMDeviceEnumerator` with `CoCreateInstance(MMDeviceEnumerator, ...)`.
- It calls `EnumAudioEndpoints(input ? eCapture : eRender,
  DEVICE_STATE_ACTIVE, ...)`. For output capture, `input` is false, so this
  enumerates active render endpoints only.
- For each `IMMDevice`, it reads the endpoint id via `IMMDevice::GetId` and
  the display name via `GetDeviceName`.
- `GetDeviceName` opens the endpoint property store and reads
  `PKEY_Device_FriendlyName`.
- `GetWASAPIAudioDevices` is the non-throwing public wrapper that clears the
  vector, calls the throwing helper, and logs on failure.

Default endpoint selection:

- `win-wasapi.cpp` `WASAPISource::BuildUpdateParams` treats the string
  `"default"` in `device_id` as the default-device sentinel by setting
  `isDefaultDevice`.
- `GetWASAPIDefaultsDeviceOutput` sets `OPT_DEVICE_ID` to `"default"` and
  enables device timing for output capture by default.
- `WASAPISource::InitDevice` resolves that sentinel by calling
  `IMMDeviceEnumerator::GetDefaultAudioEndpoint(eRender, eConsole, ...)` for
  output capture. Non-default selections are widened to UTF-16 and resolved
  with `IMMDeviceEnumerator::GetDevice`.
- `wasapi-notify.cpp` implements `IMMNotificationClient` and forwards
  `OnDefaultDeviceChanged` callbacks.
- `win-wasapi.cpp` `WASAPISource::SetDefaultDevice` listens only when the
  source is using the `"default"` sentinel. For output capture it filters to
  `flow == eRender` and `role == eConsole`, updates the stored default id, and
  signals `restartSignal`.

Endpoint loopback capture:

- `win-wasapi.cpp` `WASAPISource::Initialize` uses `InitDevice` for
  `DeviceOutput`, stores the endpoint friendly name, initializes an
  `IAudioClient`, primes output capture with `ClearBuffer`, then obtains an
  `IAudioCaptureClient` with `InitCapture`.
- `WASAPISource::InitClient` has two separate branches:
  - `ProcessOutput` uses `ActivateAudioInterfaceAsync` with
    `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK` and
    `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`.
  - `DeviceOutput` activates `IAudioClient` directly from the selected
    `IMMDevice`, calls `GetMixFormat`, and initializes shared-mode capture.
- `InitClient` adds `AUDCLNT_STREAMFLAGS_LOOPBACK` for every non-input source,
  so `DeviceOutput` is true endpoint loopback against one render endpoint.
- `InitCapture` calls `GetService(IAudioCaptureClient)`, `SetEventHandle`,
  then `Start`.
- `ProcessCaptureData` drains `GetNextPacketSize` / `GetBuffer` /
  `ReleaseBuffer`, substitutes explicit silence for silent packets, and emits
  audio frames.

Source links:

- OBS endpoint enumeration:
  https://github.com/obsproject/obs-studio/blob/master/plugins/win-wasapi/enum-wasapi.cpp#L10-L98
- OBS output/process source registration:
  https://github.com/obsproject/obs-studio/blob/master/plugins/win-wasapi/win-wasapi.cpp#L1614-L1648
- OBS default endpoint and client initialization:
  https://github.com/obsproject/obs-studio/blob/master/plugins/win-wasapi/win-wasapi.cpp#L487-L753
- OBS endpoint capture initialization and packet draining:
  https://github.com/obsproject/obs-studio/blob/master/plugins/win-wasapi/win-wasapi.cpp#L833-L1087
- OBS default-device notification:
  https://github.com/obsproject/obs-studio/blob/master/plugins/win-wasapi/wasapi-notify.cpp#L1-L109
- OBS source defaults/properties:
  https://github.com/obsproject/obs-studio/blob/master/plugins/win-wasapi/win-wasapi.cpp#L1385-L1563

## 2. Rust-side design mapping

Current local state:

- `native/wasapi-loopback/src/lib.rs` and `wasapi-loopback-repo/src/lib.rs`
  are byte-identical. When implementation starts, the same change set must land
  in both copies or the repo-local source and checkout reference will diverge.
- The upstream `thomas-quant/wasapi-loopback` `src/lib.rs` matches the same
  architecture at the time of this investigation.
- The addon currently exposes only `start(exclude_root_pid, on_chunk)` and
  `stop()`.
- `start` always activates process-tree EXCLUDE loopback through
  `activate_exclude_tree`.
- `run_capture_loop` is already generic over an initialized `IAudioClient`, so
  it can be reused for endpoint loopback if the endpoint client is initialized
  to the same 48 kHz / stereo / f32 format.

Required Rust additions:

1. Add a capture target enum internal to Rust:

   - `CaptureTarget::DefaultRenderEndpoint`
   - `CaptureTarget::RenderEndpoint { device_id: String }`
   - `CaptureTarget::DefaultRenderEndpointSelfCancel`
   - `CaptureTarget::RenderEndpointSelfCancel { device_id: String }`
   - `CaptureTarget::ProcessTree { mode: ProcessTreeMode, pid: u32 }`

   `ProcessTreeMode` should have `Exclude` and `Include` variants. The current
   EXCLUDE path remains a direct mapping to
   `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`.

2. Preserve the existing process path.

   Keep `#[napi] pub fn start(exclude_root_pid, on_chunk)` as a compatibility
   alias for process-tree EXCLUDE. Internally it should delegate to the new
   shared starter with
   `CaptureTarget::ProcessTree { mode: Exclude, pid: exclude_root_pid }`.

3. Add explicit process-tree exports instead of overloading endpoint behavior:

   - `#[napi(js_name = "startExcludeProcessTree")]`
     `start_exclude_process_tree(target_pid, on_chunk) -> bool`
   - `#[napi(js_name = "startIncludeProcessTree")]`
     `start_include_process_tree(target_pid, on_chunk) -> bool`

   Two smaller exports are less ambiguous than a string mode at the N-API
   boundary.

4. Add endpoint exports:

   - `#[napi(js_name = "startDefaultRenderEndpoint")]`
     `start_default_render_endpoint(on_chunk) -> bool`
   - `#[napi(js_name = "startRenderEndpoint")]`
     `start_render_endpoint(device_id: String, on_chunk) -> bool`
   - `#[napi(js_name = "startDefaultRenderEndpointSelfCancel")]`
     `start_default_render_endpoint_self_cancel(on_chunk) -> bool`
   - `#[napi(js_name = "startRenderEndpointSelfCancel")]`
     `start_render_endpoint_self_cancel(device_id: String, on_chunk) -> bool`
   - `list_render_endpoints() -> Vec<RenderEndpointInfo>`
   - optionally `get_default_render_endpoint() -> Option<RenderEndpointInfo>`

   `RenderEndpointInfo` should include `id`, `name`, and `is_default`.

5. Add endpoint activation:

   `activate_render_endpoint_loopback(device_id: Option<&str>) -> ActivationResult`

   Steps:

   - Create `IMMDeviceEnumerator`.
   - If `device_id` is absent or `"default"`, call
     `GetDefaultAudioEndpoint(eRender, eConsole)`.
   - Otherwise widen the UTF-8 id and call `GetDevice`.
   - Activate `IAudioClient` directly from the `IMMDevice`.
   - Initialize in shared mode with
     `AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
     AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
     AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY`.
   - Use the existing `build_wave_format()` rather than `GetMixFormat`.

   This intentionally differs from OBS. OBS uses the endpoint mix format
   because OBS can handle arbitrary sample rates/layouts. GoofCord's transport
   contract is fixed at 48 kHz / stereo / f32, so endpoint loopback must ask the
   audio engine to convert into that format or fail gracefully.

6. Add a shared starter:

   `start_capture(target: CaptureTarget, on_chunk: ChunkTsfn) -> napi::Result<bool>`

   This should own the current global `SESSION` mutex, create the stop event,
   spawn the capture thread, `CoInitializeEx` on that thread, activate based on
   the target, call `run_capture_loop`, and keep the same bounded stop/join
   behavior.

   Also extract the repeated `IAudioClient::Initialize` block from
   `activate_exclude_tree` into a helper such as
   `initialize_loopback_client(audio_client)`. Both process and endpoint paths
   should use that helper so the 48 kHz / stereo / f32 stream flags stay
   identical.

7. Add default-render change handling as a second-phase Rust feature.

   OBS restarts default endpoint capture when the default render endpoint
   changes. GoofCord can initially resolve the default endpoint at share start,
   but long-running shares will be more correct if a Rust
   `IMMNotificationClient` is added for `DefaultRenderEndpoint` sessions. It
   should filter to `eRender/eConsole` and either signal a restart event or stop
   the current capture and reacquire the default endpoint on the capture thread.

Expected windows-rs surface:

- `IMMDevice`, `IMMDeviceEnumerator`, `IMMDeviceCollection`,
  `MMDeviceEnumerator`, `DEVICE_STATE_ACTIVE`, `eRender`, `eConsole`,
  `ERole`, `EDataFlow`.
- `IPropertyStore` and `PKEY_Device_FriendlyName` for friendly names.
- `CoCreateInstance` / `CLSCTX_ALL` for MMDevice enumerator construction.
- `CoTaskMemFree` or equivalent ownership handling for endpoint ids returned by
  `IMMDevice::GetId`.

The existing `windows` feature set already includes `Win32_Media_Audio` and
`Win32_System_Com`, but endpoint names will likely require adding one or more
feature gates for the property store and device property key. Confirm this in CI
or with a syntax-only local cargo check if iteration absolutely requires it; do
not treat local cargo as verification.

Local reference points:

- Format and chunk contract: `native/wasapi-loopback/src/lib.rs:57`
- Current process EXCLUDE activation: `native/wasapi-loopback/src/lib.rs:217`
- Generic capture loop: `native/wasapi-loopback/src/lib.rs:362`
- Current N-API `start`: `native/wasapi-loopback/src/lib.rs:461`
- Current `stop`: `native/wasapi-loopback/src/lib.rs:533`

## 3. TypeScript-side design mapping

Current local state:

- `src/modules/native/wasapiLoopback.ts` assumes the addon has only
  `start(excludeRootPid, onChunk)` and `stop()`.
- `tryStartWasapiLoopback()` takes no options, always passes `process.pid`, and
  logs the capture as EXCLUDE-tree capture.
- `src/windows/screenshare/screenshare.ts` calls `tryStartWasapiLoopback()` with
  no audio config, so Windows currently ignores `audioConfig.mode` and
  `audioConfig.pids`.
- The renderer feeder in `src/windows/main/preload/wasapiTransport.ts` is
  format-specific but source-agnostic: any native path that emits 3840-byte
  48 kHz / stereo / f32 chunks can reuse it unchanged.

Recommended TypeScript surface in `wasapiLoopback.ts`:

Keep `AudioConfig.mode` as the user intent (`none`, `system`, `app`) and add a
separate backend/source discriminator instead of encoding endpoint capture as a
fourth mode:

```ts
interface AudioConfig {
    mode: "none" | "system" | "app";
    pids: number[];
    captureSource:
        | "endpoint-self-cancel"
        | "endpoint"
        | "process-tree";
    endpointId: "default" | string;
}
```

The saved default should stay `mode: "none"` but include
`captureSource: "endpoint-self-cancel"` and `endpointId: "default"` for forward
compatibility. Older saved configs should be normalized in preload code by
filling missing fields.

```ts
type WasapiCaptureRequest =
    | { kind: "endpoint-self-cancel"; endpointId: "default" | string }
    | { kind: "endpoint"; endpointId: "default" | string }
    | { kind: "process-tree"; loopbackMode: "exclude"; targetPids: number[] }
    | { kind: "process-tree"; loopbackMode: "include"; targetPids: number[] };
```

Native addon typing:

```ts
interface WasapiAddon {
    startDefaultRenderEndpointSelfCancel(onChunk: OnChunk): boolean;
    startRenderEndpointSelfCancel(deviceId: string, onChunk: OnChunk): boolean;
    startDefaultRenderEndpoint(onChunk: OnChunk): boolean;
    startRenderEndpoint(deviceId: string, onChunk: OnChunk): boolean;
    startExcludeProcessTree(rootPid: number, onChunk: OnChunk): boolean;
    startIncludeProcessTree(rootPid: number, onChunk: OnChunk): boolean;
    listRenderEndpoints?(): RenderEndpointInfo[];
    stop(): void;
    start?(excludeRootPid: number, onChunk: OnChunk): boolean; // compatibility only
}
```

Wrapper behavior:

- `tryStartWasapiLoopback(audioConfig)` resolves `AudioConfig` to a
  `WasapiCaptureRequest` internally.
- Always call `stopWasapiLoopback()` before starting a new native capture.
- Create and forward the `MessageChannelMain` exactly as today.
- Select the native start function by `request.kind`.
- If a newer addon lacks endpoint exports, the wrapper may fall back to legacy
  `start(process.pid, onChunk)` only for an explicit
  `{ kind: "process-tree", loopbackMode: "exclude" }` request. It must not
  silently satisfy `{ kind: "endpoint-self-cancel", endpointId: "default" }` with
  process-tree capture because that violates the
  firm default requirement.
- Return enough information for the caller to distinguish "native capture did
  not start, Chromium fallback is acceptable" from "native capture did not
  start, but fallback would violate requested semantics". A bare boolean is no
  longer expressive enough for strict endpoint/app/explicit-device requests.
- Log the capture kind distinctly so userData logs can show whether a share used
  endpoint loopback or process-tree loopback.

Mapping from existing `AudioConfig`:

- Existing Windows checkbox path still produces `{ mode: "system", pids: [] }`.
  With normalized fields, it should map to
  `{ kind: "endpoint-self-cancel", endpointId: "default" }` by default.
- `{ mode: "app", pids: [pid] }` maps to process INCLUDE-tree capture.
- Future multi-app mode maps to multiple process INCLUDE captures plus native
  mixing, not endpoint loopback.
- Process EXCLUDE-tree capture should remain selectable as an advanced/legacy
  system mode. It must not be the default Windows system mode after this change.
- Plain endpoint loopback remains selectable as an explicit system backend when
  the user accepts self-echo risk or wants diagnostic behavior.
- Explicit endpoint selection can be modeled separately from app PIDs as
  `{ kind: "endpoint", endpointId: <MMDevice id> }`; this needs UI/config
  expansion later.

Files that would need later TS integration outside this design artifact:

- `src/modules/native/wasapiLoopback.ts`: addon typing, request type, and native
  start selection.
- `src/windows/screenshare/screenshare.ts`: pass `audioConfig` or a derived
  `WasapiCaptureRequest` instead of calling `tryStartWasapiLoopback()` with no
  args.
- `src/windows/screenshare/preload/preload.mts`: expose Windows endpoint/process
  choices if both modes are to be user-selectable.
- `src/settingsSchema.ts`: extend the persisted default with `captureSource` and
  `endpointId`, then normalize old configs in preload.
- `src/windows/main/preload/wasapiTransport.ts`: no behavior change expected if
  all native paths preserve the 3840-byte f32 chunk contract.

Local reference points:

- Current addon type: `src/modules/native/wasapiLoopback.ts:38`
- Current argless start: `src/modules/native/wasapiLoopback.ts:102`
- Current native start call: `src/modules/native/wasapiLoopback.ts:130`
- Current Windows audio gate: `src/windows/screenshare/screenshare.ts:94`
- Current Linux-only patchcord mode UI gate:
  `src/windows/screenshare/preload/preload.mts:177`
- Current feeder format contract:
  `src/windows/main/preload/wasapiTransport.ts:47`

## 4. Landmine interaction analysis

Chromium built-in loopback:

- The current code avoids Chromium `"loopback"` whenever native process-loopback
  starts successfully.
- Endpoint-loopback has not been separately proven safe to run at the same time
  as Chromium's built-in loopback.
- Even if it does not trigger the exact same CoreMessaging failure, running both
  would duplicate audio capture and can create confusing timing/mixing behavior.
- The safe invariant is therefore broader than the current comment: if any
  native WASAPI capture succeeds, whether endpoint or process-tree, do not set
  `result.audio = "loopback"`.
- Chromium `"loopback"` should remain only a fallback when no native capture is
  active and the requested semantics are compatible with Chromium's behavior.
  Do not use Chromium fallback for app mode or an explicit endpoint id. For the
  firm default endpoint-only rule, Chromium fallback should be allowed only after
  confirming Chromium captures the same single default render endpoint and does
  not reintroduce the broad process/all-endpoint behavior. Until that is
  confirmed, failed default endpoint activation should produce no audio rather
  than silently using process-tree capture or a broad fallback.

Endpoint-loopback vs process-loopback:

- For single-source modes, do not run endpoint-loopback and process-loopback at
  the same time in the same share.
- Superseded for the new default mode: endpoint self-cancellation deliberately
  runs one endpoint-loopback capture and one GoofCord process-INCLUDE reference
  capture at the same time, then emits one cancelled stream. This is not
  "two independent captures sent to Discord"; it is a two-input DSP pipeline
  with one output.
- The current single `SESSION` owner in Rust is still valid for the old
  single-source modes, but it must be replaced before implementing endpoint
  self-cancellation.
- Multi-app process INCLUDE remains a distinct mixer feature. It should not be
  used to implement the default system-audio mode.

Echo tradeoff:

- Superseded by section 5 for the default path. The following conclusion is
  correct only for a single WASAPI capture and is kept here to avoid losing the
  boundary: a strict render-endpoint loopback captures everything rendered to that
  endpoint. Public WASAPI endpoint loopback does not also exclude GoofCord's
  process tree.
- Therefore a single endpoint capture solves the VAC/VoiceMeeter "captures all render
  endpoints" problem, but it cannot simultaneously provide the old
  exclude-self guarantee. Process EXCLUDE remains the selectable echo-fix path.
- The new default design adds a second, reference-only capture of GoofCord's own
  process tree and subtracts an adaptive estimate of that reference from the
  endpoint mix. That is reference-based echo cancellation, not a WASAPI primitive,
  and it resolves the single-capture tradeoff when the canceller converges.
- If Discord is configured to output to a non-default endpoint, OBS-style
  `eRender/eConsole` default selection will not necessarily be the endpoint
  Discord is using. The explicit render-endpoint selector is the user-facing
  fix for that case; exact per-process endpoint discovery would be a separate
  Windows audio-session investigation.

## 5. Dual-capture endpoint self-cancellation default

This section supersedes the single-capture "endpoint cannot exclude self"
tradeoff for the default Windows system-audio mode.

### Goal

Default Windows system audio should capture:

- audio rendered to the active/default render endpoint that the user is actually
  listening to;
- none of the audio on other render endpoints, including virtual cables or
  VoiceMeeter/VB-Cable endpoints;
- none of GoofCord's own rendered audio, including Discord voice playback.

The topology:

- Capture A: endpoint loopback of the selected/default render endpoint. This is
  the full speaker mix for that endpoint.
- Capture B: process-loopback INCLUDE of GoofCord's own process tree rooted at
  `process.pid`. This is the reference signal for what GoofCord renders.
- Output: A minus an adaptive estimate of B as it appears inside A.

This is equivalent to an acoustic echo-cancellation problem with a digital
far-end reference: A is the "near-end" mixture and B is the "far-end" reference
to remove.

### Why naive A-B subtraction is insufficient

Do not implement this as `output[n] = endpoint[n] - process[n]`.

Reasons:

- Windows applies per-application audio session volume, per-endpoint master
  volume, channel matrixing, endpoint format conversion, and possibly audio
  enhancements/APOs before GoofCord's stream becomes part of the endpoint mix.
  The process-loopback reference B is not guaranteed to be bit-identical to
  GoofCord's contribution inside A.
- The mismatch is not necessarily a single constant gain. Endpoint APOs may be
  frequency-dependent EQ, loudness normalization, virtual surround, limiter or
  compressor behavior, or other time-varying/nonlinear processing.
- Capture A and Capture B are separate `IAudioClient`s with independent buffer
  schedules and clock observations. Even if both are initialized to
  48 kHz / stereo / f32, the same audio reaches the two capture loops with
  different latency and jitter.
- WASAPI packet boundaries will not line up. The existing capture loop already
  rechunks arbitrary packets into 480-frame chunks; the dual-capture design must
  timestamp or sequence those chunks and delay-compensate B against A.
- If GoofCord's playback device changes during a share, B can still contain
  GoofCord audio while A no longer contains it, or vice versa. Device-change
  handling must reset or reconverge the canceller.

Naive subtraction is acceptable only as a diagnostic mode for proving the signal
paths are live. It should not ship as the default.

### Cancellation method

Recommended default: a stereo adaptive linear canceller in the Rust addon, with
delay estimation and normalized adaptation.

Concrete algorithm:

1. Maintain ring buffers for A and B at the shared 48 kHz / stereo / f32 format.
2. Estimate coarse delay between B and A by normalized cross-correlation over a
   bounded search window, initially 0 to 80 ms. Re-estimate slowly and reset on
   underrun, endpoint change, process capture restart, or large residual jump.
3. Run one adaptive filter per output channel. Start with independent same-channel
   filtering, then add cross-channel taps only if testing shows endpoint
   enhancements or channel matrixing leak left into right or right into left.
4. Use normalized least-mean-squares (NLMS), preferably partitioned-block NLMS
   for CPU headroom. RLS should not be the default: it converges faster but is
   heavier, more complex to stabilize, and unnecessary for a mostly stable
   digital echo path.
5. Freeze or slow adaptation when the reference has low energy, when A clips, or
   when residual energy rises in a way that suggests nonlinearity or unrelated
   near-end audio. This prevents the filter from learning game/system audio as
   "echo".
6. Emit `A - estimate(B_in_A)` as the only PCM stream sent to the existing
   `MessageChannelMain` transport.

Expected behavior:

- With enhancements disabled and stable endpoint/session volume, a simpler
  delay + gain estimate may remove most self audio. It is not robust enough as
  the default because it cannot model EQ, channel mixing, or time-varying gain.
- NLMS should handle fixed gain, small delay, and linear filtering differences.
  It will leave residual self audio when APOs are nonlinear, when an endpoint
  limiter/compressor changes gain based on the whole endpoint mix, or when clock
  jitter exceeds the alignment buffer.
- WebRTC AEC3 and SpeexDSP are proven AEC implementations if a library route is
  preferred. WebRTC's AudioProcessing API is built around a reverse/render stream
  and a primary/capture stream in about-10 ms frames, and has an explicit stream
  delay input. SpeexDSP's echo canceller takes a captured input frame, a played
  reference frame, and outputs echo-removed audio; its docs stress that delay and
  nonlinear distortion are primary failure modes.

Reference sources:

- WebRTC AudioProcessing API overview and 10 ms frame contract:
  https://webrtc.googlesource.com/src/+/refs/heads/main/api/audio/audio_processing.h#43
- WebRTC AEC3 render/capture processing shape:
  https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_processing/aec3/echo_canceller3.h#80
- SpeexDSP echo cancellation API and delay/nonlinearity notes:
  https://www.speex.org/docs/manual/speex-manual/node7.html#SECTION00740000000000000000
- SpeexDSP `SpeexEchoState` API:
  https://www.speex.org/docs/api/speex-api-reference/group__SpeexEchoState.html

Prior art note: OBS's Windows process audio capture avoids self audio by using
WASAPI process-loopback include/exclude modes, not by endpoint-minus-reference
cancellation. The dual-capture design here is closer to standard adaptive echo
cancellation/adaptive noise cancellation with a digital reference signal than to
an OBS WASAPI primitive.

### DSP location and dependency options

Run the DSP in the Rust addon.

Reasons:

- Both capture streams originate in native Rust. Keeping A, B, alignment, and
  cancellation in Rust avoids sending two raw 384 KB/s stereo streams over IPC
  and avoids a JS timing loop in the hot path.
- The addon already owns the fixed audio contract:
  48 kHz / stereo / f32 / 480-frame chunks. The canceller can preserve that
  exact output shape.
- Rust can keep the capture threads, ring buffers, and cancellation worker under
  one stop token and one bounded teardown path.
- JS should receive only the final cancelled stream, so
  `wasapiTransport.ts` remains a single-port, single-track feeder.

Implementation options:

- Preferred first implementation: custom Rust partitioned-block NLMS with coarse
  delay estimator. This keeps dependencies small and matches the specific
  digital-reference problem. It is also easier to instrument with exact A/B/out
  dump files for Windows test-box diagnosis.
- Library option with strongest AEC behavior: WebRTC AEC3 through
  `webrtc-audio-processing` or direct C++ FFI. This is attractive because AEC3
  already handles render/capture timing, jitter, and residual echo logic, but the
  Windows build story and binary size must be proven in CI. The current docs.rs
  metadata for `webrtc-audio-processing` shows recent versions and a bundled
  build mode, but docs.rs failed to build the latest crate at investigation time;
  treat Windows packaging as an open verification item.
- Library option with simpler C ABI: SpeexDSP through FFI. It is mature and
  directly exposes an echo canceller, but its public API is int16-oriented, so
  GoofCord would need f32<->i16 conversion or a lower-level float path if
  available. Speex's asynchronous playback/capture API also adds a documented
  two-frame delay, which is acceptable but must be budgeted.
- Do not depend on an unvetted NLMS crate unless it is audited during
  implementation. A small local implementation may be less risky than a tiny,
  unmaintained DSP crate.

### Rust architecture impact

This design breaks the current `static SESSION: Mutex<Option<CaptureSession>>`
single-client assumption in `native/wasapi-loopback/src/lib.rs`.

Required architecture:

- Replace `CaptureSession` with a session enum or struct that can own multiple
  workers:
  - `SingleCaptureSession` for plain endpoint, process EXCLUDE, and process
    INCLUDE modes.
  - `SelfCancelSession` for the default endpoint-self-cancel mode.
- `SelfCancelSession` owns:
  - endpoint capture worker A;
  - GoofCord process-INCLUDE capture worker B;
  - one canceller/mixer worker;
  - shared stop event/token;
  - bounded ring buffers for A and B;
  - one output callback path to JS.
- Refactor `run_capture_loop` so it can either push chunks directly to JS
  (single-source mode) or push timestamped chunks into an internal Rust channel
  (self-cancel mode).
- Timestamp chunks with a monotonic native timestamp at capture time and, where
  available, WASAPI device position / QPC data from `IAudioCaptureClient::GetBuffer`.
  The current code passes `None` for position and timestamp; self-cancellation
  should capture those values if windows-rs bindings permit it.
- Start order should be B then A, or start both and withhold output until both
  have produced stable chunks. The canceller should emit silence during warmup
  rather than leaking uncancelled self audio.
- Stop must signal both capture workers, drain/stop the canceller worker, close
  all handles, and join with the existing bounded timeout policy.

Both byte-identical addon copies must be changed when implementation begins:

- `native/wasapi-loopback/src/lib.rs`
- `wasapi-loopback-repo/src/lib.rs`

Concurrency verification is a blocking spike:

- This overlaps the known Tier-2 unknown: whether concurrent WASAPI clients are
  stable inside Electron's audio session.
- Specifically verify one endpoint-loopback `IAudioClient` plus one
  process-loopback INCLUDE `IAudioClient` rooted at GoofCord `process.pid`.
- Do not assume OBS's multi-source precedent is enough. GoofCord/Electron has
  already seen CoreMessaging crashes when Chromium loopback and native
  process-loopback ran together.
- CI can prove buildability, but a Windows box must prove runtime stability,
  repeated start/stop, second-share behavior, default-device changes, and no
  CoreMessaging crash.

### Latency and CPU budget

The output contract stays one 480-frame chunk every about 10 ms.

Latency budget:

- Existing native chunk cadence: 10 ms.
- Required alignment buffer: target 10 to 40 ms, cap 60 ms unless Windows-box
  testing proves larger delay is needed.
- NLMS processing itself should add no full-frame algorithmic delay beyond the
  chosen A/B alignment buffer and one output frame. Target added latency:
  20 to 50 ms. Hard cap for default mode: 70 ms added over the current native
  transport.
- SpeexDSP asynchronous playback/capture API adds two frames according to its
  manual; at GoofCord's 10 ms frame size that is about 20 ms before any extra
  alignment buffer.
- WebRTC AEC3 is designed around about-10 ms frames and internal 64-sample
  blocks, but actual end-to-end delay must be measured in the Windows artifact.

CPU budget:

- Target under 5% of one modern desktop CPU core for the cancellation worker,
  with each 10 ms frame processed in under 2 ms under normal load.
- A naive time-domain 50 ms stereo NLMS filter is likely too expensive without
  SIMD or partitioning. Use short filters only for diagnostics; use
  partitioned-block NLMS or a proven AEC library for the default.
- Instrument frame processing time, ring depth, underruns, overruns, estimated
  delay, ERLE/residual estimate, and reference energy in a userData log file.

### Failure and fallback behavior

Default mode should be strict:

- If endpoint capture A fails to start, produce no native audio and do not fall
  back to Chromium `"loopback"`.
- If reference capture B fails to start, stop A and produce no audio. Falling
  back to plain endpoint loopback would reintroduce self-echo, violating the
  default mode's purpose.
- If B starts but later stalls or is invalidated, enter a short grace period
  that emits silence while attempting to restart B. If restart fails, stop the
  self-cancel session and produce no audio.
- If the canceller fails to converge, keep the session alive only if residual is
  below a configured diagnostic threshold. Otherwise fail closed to silence and
  log the reason. Do not leak uncancelled endpoint audio by default.

Plain endpoint loopback remains selectable as an explicit mode for users who
prefer endpoint-only capture even if it includes GoofCord audio. Process EXCLUDE
also remains selectable as the current echo-fix path. These are not silent
fallbacks from the strict default.

Landmines preserved:

- Never set Chromium `result.audio = "loopback"` while any native WASAPI capture
  worker is running.
- Every native output path still emits exactly 3840-byte
  48 kHz / stereo / f32 chunks.
- If the implementation chooses a library with a different internal format
  (for example SpeexDSP int16), conversion must happen inside Rust and the JS
  transport contract must not change.

### Config and UX mapping

Extend `AudioConfig` so Windows system audio can express the default and the
explicit escape hatches:

```ts
interface AudioConfig {
    mode: "none" | "system" | "app";
    pids: number[];
    captureSource:
        | "endpoint-self-cancel"
        | "endpoint"
        | "process-tree";
    endpointId: "default" | string;
}
```

Mapping:

- `mode: "none"`: no audio.
- `mode: "system", captureSource: "endpoint-self-cancel", endpointId: "default"`:
  default Windows system-audio mode. Start endpoint capture A plus GoofCord
  process-INCLUDE reference B and emit cancelled output.
- `mode: "system", captureSource: "endpoint", endpointId: "default" | id`:
  plain endpoint loopback; captures GoofCord if GoofCord renders to that
  endpoint.
- `mode: "system", captureSource: "process-tree"`:
  process-loopback EXCLUDE of GoofCord root PID; the current echo-fix behavior.
- `mode: "app", captureSource: "process-tree", pids: [...]`:
  process-loopback INCLUDE of selected app process trees. Multi-app still needs
  the separate mixer design.

Default saved settings should keep `mode: "none"` for privacy, but the default
backend fields should be `captureSource: "endpoint-self-cancel"` and
`endpointId: "default"`. When the standard Windows audio checkbox is enabled,
it should choose endpoint self-cancel unless the user explicitly selects another
backend.

Open questions to resolve during implementation planning:

- Does process-loopback INCLUDE of GoofCord `process.pid` include the Electron
  Audio Service child in all relevant builds, or does B need to target a
  different root/process set?
- Does B represent GoofCord audio before or after per-session volume? The
  canceller design tolerates gain/filter differences, but exact tap length and
  adaptation rate depend on where Windows taps process-loopback.
- How should the UI expose "plain endpoint" and "process EXCLUDE" without making
  the normal default look risky or complex?

## 6. Implementation status

Design-only. No implementation attempt was made in this pass.

Files changed:

- `.planning/phases/999.1-windows-audio-patchcord-parity-backend/ENDPOINT-LOOPBACK-DESIGN.md`
  - Added OBS reference findings.
  - Added Rust addon design mapping.
  - Added TypeScript wrapper design mapping.
  - Added Chromium/process/endpoint landmine analysis.
  - Added dual-capture endpoint self-cancellation design.
  - Added CI-only verification notes.

Files intentionally not changed:

- `native/wasapi-loopback/src/lib.rs`
- `wasapi-loopback-repo/src/lib.rs`
- `src/modules/native/wasapiLoopback.ts`
- `src/windows/screenshare/screenshare.ts`
- `src/windows/screenshare/preload/preload.mts`
- `src/windows/main/preload/wasapiTransport.ts`

## 7. Unverified items and next CI steps

Not verified in this design pass:

- Rust endpoint-loopback code does not exist yet.
- windows-rs feature gates/import names for endpoint enumeration and friendly
  device names are not compile-confirmed.
- Hardcoded 48 kHz / stereo / f32 endpoint initialization with
  `AUTOCONVERTPCM` is the intended contract, but not confirmed against
  `windows-latest` CI or real Windows endpoints.
- Default-device change restart behavior is design-stage only.
- Dual-capture endpoint-self-cancellation code does not exist yet.
- Concurrent endpoint-loopback plus process-loopback INCLUDE has not been
  runtime-verified in Electron.
- NLMS/WebRTC/Speex dependency/build choice is unresolved.
- Cancellation quality, residual echo, delay alignment, CPU cost, and failure
  behavior are design-stage only.
- No local `cargo build`, `cargo check`, `cargo clippy`, `bun run build`, or
  package build was run.
- No GitHub Actions workflow was triggered.

Next CI verification:

1. Implement the Rust N-API endpoint/self-cancel/process exports and TypeScript
   wrapper changes on a branch.
2. Push the branch to `origin`.
3. Run GoofCord CI:
   `gh workflow run testBuild.yml --repo thomas-quant/GoofCord --ref <branch>`.
4. If the addon is updated in its own repo/package, run the wasapi-loopback
   repository's Windows CI and consume the CI-produced `.node` artifact.
5. On the Windows test box, verify:
   - default mode captures only the selected/default render endpoint;
   - virtual cable endpoints are not captured unless they are the selected
     endpoint;
   - endpoint-self-cancel starts endpoint capture A and GoofCord reference
     capture B concurrently without CoreMessaging crashes;
   - self audio is cancelled under normal Discord playback, including after
     repeated start/stop and a second share;
   - failure of B fails closed to silence/no audio rather than leaking plain
     endpoint audio;
   - process EXCLUDE and process INCLUDE remain selectable and distinct;
   - no share ever runs Chromium loopback simultaneously with a native WASAPI
     capture.
