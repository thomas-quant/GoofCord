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

use std::collections::HashMap;
use std::mem::{size_of, ManuallyDrop};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread::JoinHandle;

use napi::bindgen_prelude::Buffer;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

// The `#[implement]` macro emits absolute `::windows_core::` paths, so windows-core is a
// direct dependency (see Cargo.toml). `windows` also re-exports it as `windows::core`.
use windows::core::{implement, w, IUnknown, Interface, GUID, HRESULT, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_PROC_NOT_FOUND, E_FAIL, HANDLE, S_OK, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, IAudioSessionControl, IAudioSessionControl2,
    IAudioSessionEnumerator, IAudioSessionManager2, IMMDevice, IMMDeviceCollection,
    IMMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    DEVICE_STATE_ACTIVE, MMDeviceEnumerator, PROCESS_LOOPBACK_MODE,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVEFORMATEXTENSIBLE_0, eConsole, eRender,
};
use windows::Win32::Media::KernelStreaming::WAVE_FORMAT_EXTENSIBLE;
use windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
// Endpoint friendly-name property key + the property store interface returned by
// IMMDevice::OpenPropertyStore (render-endpoint enumeration). PKEY_Device_FriendlyName lives under
// Win32_Devices_FunctionDiscovery; IPropertyStore under Win32_UI_Shell_PropertiesSystem.
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, BLOB, CLSCTX_ALL,
    COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::System::Threading::{
    CreateEventW, GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, SetEvent,
    WaitForSingleObject, INFINITE, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::Variant::{VT_BLOB, VT_LPWSTR};

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

/// Initialize an already-acquired `IAudioClient` to the fixed 48k/stereo/f32 loopback format.
///
/// This is the SINGLE Initialize/stream-flags block shared by BOTH client-acquisition paths —
/// process-tree activation (the magic device) and render-endpoint activation (a real `IMMDevice`).
/// Routing both through here guarantees the transport format never diverges: shared mode with
/// `AUTOCONVERTPCM | SRC_DEFAULT_QUALITY` so the engine converts to our hardcoded format (the
/// deliberate divergence from OBS, which queries the endpoint mix format), plus
/// `LOOPBACK | EVENTCALLBACK` for the event-driven capture loop. StreamFlags is the SECOND
/// Initialize parameter — AUTOCONVERTPCM goes HERE, not into hnsPeriodicity (Pitfall 2 / MS
/// sample bug #196). Returns the raw `Initialize` result; callers collapse `Err` to `Unsupported`.
unsafe fn initialize_loopback_client(audio_client: &IAudioClient) -> windows::core::Result<()> {
    let wfx = build_wave_format();
    let stream_flags = AUDCLNT_STREAMFLAGS_LOOPBACK
        | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    audio_client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        stream_flags,                 // <-- StreamFlags (2nd param): AUTOCONVERTPCM lives here.
        0,                            // hnsBufferDuration (engine default in event-driven shared mode)
        0,                            // hnsPeriodicity (0 for event-driven shared mode)
        &wfx as *const _ as *const WAVEFORMATEX,
        None,
    )
}

