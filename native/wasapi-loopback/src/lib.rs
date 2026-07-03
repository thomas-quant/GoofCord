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
    eConsole, eRender, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, DEVICE_STATE_ACTIVE, PROCESS_LOOPBACK_MODE,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVEFORMATEXTENSIBLE_0,
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

// Milestone 999.1 endpoint-minus-self AEC knobs. Keep the transport contract fixed;
// these only control delay calibration and adaptive-filter safety.
const QPC_100NS_PER_SEC: u64 = 10_000_000;
const AEC_FILTER_TAPS: usize = 128;
const AEC_MU: f32 = 0.18;
const AEC_MAX_STEP: f32 = 0.04;
const AEC_EPSILON: f32 = 1.0e-6;
const AEC_TAP_LEAKAGE_PER_BLOCK: f32 = 0.999;
const AEC_ALIGNMENT_MAX_BUFFER_CHUNKS: usize = 18; // ~180 ms cap per capture stream.
const AEC_ALIGNMENT_TOLERANCE_100NS: i128 = 150_000; // 15 ms timestamp match window.
const AEC_REFERENCE_ACTIVE_DB: f32 = -60.0;
const AEC_ENDPOINT_ACTIVE_DB: f32 = -70.0;
const AEC_PRIOR_HALF_WINDOW_MS: f32 = 20.0;
const AEC_PRIOR_MAX_CONSISTENT_MS: f32 = 200.0;
const AEC_FALLBACK_MIN_DELAY_MS: f32 = 10.0;
const AEC_FALLBACK_MAX_DELAY_MS: f32 = 140.0;
const AEC_CALIBRATION_TARGET_BLOCKS: usize = 200; // ~2 s.
const AEC_CALIBRATION_MAX_BLOCKS: usize = 300; // ~3 s before retrying.
const AEC_CALIBRATION_MIN_ACTIVE_RATIO: f32 = 0.60;
const AEC_CALIBRATION_INACTIVE_RESET_BLOCKS: usize = 30;
const AEC_CALIBRATION_COARSE_STEP_FRAMES: usize = 16;
const AEC_CALIBRATION_SUBWINDOWS: usize = 3;
const AEC_CALIBRATION_MIN_SCORE: f32 = 0.08;
const AEC_CALIBRATION_MIN_PEAK_GAP: f32 = 0.015;
const AEC_CALIBRATION_MIN_PEAK_RATIO: f32 = 1.20;
const AEC_CALIBRATION_PEAK_EXCLUSION_FRAMES: usize = (SAMPLE_RATE as usize * 4) / 1000;
const AEC_CALIBRATION_SUBWINDOW_AGREE_FRAMES: usize = (SAMPLE_RATE as usize * 12) / 1000;
const AEC_REFERENCE_RING_MAX_BLOCKS: usize = 450; // ~4.5 s.
const AEC_RING_CONTIGUITY_TOLERANCE_100NS: i128 = 20_000; // 2 ms.
const AEC_STREAM_GAP_RECALIBRATE_100NS: i128 = 2_500_000; // 250 ms.
const AEC_WATCHDOG_LOW_ERLE_BLOCKS: usize = 300; // sustained ~3 s.
const AEC_WATCHDOG_MIN_REDUCTION_DB: f32 = 1.0;
const AEC_REFERENCE_MISS_RECALIBRATE_BLOCKS: usize = 50;

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
        append_diag(
            log_path,
            format!("{label} activation unsupported: entrypoint missing"),
        );
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
            append_diag(
                log_path,
                format!("{label} activation event failed: {err:?}"),
            );
            return ActivationResult::Unsupported;
        }
    };
    let handler: IActivateAudioInterfaceCompletionHandler = CompletionHandler { done }.into();

    // 5. Fire the async activation against the process-loopback magic device.
    let operation: IActivateAudioInterfaceAsyncOperation = match ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        &IAudioClient::IID,
        Some(&*prop),
        &handler,
    ) {
        Ok(op) => op,
        Err(err) => {
            append_diag(
                log_path,
                format!("{label} ActivateAudioInterfaceAsync failed: {err:?}"),
            );
            let _ = CloseHandle(done);
            return ActivationResult::Unsupported;
        }
    };

    // 6. Wait for completion, then read the activation result. ANY non-S_OK => Unsupported.
    let wait = WaitForSingleObject(done, INFINITE);
    let _ = CloseHandle(done);
    if wait != WAIT_OBJECT_0 {
        append_diag(
            log_path,
            format!("{label} activation wait failed: wait={wait:?}"),
        );
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
            append_diag(
                log_path,
                format!("{label} activation returned no IAudioClient"),
            );
            return ActivationResult::Unsupported;
        }
    };

    // 7. Initialize to the fixed GoofCord transport format.
    if !initialize_loopback_client(&audio_client) {
        append_diag(log_path, format!("{label} Initialize failed"));
        return ActivationResult::Unsupported;
    }
    append_diag(
        log_path,
        format!("{label} Initialize ok hr={}", format_hr(S_OK)),
    );

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
                append_diag(
                    log_path,
                    format!("endpoint CoCreateInstance failed: {err:?}"),
                );
                return ActivationResult::Unsupported;
            }
        };
    append_diag(
        log_path,
        format!("endpoint MMDeviceEnumerator ok hr={}", format_hr(S_OK)),
    );

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
            append_diag(
                log_path,
                format!("endpoint Activate(IAudioClient) failed: {err:?}"),
            );
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
    append_diag(
        log_path,
        format!("endpoint Initialize ok hr={}", format_hr(S_OK)),
    );

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
    ((frames as u128 * QPC_100NS_PER_SEC as u128 + (SAMPLE_RATE as u128 / 2)) / SAMPLE_RATE as u128)
        as u64
}

