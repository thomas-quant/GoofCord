# Windows screenshare audio

## Supported contract

- **System**: WASAPI `EXCLUDE_TARGET_PROCESS_TREE`, rooted at GoofCord's Electron **main PID**, including its Audio Service descendants. It is **endpoint-independent**, not the default speaker mix. No endpoint subtraction, AEC, virtual driver or complement-enumeration exclusion is used.
- **Apps**: one `INCLUDE_TARGET_PROCESS_TREE` activation per explicitly selected root, mixed by the existing renderer transport. Duplicate PIDs and observable selected descendant roots are removed; an unselected common ancestor is never substituted. Choosing a video window does not infer its audio PID: select audio apps in the Audio list.
- Windows cannot exclude an arbitrary list of independent apps from system audio with this primitive. Its system mode therefore has no exclusion checklist. Linux retains patchcord's existing exclusion/routing behavior; macOS is unchanged.
- On supported Windows x64, missing addon, refused activation, invalid identity or renderer readiness failure leaves **video without audio**, with a notification. Partial app activation/failure reports that only remaining apps continue. No app-only request silently becomes all audio.
- Non-x64 Windows and the explicit `--no-wasapi` override retain legacy Chromium **system** audio. Per-app requests on those paths fail closed. A remembered app selection is not automatically converted into the system-audio checkbox.

## Identity and lifecycle

Each Windows picker enumeration performs a bounded (5 seconds / 4 MiB), noninteractive PowerShell `Get-CimInstance Win32_Process` query. The main process keeps PID, UTC creation ticks (as strings) and full executable path **per picker request**. Renderer selections carry only PIDs plus that request's enumeration generation. Refresh invalidates the prior generation and clears Windows selections; saved PID preferences are not automatically checked on Windows. Linux's existing remembered selections are unchanged.

Immediately before INCLUDE activation, another snapshot and native audio-session enumeration must verify every selected identity. Empty, forged, malformed, disappeared, recycled or inaccessible selected identities fail closed and ask the user to re-pick. There is no basename restart matching. Live parent chains reject cycles or unknown creation metadata. Own processes, known ancestors containing GoofCord and known descendants are rejected. A parent PID whose current process was created later than the child is a reused PID, not an ancestor.

**Observable-ancestry boundary:** an absent parent terminates traversal, as does a demonstrably reused parent. This allows ordinary orphaned processes (for example Explorer after userinit exits). Windows' current process snapshot does not provide complete historical ancestry: overlap or own-tree relationships through vanished intermediates cannot be proven. The two snapshots and PID-only native activation also have a **TOCTOU window**; this is not atomic process-lifetime binding or a guarantee against every reuse between validation and activation. Stronger guarantees require native cooperation/history, not a renamed patchcord-style API.

Capture IDs and the existing MessagePort readiness handshake isolate replacement and teardown. A capture reserved before the async identity query or native start cannot revive after replacement/stop or a committed main-frame document change, crash or destruction; a session whose start resolves late is stopped. Capture-scoped listeners are removed on teardown. Navigations that never commit (downloads, 204 responses, external protocol links), iframe and same-document SPA navigation do not stop it. Native start, stop and audio-session enumeration settle on addon threads, never blocking the Electron main thread; enumeration rejects after 5 seconds. Native sessions start before a port is transferred; PCM is dropped until the renderer acknowledges. Stop, page reload, failed generator writes, video/track stop and readiness timeout dispose the session.

The renderer mixer is clocked by PCM arrival, not by a page timer, so background throttling and timer jitter cannot drop or pad audio. Main announces the started source indices first. A 10 ms frame is emitted once every non-idle source has one queued, or when a source is 3 frames ahead (the others contribute silence). A source that misses 50 emitted frames is idle and no longer waited on until it delivers again. Frames are summed and clamped (no automatic gain normalization). Two writes may be in flight; beyond that, per-source queues hold at most 200 ms, dropping the oldest.

## Sonar and other re-renderers

EXCLUDE filters the **rendering process**, not the semantic origin of sound. Another process re-rendering GoofCord/call audio (including Sonar routing) may remain audible. INCLUDE avoids unrelated processes, but a selected process can itself re-render unwanted audio. Neither mode promises universal echo removal or “VAC-free” audio.

