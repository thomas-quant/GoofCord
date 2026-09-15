function playbackDuration(segment) {
	const repeats = segment.repeats ?? 1;
	if (!Number.isInteger(repeats) || repeats < 1 || !Number.isFinite(segment.seconds) || segment.seconds <= 0) throw new Error("invalid playback duration/repeats");
	return segment.seconds * repeats;
}
function summarizeLifecycle(samples) {
	const transitions = [];
	const failures = [];
	let last;
	let running = false;
	let realignments = 0;
	for (const s of samples) {
		const key = `${s.state}:${s.generation}`;
		if (key !== last) {
			transitions.push(s);
			if (s.state === "aligning" && running) realignments++;
			last = key;
		}
		if (s.state === "running") running = true;
		if (s.state === "failed" && !failures.includes(s.reason || "native failure")) failures.push(s.reason || "native failure");
	}
	return { healthy: running && failures.length === 0 && samples.at(-1)?.state === "running", realignments, failures, transitions, lastStatus: samples.at(-1) ?? null };
}
// Injected verbatim into the renderer; must stay self-contained.
function selectSink(devices, label) {
	const matches = devices.filter((d) => d.kind === "audiooutput" && d.deviceId !== "default" && d.deviceId !== "communications" && d.label === label);
	if (matches.length !== 1) throw new Error(`expected one output named ${label}, found ${matches.length}`);
	return matches[0].deviceId;
}
async function waitForPlaybackEnd(deadline, failure) {
	while (Date.now() < deadline) {
		const reason = failure();
		if (reason) return reason;
		await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
	}
	return failure();
}
function validateCompletion({ selfResult, otherResult, selfManifest, otherManifest }) {
	const failures = [];
	for (const [leg, result] of [
		["self", selfResult],
		["other", otherResult],
	]) {
		if (!result || result.code !== 0 || result.signal != null) failures.push(`${leg} process did not exit cleanly (code=${result?.code}, signal=${result?.signal})`);
	}
	if (!selfManifest) failures.push("self manifest is missing");
	else {
		if (selfManifest.fatalError) failures.push(`self capture failed: ${selfManifest.fatalError}`);
		if (selfManifest.lifecycle?.healthy !== true) failures.push("self capture did not finalize with a healthy lifecycle");
	}
	if (!otherManifest) failures.push("other manifest is missing");
	else {
		if (otherManifest.error) failures.push(`other playback failed: ${otherManifest.error}`);
		if (!Number.isFinite(otherManifest.startedAt) || !Number.isFinite(otherManifest.endedAt) || otherManifest.endedAt <= otherManifest.startedAt) failures.push("other playback did not finalize with valid start/end timestamps");
	}
	return failures;
}
module.exports = { playbackDuration, summarizeLifecycle, selectSink, waitForPlaybackEnd, validateCompletion };