fn qpc_100ns_to_frames(delta_100ns: u64) -> usize {
    ((delta_100ns as u128 * SAMPLE_RATE as u128 + (QPC_100NS_PER_SEC as u128 / 2))
        / QPC_100NS_PER_SEC as u128) as usize
}

fn qpc_delta_100ns(a: u64, b: u64) -> i128 {
    a as i128 - b as i128
}

fn latency_100ns_to_ms(latency_100ns: Option<i64>) -> Option<f32> {
    let latency_100ns = latency_100ns?;
    if latency_100ns < 0 {
        return None;
    }
    Some(latency_100ns as f32 / 10_000.0)
}

fn ms_to_frames(ms: f32) -> usize {
    ((ms.max(0.0) * SAMPLE_RATE as f32) / 1000.0).round() as usize
}

fn frames_to_ms(frames: usize) -> f32 {
    frames as f32 * 1000.0 / SAMPLE_RATE as f32
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
                    acc_start = Some(packet_timestamp.offset_frames(packet_frame_offset as u64));
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

type SpikeActivationVerdict = (&'static str, bool, Option<i64>);

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
    endpoint_timestamp: CaptureTimestamp,
    reference_timestamp: CaptureTimestamp,
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
            samples.push(f32::from_le_bytes([
                sample[0], sample[1], sample[2], sample[3],
            ]));
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
                Self::trim_queue(
                    &mut buffers.reference,
                    &mut buffers.dropped_reference_chunks,
                );
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
                endpoint_timestamp: endpoint.timestamp,
                reference_timestamp: reference.timestamp,
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

struct AecTimingPrior {
    endpoint_latency_100ns: Option<i64>,
    reference_latency_100ns: Option<i64>,
    api_prior_ms: Option<f32>,
    search_min_frames: usize,
    search_max_frames: usize,
    used_fallback: bool,
}

impl AecTimingPrior {
    fn new(endpoint_latency_100ns: Option<i64>, reference_latency_100ns: Option<i64>) -> Self {
        let endpoint_ms = latency_100ns_to_ms(endpoint_latency_100ns);
        let reference_ms = latency_100ns_to_ms(reference_latency_100ns);
        let mut api_prior_ms = None;
        let mut used_fallback = true;
        let (search_min_ms, search_max_ms) =
            if let (Some(endpoint_ms), Some(reference_ms)) = (endpoint_ms, reference_ms) {
                let prior_ms = (endpoint_ms - reference_ms).max(0.0);
                if prior_ms.is_finite() && prior_ms <= AEC_PRIOR_MAX_CONSISTENT_MS {
                    api_prior_ms = Some(prior_ms);
                    used_fallback = false;
                    (
                        (prior_ms - AEC_PRIOR_HALF_WINDOW_MS).max(0.0),
                        prior_ms + AEC_PRIOR_HALF_WINDOW_MS,
                    )
                } else {
                    (AEC_FALLBACK_MIN_DELAY_MS, AEC_FALLBACK_MAX_DELAY_MS)
                }
            } else {
                (AEC_FALLBACK_MIN_DELAY_MS, AEC_FALLBACK_MAX_DELAY_MS)
            };

        let search_min_frames = ms_to_frames(search_min_ms);
        let search_max_frames = ms_to_frames(search_max_ms).max(search_min_frames + 1);

        Self {
            endpoint_latency_100ns,
            reference_latency_100ns,
            api_prior_ms,
            search_min_frames,
            search_max_frames,
            used_fallback,
        }
    }

    fn describe(&self) -> String {
        format!(
            "endpoint_latency_ms={} process_ref_latency_ms={} api_prior_ms={} search_min_ms={:.2} search_max_ms={:.2} source={}",
            format_optional_ms(latency_100ns_to_ms(self.endpoint_latency_100ns)),
            format_optional_ms(latency_100ns_to_ms(self.reference_latency_100ns)),
            format_optional_ms(self.api_prior_ms),
            frames_to_ms(self.search_min_frames),
            frames_to_ms(self.search_max_frames),
            if self.used_fallback { "fallback" } else { "wasapi" }
        )
    }
}

fn format_optional_ms(value: Option<f32>) -> String {
    value
        .map(|v| format!("{v:.2}"))
        .unwrap_or_else(|| "unavailable".to_string())
}

struct ReferenceRing {
    blocks: VecDeque<TimestampedAudioBlock>,
}

impl ReferenceRing {
    fn new() -> Self {
        Self {
            blocks: VecDeque::new(),
        }
    }

    fn clear(&mut self) {
        self.blocks.clear();
    }

    fn push(&mut self, samples: &[f32], timestamp: CaptureTimestamp) {
        self.blocks.push_back(TimestampedAudioBlock {
            samples: samples.to_vec(),
            timestamp,
        });
        while self.blocks.len() > AEC_REFERENCE_RING_MAX_BLOCKS {
            let _ = self.blocks.pop_front();
        }
    }

    fn read_at_qpc(&self, target_qpc_100ns: u64, frames: usize) -> Option<Vec<f32>> {
        let channel_count = CHANNELS as usize;
        let (mut block_idx, mut frame_offset) = self.find_frame(target_qpc_100ns)?;
        let mut out = Vec::with_capacity(frames * channel_count);
        let mut expected_next_qpc = None;

        while out.len() < frames * channel_count {
            let block = self.blocks.get(block_idx)?;
            if let Some(expected_qpc) = expected_next_qpc {
                let gap = qpc_delta_100ns(block.timestamp.qpc_position_100ns, expected_qpc);
                if abs_i128(gap) > AEC_RING_CONTIGUITY_TOLERANCE_100NS {
                    return None;
                }
            }

            let available_frames = FRAMES_PER_CHUNK.saturating_sub(frame_offset);
            if available_frames == 0 {
                block_idx = block_idx.saturating_add(1);
                frame_offset = 0;
                continue;
            }

            let frames_needed = frames - out.len() / channel_count;
            let frames_to_copy = available_frames.min(frames_needed);
            let sample_start = frame_offset * channel_count;
            let sample_end = sample_start + frames_to_copy * channel_count;
            if sample_end > block.samples.len() {
                return None;
            }

            out.extend_from_slice(&block.samples[sample_start..sample_end]);
            expected_next_qpc = Some(
                block
                    .timestamp
                    .qpc_position_100ns
                    .saturating_add(frames_to_qpc_100ns(FRAMES_PER_CHUNK as u64)),
            );
            block_idx = block_idx.saturating_add(1);
            frame_offset = 0;
        }

        Some(out)
    }

    fn find_frame(&self, target_qpc_100ns: u64) -> Option<(usize, usize)> {
        let chunk_duration_100ns = frames_to_qpc_100ns(FRAMES_PER_CHUNK as u64);
        for (idx, block) in self.blocks.iter().enumerate() {
            let start_qpc = block.timestamp.qpc_position_100ns;
            let end_qpc = start_qpc.saturating_add(chunk_duration_100ns);
            if qpc_delta_100ns(target_qpc_100ns, start_qpc) >= 0
                && qpc_delta_100ns(target_qpc_100ns, end_qpc) < 0
            {
                let offset_100ns = qpc_delta_100ns(target_qpc_100ns, start_qpc) as u64;
                let frame_offset = qpc_100ns_to_frames(offset_100ns);
                if frame_offset < FRAMES_PER_CHUNK {
                    return Some((idx, frame_offset));
                }
            }
        }
        None
    }
}

struct CalibrationWindow {
    endpoint: Vec<f32>,
    reference: Vec<f32>,
    blocks: usize,
    active_blocks: usize,
    inactive_run: usize,
}

impl CalibrationWindow {
    fn new() -> Self {
        Self {
            endpoint: Vec::with_capacity(AEC_CALIBRATION_MAX_BLOCKS * CHUNK_SAMPLES),
            reference: Vec::with_capacity(AEC_CALIBRATION_MAX_BLOCKS * CHUNK_SAMPLES),
            blocks: 0,
            active_blocks: 0,
            inactive_run: 0,
        }
    }

    fn clear(&mut self) {
        self.endpoint.clear();
        self.reference.clear();
        self.blocks = 0;
        self.active_blocks = 0;
        self.inactive_run = 0;
    }

    fn is_empty(&self) -> bool {
        self.blocks == 0
    }

    fn push(&mut self, endpoint: &[f32], reference: &[f32], reference_active: bool) {
        self.endpoint.extend_from_slice(endpoint);
        self.reference.extend_from_slice(reference);
        self.blocks = self.blocks.saturating_add(1);
        if reference_active {
            self.active_blocks = self.active_blocks.saturating_add(1);
            self.inactive_run = 0;
        } else {
            self.inactive_run = self.inactive_run.saturating_add(1);
        }
    }

    fn active_ratio(&self) -> f32 {
        if self.blocks == 0 {
            0.0
        } else {
            self.active_blocks as f32 / self.blocks as f32
        }
    }
}

struct AecProcessStats {
    output: Vec<f32>,
    endpoint_rms_db: f32,
    reference_rms_db: f32,
    output_rms_db: f32,
    reference_active: bool,
}

struct DelayEstimate {
    delay_samples: usize,
    score: f32,
    second_score: f32,
    agreement_count: usize,
    subwindows: usize,
    confident: bool,
}

struct NlmsCanceller {
    weights: Vec<f32>,
    x_history: VecDeque<f32>,
    reference_ring: ReferenceRing,
    calibration: CalibrationWindow,
    timing_prior: AecTimingPrior,
    estimated_delay_samples: usize,
    delay_locked: bool,
    delay_score: f32,
    aec_reset_count: u64,
    poor_residual_blocks: usize,
    reference_read_miss_blocks: usize,
    last_endpoint_qpc: Option<u64>,
    last_reference_qpc: Option<u64>,
    events: VecDeque<String>,
}

impl NlmsCanceller {
    fn new(timing_prior: AecTimingPrior) -> Self {
        let estimated_delay_samples = timing_prior.search_min_frames;
        Self {
            weights: vec![0.0; AEC_FILTER_TAPS],
            x_history: VecDeque::from(vec![0.0; AEC_FILTER_TAPS]),
            reference_ring: ReferenceRing::new(),
            calibration: CalibrationWindow::new(),
            estimated_delay_samples,
            delay_locked: false,
            delay_score: 0.0,
            aec_reset_count: 0,
            poor_residual_blocks: 0,
            reference_read_miss_blocks: 0,
            last_endpoint_qpc: None,
            last_reference_qpc: None,
            events: VecDeque::new(),
            timing_prior,
        }
    }

    fn process_block(&mut self, block: &AlignedCaptureBlock) -> AecProcessStats {
        self.observe_stream_continuity(block);
        self.reference_ring
            .push(&block.reference, block.reference_timestamp);

        let endpoint_rms_db = energy_db(&block.endpoint);
        let reference_rms_db = energy_db(&block.reference);
        let reference_active = reference_rms_db > AEC_REFERENCE_ACTIVE_DB;

        if !self.delay_locked {
            self.update_calibration(block, reference_active);
            self.leak_weights();
            return AecProcessStats {
                output: block.endpoint.clone(),
                endpoint_rms_db,
                reference_rms_db,
                output_rms_db: endpoint_rms_db,
                reference_active,
            };
        }

        if !reference_active {
            self.poor_residual_blocks = 0;
            self.leak_weights();
            return AecProcessStats {
                output: block.endpoint.clone(),
                endpoint_rms_db,
                reference_rms_db,
                output_rms_db: endpoint_rms_db,
                reference_active,
            };
        }

        let delay_100ns = frames_to_qpc_100ns(self.estimated_delay_samples as u64);
        let target_qpc = block
            .endpoint_timestamp
            .qpc_position_100ns
            .saturating_sub(delay_100ns);
        let Some(reference) = self
            .reference_ring
            .read_at_qpc(target_qpc, FRAMES_PER_CHUNK)
        else {
            self.reference_read_miss_blocks = self.reference_read_miss_blocks.saturating_add(1);
            if self.reference_read_miss_blocks >= AEC_REFERENCE_MISS_RECALIBRATE_BLOCKS {
                self.begin_recalibration("reference_ring_read_miss");
            }
            self.leak_weights();
            return AecProcessStats {
                output: block.endpoint.clone(),
                endpoint_rms_db,
                reference_rms_db,
                output_rms_db: endpoint_rms_db,
                reference_active,
            };
        };
        self.reference_read_miss_blocks = 0;

        if energy_db(&reference) <= AEC_REFERENCE_ACTIVE_DB {
            self.leak_weights();
            let output_rms_db = endpoint_rms_db;
            self.update_residual_watchdog(reference_active, endpoint_rms_db, output_rms_db);
            return AecProcessStats {
                output: block.endpoint.clone(),
                endpoint_rms_db,
                reference_rms_db,
                output_rms_db,
                reference_active,
            };
        }

        let output = self.apply_nlms(&block.endpoint, &reference);
        let output_rms_db = energy_db(&output);
        self.update_residual_watchdog(reference_active, endpoint_rms_db, output_rms_db);

        AecProcessStats {
            output,
            endpoint_rms_db,
            reference_rms_db,
            output_rms_db,
            reference_active,
        }
    }

    fn take_event(&mut self) -> Option<String> {
        self.events.pop_front()
    }

    fn observe_stream_continuity(&mut self, block: &AlignedCaptureBlock) {
        let endpoint_gap = self.stream_gap_exceeded(
            self.last_endpoint_qpc,
            block.endpoint_timestamp.qpc_position_100ns,
        );
        let reference_gap = self.stream_gap_exceeded(
            self.last_reference_qpc,
            block.reference_timestamp.qpc_position_100ns,
        );

        self.last_endpoint_qpc = Some(block.endpoint_timestamp.qpc_position_100ns);
        self.last_reference_qpc = Some(block.reference_timestamp.qpc_position_100ns);

        if endpoint_gap {
            self.begin_recalibration("endpoint_qpc_gap");
        } else if reference_gap {
            self.begin_recalibration("reference_qpc_gap");
        }
    }

    fn stream_gap_exceeded(&self, previous_qpc: Option<u64>, current_qpc: u64) -> bool {
        let Some(previous_qpc) = previous_qpc else {
            return false;
        };
        let expected_qpc =
            previous_qpc.saturating_add(frames_to_qpc_100ns(FRAMES_PER_CHUNK as u64));
        abs_i128(qpc_delta_100ns(current_qpc, expected_qpc)) > AEC_STREAM_GAP_RECALIBRATE_100NS
    }

    fn update_calibration(&mut self, block: &AlignedCaptureBlock, reference_active: bool) {
        if self.calibration.is_empty() {
            if !reference_active {
                return;
            }
            self.events.push_back(format!(
                "calibration starting search_min_ms={:.2} search_max_ms={:.2}",
                frames_to_ms(self.timing_prior.search_min_frames),
                frames_to_ms(self.timing_prior.search_max_frames)
            ));
        }

        self.calibration
            .push(&block.endpoint, &block.reference, reference_active);

        if self.calibration.inactive_run >= AEC_CALIBRATION_INACTIVE_RESET_BLOCKS {
            self.events.push_back(format!(
                "calibration reset reason=reference_inactive blocks={} active_ratio={:.2}",
                self.calibration.blocks,
                self.calibration.active_ratio()
            ));
            self.calibration.clear();
            return;
        }

        if self.calibration.blocks < AEC_CALIBRATION_TARGET_BLOCKS {
            return;
        }

        let active_ratio = self.calibration.active_ratio();
        if active_ratio < AEC_CALIBRATION_MIN_ACTIVE_RATIO {
            if self.calibration.blocks >= AEC_CALIBRATION_MAX_BLOCKS {
                self.events.push_back(format!(
                    "calibration retry reason=low_reference_activity blocks={} active_ratio={active_ratio:.2}",
                    self.calibration.blocks
                ));
                self.calibration.clear();
            }
            return;
        }

        let estimate = estimate_calibration_delay(
            &self.calibration.endpoint,
            &self.calibration.reference,
            self.timing_prior.search_min_frames,
            self.timing_prior.search_max_frames,
        );
        self.delay_score = estimate.score;

        if estimate.confident {
            self.lock_delay(estimate);
        } else {
            self.events.push_back(format!(
                "calibration retry reason=low_confidence score={:.3} second_score={:.3} agreement={}/{} blocks={} active_ratio={active_ratio:.2}",
                estimate.score,
                estimate.second_score,
                estimate.agreement_count,
                estimate.subwindows,
                self.calibration.blocks
            ));
            self.calibration.clear();
        }
    }

    fn lock_delay(&mut self, estimate: DelayEstimate) {
        self.estimated_delay_samples = estimate.delay_samples;
        self.delay_locked = true;
        self.delay_score = estimate.score;
        self.poor_residual_blocks = 0;
        self.reference_read_miss_blocks = 0;
        self.reset_filter();
        self.events.push_back(format!(
            "calibration locked delay_samples={} delay_ms={:.2} score={:.3} second_score={:.3} agreement={}/{} reset_count={}",
            self.estimated_delay_samples,
            frames_to_ms(self.estimated_delay_samples),
            estimate.score,
            estimate.second_score,
            estimate.agreement_count,
            estimate.subwindows,
            self.aec_reset_count
        ));
        self.calibration.clear();
    }

    fn begin_recalibration(&mut self, reason: &'static str) {
        self.delay_locked = false;
        self.delay_score = 0.0;
        self.poor_residual_blocks = 0;
        self.reference_read_miss_blocks = 0;
        self.calibration.clear();
        self.reference_ring.clear();
        self.reset_filter();
        self.events.push_back(format!(
            "recalibration reason={reason} reset_count={}",
            self.aec_reset_count
        ));
    }

    fn reset_filter(&mut self) {
        self.weights.fill(0.0);
        self.x_history = VecDeque::from(vec![0.0; AEC_FILTER_TAPS]);
        self.aec_reset_count = self.aec_reset_count.saturating_add(1);
    }

    fn leak_weights(&mut self) {
        for weight in self.weights.iter_mut() {
            *weight *= AEC_TAP_LEAKAGE_PER_BLOCK;
        }
    }

    fn apply_nlms(&mut self, near: &[f32], reference: &[f32]) -> Vec<f32> {
        self.leak_weights();
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
            let norm = self.x_history.iter().map(|x| *x * *x).sum::<f32>() + AEC_EPSILON;
            let step = (AEC_MU * error / norm).clamp(-AEC_MAX_STEP, AEC_MAX_STEP);

            for (weight, x) in self.weights.iter_mut().zip(self.x_history.iter()) {
                *weight += step * *x;
            }

            output.push(error.clamp(-1.0, 1.0));
        }

        output
    }

    fn update_residual_watchdog(
        &mut self,
        reference_active: bool,
        endpoint_rms_db: f32,
        output_rms_db: f32,
    ) {
        if !self.delay_locked || !reference_active || endpoint_rms_db <= AEC_ENDPOINT_ACTIVE_DB {
            self.poor_residual_blocks = 0;
            return;
        }

        let reduction_db = endpoint_rms_db - output_rms_db;
        if reduction_db < AEC_WATCHDOG_MIN_REDUCTION_DB {
            self.poor_residual_blocks = self.poor_residual_blocks.saturating_add(1);
            if self.poor_residual_blocks >= AEC_WATCHDOG_LOW_ERLE_BLOCKS {
                self.begin_recalibration("sustained_low_erle");
            }
        } else {
            self.poor_residual_blocks = 0;
        }
    }
}

fn estimate_calibration_delay(
    endpoint: &[f32],
    reference: &[f32],
    search_min_frames: usize,
    search_max_frames: usize,
) -> DelayEstimate {
    let endpoint_mono = preprocess_mono(downmix_mono(endpoint));
    let reference_mono = preprocess_mono(downmix_mono(reference));
    let mut full = find_best_delay_in_mono(
        &endpoint_mono,
        &reference_mono,
        search_min_frames,
        search_max_frames,
        AEC_CALIBRATION_COARSE_STEP_FRAMES,
    );

    let mut agreement_count = 0usize;
    let mut subwindows = 0usize;
    let subwindow_len = endpoint_mono.len() / AEC_CALIBRATION_SUBWINDOWS.max(1);
    for idx in 0..AEC_CALIBRATION_SUBWINDOWS {
        let start = idx * subwindow_len;
        let end = if idx + 1 == AEC_CALIBRATION_SUBWINDOWS {
            endpoint_mono.len()
        } else {
            (idx + 1) * subwindow_len
        };
        if end <= start || end - start <= search_max_frames + FRAMES_PER_CHUNK {
            continue;
        }

        let sub = find_best_delay_in_mono(
            &endpoint_mono[start..end],
            &reference_mono[start..end],
            search_min_frames,
            search_max_frames,
            AEC_CALIBRATION_COARSE_STEP_FRAMES * 2,
        );
        subwindows = subwindows.saturating_add(1);
        if sub.score >= AEC_CALIBRATION_MIN_SCORE * 0.75
            && sub.delay_samples.abs_diff(full.delay_samples)
                <= AEC_CALIBRATION_SUBWINDOW_AGREE_FRAMES
        {
            agreement_count = agreement_count.saturating_add(1);
        }
    }

    let peak_separated = full.score - full.second_score >= AEC_CALIBRATION_MIN_PEAK_GAP
        || full.score / full.second_score.max(AEC_EPSILON) >= AEC_CALIBRATION_MIN_PEAK_RATIO;
    full.agreement_count = agreement_count;
    full.subwindows = subwindows;
    full.confident =
        full.score >= AEC_CALIBRATION_MIN_SCORE && peak_separated && agreement_count >= 2;
    full
}

fn find_best_delay_in_mono(
    endpoint: &[f32],
    reference: &[f32],
    search_min_frames: usize,
    search_max_frames: usize,
    coarse_step_frames: usize,
) -> DelayEstimate {
    let max_valid_delay = endpoint
        .len()
        .min(reference.len())
        .saturating_sub(FRAMES_PER_CHUNK);
    let min_delay = search_min_frames.min(max_valid_delay);
    let max_delay = search_max_frames.min(max_valid_delay);
    if min_delay > max_delay {
        return DelayEstimate {
            delay_samples: search_min_frames,
            score: 0.0,
            second_score: 0.0,
            agreement_count: 0,
            subwindows: 0,
            confident: false,
        };
    }

    let coarse_step = coarse_step_frames.max(1);
    let mut best_delay = min_delay;
    let mut best_score = 0.0f32;
    let mut delay = min_delay;
    loop {
        let score = normalized_delay_score(endpoint, reference, delay);
        if score > best_score {
            best_score = score;
            best_delay = delay;
        }
        if delay == max_delay {
            break;
        }
        delay = delay.saturating_add(coarse_step).min(max_delay);
    }

    let refine_min = best_delay.saturating_sub(coarse_step).max(min_delay);
    let refine_max = best_delay.saturating_add(coarse_step).min(max_delay);
    for delay in refine_min..=refine_max {
        let score = normalized_delay_score(endpoint, reference, delay);
        if score > best_score {
            best_score = score;
            best_delay = delay;
        }
    }

    let mut second_score = 0.0f32;
    let exclusion = AEC_CALIBRATION_PEAK_EXCLUSION_FRAMES.max(coarse_step);
    let mut delay = min_delay;
    loop {
        if delay.abs_diff(best_delay) > exclusion {
            second_score = second_score.max(normalized_delay_score(endpoint, reference, delay));
        }
        if delay == max_delay {
            break;
        }
        delay = delay.saturating_add(coarse_step).min(max_delay);
    }

    DelayEstimate {
        delay_samples: best_delay,
        score: best_score,
        second_score,
        agreement_count: 0,
        subwindows: 0,
        confident: false,
    }
}

fn normalized_delay_score(endpoint: &[f32], reference: &[f32], delay_samples: usize) -> f32 {
    let len = endpoint.len().min(reference.len());
    if len <= delay_samples + FRAMES_PER_CHUNK {
        return 0.0;
    }

    let mut dot = 0.0f64;
    let mut endpoint_energy = AEC_EPSILON as f64;
    let mut reference_energy = AEC_EPSILON as f64;
    for i in delay_samples..len {
        let endpoint_sample = endpoint[i] as f64;
        let reference_sample = reference[i - delay_samples] as f64;
        dot += endpoint_sample * reference_sample;
        endpoint_energy += endpoint_sample * endpoint_sample;
        reference_energy += reference_sample * reference_sample;
    }

    (dot.abs() / (endpoint_energy.sqrt() * reference_energy.sqrt())) as f32
}

fn downmix_mono(samples: &[f32]) -> Vec<f32> {
    samples
        .chunks_exact(CHANNELS as usize)
        .map(|frame| frame.iter().sum::<f32>() / CHANNELS as f32)
        .collect()
}

fn preprocess_mono(mut samples: Vec<f32>) -> Vec<f32> {
    if samples.is_empty() {
        return samples;
    }

    let mean = samples.iter().sum::<f32>() / samples.len() as f32;
    let mut prev_x = 0.0f32;
    let mut prev_y = 0.0f32;
    for sample in samples.iter_mut() {
        let x = *sample - mean;
        let y = x - prev_x + 0.995 * prev_y;
        *sample = y;
        prev_x = x;
        prev_y = y;
    }
    samples
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
    verdict_tx: Sender<SpikeActivationVerdict>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let stop_handle = stop_event;
        append_diag(Some(&log_path), format!("{label} capture thread starting"));

        let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let com_ok = com.is_ok();
        append_diag(
            Some(&log_path),
            format!("{label} CoInitializeEx ok={com_ok}"),
        );

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
                let stream_latency_100ns = unsafe { client.GetStreamLatency().ok() };
                append_diag(
                    Some(&log_path),
                    format!(
                        "{label} stream_latency_ms={}",
                        format_optional_ms(latency_100ns_to_ms(stream_latency_100ns))
                    ),
                );
                let _ = verdict_tx.send((label, true, stream_latency_100ns));
                append_diag(Some(&log_path), format!("{label} capture loop entering"));
                unsafe {
                    run_capture_loop_with_sink(client, stop_handle.0, |chunk| {
                        shared.push_chunk(stream, chunk);
                    });
                }
                append_diag(Some(&log_path), format!("{label} capture loop exited"));
            }
            ActivationResult::Unsupported => {
                let _ = verdict_tx.send((label, false, None));
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
    timing_prior: AecTimingPrior,
    on_chunk: ChunkTsfn,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let stop_handle = stop_event;
        append_diag(Some(&log_path), "aec canceller thread starting");
        append_diag(
            Some(&log_path),
            format!("aec timing-prior {}", timing_prior.describe()),
        );
        let mut canceller = NlmsCanceller::new(timing_prior);
        let started = Instant::now();
        let mut last_log = Instant::now();
        let mut last_delay = usize::MAX;
        let mut last_delay_locked = false;

        while unsafe { WaitForSingleObject(stop_handle.0, 0) } != WAIT_OBJECT_0 {
            let Some(block) = shared.wait_pop_block(stop_handle.0) else {
                break;
            };

            let stats = canceller.process_block(&block);
            let before_db = stats.endpoint_rms_db;
            let after_db = stats.output_rms_db;
            on_chunk.call(
                Ok(samples_to_chunk_bytes(&stats.output).into()),
                ThreadsafeFunctionCallMode::NonBlocking,
            );

            while let Some(event) = canceller.take_event() {
                append_diag(Some(&log_path), format!("aec {event}"));
            }

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
                        "aec heartbeat elapsed_ms={} before_db={before_db:.2} after_db={after_db:.2} reduction_db={:.2} endpoint_rms_db={:.2} reference_rms_db={:.2} reference_active={} output_rms_db={:.2} aec_reset_count={} delay_samples={} endpoint_buffered_samples={} reference_buffered_samples={} aligned={} delay_locked={} aec_locked={} alignment_delta_ms={:.2} device_delta_frames={} delay_score={:.3} dropped_endpoint_chunks={} dropped_reference_chunks={}",
                        started.elapsed().as_millis(),
                        before_db - after_db,
                        stats.endpoint_rms_db,
                        stats.reference_rms_db,
                        stats.reference_active,
                        stats.output_rms_db,
                        canceller.aec_reset_count,
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
            append_diag(
                Some(&log_path),
                format!("stop event create failed: {err:?}"),
            );
            return Ok(false);
        }
    };
    let stop_event_for_endpoint = SendHandle(stop_event);
    let stop_event_for_reference = SendHandle(stop_event);

    let shared = Arc::new(SharedCaptureBuffers::new());
    let (tx, rx): (Sender<SpikeActivationVerdict>, _) = channel();

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

    let mut endpoint_ok = false;
    let mut reference_ok = false;
    let mut endpoint_latency_100ns = None;
    let mut reference_latency_100ns = None;
    for _ in 0..2 {
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(("endpoint", ok, latency_100ns)) => {
                endpoint_ok = ok;
                endpoint_latency_100ns = latency_100ns;
            }
            Ok(("process-include", ok, latency_100ns)) => {
                reference_ok = ok;
                reference_latency_100ns = latency_100ns;
            }
            Ok((label, ok, _)) => append_diag(
                Some(&log_path),
                format!("unexpected activation verdict label={label} ok={ok}"),
            ),
            Err(err) => {
                append_diag(
                    Some(&log_path),
                    format!("activation verdict wait failed: {err:?}"),
                );
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
        join_all_with_timeout(vec![endpoint_join, reference_join]);
        unsafe {
            let _ = CloseHandle(stop_event);
        }
        return Ok(false);
    }

    let timing_prior = AecTimingPrior::new(endpoint_latency_100ns, reference_latency_100ns);
    let canceller_join = spawn_canceller_thread(
        shared,
        SendHandle(stop_event),
        log_path.clone(),
        timing_prior,
        on_chunk,
    );

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
