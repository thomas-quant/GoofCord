Native Windows system-audio capture for screenshare that doesn't echo the Discord call back to viewers.

## What I verified

Built this on Windows 10 (build 19045, x64) and tested it the only way that actually proves it — two machines on a call, one sharing, one watching. With music playing on the sharing box, the viewer hears the shared desktop audio and does **not** hear the call echoed back. Flip the same build to the old path (`--no-wasapi`) and the echo comes straight back, so the suppression is specifically this capture and not something else in the audio stack. No crash across repeated start / cancel / re-share.

The reason the echo goes away: the capture **excludes GoofCord's own process tree**. The exclude root is the Electron main PID, and Discord's call playback comes out of the Audio Service utility process, which is a child in that tree — so the call is dropped from the captured mix while the rest of the desktop audio is kept. (The streamer can't hear this themselves; Electron mutes local echo, which is why it needs a second device to confirm.)

## How it works

Windows has a per-process loopback mode (`ActivateAudioInterfaceAsync` with the process-loopback `AUDCLNT_STREAMOPTIONS`, including or excluding a target process tree) — the same OS capability Discord's own native capture uses, and basically the Windows analogue of what venmic does on Linux. Here it runs in EXCLUDE-tree mode against our own tree, so it grabs the whole endpoint mix minus our call audio.

The capture is a small Rust addon, clean-room from Microsoft's public ApplicationLoopback sample (MIT, notice retained) — no Discord code anywhere in it. It produces 48k / stereo / f32 PCM.

The interesting part of wrapping the Discord **web** client is getting that PCM into the stream: the web client builds its screenshare from `getDisplayMedia`, so the native audio has to become a real MediaStream track. The addon's chunks go over a `MessageChannelMain` to a feeder injected into the page's main world, which rebuilds the audio with a `MediaStreamTrackGenerator` and swaps it into the `getDisplayMedia` result. The swap only arms once the native capture is actually producing audio, so a failed start can't leave you with a dead track.

## Things that bit me, in case it saves you the time

- Letting the addon's loopback and Chromium's own `"loopback"` capture the same session at once corrupts it — a `CoreMessaging.dll` heap-corruption **hard crash**, but only on system-audio shares (each capturer alone is fine). The fix is to make the addon the sole capturer and not request Chromium loopback on that branch.
- A `PROPVARIANT` was being dropped twice across the FFI boundary; needed `ManuallyDrop` to stop the heap corruption.
- The napi threadsafe callback is CalleeHandled, so JS gets invoked as `(err, chunk)`. I first read the chunk as the first argument, got `null`, and tore the capture down on the very first packet (viewer heard nothing). There's a comment on this in the code so nobody repeats it.
- Bun's `native-module:` file-loader silently emits **zero** `.node` when the build host is Windows (CI on `windows-latest`, bun `latest`): every addon then resolves to `export default null` and you get a silent fallback with no error at all. I swapped that for a plain host-agnostic fs copy into `ts-out/native`.
- electron-builder doesn't auto-unpack app-source `.node` files (only node_modules ones), so the addon ended up packed inside the asar where `require()` can't load it. `asarUnpack: ["**/*.node"]` fixes it — and venbind had the same latent packaging gap.

## How it's delivered

The addon ships as a prebuilt `.node` from its own small repo (MIT + the retained Microsoft notice), which has a `windows-latest` CI that builds and commits the prebuilt — the same committed-prebuilt approach as venbind / patchcord. GoofCord pulls it in with a single `optionalDependencies` line. It's under my account for now; I'm happy to move it under the GoofCord org and repoint the ref if you'd rather own it.

## Fallback and other platforms

If the per-process loopback API isn't available on a given Windows build, or you pass `--no-wasapi`, the native start returns false and it falls back to the existing Chromium `"loopback"` — audio still works, you just get the old echo behaviour, no crash and no silence. The whole path sits behind a `process.platform === "win32"` gate and the optionalDependency is `os: ["win32"]`, so Linux (patchcord) and macOS aren't touched — the Linux screenshare path is unchanged and that build still passes.

The diff is intentionally small: the native wrapper + transport, one extra branch in the screenshare audio path, the IPC for it, and the packaging. It's independent of #210 — it touches `selectScreenshareSource` in a different spot, so the two can land in either order.

Closes #46.
