// wasapi-loopback — clean-room WASAPI process-tree EXCLUDE loopback capture.
//
// Authored SOLELY from the public Microsoft "ApplicationLoopback" MIT sample
// (Windows-classic-samples) and the public `windows` crate / Win32 docs. See NOTICE
// for the retained Microsoft MIT copyright. No proprietary or third-party application
// code or symbol layout is used as a basis (ECHO-04 clean-room boundary).
//
// Mechanism: activate a WASAPI IAudioClient in process-loopback mode with
// PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE against a caller-supplied root PID,
// so everything EXCEPT that process tree is captured (the #46 echo fix — exclude the
// host's own call playback). The format is hardcoded 48000 Hz / 2ch / 32-bit IEEE
// float; the audio engine converts to it in shared mode via AUTOCONVERTPCM (no Rust DSP).
//
// Task 1: crate scaffold + the clean-room activation path (hardcoded format, dynamic
// ActivateAudioInterfaceAsync resolution, async-completion wait, try-activate-and-catch
// -> "unsupported" instead of throwing).
// Task 2: the event-driven WASAPI capture loop on a dedicated thread + the napi
// ThreadsafeFunction NonBlocking push of 480-frame (3840-byte) f32 chunks (drop-oldest
// backpressure) + an idempotent `stop` that signals the thread and joins with a timeout.

#![cfg(windows)]

use std::collections::VecDeque;
use std::io::Write;
use std::mem::{size_of, ManuallyDrop};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::Buffer;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

// The `#[implement]` macro emits absolute `::windows_core::` paths, so windows-core is a
// direct dependency (see Cargo.toml). `windows` also re-exports it as `windows::core`.
use windows::core::{implement, w, IUnknown, Interface, GUID, HRESULT, PCWSTR};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_PROC_NOT_FOUND, E_FAIL, HANDLE, S_OK, WAIT_OBJECT_0,
};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, DEVICE_STATE_ACTIVE,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    MMDeviceEnumerator, PROCESS_LOOPBACK_MODE,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVEFORMATEXTENSIBLE_0, eConsole, eRender,
};
use windows::Win32::Media::KernelStreaming::WAVE_FORMAT_EXTENSIBLE;
use windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, BLOB, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject, INFINITE};
use windows::Win32::System::Variant::VT_BLOB;

// ─── Hardcoded capture format (the renderer/transport contract) ─────────────────────
//
// 48000 Hz / 2 channels / 32-bit IEEE float, interleaved stereo (L,R,L,R...).
// The process-loopback "magic device" returns E_NOTIMPL from the format-query calls
// (mix-format / format-support), so the format MUST be hardcoded and we never query it;
// AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM makes the shared-mode engine resample/matrix to it,
// so no Rust-side conversion is needed.
const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
const BITS_PER_SAMPLE: u16 = 32;
const BLOCK_ALIGN: u16 = CHANNELS * BITS_PER_SAMPLE / 8; // 8 bytes/frame
const AVG_BYTES_PER_SEC: u32 = SAMPLE_RATE * BLOCK_ALIGN as u32; // 384000

// SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT == 0x1 | 0x2 == 0x3.
const SPEAKER_STEREO_MASK: u32 = 0x3;

// ─── Chunk shape (the Plan 04-01 proven-transport contract — do NOT change) ─────────
//
// Each chunk delivered to JS is exactly 480 interleaved-stereo f32 frames:
//   480 frames * 2 channels * 4 bytes/sample = 3840 bytes (~10 ms at 48 kHz).
// This is the buffer shape the Plan 04-01 MSTG feeder already consumes; the JS wrapper
// forwards each 3840-byte buffer down the MessagePort with `port1.postMessage(buf)`.
const FRAMES_PER_CHUNK: usize = 480;
const BYTES_PER_FRAME: usize = (CHANNELS as usize) * (BITS_PER_SAMPLE as usize / 8); // 8
const CHUNK_BYTES: usize = FRAMES_PER_CHUNK * BYTES_PER_FRAME; // 3840
const CHUNK_SAMPLES: usize = FRAMES_PER_CHUNK * CHANNELS as usize; // 960 f32 samples

// Bounded ThreadsafeFunction queue: when JS can't keep up, NonBlocking `.call()` returns
// QueueFull and the Rust side drops the chunk (drop-oldest backpressure — locked T4 policy
// realized at the FFI boundary). MaxQueueSize has no effect in Blocking mode, so we use
// NonBlocking. ~5 chunks ≈ ~50 ms of slack before dropping. MaxQueueSize is a const generic
// on ThreadsafeFunction, so it is applied via the `ChunkTsfn` type alias below.
const TSFN_MAX_QUEUE: usize = 5;

// The napi callback the capture loop pushes to: a 3840-byte f32 Buffer per chunk, with a
// bounded queue (drop-oldest at QueueFull). Generic order is
// <T, Return, CallJsBackArgs, ErrorStatus, CalleeHandled, Weak, MaxQueueSize>; we keep the
// CalleeHandled default (true) so `.call(Ok(..))` is the call shape, and bound MaxQueueSize.
type ChunkTsfn = ThreadsafeFunction<
    Buffer,
    (),
    Buffer,
    napi::Status,
    true,  // CalleeHandled (default) — first JS arg is the error slot
    false, // Weak (default) — keep the event loop alive while capturing
    TSFN_MAX_QUEUE,
>;

// Bounded join timeout on stop so a hung native teardown can't wedge the caller's quit
// (composes with the JS wrapper's before-quit Promise.race).
const STOP_JOIN_TIMEOUT_MS: u64 = 1500;

// Throwaway milestone 999.1 AEC spike knobs. Keep deliberately small: the goal is to
// measure whether endpoint-minus-self has a usable residual, not ship production DSP.
const QPC_100NS_PER_SEC: u64 = 10_000_000;
const AEC_MIN_DELAY_CHUNKS: usize = 1; // 10 ms; avoid the run-1 lock-at-zero failure.
const AEC_MAX_DELAY_CHUNKS: usize = 14; // 140 ms render -> endpoint residual search.
const AEC_FILTER_TAPS: usize = 128;
const AEC_MU: f32 = 0.18;
const AEC_EPSILON: f32 = 1.0e-6;
const AEC_ALIGNMENT_MAX_BUFFER_CHUNKS: usize = 18; // ~180 ms cap per capture stream.
const AEC_ALIGNMENT_TOLERANCE_100NS: i128 = 150_000; // 15 ms timestamp match window.
const AEC_DELAY_LOCK_MIN_SCORE: f32 = 0.08;
const AEC_DELAY_UNLOCK_SCORE: f32 = 0.03;
const AEC_DELAY_RESCAN_BLOCKS: usize = 50;
const AEC_DELAY_UNLOCK_CHECKS: usize = 3;