/// Attempt to activate a process-loopback IAudioClient for the process tree rooted at
/// `target_pid`, in the requested `mode`, initialized to the hardcoded 48k/stereo/f32 format.
///
/// `mode` is the ONLY functional divergence between the two capture kinds:
///   - `EXCLUDE_TARGET_PROCESS_TREE` — capture everything EXCEPT `target_pid`'s tree (the
///     shipped #46 echo fix: pass the Electron main PID to drop the host's own playback).
///   - `INCLUDE_TARGET_PROCESS_TREE` — capture ONLY `target_pid`'s tree (app-exclusive share).
/// Every other step (VT_BLOB guard, async wait, `build_wave_format()` + `AUTOCONVERTPCM`
/// initialize) is byte-identical across both modes.
///
/// Returns `Activated(client)` on success, or `Unsupported` for ANY failure (missing
/// entry point, non-S_OK activate result, or COM error) — never panics, never throws.
unsafe fn activate_process_tree(mode: PROCESS_LOOPBACK_MODE, target_pid: u32) -> ActivationResult {
    // 1. Dynamic-load gate: if the entry point is absent, this build doesn't support it.
    if !process_loopback_entrypoint_present() {
        return ActivationResult::Unsupported;
    }

    // 2. Build the activation params for the supplied process tree in the requested mode.
    let mut activation_params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: target_pid,
                // EXCLUDE tree: capture everything EXCEPT target_pid + its children.
                // INCLUDE tree: capture ONLY target_pid + its children.
                ProcessLoopbackMode: mode,
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
        Err(_) => return ActivationResult::Unsupported,
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
        Err(_) => {
            let _ = CloseHandle(done);
            return ActivationResult::Unsupported;
        }
    };

    // 6. Wait for completion, then read the activation result. ANY non-S_OK => Unsupported.
    let wait = WaitForSingleObject(done, INFINITE);
    let _ = CloseHandle(done);
    if wait != WAIT_OBJECT_0 {
        return ActivationResult::Unsupported;
    }

    let mut activate_hr: HRESULT = E_FAIL;
    let mut activated_iface: Option<IUnknown> = None;
    if operation
        .GetActivateResult(&mut activate_hr, &mut activated_iface)
        .is_err()
    {
        return ActivationResult::Unsupported;
    }
    // E_NOTIMPL / E_INVALIDARG / AUDCLNT_E_DEVICE_INVALIDATED / any other non-success ->
    // "unsupported on this build" (try-activate-and-catch — no hardcoded OS build gate).
    if activate_hr != S_OK {
        return ActivationResult::Unsupported;
    }
    let audio_client: IAudioClient = match activated_iface.and_then(|u| u.cast().ok()) {
        Some(c) => c,
        None => return ActivationResult::Unsupported,
    };

    // 7. Initialize to the fixed 48k/stereo/f32 loopback format via the shared helper — the SAME
    //    Initialize/stream-flags block the endpoint path uses, so the transport format stays
    //    byte-identical across both client-acquisition paths. AUTOCONVERTPCM makes the shared-mode
    //    engine convert to our hardcoded format, so no Rust DSP.
    if initialize_loopback_client(&audio_client).is_err() {
        return ActivationResult::Unsupported;
    }

    ActivationResult::Activated(audio_client)
}

// ─── Capture-thread state ───────────────────────────────────────────────────────────
//
// N concurrent capture sessions, keyed in SESSIONS. Each capture thread owns its own
// COM-apartment-affine
// IAudioClient/IAudioCaptureClient: activation runs ON the capture thread (after
// CoInitializeEx) and the outcome is reported back to `start()` over a channel, so the
// COM objects never cross a thread boundary. `stop` signals the stop event and joins.

struct CaptureSession {
    /// Manual-reset event the capture loop polls; SetEvent => "please exit".
    stop_event: HANDLE,
    /// The capture thread join handle (taken by `stop`).
    join: Option<JoinHandle<()>>,
    /// Live timing counters, shared with the capture thread.
    stats: Arc<StreamStats>,
}

// HANDLE is a raw pointer; it is only ever touched under the GLOBAL mutex below and on
// the capture thread we created, so guarding it this way is sound.
unsafe impl Send for CaptureSession {}

/// A `HANDLE` that can be moved into the capture thread. A Win32 event handle is a kernel
/// object safe to use from any thread; the raw pointer is only non-`Send` by default.
#[derive(Clone, Copy)]
struct SendHandle(HANDLE);
unsafe impl Send for SendHandle {}

/// All live capture sessions, keyed by the id handed back to JS.
///
/// This used to be a single `Mutex<Option<CaptureSession>>`. That singleton made multi-app
/// INCLUDE capture (Discord's window-share mode, generalized to N apps) impossible AND
/// silently wrong: a second `start*` call hit the `is_some()` early-return and reported
/// SUCCESS while capturing nothing. Keying by session id is what makes N concurrent
/// INCLUDE captures — one per selected app — actually run.
/// Per-stream timing taken straight from `IAudioCaptureClient::GetBuffer`.
///
/// `DevicePosition`/`QPCPosition` are the engine's own accounting: frames-since-stream-start
/// paired with the performance counter at the moment that frame was recorded. They stay
/// authoritative even when the FFI queue drops chunks, which is exactly why inferring a rate
/// from chunk *arrival* cannot work here — `dropped_chunks` counts that failure directly.
#[derive(Default)]
struct StreamStats {
    device_position: AtomicU64,
    qpc_position: AtomicU64,
    packets: AtomicU64,
    dropped_chunks: AtomicU64,
    discontinuities: AtomicU64,
    timestamp_errors: AtomicU64,
}

static SESSIONS: LazyLock<Mutex<HashMap<u32, CaptureSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Monotonic session-id source. Starts at 1 so `0` is never a valid id and the TS side can
/// use `-1`/`0` as "failed" sentinels without ambiguity.
static NEXT_SESSION_ID: AtomicU32 = AtomicU32::new(1);

// ─── Event-driven capture loop (runs on the dedicated capture thread) ───────────────
//
// Source basis: the MS ApplicationLoopback sample's event-driven capture loop
// (SetEventHandle -> GetService(IAudioCaptureClient) -> Start -> wait-on-event ->
// GetNextPacketSize / GetBuffer / ReleaseBuffer). Re-expressed via windows-rs.

