# Concurrent raw-capture diagnostic

## Approved goal and scope
Record raw endpoint, raw self-tree, and native endpoint-minus-self output concurrently to identify the unexplained calibration residual. User approved this diagnostic after the run-2 timing investigation. Do not change native subtraction, audio devices/volumes, existing processes, thresholds, or captured samples.

The installed Windows addon already exposes startRenderEndpointLoopback and startIncludeProcessTree. Use independent raw sessions in the self Electron process instead of adding native internal taps (which would require a new addon build). On-box probing found duplicate INCLUDE of the same root PID is refused, while overlapping parent/child targets work. The raw self tap therefore targets the identified Chromium Audio Service child; subtraction still targets the main tree. Save the narrower target explicitly. Separate sessions have separate timelines: save packet indexes/stats and measure waveform alignment. Wall-clock times alone are not sample alignment. This cannot inspect the exact internal subtraction buffers.

## Execution
- [x] Add a tested CJS raw-capture helper. Start two sessions; retain exact callback bytes and per-stream frame indexes; poll capture stats; stop only owned sessions; persist errors and partial evidence on refusal/failure. Bound recording through the existing watchdog. Refuse to overwrite evidence.
- [x] Wire opt-in --diagnostic-raw through the existing harness/self process. Close diagnostics on normal and error exits. Leave normal behavior and scoring thresholds unchanged.
- [x] Run Node unit tests and syntax checks. Exercise Windows addon using the existing Electron 41 installation and existing subtraction-addon .node, in a fresh dist/audio-validation directory. Run through tmux with an exit-status file.
- [x] Identify generated self in raw self/endpoint; locate other in raw endpoint/output; compare unmodified output residual against raw sources. Report timing/coverage failures explicitly, never infer self cancellation from low correlation at an unverified lag. Save analysis and caveats next to recordings and in the README.

## Recorded outcome
Two completed runs: `dist/audio-validation/subtraction-raw-2/` and `subtraction-raw-3/`.
The identity `native output == float32(raw endpoint - raw self)` holds bit-for-bit in both channels for two post-lock windows totaling 7.25 seconds in each run. The raw endpoint contains unrelated content even before self playback. Generated self differs from raw self by at most 6.985e-10 per sample. The overall feature is not certified: startup resets, a run-2 re-lock, endpoint DSP, real calls and sustained operation remain caveats. See `endpoint-minus-self-README.md` and each run's `raw-analysis.json`. No native or application rebuild was necessary.

## Acceptance and limits
Frame: keep other audio, remove self on the selected endpoint; test uses synthetic Electron playback rather than arbitrary application content. Condition: positive raw evidence of self playback on the endpoint and a known waveform timeline. Roles: source references label/time audio; raw taps identify residual sources; none may be used to modify native output before evaluation. All DSP diagnostics are deterministic measurements, not statistical significance tests.

No application build is needed for diagnostics-only changes. The previous ZIP remains experimental. Hardware success on this one endpoint would not prove all-device compatibility or long-duration reliability.
