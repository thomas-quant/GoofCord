---
phase: 03-delivery-path-spike-pcm-mediastream-go-no-go
reviewed: 2026-06-02T00:00:00Z
depth: quick
files_reviewed: 4
files_reviewed_list:
  - src/modules/screenshareDebug.ts
  - src/windows/main/preload/bridge.ts
  - src/windows/main/preload/deliverySpike.ts
  - src/windows/main/preload/preload.mts
findings:
  critical: 0
  warning: 4
  info: 4
  total: 8
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-06-02T00:00:00Z
**Depth:** quick
**Files Reviewed:** 4
**Status:** issues_found

## Summary

Reviewed the Phase-3 delivery-path spike: the real/upstream-bound surface
(`screenshareDebug.ts` log writer + gate getter, `bridge.ts` contextBridge fields)
and the throwaway scaffolding (`deliverySpike.ts`, `injectDeliverySpike()` in
`preload.mts`). No Critical findings: no injection sinks, no hardcoded secrets, no
auth bypass, and the gate is off by default. The spike correctly bails when the
bridge is absent and gates the swap-seam behind `bridge.deliverySpike`.

The most material finding is in **real upstream-bound code**: the "off by default ⇒
byte-identical to today" guarantee does NOT hold at the IPC level. `bridge.ts`
evaluates a *synchronous, blocking* `sendSync` gate read at module-init time for
**every** Discord page load for **all** users, plus a second `sendSync` in
`injectDeliverySpike()` — two new blocking round-trips on the renderer startup path
regardless of the gate. Remaining findings are unbounded log growth, an unchecked
array access in the KEEP reconstruction, and resource/listener leaks in the spike.

The already-documented `audioSenders=0` / replaceTrack-vs-addTrack finding (in
03-FINDINGS.md) is acknowledged and not re-counted here.

## Warnings

### WR-01: `deliverySpike` gate read runs a blocking sync IPC for ALL users on every page (breaks "byte-identical when off")

**File:** `src/windows/main/preload/bridge.ts:46` (and `src/windows/main/preload/preload.mts:35`)
**Issue:** `deliverySpike: sendSync("screenshareDebug:isDeliverySpikeEnabled")` is a
*value*, evaluated eagerly when `bridge.ts` is imported. `bridge.ts` is imported
unconditionally by `preload.mts:1`, so this fires a synchronous, main-process-blocking
IPC round-trip on every Discord preload for every user — even when the gate is off.
`injectDeliverySpike()` (`preload.mts:35`) then performs a *second* `sendSync` to the
same channel on the same startup path. This contradicts the stated "off by default ⇒
byte-identical to today" invariant for upstream-bound code: the off state now adds two
blocking IPCs and a permanent new contextBridge field versus the pre-spike baseline.
This is the field most likely to leak into the upstream PR if the throwaway lines are
stripped imperfectly (it sits in the middle of the otherwise-real `api` object).
**Fix:** Make the gate a lazy getter so it costs nothing when unused, and dedupe the
two reads. The spike already reads `window.goofcord.deliverySpike` from the page; keep
a single source:
```ts
// bridge.ts — lazy, no eager sync IPC at import time
get deliverySpike() { return sendSync("screenshareDebug:isDeliverySpikeEnabled"); },
```
Then have `injectDeliverySpike()` reuse the bridge value instead of issuing its own
`sendSync`. Better still, keep the entire `deliverySpike`/`appendScreenshareDebug`
pair behind a clearly-fenced block that is trivially removable as a unit so the upstream
diff truly returns to baseline.

### WR-02: `screenshare-debug.log` grows unbounded — no size cap or rotation

**File:** `src/modules/screenshareDebug.ts:10-14`
**Issue:** `appendScreenshareDebug` appends a timestamped line per call with no cap.
The spike's `pollStats()` runs on a 2s interval and the MSTG feed/diagnostics log
repeatedly, so a long screenshare session writes continuously to a file in the user's
userData dir that nothing ever truncates or deletes. Even as throwaway diagnostics this
can balloon the log across sessions (the file is opened in append mode and survives
restarts).
**Fix:** Truncate on startup (open with `"w"` once per session) or cap size before
appending, e.g.:
```ts
try {
  const { size } = await fs.promises.stat(LOG);
  if (size > 5_000_000) await fs.promises.writeFile(LOG, ""); // reset at ~5MB
} catch { /* ENOENT: first write, ignore */ }
await fs.promises.appendFile(LOG, `${new Date().toISOString()} ${line}\n`);
```

### WR-03: `appendScreenshareDebug` has no error handling — rejection escapes the IPC handler