/// The capture loop. Owns `audio_client` (already Initialize()'d to 48k/stereo/f32).
/// Batches the device's interleaved-stereo f32 frames into 3840-byte chunks and pushes
/// each via `on_chunk` (NonBlocking — drops on QueueFull). Exits when `stop_event` fires.
unsafe fn run_capture_loop(
    audio_client: IAudioClient,
    on_chunk: ChunkTsfn,
    stop_event: HANDLE,
    stats: Arc<StreamStats>,
) {
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
    // not align to 480 frames, so we re-chunk across packet boundaries.
    let mut acc: Vec<u8> = Vec::with_capacity(CHUNK_BYTES * 2);

    // Wait on BOTH the audio event and the stop event; WaitForMultipleObjects would be
    // ideal, but a short timed wait on the audio event + a stop-event poll keeps the
    // dependency surface minimal and the teardown latency bounded.
    loop {
        // Stop requested? (non-blocking poll.) Exit on ANYTHING that is not "still unsignaled".
        //
        // This deliberately treats WAIT_FAILED as "stop" too. If `stop()` hits its join timeout
        // it detaches this thread, and a closed/recycled stop handle then makes WaitForSingleObject
        // return WAIT_FAILED — the old `== WAIT_OBJECT_0` test would never match, so the detached
        // thread span forever, still pushing chunks into a dropped ThreadsafeFunction.
        if WaitForSingleObject(stop_event, 0) != WAIT_TIMEOUT {
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
            // The two trailing arguments used to be None. They are the engine's timing for this
            // packet, and discarding them is what forced rate to be guessed from arrival times.
            let mut device_pos: u64 = 0;
            let mut qpc_pos: u64 = 0;
            if capture
                .GetBuffer(
                    &mut data_ptr,
                    &mut num_frames,
                    &mut flags,
                    Some(&mut device_pos),
                    Some(&mut qpc_pos),
                )
                .is_err()
            {
                break;
            }

            stats.packets.fetch_add(1, Ordering::Relaxed);
            if (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32) != 0 {
                stats.timestamp_errors.fetch_add(1, Ordering::Relaxed);
            } else {
                // Store as a matched pair; a reader may see a torn pair, which costs one sample
                // of a 500-sample regression and is not worth a lock on the capture thread.
                stats.device_position.store(device_pos, Ordering::Relaxed);
                stats.qpc_position.store(qpc_pos, Ordering::Relaxed);
            }
            if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32) != 0 {
                stats.discontinuities.fetch_add(1, Ordering::Relaxed);
            }

            let frame_count = num_frames as usize;
            let byte_count = frame_count * BYTES_PER_FRAME;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data_ptr.is_null() {
                // Silent packet: the engine says "treat as silence" — append zeros so the
                // timeline stays monotonic (the renderer expects continuous f32 frames).
                acc.resize(acc.len() + byte_count, 0u8);
            } else {
                let slice = std::slice::from_raw_parts(data_ptr, byte_count);
                acc.extend_from_slice(slice);
            }

            let _ = capture.ReleaseBuffer(num_frames);

            // Flush as many full 3840-byte chunks as we now have.
            while acc.len() >= CHUNK_BYTES {
                let chunk: Vec<u8> = acc.drain(..CHUNK_BYTES).collect();
                // NonBlocking push: QueueFull => the chunk is dropped (drop-oldest at the
                // FFI boundary). Bounded latency wins over perfect fidelity (locked T4).
                if on_chunk.call(Ok(chunk.into()), ThreadsafeFunctionCallMode::NonBlocking)
                    != napi::Status::Ok
                {
                    stats.dropped_chunks.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    }

    // Teardown: stop the client and release the per-loop event.
    let _ = audio_client.Stop();
    let _ = CloseHandle(audio_event);
    // `capture` and `audio_client` drop here, releasing the COM references on this thread.
}

// ─── Session spawner (shared by every capture mode) ─────────────────────────────────

/// Spawn one capture session: create its stop event, run `activate` ON a dedicated MTA
/// capture thread (COM apartment affinity — the IAudioClient never crosses a thread
/// boundary), wait for the activation verdict, then register the session in `SESSIONS`.
///
/// Returns the new session id, or `None` when activation failed for any reason (missing
/// entry point, non-S_OK activate result, COM error). Never panics, never throws.
///
/// Every capture mode funnels through here, so there is exactly one implementation of the
/// thread/COM/stop-event/registration dance — the EXCLUDE and INCLUDE paths differ ONLY in
/// the closure they hand in.
fn spawn_session<F>(activate: F, on_chunk: ChunkTsfn) -> Option<u32>
where
    F: FnOnce() -> ActivationResult + Send + 'static,
{
    // Manual-reset stop event the capture loop polls; unsignaled initially. Created here so
    // a concurrent stop can signal it even while the thread is still activating.
    let stop_event = match unsafe { CreateEventW(None, true, false, PCWSTR::null()) } {
        Ok(h) => h,
        Err(_) => return None,
    };

    let (tx, rx): (Sender<bool>, _) = channel();
    let stop_event_for_thread = SendHandle(stop_event);
    let stats = Arc::new(StreamStats::default());
    let stats_for_thread = Arc::clone(&stats);

    let join = std::thread::spawn(move || {
        // Capture the whole SendHandle (Send), not its inner HANDLE field — Rust 2021's
        // disjoint closure capture would otherwise grab the non-Send `.0` directly.
        let stop_handle = stop_event_for_thread;

        // COM on the capture thread (MTA — no message pump needed for WASAPI capture). MTA is
        // also what spares the async-activation completion handler from needing IAgileObject:
        // it never has to marshal into an STA.
        let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let com_ok = com.is_ok();

        match activate() {
            ActivationResult::Activated(client) => {
                // Report the verdict BEFORE entering the (blocking) capture loop.
                let _ = tx.send(true);
                unsafe { run_capture_loop(client, on_chunk, stop_handle.0, stats_for_thread) };
            }
            ActivationResult::Unsupported => {
                let _ = tx.send(false);
            }
        }

        if com_ok {
            unsafe { CoUninitialize() };
        }
    });

    if !rx.recv().unwrap_or(false) {
        // Activation failed. The thread is already exiting; join it, THEN reclaim the event.
        // Closing is safe here (unlike the detach path in `stop`) precisely because the join
        // completed — nothing can be waiting on this handle afterwards.
        unsafe {
            let _ = SetEvent(stop_event);
        }
        let _ = join.join();
        unsafe {
            let _ = CloseHandle(stop_event);
        }
        return None;
    }

    let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    SESSIONS.lock().unwrap_or_else(|p| p.into_inner()).insert(
        id,
        CaptureSession {
            stop_event,
            join: Some(join),
            stats,
        },
    );
    Some(id)
}

// ─── napi surface ───────────────────────────────────────────────────────────────────

/// Begin process-tree EXCLUDE loopback capture, excluding the tree rooted at
/// `exclude_root_pid` (pass the Electron MAIN process PID — EXCLUDE_TARGET_PROCESS_TREE
/// covers the whole tree incl. the separate "Audio Service" utility child). `on_chunk`
/// receives 480-frame (3840-byte) interleaved-stereo f32 buffers, ~one per 10 ms.
///
/// This is the "share a whole screen" mode, and it is mechanically what Discord does for a
/// `screen:*` source (its renderer sends the sentinel `soundsharePid = 1`).
///
/// Returns the session id, or `0` when process-loopback is unavailable on this build OR
/// activation failed — the caller then falls back to Electron "loopback". Never throws.
#[napi(js_name = "startExcludeProcessTree")]
pub fn start_exclude_process_tree(exclude_root_pid: u32, on_chunk: ChunkTsfn) -> napi::Result<u32> {
    Ok(spawn_session(
        move || unsafe {
            activate_process_tree(
                PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                exclude_root_pid,
            )
        },
        on_chunk,
    )
    .unwrap_or(0))
}

/// Begin app-exclusive INCLUDE loopback capture of the process tree rooted at `target_pid`
/// — captures ONLY that app + its children, so it is self-free AND virtual-audio-device-free
/// by construction (an allowlist cannot pick up a VAC that is not in it). This is the mode
/// Discord uses for a `window:*` source, and the one that fixes the VAC echo.
///
/// Emits the SAME fixed 48k/stereo/f32 480-frame (3840-byte) chunk contract as the EXCLUDE
/// path; the only divergence is the loopback-mode constant.
///
/// Call it once per selected app — sessions are independent and run concurrently, so N apps
/// means N sessions mixed downstream.
///
/// Returns the session id, or `0` on failure. Never throws.
#[napi(js_name = "startIncludeProcessTree")]
pub fn start_include_process_tree(target_pid: u32, on_chunk: ChunkTsfn) -> napi::Result<u32> {
    Ok(spawn_session(
        move || unsafe {
            activate_process_tree(PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, target_pid)
        },
        on_chunk,
    )
    .unwrap_or(0))
}

/// Stop ONE capture session by id. Signals its capture thread to exit, then joins with a
/// bounded timeout so a hung native teardown can't wedge the caller (composes with the JS
/// wrapper's before-quit Promise.race). Idempotent — an unknown id is a no-op.
#[napi(js_name = "stopSession")]
pub fn stop_session(id: u32) {
    let session = SESSIONS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&id);
    if let Some(session) = session {
        teardown_session(session);
    }
}

/// Engine-reported timing for a live session. Numbers are `f64` because napi has no u64 and
/// these stay exact well past any realistic session length (2^53 frames is ~5900 years at 48k).
#[napi(object)]
pub struct CaptureStats {
    /// Frames from the start of the stream, for the first frame of the last packet.
    pub device_position: f64,
    /// Performance counter at which the engine recorded that frame, in 100 ns units.
    pub qpc_position100ns: f64,
    /// Packets pulled from the engine.
    pub packets: f64,
    /// Chunks the FFI queue refused (QueueFull). Non-zero means chunk-arrival timing is a lie.
    pub dropped_chunks: f64,
    /// Packets flagged AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.
    pub discontinuities: f64,
    /// Packets whose reported position was flagged invalid.
    pub timestamp_errors: f64,
}

/// Read a live session's timing counters. `None` when the id is not running.
///
/// Regressing `device_position` against `qpc_position100ns` across polls gives the stream's true
/// sample rate against the system performance counter — which is what distinguishes a real clock
/// difference from packets simply arriving unevenly.
#[napi(js_name = "getCaptureStats")]
pub fn get_capture_stats(id: u32) -> Option<CaptureStats> {
    let guard = SESSIONS.lock().unwrap_or_else(|p| p.into_inner());
    let s = &guard.get(&id)?.stats;
    Some(CaptureStats {
        device_position: s.device_position.load(Ordering::Relaxed) as f64,
        qpc_position100ns: s.qpc_position.load(Ordering::Relaxed) as f64,
        packets: s.packets.load(Ordering::Relaxed) as f64,
        dropped_chunks: s.dropped_chunks.load(Ordering::Relaxed) as f64,
        discontinuities: s.discontinuities.load(Ordering::Relaxed) as f64,
        timestamp_errors: s.timestamp_errors.load(Ordering::Relaxed) as f64,
    })
}

/// Plain endpoint loopback on one render device — no process filter of any kind.
///
/// Diagnostic surface, not a product path. Endpoint-bound capture carrying an EXCLUDE blob was
/// falsified (the process filter is silently ignored), so this deliberately does not pretend to
/// filter: it captures the chosen device's whole mix. It exists so endpoint-scoped and
/// process-scoped capture can be compared on the same box.
///
/// `device_id` is an `IMMDevice` id, or `None`/`"default"` for the default console render endpoint.
#[napi(js_name = "startRenderEndpointLoopback")]
pub fn start_render_endpoint_loopback(
    device_id: Option<String>,
    on_chunk: ChunkTsfn,
) -> napi::Result<u32> {
    Ok(
        spawn_session(
            move || unsafe { activate_render_endpoint_loopback(device_id.as_deref()) },
            on_chunk,
        )
        .unwrap_or(0),
    )
}

/// Resolve an `IMMDevice` and activate plain loopback capture on it.
unsafe fn activate_render_endpoint_loopback(device_id: Option<&str>) -> ActivationResult {
    let enumerator: IMMDeviceEnumerator =
        match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
            Ok(e) => e,
            Err(_) => return ActivationResult::Unsupported,
        };

    let device: IMMDevice = match device_id {
        None | Some("default") => match enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
            Ok(d) => d,
            Err(_) => return ActivationResult::Unsupported,
        },
        Some(id) => {
            let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
            match enumerator.GetDevice(PCWSTR(wide.as_ptr())) {
                Ok(d) => d,
                Err(_) => return ActivationResult::Unsupported,
            }
        }
    };

    // No activation params: a render endpoint activated with a null blob is ordinary loopback.
    let audio_client: IAudioClient = match device.Activate(CLSCTX_ALL, None) {
        Ok(c) => c,
        Err(_) => return ActivationResult::Unsupported,
    };

    if initialize_loopback_client(&audio_client).is_err() {
        return ActivationResult::Unsupported;
    }

    ActivationResult::Activated(audio_client)
}