/// Build the hardcoded 48k/stereo/f32 WAVEFORMATEXTENSIBLE.
fn build_wave_format() -> WAVEFORMATEXTENSIBLE {
    WAVEFORMATEXTENSIBLE {
        Format: WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_EXTENSIBLE as u16,
            nChannels: CHANNELS,
            nSamplesPerSec: SAMPLE_RATE,
            wBitsPerSample: BITS_PER_SAMPLE,
            nBlockAlign: BLOCK_ALIGN,
            nAvgBytesPerSec: AVG_BYTES_PER_SEC,
            // cbSize = bytes that follow the WAVEFORMATEX header (the EXTENSIBLE tail).
            cbSize: (size_of::<WAVEFORMATEXTENSIBLE>() - size_of::<WAVEFORMATEX>()) as u16,
        },
        Samples: WAVEFORMATEXTENSIBLE_0 {
            wValidBitsPerSample: BITS_PER_SAMPLE,
        },
        dwChannelMask: SPEAKER_STEREO_MASK,
        SubFormat: KSDATAFORMAT_SUBTYPE_IEEE_FLOAT,
    }
}

// ─── Activation outcome ─────────────────────────────────────────────────────────────

/// The result of attempting to activate process-loopback. Any failure (a missing
/// entry point, a non-S_OK activate result, or a COM error) collapses to `Unsupported`
/// — the JS-visible `start` then resolves `false` and the caller falls back gracefully
/// (ECHO-03). Nothing here panics or throws.
enum ActivationResult {
    /// Activated; the IAudioClient is initialized and ready to start capturing.
    Activated(IAudioClient),
    /// The API is absent on this build, or activation returned a non-success result.
    Unsupported,
}

fn append_diag(log_path: Option<&str>, line: impl AsRef<str>) {
    let Some(log_path) = log_path else {
        return;
    };

    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
    else {
        return;
    };

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    let _ = writeln!(
        file,
        "[{}.{:03}] {}",
        ts.as_secs(),
        ts.subsec_millis(),
        line.as_ref()
    );
}

fn format_hr(hr: HRESULT) -> String {
    format!("0x{:08x}", hr.0 as u32)
}

unsafe fn initialize_loopback_client(audio_client: &IAudioClient) -> bool {
    // StreamFlags is the SECOND Initialize parameter — AUTOCONVERTPCM lives here.
    let wfx = build_wave_format();
    let stream_flags = AUDCLNT_STREAMFLAGS_LOOPBACK
        | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    audio_client
        .Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            stream_flags,
            0,
            0,
            &wfx as *const _ as *const WAVEFORMATEX,
            None,
        )
        .is_ok()
}

// ─── Async activation completion handler ────────────────────────────────────────────
//
// ActivateAudioInterfaceAsync is asynchronous: it returns immediately and signals
// completion on an IActivateAudioInterfaceCompletionHandler. We implement the handler
// to set a Win32 event, then WaitForSingleObject on that event before reading the
// activation result (Pitfall 4 — treating activation as synchronous yields a null client).

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct CompletionHandler {
    done: HANDLE,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for CompletionHandler_Impl {
    fn ActivateCompleted(
        &self,
        _operation: windows::core::Ref<'_, IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        // Wake the waiting thread; the activation result is read from the operation
        // by the caller after the wait returns.
        unsafe {
            let _ = SetEvent(self.done);
        }
        Ok(())
    }
}

// ─── Dynamic resolution of ActivateAudioInterfaceAsync ──────────────────────────────
//
// Resolve the entry point at runtime via LoadLibraryW + GetProcAddress (NOT a static
// import) so the .node LOADS on every Windows build; only where the symbol is present
// does activation proceed. A null GetProcAddress => Unsupported (graceful, ECHO-03).
//
// NOTE: the `windows` crate also exposes a statically-bound `ActivateAudioInterfaceAsync`
// (imported above and used for its type signatures); the dynamic probe below is the
// load-bearing availability gate — if the export is absent we never reach the call.

type ActivateAudioInterfaceAsyncFn = unsafe extern "system" fn(
    deviceinterfacepath: PCWSTR,
    riid: *const GUID,
    activationparams: *const PROPVARIANT,
    completionhandler: *mut core::ffi::c_void,
    activationoperation: *mut *mut core::ffi::c_void,
) -> HRESULT;

/// Returns true if `ActivateAudioInterfaceAsync` is resolvable on this build.
fn process_loopback_entrypoint_present() -> bool {
    unsafe {
        // mmdevapi.dll exports ActivateAudioInterfaceAsync on builds that support it.
        let module = match LoadLibraryW(w!("mmdevapi.dll")) {
            Ok(h) if !h.is_invalid() => h,
            _ => return false,
        };
        let proc = GetProcAddress(module, windows::core::s!("ActivateAudioInterfaceAsync"));
        // (s! builds a null-terminated PCSTR literal — windows-core macro, no path import.)
        // If GetProcAddress is null the API is unavailable on this build -> Unsupported.
        if proc.is_none() {
            // Distinguish the "old build" case in logs if ever needed.
            let _ = GetLastError() == ERROR_PROC_NOT_FOUND;
            return false;
        }
        // We keep the statically-bound symbol for the actual call (same export); this
        // probe is purely the availability gate so the .node still loads pre-2004.
        let _resolved: ActivateAudioInterfaceAsyncFn =
            std::mem::transmute::<_, ActivateAudioInterfaceAsyncFn>(proc.unwrap());
        true
    }
}

// ─── Activation ─────────────────────────────────────────────────────────────────────

/// Attempt to activate a process-loopback IAudioClient for the process tree rooted at
/// `root_pid`, initialized to the hardcoded 48k/stereo/f32 format.
///
/// Returns `Activated(client)` on success, or `Unsupported` for ANY failure (missing
/// entry point, non-S_OK activate result, or COM error) — never panics, never throws.
unsafe fn activate_process_tree(
    root_pid: u32,
    process_loopback_mode: PROCESS_LOOPBACK_MODE,
    label: &str,
    log_path: Option<&str>,
) -> ActivationResult {
    // 1. Dynamic-load gate: if the entry point is absent, this build doesn't support it.
    if !process_loopback_entrypoint_present() {
        append_diag(log_path, format!("{label} activation unsupported: entrypoint missing"));
        return ActivationResult::Unsupported;
    }

    // 2. Build the activation params: INCLUDE or EXCLUDE the supplied process tree.
    let mut activation_params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: root_pid,
                ProcessLoopbackMode: process_loopback_mode,
            },
        },
    };

    // 3. Wrap the params in a PROPVARIANT (VT_BLOB) for the activation call.
    //
    // HEAP-CORRUPTION FIX (0xc0000374): windows-rs's PROPVARIANT is an OWNING type — its Drop
    // calls PropVariantClear, which for VT_BLOB does CoTaskMemFree(blob.pBlobData). Here pBlobData
    // borrows the STACK `activation_params` (the PROPVARIANT owns NOTHING), so letting it drop would
    // CoTaskMemFree a stack pointer → heap corruption → hard crash inside start(). The C++
    // ApplicationLoopback sample uses a raw PROPVARIANT with no destructor; mirror that exactly by
    // wrapping in ManuallyDrop so PropVariantClear NEVER runs. No leak: the blob is stack memory
    // released with the stack frame, and the async activation completes (we wait) before we return.
    let mut prop = ManuallyDrop::new(PROPVARIANT::default());
    {
        let pv = &mut prop.Anonymous.Anonymous;
        pv.vt = VT_BLOB;
        pv.Anonymous.blob = BLOB {
            cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            pBlobData: &mut activation_params as *mut _ as *mut u8,
        };
    }

    // 4. Create the completion event + handler (async activation, Pitfall 4).
    //    CreateEventW(attrs, bManualReset, bInitialState, name): manual-reset, unsignaled.
    let done = match CreateEventW(None, true, false, PCWSTR::null()) {
        Ok(h) => h,
        Err(err) => {
            append_diag(log_path, format!("{label} activation event failed: {err:?}"));
            return ActivationResult::Unsupported;
        }
    };
    let handler: IActivateAudioInterfaceCompletionHandler =
        CompletionHandler { done }.into();

    // 5. Fire the async activation against the process-loopback magic device.
    let operation: IActivateAudioInterfaceAsyncOperation = match ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        &IAudioClient::IID,
        Some(&*prop),
        &handler,
    ) {
        Ok(op) => op,
        Err(err) => {
            append_diag(log_path, format!("{label} ActivateAudioInterfaceAsync failed: {err:?}"));
            let _ = CloseHandle(done);
            return ActivationResult::Unsupported;
        }
    };

    // 6. Wait for completion, then read the activation result. ANY non-S_OK => Unsupported.
    let wait = WaitForSingleObject(done, INFINITE);
    let _ = CloseHandle(done);
    if wait != WAIT_OBJECT_0 {
        append_diag(log_path, format!("{label} activation wait failed: wait={wait:?}"));
        return ActivationResult::Unsupported;
    }

    let mut activate_hr: HRESULT = E_FAIL;
    let mut activated_iface: Option<IUnknown> = None;
    if operation
        .GetActivateResult(&mut activate_hr, &mut activated_iface)
        .is_err()
    {
        append_diag(log_path, format!("{label} GetActivateResult failed"));
        return ActivationResult::Unsupported;
    }
    append_diag(
        log_path,
        format!("{label} activation result hr={}", format_hr(activate_hr)),
    );
    // E_NOTIMPL / E_INVALIDARG / AUDCLNT_E_DEVICE_INVALIDATED / any other non-success ->
    // "unsupported on this build" (try-activate-and-catch — no hardcoded OS build gate).
    if activate_hr != S_OK {
        return ActivationResult::Unsupported;
    }
    let audio_client: IAudioClient = match activated_iface.and_then(|u| u.cast().ok()) {
        Some(c) => c,
        None => {
            append_diag(log_path, format!("{label} activation returned no IAudioClient"));
            return ActivationResult::Unsupported;
        }
    };

    // 7. Initialize to the fixed GoofCord transport format.
    if !initialize_loopback_client(&audio_client) {
        append_diag(log_path, format!("{label} Initialize failed"));
        return ActivationResult::Unsupported;
    }
    append_diag(log_path, format!("{label} Initialize ok hr={}", format_hr(S_OK)));

    ActivationResult::Activated(audio_client)
}

