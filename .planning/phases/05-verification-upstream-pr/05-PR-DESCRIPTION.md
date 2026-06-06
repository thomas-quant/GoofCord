Adds native Windows system-audio capture for screenshare so sharing system audio no longer echoes the call back to viewers. Closes #46.

Windows has no per-app audio routing (what patchcord gives us on Linux), so the current `"loopback"` path grabs the whole output mix, call included — which the viewer hears echoed back. This captures the same mix with our own call excluded.

The capture is a small Rust addon using the Windows process-loopback API (`ActivateAudioInterfaceAsync` with the exclude-process-tree `AUDCLNT_STREAMOPTIONS`), run in EXCLUDE mode against GoofCord's own process tree. The call audio comes out of the Audio Service child, which is in that tree, so it drops out of the capture while the rest of the desktop audio stays. The Rust side is based on Microsoft's public ApplicationLoopback sample (MIT).

Since we wrap the web client, the PCM has to reach `getDisplayMedia`: the addon's f32 chunks go over a `MessageChannelMain` to a feeder injected into the page main world, which rebuilds the track with `MediaStreamTrackGenerator` and swaps it into the stream. The swap only arms once capture is actually producing audio, so a failed start falls through to loopback. One gotcha: running this and Chromium's own `"loopback"` at once (two loopbacks on one session) hard-crashes in CoreMessaging on system-audio shares, so the win32 path doesn't request Chromium loopback.

The addon ships like venbind/patchcord — its own repo with a `windows-latest` CI that commits a prebuilt `.node`, pulled in via one `optionalDependencies` line (`os: ["win32"]`, so non-Windows skips it). `asarUnpack` is there because electron-builder packs app-source `.node` inside the asar where `require()` can't reach it. Happy to move the repo under the org if you'd rather own it.

If the API isn't available (older Windows) or you pass `--no-wasapi`, it falls back to the existing `"loopback"` — audio works, just the old echo, no crash. Linux/macOS are untouched (the path is behind a `process.platform === "win32"` gate).

Verified by hand on CI builds of this branch (no automated repro for screenshare). Windows 10 19045, two devices on a call: viewer hears the shared desktop audio and no echo; with `--no-wasapi` the echo comes back, so it's this capture doing the work. No crash. `bun run check` passes. Independent of #210.

Closes #46