/// Stop every live capture session. Used for share teardown and the before-quit path.
/// Idempotent — a no-op when nothing is running.
#[napi(js_name = "stopAll")]
pub fn stop_all() {
    let sessions: Vec<CaptureSession> = {
        let mut guard = SESSIONS.lock().unwrap_or_else(|p| p.into_inner());
        guard.drain().map(|(_, s)| s).collect()
    };
    for session in sessions {
        teardown_session(session);
    }
}

/// Signal + bounded join for one session.
///
/// HANDLE-LIFETIME NOTE (load-bearing): on the timeout path we deliberately LEAK the stop
/// event instead of closing it. The capture thread is still alive and still polling that
/// handle; closing it would (a) make its `WaitForSingleObject` return WAIT_FAILED and (b)
/// free the handle value for recycling, so a later `CreateEventW` could hand the orphaned
/// thread an unrelated kernel object to wait on. One leaked event per hung teardown is far
/// cheaper than a thread waiting on someone else's object. (The capture loop also now exits
/// on any non-WAIT_TIMEOUT result, so a leaked-but-signaled event still ends it promptly.)
fn teardown_session(mut session: CaptureSession) {
    unsafe {
        let _ = SetEvent(session.stop_event);
    }

    let mut joined = false;
    if let Some(join) = session.join.take() {
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_millis(STOP_JOIN_TIMEOUT_MS);
        loop {
            if join.is_finished() {
                let _ = join.join();
                joined = true;
                break;
            }
            if std::time::Instant::now() >= deadline {
                // Detach rather than block the caller. Handle intentionally NOT closed.
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    } else {
        joined = true;
    }

    if joined {
        // Only safe once the thread is provably gone.
        unsafe {
            let _ = CloseHandle(session.stop_event);
        }
    }
}

// ─── Audio-session app enumeration (listAudioApps) ──────────────────────────────────
//
// Clean-room from the public Microsoft Core Audio session APIs (IMMDeviceEnumerator +
// IAudioSessionManager2/IAudioSessionControl2): enumerate every ACTIVE eRender endpoint,
// walk each endpoint's audio sessions, and surface one entry per audio-emitting app PID.
// The picker (Plan 02) lists these so the user can choose an app to INCLUDE-capture.
// Enumeration is fail-closed: ANY failure at ANY step yields an empty list — never an
// error, never a panic across the FFI boundary.

/// One audio-emitting app, as surfaced to the screenshare picker. napi maps the fields to
/// the JS shape `{ processId, displayName, binary }` — the exact contract the existing
/// renderer checklist already consumes. Do NOT widen it.
#[napi(object)]
pub struct AudioAppInfo {
    /// The app's process id (the INCLUDE-capture target).
    pub process_id: u32,
    /// Friendly name: the audio-session display name, else the executable basename.
    pub display_name: String,
    /// The executable basename (e.g. `chrome.exe`).
    pub binary: String,
}

/// Enumerate audio-emitting apps (one entry per PID). Deduped by PID; the system-sounds
/// pseudo-session and GoofCord's OWN process id are dropped. Fail-closed: returns an empty
/// vec on any failure — never throws.
///
/// The Electron "Audio Service" utility CHILD pid is dropped on the TS side in Plan 02
/// (only the main process can resolve it via `app.getAppMetrics()`); this addon drops only
/// its own process id here — the split is intentional.
#[napi(js_name = "listAudioApps")]
pub fn list_audio_apps() -> napi::Result<Vec<AudioAppInfo>> {
    // Session enumeration is COM-apartment-affine: run it on a dedicated MTA thread (the
    // same apartment discipline as the capture thread) so it never depends on — or
    // disturbs — the caller's apartment. A panic on that thread collapses to an empty vec.
    let apps = std::thread::spawn(|| unsafe { enumerate_audio_apps() })
        .join()
        .unwrap_or_default();
    Ok(apps)
}

/// MTA-apartment bracket around the enumeration: CoInitialize the dedicated thread, collect,
/// CoUninitialize — mirrors the capture thread's `CoInitializeEx(COINIT_MULTITHREADED)` +
/// `CoUninitialize` pattern. All COM interfaces are created and dropped inside
/// `collect_audio_apps` before the apartment is torn down.
unsafe fn enumerate_audio_apps() -> Vec<AudioAppInfo> {
    let com = CoInitializeEx(None, COINIT_MULTITHREADED);
    let com_ok = com.is_ok();
    let apps = collect_audio_apps();
    if com_ok {
        CoUninitialize();
    }
    apps
}

/// The enumeration body. Every fallible COM step degrades to "skip this item" or an early
/// empty return — no `?`, no panic, no throw (fail-closed enumeration).
unsafe fn collect_audio_apps() -> Vec<AudioAppInfo> {
    let mut out: Vec<AudioAppInfo> = Vec::new();
    let mut seen: Vec<u32> = Vec::new(); // dedupe by PID (N is tiny; a linear scan is fine).
    let own_pid = GetCurrentProcessId();

    let enumerator: IMMDeviceEnumerator =
        match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
            Ok(e) => e,
            Err(_) => return out,
        };

    // Every ACTIVE render endpoint — an app can be emitting on any of them.
    let devices: IMMDeviceCollection =
        match enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) {
            Ok(d) => d,
            Err(_) => return out,
        };

    let device_count = devices.GetCount().unwrap_or(0);
    for d in 0..device_count {
        let device: IMMDevice = match devices.Item(d) {
            Ok(dev) => dev,
            Err(_) => continue,
        };
        let manager: IAudioSessionManager2 = match device.Activate(CLSCTX_ALL, None) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let sessions: IAudioSessionEnumerator = match manager.GetSessionEnumerator() {
            Ok(s) => s,
            Err(_) => continue,
        };

        let session_count = sessions.GetCount().unwrap_or(0);
        for s in 0..session_count {
            let control: IAudioSessionControl = match sessions.GetSession(s) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let control2: IAudioSessionControl2 = match control.cast() {
                Ok(c) => c,
                Err(_) => continue,
            };

            // Drop the system-sounds pseudo-session (S_OK == "is system sounds").
            if control2.IsSystemSoundsSession() == S_OK {
                continue;
            }

            let pid = match control2.GetProcessId() {
                Ok(p) => p,
                Err(_) => continue,
            };
            // Drop the "no single process" sentinel (0), GoofCord's own PID, and dupes.
            if pid == 0 || pid == own_pid || seen.contains(&pid) {
                continue;
            }
            seen.push(pid);

            // Prefer the session display name; fall back to the executable basename.
            let binary = process_basename(pid);
            let display_name =
                session_display_name(&control).unwrap_or_else(|| binary.clone());
            out.push(AudioAppInfo {
                process_id: pid,
                display_name,
                binary,
            });
        }
    }

    out
}

