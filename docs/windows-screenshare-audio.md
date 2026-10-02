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

Capture IDs and the existing MessagePort readiness handshake isolate replacement and teardown. A capture reserved before the async identity query cannot revive after replacement/stop. Native sessions start before a port is transferred; PCM is dropped until the renderer acknowledges. Stop, page reload, failed generator writes, video/track stop and readiness timeout dispose the session. The mixer retains bounded per-source queues, 10 ms frames, sum/clamp (not automatic gain normalization), and silence for sources without queued frames.

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

Product consumes optionalDependency `thomas-quant/wasapi-loopback` pinned to **`0b7c34fb4cb17db336976d29a384256c11fe57a3`**, not an arbitrary local Rust build. Its x64 prebuilt is **624128 bytes**, SHA-256 **`fd26b76122a9ea73feb64ca30a0aa4bc021755798185d31c2d55a7d12b255d00`**. Required callable exports: `startExcludeProcessTree`, `startIncludeProcessTree`, `stopSession`, `stopAll`, `listAudioApps`.

Build stages/emits WASAPI only for Windows x64. Each target's `afterPack` validates the actual ASAR inventory; Windows x64 also requires an unpacked addon identical to the installed dependency and loads/checks its exports on the Windows CI host. Linux, macOS and Windows arm64 must contain no WASAPI addon. Static string scans are not a substitute for that real load; CI package checks do not start audio capture.

In-tree Rust subtraction code, `SUBTRACTION.md`, diagnostic tools and historical experimental results are retained, not deleted or re-certified. The dependency also retains experimental exports. None is selected by normal GoofCord runtime or required for product packaging. Historical notes claiming endpoint-minus-self is the chosen full-screen path, or universal VAC immunity, do not describe this contract. No native-repository change or release is needed for these existing INCLUDE/EXCLUDE primitives.