unsafe fn activate_exclude_tree(exclude_root_pid: u32) -> ActivationResult {
    activate_process_tree(
        exclude_root_pid,
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
        "process-exclude",
        None,
    )
}

unsafe fn activate_include_tree(include_root_pid: u32, log_path: Option<&str>) -> ActivationResult {
    activate_process_tree(
        include_root_pid,
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
        "process-include",
        log_path,
    )
}

unsafe fn activate_default_render_endpoint_loopback(log_path: Option<&str>) -> ActivationResult {
    let enumerator: IMMDeviceEnumerator =
        match CoCreateInstance(&MMDeviceEnumerator, None::<&IUnknown>, CLSCTX_ALL) {
            Ok(e) => e,
            Err(err) => {
                append_diag(log_path, format!("endpoint CoCreateInstance failed: {err:?}"));
                return ActivationResult::Unsupported;
            }
        };
    append_diag(log_path, format!("endpoint MMDeviceEnumerator ok hr={}", format_hr(S_OK)));

    let endpoint: IMMDevice = match enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
        Ok(endpoint) => endpoint,
        Err(err) => {
            append_diag(
                log_path,
                format!("endpoint GetDefaultAudioEndpoint(eRender,eConsole) failed: {err:?}"),
            );
            return ActivationResult::Unsupported;
        }
    };
    append_diag(
        log_path,
        format!("endpoint GetDefaultAudioEndpoint ok hr={}", format_hr(S_OK)),
    );

    match endpoint.GetState() {
        Ok(state) => append_diag(
            log_path,
            format!(
                "endpoint state={} active_constant={}",
                state.0, DEVICE_STATE_ACTIVE.0
            ),
        ),
        Err(err) => append_diag(log_path, format!("endpoint GetState failed: {err:?}")),
    }

    let audio_client: IAudioClient = match endpoint.Activate(CLSCTX_ALL, None) {
        Ok(client) => client,
        Err(err) => {
            append_diag(log_path, format!("endpoint Activate(IAudioClient) failed: {err:?}"));
            return ActivationResult::Unsupported;
        }
    };
    append_diag(
        log_path,
        format!("endpoint Activate(IAudioClient) ok hr={}", format_hr(S_OK)),
    );

    if !initialize_loopback_client(&audio_client) {
        append_diag(log_path, "endpoint Initialize failed");
        return ActivationResult::Unsupported;
    }
    append_diag(log_path, format!("endpoint Initialize ok hr={}", format_hr(S_OK)));

    ActivationResult::Activated(audio_client)
}

// ─── Capture-thread state ───────────────────────────────────────────────────────────
//
// A single capture session at a time. The capture thread owns the COM-apartment-affine
// IAudioClient/IAudioCaptureClient: activation runs ON the capture thread (after
// CoInitializeEx) and the outcome is reported back to `start()` over a channel, so the
// COM objects never cross a thread boundary. `stop` signals the stop event and joins.