/// The session's friendly display name, or `None` when absent. An empty name — or an
/// unexpanded resource reference (`@%SystemRoot%\...,-101`) that would render as gibberish —
/// is treated as "no name" so the caller falls back to the executable basename. The string
/// GetDisplayName hands back is CoTaskMem-allocated; we free it here regardless of parse.
unsafe fn session_display_name(control: &IAudioSessionControl) -> Option<String> {
    let raw: PWSTR = control.GetDisplayName().ok()?;
    if raw.is_null() {
        return None;
    }
    let owned = raw.to_string().ok();
    CoTaskMemFree(Some(raw.as_ptr() as *const core::ffi::c_void));

    let name = owned?;
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.starts_with('@') {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// The executable basename for `pid` (e.g. `chrome.exe`) via `QueryFullProcessImageNameW`,
/// or an empty string when the process can't be opened/queried. Opens with only
/// PROCESS_QUERY_LIMITED_INFORMATION (resolves across integrity levels without elevation).
unsafe fn process_basename(pid: u32) -> String {
    let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
        Ok(h) => h,
        Err(_) => return String::new(),
    };

    let mut buf = [0u16; 260]; // MAX_PATH
    let mut size = buf.len() as u32;
    let queried = QueryFullProcessImageNameW(
        handle,
        PROCESS_NAME_WIN32,
        PWSTR::from_raw(buf.as_mut_ptr()),
        &mut size,
    )
    .is_ok();
    let _ = CloseHandle(handle);

    if !queried || size == 0 {
        return String::new();
    }

    let full = String::from_utf16_lossy(&buf[..size as usize]);
    // basename: keep only the segment after the last path separator.
    full.rsplit(|c| c == '\\' || c == '/')
        .next()
        .unwrap_or("")
        .to_string()
}

// ─── Render-endpoint enumeration (list_render_endpoints) ────────────────────────────
//
// Clean-room from the public Microsoft Core Audio device APIs (IMMDeviceEnumerator +
// IPropertyStore + PKEY_Device_FriendlyName), mirroring OBS's win-wasapi endpoint
// enumeration: list every ACTIVE eRender endpoint, read its device id + friendly name,
// and tag the eConsole default. The selector (Plan 04) presents these so the user can
// point GoofCord at a clean render bus (e.g. a VAC "Stream" endpoint). Fail-closed: ANY
// failure at ANY step yields an empty list — never an error, never a panic across FFI.

/// One active render endpoint, as surfaced to the source selector. napi maps the fields to
/// the JS shape `{ id, name, isDefault }` (`is_default` → `isDefault`). `id` is the raw
/// `IMMDevice` id (the `GetDevice` key); `name` is the friendly name (or the id when the
/// property store has none); `isDefault` marks the eConsole default render endpoint.
#[napi(object)]
pub struct RenderEndpointInfo {
    /// The endpoint's `IMMDevice` id (the explicit render-endpoint selector key).
    pub id: String,
    /// Friendly name (`PKEY_Device_FriendlyName`), falling back to the id.
    pub name: String,
    /// True for the current eConsole default render endpoint (the `"default"` sentinel target).
    pub is_default: bool,
}

/// Enumerate active render endpoints (one entry per `eRender` `DEVICE_STATE_ACTIVE` device),
/// with the eConsole default tagged. Fail-closed: returns an empty vec on any failure — never
/// throws. Runs on a dedicated MTA thread (same apartment discipline as `listAudioApps` and the
/// capture thread) so it never depends on — or disturbs — the caller's apartment.
#[napi(js_name = "listRenderEndpoints")]
pub fn list_render_endpoints() -> napi::Result<Vec<RenderEndpointInfo>> {
    let endpoints = std::thread::spawn(|| unsafe { enumerate_render_endpoints() })
        .join()
        .unwrap_or_default();
    Ok(endpoints)
}

/// MTA-apartment bracket around the render-endpoint enumeration (mirrors `enumerate_audio_apps`):
/// CoInitialize the dedicated thread, collect, CoUninitialize. All COM interfaces are created and
/// dropped inside `collect_render_endpoints` before the apartment is torn down.
unsafe fn enumerate_render_endpoints() -> Vec<RenderEndpointInfo> {
    let com = CoInitializeEx(None, COINIT_MULTITHREADED);
    let com_ok = com.is_ok();
    let out = collect_render_endpoints();
    if com_ok {
        CoUninitialize();
    }
    out
}

/// The enumeration body. Every fallible COM step degrades to "skip this endpoint" or an early
/// empty return — no `?`, no panic, no throw (fail-closed enumeration).
unsafe fn collect_render_endpoints() -> Vec<RenderEndpointInfo> {
    let mut out: Vec<RenderEndpointInfo> = Vec::new();

    let enumerator: IMMDeviceEnumerator =
        match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
            Ok(e) => e,
            Err(_) => return out,
        };

    // Resolve the eConsole default once (best-effort) so each entry can be tagged. A failure
    // here just means nothing is tagged default — enumeration still proceeds.
    let default_id: Option<String> = match enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
        Ok(d) => immdevice_id(&d),
        Err(_) => None,
    };

    let devices: IMMDeviceCollection =
        match enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) {
            Ok(d) => d,
            Err(_) => return out,
        };

    let device_count = devices.GetCount().unwrap_or(0);
    for d in 0..device_count {
        let device: IMMDevice = match devices.Item(d) {
            Ok(dev) => dev,
            Err(_) => continue,
        };
        // The id is the selector key — an endpoint without one is unusable, so skip it.
        let id = match immdevice_id(&device) {
            Some(i) => i,
            None => continue,
        };
        let name = endpoint_friendly_name(&device).unwrap_or_else(|| id.clone());
        let is_default = default_id.as_deref() == Some(id.as_str());
        out.push(RenderEndpointInfo { id, name, is_default });
    }

    out
}