**File:** `src/modules/screenshareDebug.ts:12-14`
**Issue:** The `await fs.promises.appendFile(...)` is unguarded. If the write fails
(disk full, permissions, EBUSY), the rejection propagates out of the auto-generated
IPC handler (`gen.ts:34` does `return await ...`), rejecting the renderer's `invoke`
promise. This diverges from the project's filesystem error idiom
(CLAUDE.md: catch as `unknown`, `getErrorMessage(e)`, swallow expected ENOENT). The
renderer side in `deliverySpike.ts:38-43` swallows via try/catch, but a logging
primitive should not be able to surface a rejected promise to callers.
**Fix:** Wrap and swallow per project convention:
```ts
export async function appendScreenshareDebug<IPCHandle>(line: string) {
  try {
    await fs.promises.appendFile(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch (e) {
    console.warn(LOG_PREFIX, "screenshare debug write failed:", getErrorMessage(e));
  }
}
```

### WR-04: Unchecked array access returns `undefined` as `MediaStreamTrack` in KEEP reconstruction

**File:** `src/windows/main/preload/deliverySpike.ts:162`
**Issue:** `return dest.stream.getAudioTracks()[0];` is typed/declared to return
`MediaStreamTrack` but `[0]` is `MediaStreamTrack | undefined`. Under the project's
`strict` TS this is an unsound index. At runtime, if the destination has no audio track
the function returns `undefined`, and the caller does `stream.addTrack(synthetic)`
(`deliverySpike.ts:258`) which throws on `undefined`. This is in the KEEP (Phase-4 seed)
reconstruction path, so the unsound shape would carry into Phase 4. (The throw is caught
by the swap-seam try/catch, so it degrades silently rather than crashing — but the
silent-failure path is exactly what the spike is trying to prove/disprove.)
**Fix:** Validate before returning:
```ts
const track = dest.stream.getAudioTracks()[0];
if (!track) throw new Error("WebAudio destination produced no audio track");
return track;
```

## Info

### IN-01: Spike timers/contexts orphaned if `getDisplayMedia` is called twice before teardown

**File:** `src/windows/main/preload/deliverySpike.ts:64-68, 109, 143-147, 252`
**Issue:** `feedTimer`, `activeCtx`, `activeOsc`, `activeWriter` are single module-level
handles. Each gated `getDisplayMedia` call invokes `buildSyntheticAudioTrack()` which
reassigns them, orphaning the previous interval/AudioContext/oscillator without teardown
(the previous track's `ended` listener only fires when *that* track ends). The
cancel/re-click flow this fork targets is precisely a double-invoke scenario, so the
spike's own "Pitfall 5 — no leak" guarantee can be violated during the very flow it
diagnoses. THROWAWAY, but worth noting since it can skew the spike's own measurements.
**Fix:** Call `teardownSpike()` at the top of the gated branch before building a new
track, or store handles per-track rather than module-wide.

### IN-02: `ended` listeners added but never removed; teardown not idempotent-safe across tracks

**File:** `src/windows/main/preload/deliverySpike.ts:265-267`
**Issue:** `synthetic.addEventListener("ended", onEnd)` and the video-track listener are
never removed in `teardownSpike()`. Combined with IN-01, repeated invocations accumulate
listeners on distinct tracks. Minor for throwaway diagnostics.
**Fix:** Keep references and `removeEventListener` in `teardownSpike()`, or rely on
track GC after `stop()`.

### IN-03: Throwaway field interleaved with real `api` object increases strip risk

**File:** `src/windows/main/preload/bridge.ts:45-47`
**Issue:** The two throwaway fields (`deliverySpike`, `appendScreenshareDebug`) sit
between real fields (`stopPatchcord` above, `isVencordPresent` below). The comment marks
them, but their placement mid-object makes a clean mechanical strip before the upstream
PR error-prone (and they alter the public `GoofCordApi` type surface). See WR-01 for the
functional half of this concern.
**Fix:** Group all throwaway bridge fields at the end of the object behind a single
clearly-fenced comment block for atomic removal.

### IN-04: Synthetic-sample math is dead-but-shipped in WebAudio fallback path

**File:** `src/windows/main/preload/deliverySpike.ts:85-91`
**Issue:** `makeDistinctiveSample` is only consumed by the MSTG branch
(`deliverySpike.ts:112`). When the MSTG path is absent/fails and the WebAudio fallback
runs, the function is unused dead weight for that path. Explicitly THROWAWAY, so this is
informational only.
**Fix:** N/A for the spike; ensure both the function and the MSTG branch are removed
together when reducing to the KEEP seed.

---

_Reviewed: 2026-06-02T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: quick_
