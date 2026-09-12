// Turns one completed run's raw files (captured.f32 + captured-index.ndjson + self-manifest.json
// + other-reference-*.f32) into windowed slices and scored gates. Pulled out of
// endpoint-minus-self-harness.mjs so the windowing/deinterleave arithmetic — the most
// hand-written, bug-prone part of this harness — can be exercised directly by
// endpoint-minus-self-report.test.mjs against a fabricated fixture, without needing Electron or
// the real addon.
//
// Reads files; does not spawn anything and does not talk to the addon. Purely turns "what a run
// already produced on disk" into a score.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { scoreCrossWiring, scoreExactCancellation, scoreLeakage, scoreMissingOutput, scoreOffsetStability, scorePreservation } from "./endpoint-minus-self-scorer.mjs";
import { generateBroadbandStereo } from "./endpoint-minus-self-signal.mjs";

// Buffer.prototype.buffer may be a pooled ArrayBuffer with a non-4-byte-aligned byteOffset for
// small reads, which a Float32Array view would reject — copy out to a dedicated, aligned buffer.
export function readFloat32(path) {
	const raw = readFileSync(path);
	const copy = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
	return new Float32Array(copy);
}

/**
 * Maps a wall-clock millisecond timestamp to the interpolated captured frame index active at that
 * moment, from an ndjson index of {wallClockMs, frameStart} entries (already filtered to real
 * audio packets). Packets arrive roughly every 10ms (480 frames @ 48kHz), so linear interpolation
 * between the bracketing entries is accurate to a small fraction of that — comfortably inside the
 * trim guard band applied around every scored window.
 */
export function frameAtWallClock(indexLines, targetMs) {
	if (indexLines.length === 0) return 0;
	let lo = indexLines[0];
	let hi = indexLines[indexLines.length - 1];
	for (const entry of indexLines) {
		if (entry.wallClockMs <= targetMs) lo = entry;
		if (entry.wallClockMs >= targetMs) {
			hi = entry;
			break;
		}
	}
	if (lo === hi || hi.wallClockMs === lo.wallClockMs) return lo.frameStart;
	const t = (targetMs - lo.wallClockMs) / (hi.wallClockMs - lo.wallClockMs);
	return Math.round(lo.frameStart + t * (hi.frameStart - lo.frameStart));
}

export function deinterleave(capturedInterleaved, totalFrames, startFrame, frameCount) {
	const left = new Float32Array(Math.max(0, frameCount));
	const right = new Float32Array(Math.max(0, frameCount));
	for (let i = 0; i < frameCount; i++) {
		const frame = startFrame + i;
		if (frame < 0 || frame >= totalFrames) continue;
		left[i] = capturedInterleaved[frame * 2];
		right[i] = capturedInterleaved[frame * 2 + 1];
	}
	return { left, right };
}

function trimRef(ref, frameCount, trimFrames) {
	return { left: ref.left.subarray(trimFrames, frameCount - trimFrames), right: ref.right.subarray(trimFrames, frameCount - trimFrames) };
}

/**
 * Score one completed run. `schedule` and `config` are the same shapes endpoint-minus-self-
 * harness.mjs writes/uses; `selfManifest` is self-manifest.json already parsed, from a run that
 * completed (not skipped, no fatalError) so timings/offsetFramesSamples/packets are populated.
 */