/// The `IMMDevice` id string (the `GetDevice`/selector key), or `None` when absent. `GetId`
/// hands back a CoTaskMem-allocated `PWSTR`; we copy it into an owned `String` and free the
/// original with `CoTaskMemFree` (same ownership discipline as `session_display_name`).
unsafe fn immdevice_id(device: &IMMDevice) -> Option<String> {
    let raw: PWSTR = device.GetId().ok()?;
    if raw.is_null() {
        return None;
    }
    let owned = raw.to_string().ok();
    CoTaskMemFree(Some(raw.as_ptr() as *const core::ffi::c_void));
    owned
}

/// The endpoint's friendly name via the property store (`PKEY_Device_FriendlyName`), or `None`.
/// The string lives inside the returned owning `PROPVARIANT` (`VT_LPWSTR`); we copy it into an
/// owned `String` and let the `PROPVARIANT` drop — its `PropVariantClear` frees the string (we
/// OWN the value returned by `GetValue`, so this is the correct release, NOT `CoTaskMemFree`).
unsafe fn endpoint_friendly_name(device: &IMMDevice) -> Option<String> {
    let store: IPropertyStore = device.OpenPropertyStore(STGM_READ).ok()?;
    let prop = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
    let pv = &prop.Anonymous.Anonymous;
    if pv.vt != VT_LPWSTR {
        return None;
    }
    let raw = pv.Anonymous.pwszVal;
    if raw.is_null() {
        return None;
    }
    let owned = raw.to_string().ok()?;
    let trimmed = owned.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
