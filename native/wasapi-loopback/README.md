# wasapi-loopback

A clean-room native Node addon (Rust + [napi-rs](https://napi.rs) + the
[`windows`](https://crates.io/crates/windows) crate) that performs **WASAPI
process-tree EXCLUDE loopback** on Windows: it captures the full default-endpoint
audio mix **except** the process tree rooted at a caller-supplied PID.

In GoofCord this is the **#46 echo fix** (`ECHO-01`): excluding GoofCord's own
Electron process tree removes the call audio GoofCord itself plays back, so a
remote screenshare viewer hears shared desktop/app audio but **not** the call
echoed back to them.

## Clean-room provenance (ECHO-04)

This crate is authored **solely** from the public Microsoft
[`ApplicationLoopback`](https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback)
MIT sample and the public `windows` crate / Win32 documentation. No proprietary
or third-party application code or symbol layout was used as a basis. The
Microsoft MIT copyright notice is retained verbatim in [`NOTICE`](./NOTICE).

## What it does

- Hardcodes a **48000 Hz / 2-channel / 32-bit IEEE-float** `WAVEFORMATEXTENSIBLE`
  (the renderer/transport contract). The process-loopback device returns
  `E_NOTIMPL` from `GetMixFormat`/`IsFormatSupported`, so the format is **not**
  queried — it is hardcoded and the audio engine converts to it in shared mode
  via `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM` (no Rust-side resampling).
- Activates the WASAPI process loopback in
  `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` mode against the supplied
  exclude-root PID.
- Resolves `ActivateAudioInterfaceAsync` **dynamically** (`LoadLibraryW` +
  `GetProcAddress` on `mmdevapi.dll`), so the `.node` **loads** on every Windows
  build and only **activates** where the API is present. Any non-`S_OK`
  activation result (or a failed `GetProcAddress`) is reported as "unsupported"
  (`start` resolves `false`) rather than thrown — the graceful-fallback
  foundation for `ECHO-03`.
- Runs an event-driven capture loop on a dedicated thread and pushes
  **480-frame** (3840-byte) interleaved-stereo f32 chunks to JS over a napi
  `ThreadsafeFunction` (`NonBlocking` + bounded queue → drop-oldest backpressure).

## Exported API (consumed by GoofCord's main-process wrapper)

```ts
// excludeRootPid: the Electron MAIN process PID (process.pid). EXCLUDE_TARGET_PROCESS_TREE
// covers the whole tree, including the separate "Audio Service" utility child.
// onChunk: called with a 3840-byte (480 frames * 2ch * 4 bytes) f32 Buffer per ~10 ms.
function start(excludeRootPid: number, onChunk: (chunk: Buffer) => void): boolean; // false => unsupported
function stop(): void; // idempotent; signals the capture thread and joins with a bounded timeout
```

## Building (Windows only)

This crate is **not** compiled by GoofCord's Bun build (GoofCord consumes a
prebuilt `.node`, per its "no new build tooling" constraint). It is built on a
`windows-latest` CI runner:

```bash
napi build --release --target x86_64-pc-windows-msvc
```

which produces **`wasapi-loopback-win32-x64.node`**. GoofCord picks it up via the
`GOOFCORD_WASAPI_LOOPBACK_PATH` env override (mirrors `GOOFCORD_VENBIND_PATH` /
`GOOFCORD_PATCHCORD_PATH`); `copyNativeModules()` renames it into
`assets/native/wasapi-loopback-win32-x64.node`.

## Status

In-repo during Phase 4 (`native/wasapi-loopback/`). It is slated to move to its
own published, venbind-style prebuilt-`.node` repo (with `optionalDependencies`)
in **Phase 5**.
