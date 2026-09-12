// Offline unit tests for endpoint-minus-self-scorer.mjs. Pure synthetic data only — no Electron,
// no addon, no real capture. These verify the scoring primitives do what they claim; they do not
// (and cannot) verify the real WASAPI subtraction, which is the harness's job.
import assert from "node:assert/strict";
import test from "node:test";

import { crossCorrelateLag, dbfs, rms, scoreCrossWiring, scoreExactCancellation, scoreLeakage, scoreMissingOutput, scoreOffsetStability, scorePreservation } from "./endpoint-minus-self-scorer.mjs";
import { generateBroadbandStereo } from "./endpoint-minus-self-signal.mjs";

function shift(buf, lag) {
	const out = new Float32Array(buf.length);
	for (let i = 0; i < buf.length; i++) {
		const j = i - lag;
		out[i] = j >= 0 && j < buf.length ? buf[j] : 0;
	}
	return out;
}

function mix(a, b) {
	const out = new Float32Array(Math.max(a.length, b.length));
	for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
	return out;
}

test("rms/dbfs basics", () => {
	const silence = new Float32Array(1000);
	assert.equal(rms(silence), 0);
	const full = new Float32Array(1000).fill(1);
	assert.equal(rms(full), 1);
	assert.ok(dbfs(0.5, 1) < 0);
	assert.equal(dbfs(1, 1), 0);
});

test("crossCorrelateLag finds a known integer shift", () => {
	const { left } = generateBroadbandStereo(11, 22, 4000, 0.3);
	const delayed = shift(left, 17);
	const { lagFrames, normCorr } = crossCorrelateLag(left, delayed, 64);
	assert.equal(lagFrames, 17);
	assert.ok(normCorr > 0.95, `expected strong correlation, got ${normCorr}`);
});

test("scoreExactCancellation passes on true silence and fails on a real residual", () => {
	const { left: ownRef } = generateBroadbandStereo(1, 2, 48000, 0.25);
	const silence = new Float32Array(ownRef.length);
	const clean = scoreExactCancellation({ captured: silence, ownReference: ownRef });
	assert.equal(clean.pass, true);

	const leaked = ownRef.map((v) => v * 0.2); // -14 dB residual, well above any sane gate
	const dirty = scoreExactCancellation({ captured: leaked, ownReference: ownRef });
	assert.equal(dirty.pass, false);
});

test("scoreLeakage passes when own hold-out is truly absent and fails when it correlates", () => {
	const { left: ownHoldout } = generateBroadbandStereo(101, 202, 48000, 0.25);
	const { left: unrelated } = generateBroadbandStereo(303, 404, 48000, 0.25);

	const clean = scoreLeakage({ capturedHoldout: unrelated, ownHoldoutReference: ownHoldout });
	assert.equal(clean.pass, true);
	assert.ok(Math.abs(clean.normCorr) < 0.08);

	const leaking = mix(
		unrelated,
		ownHoldout.map((v) => v * 0.6),
	);
	const dirty = scoreLeakage({ capturedHoldout: leaking, ownHoldoutReference: ownHoldout });
	assert.equal(dirty.pass, false);
});

test("scoreMissingOutput flags perpetual silence and passes on real signal", () => {
	const silence = new Float32Array(48000);
	const missing = scoreMissingOutput({ captured: silence });
	assert.equal(missing.pass, false);

	const { left: present } = generateBroadbandStereo(5, 6, 48000, 0.2);
	const ok = scoreMissingOutput({ captured: present });
	assert.equal(ok.pass, true);
});

test("scorePreservation passes on a delayed unity-ish copy of the other signal and fails when absent", () => {
	const { left: other } = generateBroadbandStereo(9, 10, 48000, 0.3);
	const preserved = shift(other, 12);
	const good = scorePreservation({ captured: preserved, otherReference: other });
	assert.equal(good.pass, true);
	assert.equal(good.lagFrames, 12);
	assert.ok(good.gain > 0.9 && good.gain < 1.1);

	const { left: somethingElse } = generateBroadbandStereo(500, 501, 48000, 0.3);
	const bad = scorePreservation({ captured: somethingElse, otherReference: other });
	assert.equal(bad.pass, false);

	const tooQuiet = other.map((v) => v * 0.05);
	const quiet = scorePreservation({ captured: tooQuiet, otherReference: other });
	assert.equal(quiet.pass, false);
});

test("scoreCrossWiring passes on clean absence and fails on an L/R swap", () => {
	const { left: refL, right: refR } = generateBroadbandStereo(21, 22, 48000, 0.25);
	const { left: capL, right: capR } = generateBroadbandStereo(23, 24, 48000, 0.25);

	const clean = scoreCrossWiring({ capturedL: capL, capturedR: capR, refL, refR });
	assert.equal(clean.pass, true);

	// Swap: refL leaks into capturedR instead of capturedL.
	const swapped = scoreCrossWiring({
		capturedL: capL,
		capturedR: mix(
			capR,
			refL.map((v) => v * 0.5),
		),
		refL,
		refR,
	});
	assert.equal(swapped.pass, false);
	assert.equal(swapped.worst.name, "refL_capR");
});

test("scoreOffsetStability passes on steady offsets and fails on a jump", () => {
	const steady = scoreOffsetStability({ offsetFramesSamples: [1024, 1025, 1023, 1024, 1026] });
	assert.equal(steady.pass, true);

	const jumping = scoreOffsetStability({ offsetFramesSamples: [1024, 1025, 4096, 1023] });
	assert.equal(jumping.pass, false);

	const empty = scoreOffsetStability({ offsetFramesSamples: [] });
	assert.equal(empty.pass, false);
});