struct CaptureSession {
    /// Manual-reset event the capture loop polls; SetEvent => "please exit".
    stop_event: HANDLE,
    /// Capture/canceller thread join handles (taken by `stop`).
    joins: Vec<JoinHandle<()>>,
    /// Optional diagnostics file for spike sessions.
    log_path: Option<String>,
}

// HANDLE is a raw pointer; it is only ever touched under the GLOBAL mutex below and on
// the capture thread we created, so guarding it this way is sound.
unsafe impl Send for CaptureSession {}

/// A `HANDLE` that can be moved into the capture thread. A Win32 event handle is a kernel
/// object safe to use from any thread; the raw pointer is only non-`Send` by default.
#[derive(Clone, Copy)]
struct SendHandle(HANDLE);
unsafe impl Send for SendHandle {}

static SESSION: Mutex<Option<CaptureSession>> = Mutex::new(None);

fn join_all_with_timeout(joins: Vec<JoinHandle<()>>) {
    let deadline = Instant::now() + Duration::from_millis(STOP_JOIN_TIMEOUT_MS);
    for join in joins {
        loop {
            if join.is_finished() {
                let _ = join.join();
                break;
            }
            if Instant::now() >= deadline {
                // Detach a hung thread rather than block the caller; the stop event is
                // already signaled, so it will exit on its own shortly.
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

// ─── Event-driven capture loop (runs on the dedicated capture thread) ───────────────
//
// Source basis: the MS ApplicationLoopback sample's event-driven capture loop
// (SetEventHandle -> GetService(IAudioCaptureClient) -> Start -> wait-on-event ->
// GetNextPacketSize / GetBuffer / ReleaseBuffer). Re-expressed via windows-rs.

#[derive(Clone, Copy)]
struct CaptureTimestamp {
    device_position: u64,
    qpc_position_100ns: u64,
}

impl CaptureTimestamp {
    fn offset_frames(self, frames: u64) -> Self {
        Self {
            device_position: self.device_position.saturating_add(frames),
            qpc_position_100ns: self
                .qpc_position_100ns
                .saturating_add(frames_to_qpc_100ns(frames)),
        }
    }
}

struct CapturedChunk {
    bytes: Vec<u8>,
    timestamp: CaptureTimestamp,
}

fn frames_to_qpc_100ns(frames: u64) -> u64 {
    ((frames as u128 * QPC_100NS_PER_SEC as u128 + (SAMPLE_RATE as u128 / 2))
        / SAMPLE_RATE as u128) as u64
}

fn qpc_delta_100ns(a: u64, b: u64) -> i128 {
    a as i128 - b as i128
}

fn abs_i128(value: i128) -> i128 {
    if value < 0 {
        -value
    } else {
        value
    }
}

/// The capture loop. Owns `audio_client` (already Initialize()'d to 48k/stereo/f32).
/// Batches the device's interleaved-stereo f32 frames into 3840-byte chunks and passes
/// each to `on_chunk`. Exits when `stop_event` fires.
unsafe fn run_capture_loop_with_sink<F>(
    audio_client: IAudioClient,
    stop_event: HANDLE,
    mut on_chunk: F,
) where
    F: FnMut(CapturedChunk),
{
    // Event the engine signals each period (EVENTCALLBACK mode). Auto-reset, unsignaled.
    let audio_event = match CreateEventW(None, false, false, PCWSTR::null()) {
        Ok(h) => h,
        Err(_) => return,
    };
    if audio_client.SetEventHandle(audio_event).is_err() {
        let _ = CloseHandle(audio_event);
        return;
    }

    let capture: IAudioCaptureClient = match audio_client.GetService() {
        Ok(c) => c,
        Err(_) => {
            let _ = CloseHandle(audio_event);
            return;
        }
    };

    if audio_client.Start().is_err() {
        let _ = CloseHandle(audio_event);
        return;
    }

    // Accumulator: fill to exactly CHUNK_BYTES (3840), flush, repeat. WASAPI packets do
    // not align to 480 frames, so we re-chunk across packet boundaries while carrying
    // the timestamp of the first frame in each emitted chunk.
    let mut acc: Vec<u8> = Vec::with_capacity(CHUNK_BYTES * 2);
    let mut acc_start: Option<CaptureTimestamp> = None;

    // Wait on BOTH the audio event and the stop event; WaitForMultipleObjects would be
    // ideal, but a short timed wait on the audio event + a stop-event poll keeps the
    // dependency surface minimal and the teardown latency bounded.
    loop {
        // Stop requested? (non-blocking poll; WAIT_OBJECT_0 => signaled)
        if WaitForSingleObject(stop_event, 0) == WAIT_OBJECT_0 {
            break;
        }

        // Wait up to ~100 ms for the next audio period; a timeout just re-polls stop.
        let _ = WaitForSingleObject(audio_event, 100);

        // Drain every packet currently available.
        loop {
            let packet_frames = match capture.GetNextPacketSize() {
                Ok(n) => n,
                Err(_) => break,
            };
            if packet_frames == 0 {
                break;
            }

            let mut data_ptr: *mut u8 = std::ptr::null_mut();
            let mut num_frames: u32 = 0;
            let mut flags: u32 = 0;
            let mut device_position: u64 = 0;
            let mut qpc_position_100ns: u64 = 0;
            if capture
                .GetBuffer(
                    &mut data_ptr,
                    &mut num_frames,
                    &mut flags,
                    // TODO verify in CI: windows-rs 0.62 GetBuffer optional timestamp
                    // out-params accept Some(&mut u64) for these WASAPI positions.
                    Some(&mut device_position),
                    Some(&mut qpc_position_100ns),
                )
                .is_err()
            {
                break;
            }

            let frame_count = num_frames as usize;
            let byte_count = frame_count * BYTES_PER_FRAME;
            let packet_timestamp = CaptureTimestamp {
                device_position,
                qpc_position_100ns,
            };
            let packet_bytes =
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data_ptr.is_null() {
                    None
                } else {
                    Some(std::slice::from_raw_parts(data_ptr, byte_count))
                };

            let mut packet_frame_offset = 0usize;
            while packet_frame_offset < frame_count {
                if acc.is_empty() {
                    acc_start =
                        Some(packet_timestamp.offset_frames(packet_frame_offset as u64));
                }

                let frames_in_acc = acc.len() / BYTES_PER_FRAME;
                let frames_needed = FRAMES_PER_CHUNK.saturating_sub(frames_in_acc);
                let frames_available = frame_count - packet_frame_offset;
                let frames_to_copy = frames_needed.min(frames_available);
                let bytes_to_copy = frames_to_copy * BYTES_PER_FRAME;

                if let Some(slice) = packet_bytes {
                    let start = packet_frame_offset * BYTES_PER_FRAME;
                    let end = start + bytes_to_copy;
                    acc.extend_from_slice(&slice[start..end]);
                } else {
                    // Silent packet: the engine says "treat as silence" — append zeros so
                    // the timeline stays monotonic (the renderer expects continuous f32).
                    acc.resize(acc.len() + bytes_to_copy, 0u8);
                }

                packet_frame_offset += frames_to_copy;

                if acc.len() == CHUNK_BYTES {
                    let timestamp = acc_start.unwrap_or(packet_timestamp);
                    let chunk = std::mem::replace(&mut acc, Vec::with_capacity(CHUNK_BYTES * 2));
                    on_chunk(CapturedChunk {
                        bytes: chunk,
                        timestamp,
                    });
                    acc_start = None;
                }
            }

            let _ = capture.ReleaseBuffer(num_frames);
        }
    }

    // Teardown: stop the client and release the per-loop event.
    let _ = audio_client.Stop();
    let _ = CloseHandle(audio_event);
    // `capture` and `audio_client` drop here, releasing the COM references on this thread.
}

/// JS-facing capture loop wrapper. NonBlocking push: QueueFull => the chunk is dropped
/// (drop-oldest at the FFI boundary). Bounded latency wins over perfect fidelity.
unsafe fn run_capture_loop(audio_client: IAudioClient, on_chunk: ChunkTsfn, stop_event: HANDLE) {
    run_capture_loop_with_sink(audio_client, stop_event, |chunk| {
        on_chunk.call(
            Ok(chunk.bytes.into()),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    });
}

#[derive(Clone, Copy)]
enum SpikeStream {
    Endpoint,
    Reference,
}

enum SpikeCaptureSource {
    DefaultRenderEndpoint,
    IncludeProcessTree(u32),
}

struct TimestampedAudioBlock {
    samples: Vec<f32>,
    timestamp: CaptureTimestamp,
}

struct StreamBuffers {
    endpoint: VecDeque<TimestampedAudioBlock>,
    reference: VecDeque<TimestampedAudioBlock>,
    dropped_endpoint_chunks: u64,
    dropped_reference_chunks: u64,
}

struct AlignedCaptureBlock {
    endpoint: Vec<f32>,
    reference: Vec<f32>,
    endpoint_buffered_samples: usize,
    reference_buffered_samples: usize,
    aligned: bool,
    alignment_delta_100ns: i128,
    device_delta_frames: i128,
    dropped_endpoint_chunks: u64,
    dropped_reference_chunks: u64,
}

struct SharedCaptureBuffers {
    inner: Mutex<StreamBuffers>,
    ready: Condvar,
}

impl SharedCaptureBuffers {
    fn new() -> Self {
        Self {
            inner: Mutex::new(StreamBuffers {
                endpoint: VecDeque::new(),
                reference: VecDeque::new(),
                dropped_endpoint_chunks: 0,
                dropped_reference_chunks: 0,
            }),
            ready: Condvar::new(),
        }
    }

    fn push_chunk(&self, stream: SpikeStream, chunk: CapturedChunk) {
        let mut samples = Vec::with_capacity(CHUNK_SAMPLES);
        for sample in chunk.bytes.chunks_exact(4).take(CHUNK_SAMPLES) {
            samples.push(f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]));
        }
        while samples.len() < CHUNK_SAMPLES {
            samples.push(0.0);
        }

        let block = TimestampedAudioBlock {
            samples,
            timestamp: chunk.timestamp,
        };

        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        // Deref the MutexGuard once into &mut StreamBuffers so the two disjoint field
        // borrows below don't each trigger a separate deref_mut (E0499).
        let buffers = &mut *guard;
        match stream {
            SpikeStream::Endpoint => {
                buffers.endpoint.push_back(block);
                Self::trim_queue(&mut buffers.endpoint, &mut buffers.dropped_endpoint_chunks);
            }
            SpikeStream::Reference => {
                buffers.reference.push_back(block);
                Self::trim_queue(&mut buffers.reference, &mut buffers.dropped_reference_chunks);
            }
        }
        self.ready.notify_one();
    }

    fn trim_queue(queue: &mut VecDeque<TimestampedAudioBlock>, dropped_chunks: &mut u64) {
        while queue.len() > AEC_ALIGNMENT_MAX_BUFFER_CHUNKS {
            let _ = queue.pop_front();
            *dropped_chunks = dropped_chunks.saturating_add(1);
        }
    }

    fn drop_endpoint_front(guard: &mut StreamBuffers) {
        let _ = guard.endpoint.pop_front();
        guard.dropped_endpoint_chunks = guard.dropped_endpoint_chunks.saturating_add(1);
    }

    fn drop_reference_front(guard: &mut StreamBuffers) {
        let _ = guard.reference.pop_front();
        guard.dropped_reference_chunks = guard.dropped_reference_chunks.saturating_add(1);
    }

    fn try_pop_aligned(guard: &mut StreamBuffers) -> Option<AlignedCaptureBlock> {
        loop {
            let endpoint_qpc = guard.endpoint.front()?.timestamp.qpc_position_100ns;

            while let Some(reference) = guard.reference.front() {
                let delta = qpc_delta_100ns(reference.timestamp.qpc_position_100ns, endpoint_qpc);
                if delta < -AEC_ALIGNMENT_TOLERANCE_100NS {
                    Self::drop_reference_front(guard);
                } else {
                    break;
                }
            }

            let Some(reference) = guard.reference.front() else {
                return None;
            };
            if qpc_delta_100ns(reference.timestamp.qpc_position_100ns, endpoint_qpc)
                > AEC_ALIGNMENT_TOLERANCE_100NS
            {
                Self::drop_endpoint_front(guard);
                continue;
            }

            let mut best_idx = None;
            let mut best_abs_delta = AEC_ALIGNMENT_TOLERANCE_100NS + 1;
            for (idx, reference) in guard.reference.iter().enumerate() {
                let delta = qpc_delta_100ns(reference.timestamp.qpc_position_100ns, endpoint_qpc);
                if delta > AEC_ALIGNMENT_TOLERANCE_100NS {
                    break;
                }

                let abs_delta = abs_i128(delta);
                if abs_delta <= AEC_ALIGNMENT_TOLERANCE_100NS && abs_delta < best_abs_delta {
                    best_idx = Some(idx);
                    best_abs_delta = abs_delta;
                }
            }

            let reference_idx = best_idx?;
            for _ in 0..reference_idx {
                Self::drop_reference_front(guard);
            }

            let endpoint = guard.endpoint.pop_front().unwrap();
            let reference = guard.reference.pop_front().unwrap();
            let alignment_delta_100ns = qpc_delta_100ns(
                reference.timestamp.qpc_position_100ns,
                endpoint.timestamp.qpc_position_100ns,
            );
            let device_delta_frames = reference.timestamp.device_position as i128
                - endpoint.timestamp.device_position as i128;

            return Some(AlignedCaptureBlock {
                endpoint: endpoint.samples,
                reference: reference.samples,
                endpoint_buffered_samples: guard.endpoint.len() * CHUNK_SAMPLES,
                reference_buffered_samples: guard.reference.len() * CHUNK_SAMPLES,
                aligned: true,
                alignment_delta_100ns,
                device_delta_frames,
                dropped_endpoint_chunks: guard.dropped_endpoint_chunks,
                dropped_reference_chunks: guard.dropped_reference_chunks,
            });
        }
    }

    fn wait_pop_block(&self, stop_event: HANDLE) -> Option<AlignedCaptureBlock> {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            if unsafe { WaitForSingleObject(stop_event, 0) } == WAIT_OBJECT_0 {
                return None;
            }

            if let Some(block) = Self::try_pop_aligned(&mut guard) {
                return Some(block);
            }

            guard = match self.ready.wait_timeout(guard, Duration::from_millis(50)) {
                Ok((guard, _)) => guard,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
    }
}

struct NlmsCanceller {
    weights: Vec<f32>,
    x_history: VecDeque<f32>,
    reference_history: VecDeque<f32>,
    estimated_delay_samples: usize,
    delay_locked: bool,
    delay_score: f32,
    poor_delay_checks: usize,
    blocks_until_delay_scan: usize,
}

struct DelayEstimate {
    delay_samples: usize,
    score: f32,
}

impl NlmsCanceller {
    fn new() -> Self {
        Self {
            weights: vec![0.0; AEC_FILTER_TAPS],
            x_history: VecDeque::from(vec![0.0; AEC_FILTER_TAPS]),
            reference_history: VecDeque::new(),
            estimated_delay_samples: AEC_MIN_DELAY_CHUNKS * CHUNK_SAMPLES,
            delay_locked: false,
            delay_score: 0.0,
            poor_delay_checks: 0,
            blocks_until_delay_scan: 0,
        }
    }

    fn process_block(&mut self, near: &[f32], reference_now: &[f32]) -> Vec<f32> {
        for sample in reference_now {
            self.reference_history.push_back(*sample);
        }
        while self.reference_history.len()
            > CHUNK_SAMPLES * (AEC_MAX_DELAY_CHUNKS + 4)
        {
            let _ = self.reference_history.pop_front();
        }

        self.update_delay_lock(near);

        let reference = self.delayed_reference_block(near.len());
        let mut output = Vec::with_capacity(near.len());

        for (near_sample, reference_sample) in near.iter().zip(reference.iter()) {
            let _ = self.x_history.pop_back();
            self.x_history.push_front(*reference_sample);

            let estimate = self
                .weights
                .iter()
                .zip(self.x_history.iter())
                .map(|(weight, x)| *weight * *x)
                .sum::<f32>();
            let error = *near_sample - estimate;
            let norm = self
                .x_history
                .iter()
                .map(|x| *x * *x)
                .sum::<f32>()
                + AEC_EPSILON;
            let step = AEC_MU * error / norm;

            for (weight, x) in self.weights.iter_mut().zip(self.x_history.iter()) {
                *weight += step * *x;
            }

            output.push(error.clamp(-1.0, 1.0));
        }

        output
    }

    fn update_delay_lock(&mut self, near: &[f32]) {
        if self.reference_history.len()
            < near.len() + AEC_MIN_DELAY_CHUNKS * CHUNK_SAMPLES
        {
            return;
        }

        if self.blocks_until_delay_scan > 0 {
            self.blocks_until_delay_scan -= 1;
            return;
        }

        if !self.delay_locked {
            let estimate = self.estimate_delay(near);
            self.apply_delay_estimate(estimate);
            if self.delay_score >= AEC_DELAY_LOCK_MIN_SCORE {
                self.delay_locked = true;
                self.poor_delay_checks = 0;
                self.blocks_until_delay_scan = AEC_DELAY_RESCAN_BLOCKS;
            } else {
                self.blocks_until_delay_scan = 5;
            }
            return;
        }

        self.delay_score = self.score_delay(near, self.estimated_delay_samples);
        if self.delay_score < AEC_DELAY_UNLOCK_SCORE {
            self.poor_delay_checks = self.poor_delay_checks.saturating_add(1);
        } else {
            self.poor_delay_checks = 0;
        }

        if self.poor_delay_checks >= AEC_DELAY_UNLOCK_CHECKS {
            self.delay_locked = false;
            self.poor_delay_checks = 0;
            let estimate = self.estimate_delay(near);
            self.apply_delay_estimate(estimate);
            if self.delay_score >= AEC_DELAY_LOCK_MIN_SCORE {
                self.delay_locked = true;
                self.blocks_until_delay_scan = AEC_DELAY_RESCAN_BLOCKS;
            }
        } else {
            self.blocks_until_delay_scan = AEC_DELAY_RESCAN_BLOCKS;
        }
    }

    fn apply_delay_estimate(&mut self, estimate: DelayEstimate) {
        if self.estimated_delay_samples.abs_diff(estimate.delay_samples) >= CHUNK_SAMPLES {
            self.weights.fill(0.0);
            self.x_history = VecDeque::from(vec![0.0; AEC_FILTER_TAPS]);
        }
        self.estimated_delay_samples = estimate.delay_samples;
        self.delay_score = estimate.score;
    }

    fn estimate_delay(&self, near: &[f32]) -> DelayEstimate {
        let mut best = DelayEstimate {
            delay_samples: AEC_MIN_DELAY_CHUNKS * CHUNK_SAMPLES,
            score: 0.0,
        };
        if self.reference_history.len() < near.len() + best.delay_samples {
            return best;
        }

        let near_energy = near.iter().map(|v| *v * *v).sum::<f32>().sqrt() + AEC_EPSILON;

        for delay_chunks in AEC_MIN_DELAY_CHUNKS..=AEC_MAX_DELAY_CHUNKS {
            let delay_samples = delay_chunks * CHUNK_SAMPLES;
            if self.reference_history.len() < near.len() + delay_samples {
                continue;
            }

            let score = self.score_delay_with_near_energy(near, near_energy, delay_samples);
            if score > best.score {
                best = DelayEstimate {
                    delay_samples,
                    score,
                };
            }
        }

        best
    }

    fn score_delay(&self, near: &[f32], delay_samples: usize) -> f32 {
        if self.reference_history.len() < near.len() + delay_samples {
            return 0.0;
        }

        let near_energy = near.iter().map(|v| *v * *v).sum::<f32>().sqrt() + AEC_EPSILON;
        self.score_delay_with_near_energy(near, near_energy, delay_samples)
    }

    fn score_delay_with_near_energy(
        &self,
        near: &[f32],
        near_energy: f32,
        delay_samples: usize,
    ) -> f32 {
        let start = self.reference_history.len() - near.len() - delay_samples;
        let mut dot = 0.0f32;
        let mut ref_energy = AEC_EPSILON;
        for (i, near_sample) in near.iter().enumerate() {
            let reference_sample = self.reference_history[start + i];
            dot += *near_sample * reference_sample;
            ref_energy += reference_sample * reference_sample;
        }

        dot.abs() / (near_energy * ref_energy.sqrt())
    }

    fn delayed_reference_block(&self, len: usize) -> Vec<f32> {
        let delay = self.estimated_delay_samples;
        if self.reference_history.len() < len + delay {
            return vec![0.0; len];
        }

        let start = self.reference_history.len() - len - delay;
        (0..len)
            .map(|i| self.reference_history[start + i])
            .collect()
    }
}

fn samples_to_chunk_bytes(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(CHUNK_BYTES);
    for sample in samples.iter().take(CHUNK_SAMPLES) {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    while out.len() < CHUNK_BYTES {
        out.extend_from_slice(&0.0f32.to_le_bytes());
    }
    out
}

fn energy_db(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return -120.0;
    }
    let mean_square = samples.iter().map(|v| *v * *v).sum::<f32>() / samples.len() as f32;
    10.0 * (mean_square + 1.0e-12).log10()
}

fn spawn_spike_capture_thread(
    label: &'static str,
    source: SpikeCaptureSource,
    stream: SpikeStream,
    shared: Arc<SharedCaptureBuffers>,
    stop_event: SendHandle,
    log_path: String,
    verdict_tx: Sender<(&'static str, bool)>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let stop_handle = stop_event;
        append_diag(Some(&log_path), format!("{label} capture thread starting"));

        let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let com_ok = com.is_ok();
        append_diag(Some(&log_path), format!("{label} CoInitializeEx ok={com_ok}"));

        let activation = unsafe {
            match source {
                SpikeCaptureSource::DefaultRenderEndpoint => {
                    activate_default_render_endpoint_loopback(Some(&log_path))
                }
                SpikeCaptureSource::IncludeProcessTree(pid) => {
                    activate_include_tree(pid, Some(&log_path))
                }
            }
        };

        match activation {
            ActivationResult::Activated(client) => {
                let _ = verdict_tx.send((label, true));
                append_diag(Some(&log_path), format!("{label} capture loop entering"));
                unsafe {
                    run_capture_loop_with_sink(client, stop_handle.0, |chunk| {
                        shared.push_chunk(stream, chunk);
                    });
                }
                append_diag(Some(&log_path), format!("{label} capture loop exited"));
            }
            ActivationResult::Unsupported => {
                let _ = verdict_tx.send((label, false));
                append_diag(Some(&log_path), format!("{label} activation unsupported"));
            }
        }

        if com_ok {
            unsafe { CoUninitialize() };
        }
        append_diag(Some(&log_path), format!("{label} capture thread exiting"));
    })
}

fn spawn_canceller_thread(
    shared: Arc<SharedCaptureBuffers>,
    stop_event: SendHandle,
    log_path: String,
    on_chunk: ChunkTsfn,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let stop_handle = stop_event;
        append_diag(Some(&log_path), "aec canceller thread starting");
        let mut canceller = NlmsCanceller::new();
        let started = Instant::now();
        let mut last_log = Instant::now();
        let mut last_delay = usize::MAX;
        let mut last_delay_locked = false;

        while unsafe { WaitForSingleObject(stop_handle.0, 0) } != WAIT_OBJECT_0 {
            let Some(block) = shared.wait_pop_block(stop_handle.0) else {
                break;
            };

            let output = canceller.process_block(&block.endpoint, &block.reference);
            let before_db = energy_db(&block.endpoint);
            let after_db = energy_db(&output);
            on_chunk.call(
                Ok(samples_to_chunk_bytes(&output).into()),
                ThreadsafeFunctionCallMode::NonBlocking,
            );

            if canceller.estimated_delay_samples != last_delay
                || canceller.delay_locked != last_delay_locked
            {
                last_delay = canceller.estimated_delay_samples;
                last_delay_locked = canceller.delay_locked;
                append_diag(
                    Some(&log_path),
                    format!(
                        "aec delay-state samples={last_delay} locked={} score={:.3}",
                        canceller.delay_locked, canceller.delay_score
                    ),
                );
            }

            if last_log.elapsed() >= Duration::from_secs(1) {
                let aec_locked = block.aligned && canceller.delay_locked;
                let alignment_delta_ms = block.alignment_delta_100ns as f64 / 10_000.0;
                append_diag(
                    Some(&log_path),
                    format!(
                        "aec heartbeat elapsed_ms={} before_db={before_db:.2} after_db={after_db:.2} reduction_db={:.2} delay_samples={} endpoint_buffered_samples={} reference_buffered_samples={} aligned={} delay_locked={} aec_locked={} alignment_delta_ms={:.2} device_delta_frames={} delay_score={:.3} dropped_endpoint_chunks={} dropped_reference_chunks={}",
                        started.elapsed().as_millis(),
                        before_db - after_db,
                        canceller.estimated_delay_samples,
                        block.endpoint_buffered_samples,
                        block.reference_buffered_samples,
                        block.aligned,
                        canceller.delay_locked,
                        aec_locked,
                        alignment_delta_ms,
                        block.device_delta_frames,
                        canceller.delay_score,
                        block.dropped_endpoint_chunks,
                        block.dropped_reference_chunks
                    ),
                );
                last_log = Instant::now();
            }
        }

        append_diag(Some(&log_path), "aec canceller thread exiting");
    })
}

// ─── napi surface ───────────────────────────────────────────────────────────────────

/// Begin process-tree EXCLUDE loopback capture, excluding the tree rooted at
/// `exclude_root_pid` (pass the Electron MAIN process PID — EXCLUDE_TARGET_PROCESS_TREE
/// covers the whole tree incl. the separate "Audio Service" utility child). `on_chunk`
/// receives 480-frame (3840-byte) interleaved-stereo f32 buffers, ~one per 10 ms.
///
/// Returns `false` (NOT an error) when the API is unavailable on this build OR activation
/// fails for any reason — the caller then falls back to Electron "loopback" (ECHO-03).
#[napi]
pub fn start(exclude_root_pid: u32, on_chunk: ChunkTsfn) -> napi::Result<bool> {
    let mut guard = SESSION.lock().unwrap_or_else(|p| p.into_inner());
    // Idempotent: a session already running counts as "started".
    if guard.is_some() {
        return Ok(true);
    }

    // Stop event the capture thread polls. Created here so `stop()` can signal it even if
    // the thread is still activating.
    // Manual-reset stop event the capture loop polls; unsignaled initially.
    let stop_event = match unsafe { CreateEventW(None, true, false, PCWSTR::null()) } {
        Ok(h) => h,
        Err(_) => return Ok(false),
    };

    // Activation is COM-apartment-affine, so run it ON the capture thread and report the
    // outcome back over a channel; `start` returns the real support verdict.
    let (tx, rx): (Sender<bool>, _) = channel();
    let stop_event_for_thread = SendHandle(stop_event);

    let join = std::thread::spawn(move || {
        // Capture the whole SendHandle (Send), not its inner HANDLE field — Rust 2021's
        // disjoint closure capture would otherwise grab the non-Send `.0` directly.
        let stop_handle = stop_event_for_thread;

        // COM on the capture thread (MTA — no message pump needed for WASAPI capture).
        let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        // CoInitializeEx returns an HRESULT; S_FALSE means "already initialized" (still ok).
        let com_ok = com.is_ok();

        let activation = unsafe { activate_exclude_tree(exclude_root_pid) };
        match activation {
            ActivationResult::Activated(client) => {
                // Report support BEFORE entering the (blocking) capture loop.
                let _ = tx.send(true);
                unsafe { run_capture_loop(client, on_chunk, stop_handle.0) };
            }
            ActivationResult::Unsupported => {
                let _ = tx.send(false);
            }
        }

        if com_ok {
            unsafe { CoUninitialize() };
        }
    });

    // Wait for the activation verdict from the capture thread.
    let supported = rx.recv().unwrap_or(false);
    if !supported {
        // Unsupported: tear the (now-exiting) thread down and clean up the stop event.
        unsafe {
            let _ = SetEvent(stop_event);
        }
        let _ = join.join();
        unsafe {
            let _ = CloseHandle(stop_event);
        }
        return Ok(false);
    }

    *guard = Some(CaptureSession {
        stop_event,
        joins: vec![join],
        log_path: None,
    });
    Ok(true)
}

/// Spike export: capture the default render endpoint (A) and the caller's process tree
/// INCLUDE loopback (B) concurrently, then emit A minus an adaptive estimate of B.
/// Diagnostics are appended to `log_path`.
#[napi(js_name = "startEndpointMinusSelf")]
pub fn start_endpoint_minus_self(
    self_pid: u32,
    log_path: String,
    on_chunk: ChunkTsfn,
) -> napi::Result<bool> {
    let mut guard = SESSION.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_some() {
        append_diag(
            Some(&log_path),
            "startEndpointMinusSelf called while a capture session is already running",
        );
        return Ok(true);
    }

    append_diag(
        Some(&log_path),
        format!("startEndpointMinusSelf self_pid={self_pid}"),
    );

    let stop_event = match unsafe { CreateEventW(None, true, false, PCWSTR::null()) } {
        Ok(h) => h,
        Err(err) => {
            append_diag(Some(&log_path), format!("stop event create failed: {err:?}"));
            return Ok(false);
        }
    };
    let stop_event_for_endpoint = SendHandle(stop_event);
    let stop_event_for_reference = SendHandle(stop_event);
    let stop_event_for_canceller = SendHandle(stop_event);

    let shared = Arc::new(SharedCaptureBuffers::new());
    let (tx, rx): (Sender<(&'static str, bool)>, _) = channel();

    let endpoint_join = spawn_spike_capture_thread(
        "endpoint",
        SpikeCaptureSource::DefaultRenderEndpoint,
        SpikeStream::Endpoint,
        Arc::clone(&shared),
        stop_event_for_endpoint,
        log_path.clone(),
        tx.clone(),
    );
    let reference_join = spawn_spike_capture_thread(
        "process-include",
        SpikeCaptureSource::IncludeProcessTree(self_pid),
        SpikeStream::Reference,
        Arc::clone(&shared),
        stop_event_for_reference,
        log_path.clone(),
        tx,
    );
    let canceller_join =
        spawn_canceller_thread(shared, stop_event_for_canceller, log_path.clone(), on_chunk);

    let mut endpoint_ok = false;
    let mut reference_ok = false;
    for _ in 0..2 {
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(("endpoint", ok)) => endpoint_ok = ok,
            Ok(("process-include", ok)) => reference_ok = ok,
            Ok((label, ok)) => append_diag(
                Some(&log_path),
                format!("unexpected activation verdict label={label} ok={ok}"),
            ),
            Err(err) => {
                append_diag(Some(&log_path), format!("activation verdict wait failed: {err:?}"));
                break;
            }
        }
    }

    if !(endpoint_ok && reference_ok) {
        append_diag(
            Some(&log_path),
            format!(
                "concurrency failed endpoint_ok={endpoint_ok} process_include_ok={reference_ok}"
            ),
        );
        unsafe {
            let _ = SetEvent(stop_event);
        }
        join_all_with_timeout(vec![endpoint_join, reference_join, canceller_join]);
        unsafe {
            let _ = CloseHandle(stop_event);
        }
        return Ok(false);
    }

    append_diag(
        Some(&log_path),
        "concurrency ok: endpoint and process-include captures active; aec canceller running",
    );

    *guard = Some(CaptureSession {
        stop_event,
        joins: vec![endpoint_join, reference_join, canceller_join],
        log_path: Some(log_path),
    });
    Ok(true)
}

/// Stop capture: signal the capture thread to exit, then join it with a bounded timeout
/// so a hung native teardown can't wedge the caller (composes with the JS wrapper's
/// before-quit Promise.race). Idempotent — a no-op if nothing is running.
#[napi]
pub fn stop() {
    let session = {
        let mut guard = SESSION.lock().unwrap_or_else(|p| p.into_inner());
        guard.take()
    };

    let Some(mut session) = session else {
        return; // idempotent: nothing running.
    };

    append_diag(session.log_path.as_deref(), "stop signaled");

    // Signal the capture loop to exit.
    unsafe {
        let _ = SetEvent(session.stop_event);
    }

    // Join with a bounded timeout: poll is_finished() rather than block forever.
    join_all_with_timeout(std::mem::take(&mut session.joins));

    unsafe {
        let _ = CloseHandle(session.stop_event);
    }
    append_diag(session.log_path.as_deref(), "stop completed");
}