export function scoreCapture({ outDir, schedule, config, selfManifest }) {
	const capturedInterleaved = readFloat32(join(outDir, "captured.f32"));
	const totalFrames = capturedInterleaved.length / 2;

	const indexLines = readFileSync(join(outDir, "captured-index.ndjson"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((e) => e.frameStart !== undefined);

	const trimFrames = Math.round((config.trimMs / 1000) * config.sampleRate);
	const { timings } = selfManifest;
	const calibStartFrame = frameAtWallClock(indexLines, timings.selfAudioStartAtEpochMs) + trimFrames;
	const calibEndFrame = frameAtWallClock(indexLines, timings.calibrationEndAtEpochMs) - trimFrames;
	const holdoutStartFrame = frameAtWallClock(indexLines, timings.holdoutStartAtEpochMs) + trimFrames;
	const holdoutEndFrame = frameAtWallClock(indexLines, timings.holdoutEndAtEpochMs) - trimFrames;

	const calibCaptured = deinterleave(capturedInterleaved, totalFrames, calibStartFrame, Math.max(0, calibEndFrame - calibStartFrame));
	const holdoutCaptured = deinterleave(capturedInterleaved, totalFrames, holdoutStartFrame, Math.max(0, holdoutEndFrame - holdoutStartFrame));
	const fullCaptured = deinterleave(capturedInterleaved, totalFrames, 0, totalFrames);

	const calibFrameCount = Math.round(schedule.calibration.seconds * config.sampleRate);
	const holdoutFrameCount = Math.round(schedule.holdout.seconds * config.sampleRate);
	const calibReference = generateBroadbandStereo(schedule.calibration.seedL, schedule.calibration.seedR, calibFrameCount, schedule.calibration.peakAmplitude);
	const holdoutReference = generateBroadbandStereo(schedule.holdout.seedL, schedule.holdout.seedR, holdoutFrameCount, schedule.holdout.peakAmplitude);
	const calibRefTrimmed = trimRef(calibReference, calibFrameCount, trimFrames);
	const holdoutRefTrimmed = trimRef(holdoutReference, holdoutFrameCount, trimFrames);

	const otherRefLeft = readFloat32(join(outDir, "other-reference-left.f32"));
	const otherRefRight = readFloat32(join(outDir, "other-reference-right.f32"));
	const otherRefTrimmed = { left: otherRefLeft.subarray(trimFrames, holdoutFrameCount - trimFrames), right: otherRefRight.subarray(trimFrames, holdoutFrameCount - trimFrames) };

	const gates = {
		"exact-cancellation-L": scoreExactCancellation({ captured: calibCaptured.left, ownReference: calibRefTrimmed.left }),
		"exact-cancellation-R": scoreExactCancellation({ captured: calibCaptured.right, ownReference: calibRefTrimmed.right }),
		"missing-output": scoreMissingOutput({ captured: fullCaptured.left.length > 0 ? fullCaptured.left : fullCaptured.right }),
		"leakage-holdout-L": scoreLeakage({ capturedHoldout: holdoutCaptured.left, ownHoldoutReference: holdoutRefTrimmed.left, maxLagFrames: config.maxLagFrames }),
		"leakage-holdout-R": scoreLeakage({ capturedHoldout: holdoutCaptured.right, ownHoldoutReference: holdoutRefTrimmed.right, maxLagFrames: config.maxLagFrames }),
		"cross-wiring-holdout": scoreCrossWiring({ capturedL: holdoutCaptured.left, capturedR: holdoutCaptured.right, refL: holdoutRefTrimmed.left, refR: holdoutRefTrimmed.right, maxLagFrames: config.maxLagFrames }),
		"preservation-other-L": scorePreservation({ captured: holdoutCaptured.left, otherReference: otherRefTrimmed.left, maxLagFrames: config.maxLagFrames }),
		"preservation-other-R": scorePreservation({ captured: holdoutCaptured.right, otherReference: otherRefTrimmed.right, maxLagFrames: config.maxLagFrames }),
		"offset-stability": scoreOffsetStability({ offsetFramesSamples: selfManifest.offsetFramesSamples ?? [] }),
	};

	const limitations = [];
	if ((selfManifest.packets?.gaps ?? 0) > 0) limitations.push(`${selfManifest.packets.gaps} captured chunk(s) were not the expected 480-frame size — scoring assumes contiguous packets and does not reconstruct dropped-frame silence; treat this run's windowing as approximate.`);

	return {
		gates,
		windowing: { trimFrames, calibStartFrame, calibEndFrame, holdoutStartFrame, holdoutEndFrame, totalFrames, packets: selfManifest.packets },
		limitations,
		pass: Object.values(gates).every((g) => g.pass),
	};
}
