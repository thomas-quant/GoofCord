import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const { playbackDuration, summarizeLifecycle, selectSink, waitForPlaybackEnd, validateCompletion } = createRequire(import.meta.url)("./endpoint-minus-self-lifecycle.cjs");
test("repeat duration is bounded and validated", () => {
	assert.equal(playbackDuration({ seconds: 20, repeats: 90 }), 1800);
	assert.equal(playbackDuration({ seconds: 4 }), 4);
	for (const repeats of [0, -1, 1.5, NaN]) assert.throws(() => playbackDuration({ seconds: 4, repeats }));
});
test("late native failure never becomes successful lifecycle", () => {
	const result = summarizeLifecycle([
		{ state: "aligning", generation: 1, wallClockMs: 0 },
		{ state: "running", generation: 1, wallClockMs: 100 },
		{ state: "failed", generation: 1, wallClockMs: 900, reason: "lost lock" },
	]);
	assert.equal(result.healthy, false);
	assert.deepEqual(result.failures, ["lost lock"]);
});
test("relocking and every generation are retained", () => {
	const result = summarizeLifecycle([
		{ state: "running", generation: 1, wallClockMs: 100 },
		{ state: "aligning", generation: 2, wallClockMs: 200 },
		{ state: "running", generation: 2, wallClockMs: 300 },
	]);
	assert.equal(result.realignments, 1);
	assert.equal(result.transitions.length, 3);
	assert.equal(result.healthy, true);
	assert.equal(summarizeLifecycle([]).healthy, false);
	assert.equal(
		summarizeLifecycle([
			{ state: "running", generation: 1 },
			{ state: "aligning", generation: 2 },
		]).healthy,
		false,
	);
});
test("playback wait stops immediately on a native failure", async () => {
	let polls = 0;
	const result = await waitForPlaybackEnd(Date.now() + 60000, () => {
		polls++;
		return "device lost";
	});
	assert.equal(result, "device lost");
	assert.equal(polls, 1);
});
const completedRun = () => ({
	selfResult: { code: 0, signal: null },
	otherResult: { code: 0, signal: null },
	selfManifest: { lifecycle: { healthy: true } },
	otherManifest: { startedAt: 100, endedAt: 200 },
});
test("completion requires clean child exits and finalized manifests", () => {
	assert.deepEqual(validateCompletion(completedRun()), []);
	for (const leg of ["self", "other"]) {
		for (const result of [
			{ code: null, signal: "SIGTERM" },
			{ code: 1, signal: null },
			{ code: null, signal: null },
		]) {
			const run = completedRun();
			run[`${leg}Result`] = result;
			assert.ok(validateCompletion(run).length > 0, `${leg}: ${JSON.stringify(result)}`);
		}
	}
	for (const selfManifest of [null, {}, { lifecycle: { healthy: false } }, { fatalError: "lost lock", lifecycle: { healthy: true } }]) {
		assert.ok(validateCompletion({ ...completedRun(), selfManifest }).length > 0);
	}
	for (const otherManifest of [null, {}, { startedAt: 100, endedAt: null }, { startedAt: 100, endedAt: 99 }, { startedAt: 100, endedAt: 200, error: "playback failed" }]) {
		assert.ok(validateCompletion({ ...completedRun(), otherManifest }).length > 0);
	}
});
test("sink selection requires one exact non-default label", () => {
	const devices = [
		{ kind: "audiooutput", deviceId: "default", label: "Default - Speakers" },
		{ kind: "audiooutput", deviceId: "abc", label: "Speakers" },
	];
	assert.equal(selectSink(devices, "Speakers"), "abc");
	assert.throws(() => selectSink(devices, "HDMI"));
	assert.throws(() => selectSink([...devices, { ...devices[1], deviceId: "def" }], "Speakers"));
});