Use consented synthetic audio for manual checks: two independent apps, parent/child overlap volume, process exit/restart/reuse, own Audio Service exclusion, a second physical output endpoint, default-device change/disconnect, unsupported Windows/override, repeated replacement/stop/reload, and unrelated-process Sonar re-rendering. Unit tests, package loads and the protected route-inventory script are **not live audio-quality evidence**.

## Practical patchcord parity (source-based)

Reference: patchcord [`cb0d3d48f0c217e9621c48c576ec340fdfd9b9b7`](https://github.com/Milkshiift/patchcord/tree/cb0d3d48f0c217e9621c48c576ec340fdfd9b9b7), `node/patchcord.d.ts`, `src/patchbay/{state,routing,models}.rs`; GoofCord `src/modules/native/patchcord.ts`. PR [#211 discussion](https://github.com/Milkshiift/GoofCord/pull/211#issuecomment-4643186973) asks for behavioral parity, not merely matching method names.

| Surface | Linux/patchcord | Windows | Parity |
| --- | --- | --- | --- |
| Enumeration | PipeWire output nodes; optional device nodes (`state.rs`) | Audio-session PIDs across active render endpoints (`native/wasapi-loopback/src/lib.rs`, `listAudioApps`); not proof of current audibility | Adapted; device-node selection unavailable |
| Selection IDs | `routeNodes(nodeIds)`; GoofCord matches picker PIDs and learns app metadata | Request-bound PID + creation/path identity; process trees, not graph nodes | Adapted |
| Include/mix | Links node output ports to a stereo virtual sink, dedupes links (`routing.rs`) | One INCLUDE per observable non-overlapping selected root; renderer sums sources | Adapted |
| Exclusion | Existing GoofCord matcher filters current nodes dynamically | One EXCLUDE root: own main process tree | Exact fixed Windows primitive; arbitrary independent exclusion list unavailable |
| Routing/endpoints | Real virtual sink/source and graph links | Endpoint-independent process loopback to PCM; no virtual microphone/endpoint selector | Routing API unavailable; endpoint selection out of scope |
| Start/stop/update | Ensure sink, route/clear links, dispose helper | Existing captureId replacement/ack/stop and renderer lifecycle; re-share to update | Adapted; live route editing deferred |
| Changes/events | `graphChanged` / `monitorDied`; debounce and polling; learned restart matcher | Native stream faults, manual picker refresh; no cross-PID auto-follow | Deferred, not promised |
| Platforms | Linux x64/arm64 helper + PipeWire tools | Windows x64 N-API addon; Windows arm64 explicitly unsupported natively | Adapted; Linux/macOS preserved |

## Shipped binary and retained experiments

Product consumes optionalDependency `thomas-quant/wasapi-loopback` pinned to **`29b24a1eaa04a60d79d1c89a80a8574e7ca3887f`** (branch `fix/async-native-calls`), not an arbitrary local Rust build. Its x64 prebuilt is **671232 bytes**, SHA-256 **`e2ba4f1bbd0baa2fc2f75fdaace6c0571016832d4bf345871ff3f767296a4165`**, recorded as `WASAPI_ADDON_SHA256` in `build/validateWasapiAddon.ts`; bump it with the pin. Required callable exports: `startExcludeProcessTree`, `startIncludeProcessTree`, `stopSession`, `stopAll`, `listAudioApps`, all returning promises.

Build stages/emits WASAPI only for Windows x64. Staging and each target's `afterPack` reject any Windows x64 addon whose SHA-256 differs from the pin, on every build host, so a stale `node_modules` cannot ship. `afterPack` also validates the actual ASAR inventory and requires the addon unpacked; on a Windows host it loads/checks the exports. Linux, macOS and Windows arm64 must contain no WASAPI addon. Static string scans are not a substitute for that real load; CI package checks do not start audio capture.

In-tree Rust subtraction code, `SUBTRACTION.md`, diagnostic tools and historical experimental results are retained, not deleted or re-certified. The dependency also retains experimental exports. None is selected by normal GoofCord runtime or required for product packaging. Historical notes claiming endpoint-minus-self is the chosen full-screen path, or universal VAC immunity, do not describe this contract. Scripts under `tools/wasapi-echo-test` predate the promise-returning start/stop/list API and call it synchronously.
