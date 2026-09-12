// Exercises the windowing/deinterleave arithmetic in endpoint-minus-self-report.mjs against a
// fabricated on-disk fixture that mimics what a real run leaves in --out. This is the one place
// that arithmetic (frameAtWallClock, deinterleave, trim bands) gets run for real in this test
// suite — everything else here is pure synthetic data, no Electron, no addon.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { scoreCapture } from "./endpoint-minus-self-report.mjs";
import { generateBroadbandStereo } from "./endpoint-minus-self-signal.mjs";

const SAMPLE_RATE = 48000;

function writeInterleaved(path, left, right) {
	const out = new Float32Array(left.length * 2);
	for (let i = 0; i < left.length; i++) {
		out[i * 2] = left[i];
		out[i * 2 + 1] = right[i];
	}
	writeFileSync(path, Buffer.from(out.buffer));
}

function buildFixture({ outDir, schedule, config, otherLeftFull, otherRightFull, capturedLeft, capturedRight, startEpochMs }) {
	writeInterleaved(join(outDir, "captured.f32"), capturedLeft, capturedRight);
	writeFileSync(join(outDir, "other-reference-left.f32"), Buffer.from(otherLeftFull.buffer));
	writeFileSync(join(outDir, "other-reference-right.f32"), Buffer.from(otherRightFull.buffer));

	// One packet every 480 frames (10ms @ 48kHz), wall clock advancing in lockstep from startEpochMs
	// — a clean, gap-free capture clock, exactly what the self process produces in the ordinary case.
	const lines = [];
	const totalFrames = capturedLeft.length;
	for (let frameStart = 0, seq = 0; frameStart < totalFrames; frameStart += 480, seq++) {
		const frameCount = Math.min(480, totalFrames - frameStart);
		const wallClockMs = startEpochMs + Math.round((frameStart / SAMPLE_RATE) * 1000);
		lines.push(JSON.stringify({ seq, wallClockMs, frameStart, frameCount, byteOffset: frameStart * 8, byteLength: frameCount * 8 }));
	}
	writeFileSync(join(outDir, "captured-index.ndjson"), lines.join("\n") + "\n");

	return { schedule, config };
}

test("scoreCapture passes on a fixture with clean cancellation and preserved other-audio", () => {
	const dir = mkdtempSync(join(tmpdir(), "endpoint-minus-self-report-"));
	try {
		const calibrationSeconds = 1;
		const holdoutSeconds = 1;
		const peakAmplitude = 0.2;
		const schedule = {
			calibration: { seconds: calibrationSeconds, seedL: 1, seedR: 2, peakAmplitude },
			holdout: { seconds: holdoutSeconds, seedL: 3, seedR: 4, peakAmplitude },
		};
		const config = { sampleRate: SAMPLE_RATE, trimMs: 50, maxLagFrames: 64 };

		const calibFrames = calibrationSeconds * SAMPLE_RATE;
		const holdoutFrames = holdoutSeconds * SAMPLE_RATE;
		const other = generateBroadbandStereo(5, 6, holdoutFrames, peakAmplitude);

		// Captured stream: silence during calibration (perfect self-cancellation), then exactly the
		// other signal during hold-out (self fully removed, other fully preserved) — the ideal case.
		const capturedLeft = new Float32Array(calibFrames + holdoutFrames);
		const capturedRight = new Float32Array(calibFrames + holdoutFrames);
		capturedLeft.set(other.left, calibFrames);
		capturedRight.set(other.right, calibFrames);

		const startEpochMs = 1_000_000;
		const selfManifest = {
			timings: {
				selfAudioStartAtEpochMs: startEpochMs,
				calibrationEndAtEpochMs: startEpochMs + calibrationSeconds * 1000,
				holdoutStartAtEpochMs: startEpochMs + calibrationSeconds * 1000,
				holdoutEndAtEpochMs: startEpochMs + (calibrationSeconds + holdoutSeconds) * 1000,
			},
			packets: { gaps: 0 },
			offsetFramesSamples: [100, 101, 100, 99],
		};

		buildFixture({ outDir: dir, schedule, config, otherLeftFull: other.left, otherRightFull: other.right, capturedLeft, capturedRight, startEpochMs });

		const result = scoreCapture({ outDir: dir, schedule, config, selfManifest });
		assert.equal(result.pass, true, JSON.stringify(result.gates, null, 2));
		assert.equal(result.gates["exact-cancellation-L"].pass, true);
		assert.equal(result.gates["preservation-other-L"].pass, true);
		assert.equal(result.gates["leakage-holdout-L"].pass, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("scoreCapture fails when the self signal leaks into the hold-out window", () => {
	const dir = mkdtempSync(join(tmpdir(), "endpoint-minus-self-report-"));
	try {
		const calibrationSeconds = 1;
		const holdoutSeconds = 1;
		const peakAmplitude = 0.2;
		const schedule = {
			calibration: { seconds: calibrationSeconds, seedL: 1, seedR: 2, peakAmplitude },
			holdout: { seconds: holdoutSeconds, seedL: 3, seedR: 4, peakAmplitude },
		};
		const config = { sampleRate: SAMPLE_RATE, trimMs: 50, maxLagFrames: 64 };

		const calibFrames = calibrationSeconds * SAMPLE_RATE;
		const holdoutFrames = holdoutSeconds * SAMPLE_RATE;
		const other = generateBroadbandStereo(5, 6, holdoutFrames, peakAmplitude);
		const ownHoldout = generateBroadbandStereo(schedule.holdout.seedL, schedule.holdout.seedR, holdoutFrames, peakAmplitude);

		const capturedLeft = new Float32Array(calibFrames + holdoutFrames);
		const capturedRight = new Float32Array(calibFrames + holdoutFrames);
		// Hold-out window leaks 40% of the own signal on top of the other signal that should have
		// been the only thing there.
		for (let i = 0; i < holdoutFrames; i++) {
			capturedLeft[calibFrames + i] = other.left[i] + ownHoldout.left[i] * 0.4;
			capturedRight[calibFrames + i] = other.right[i] + ownHoldout.right[i] * 0.4;
		}

		const startEpochMs = 1_000_000;
		const selfManifest = {
			timings: {
				selfAudioStartAtEpochMs: startEpochMs,
				calibrationEndAtEpochMs: startEpochMs + calibrationSeconds * 1000,
				holdoutStartAtEpochMs: startEpochMs + calibrationSeconds * 1000,
				holdoutEndAtEpochMs: startEpochMs + (calibrationSeconds + holdoutSeconds) * 1000,
			},
			packets: { gaps: 0 },
			offsetFramesSamples: [100],
		};

		buildFixture({ outDir: dir, schedule, config, otherLeftFull: other.left, otherRightFull: other.right, capturedLeft, capturedRight, startEpochMs });

		const result = scoreCapture({ outDir: dir, schedule, config, selfManifest });
		assert.equal(result.pass, false);
		assert.equal(result.gates["leakage-holdout-L"].pass, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
