// The process under test: loads the real wasapi-loopback addon, calls the real
// startEndpointMinusSelf/getSubtractionStatus/stopSession API against a real endpoint capture
// session, and plays deterministic own-process audio through Web Audio so THIS process is a real
// "self" the addon has to subtract.
//
// No microphone, no killing of pre-existing processes, no global audio/volume/device changes:
// this only loads the addon from the path it is given and opens a hidden window that plays a
// finite generated buffer.
//
// Usage:
//   electron endpoint-minus-self-electron-main.cjs --addon <path.node> --device-id <id|""> \
//     --schedule <schedule.json> --out <dir>
//
// Exit codes (distinct on purpose — the parent CLI must be able to tell "this environment cannot
// run the real feature" apart from "it ran and failed its gates"):
//   0  ran to completion with no addon-level fatal error (scoring happens in the parent)
//   1  unhandled error during the run
//   2  addon file not found at the given path
//   3  not running on win32 — the addon is Windows-only, this is an environment limitation
//   4  addon loaded but is missing startEndpointMinusSelf/getSubtractionStatus/stopSession
//   5  require() of the addon threw (corrupt file or ABI-incompatible build)
//   6  startEndpointMinusSelf returned a falsy session id (addon refused to start)
//   7  getSubtractionStatus reported "failed", or never reached "running" before the deadline
//   8  watchdog timeout
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const REQUIRED_EXPORTS = ["startEndpointMinusSelf", "getSubtractionStatus", "stopSession"];

function argValue(flag) {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const addonPath = argValue("--addon");
const deviceIdArg = argValue("--device-id");
const deviceId = deviceIdArg === undefined || deviceIdArg === "" ? undefined : deviceIdArg;
const schedulePath = argValue("--schedule");
const outDir = argValue("--out");

if (!addonPath || !schedulePath || !outDir) {
	console.error('Usage: electron endpoint-minus-self-electron-main.cjs --addon <path.node> --device-id <id|""> --schedule <schedule.json> --out <dir>');
	process.exit(2);
}

const schedule = JSON.parse(fs.readFileSync(schedulePath, "utf8"));
const { sampleRate, leadInSeconds, calibration, holdout, alignTimeoutSeconds, pollIntervalMs } = schedule;

const manifest = {
	role: "self",
	pid: process.pid,
	platform: process.platform,
	electron: process.versions.electron,
	chromium: process.versions.chrome,
	addonPath,
	deviceId: deviceId ?? null,
	sampleRate,
	skipped: false,
	skipReason: null,
	fatalError: null,
	sessionId: null,
	alignedAtMs: null,
	timings: { selfAudioStartAtEpochMs: null, calibrationEndAtEpochMs: null, holdoutStartAtEpochMs: null, holdoutEndAtEpochMs: null },
	packets: { count: 0, bytes: 0, gaps: 0, errors: 0 },
	statusLogFile: "status-log.ndjson",
	capturedIndexFile: "captured-index.ndjson",
	capturedFile: "captured.f32",
};

function writeManifest() {
	fs.writeFileSync(path.join(outDir, "self-manifest.json"), JSON.stringify(manifest, null, 2));
}

function bail(code, reason) {
	manifest.fatalError = reason;
	if (code === 3) {
		manifest.skipped = true;
		manifest.skipReason = reason;
	}
	writeManifest();
	console.error(`endpoint-minus-self-electron-main: ${reason}`);
	app.exit(code);
}

// ── Capability checks, each with its own exit code (see header) ────────────────────────────
// Gated on whenReady(): BrowserWindow (created inside run()) is unusable before then, and
// app.exit() is meant to be called once Electron has actually started up.
app.whenReady().then(() => {
	if (process.platform !== "win32") {
		bail(3, `startEndpointMinusSelf is a Windows-only WASAPI API; this host is "${process.platform}". Cannot exercise the real addon here — this is an environment limitation, not a pass or a fail.`);
		return;
	}
	if (!fs.existsSync(addonPath)) {
		bail(2, `addon not found at ${addonPath}`);
		return;
	}
	let addon;
	try {
		addon = createRequire(__filename)(addonPath);
	} catch (e) {
		bail(5, `require() of ${addonPath} threw: ${(e && e.stack) || e}`);
		return;
	}
	const missing = REQUIRED_EXPORTS.filter((name) => typeof addon[name] !== "function");
	if (missing.length > 0) {
		bail(4, `addon at ${addonPath} is missing required export(s): ${missing.join(", ")}. This validation harness targets a newer contract than this addon build implements.`);
		return;
	}
	run(addon).catch((e) => bail(1, `unhandled error: ${(e && e.stack) || e}`));
});

async function run(addon) {
	const capturedPath = path.join(outDir, "captured.f32");
	const capturedStream = fs.createWriteStream(capturedPath);
	const indexLines = [];
	let frameIndex = 0;
	let byteOffset = 0;
	let seq = 0;
	const BYTES_PER_FRAME = 4 * 2; // f32 stereo
	const EXPECTED_FRAMES_PER_CHUNK = 480;

	function appendIndex(entry) {
		indexLines.push(JSON.stringify(entry));
		if (indexLines.length >= 200) flushIndex();
	}
	function flushIndex() {
		if (indexLines.length === 0) return;
		fs.appendFileSync(path.join(outDir, "captured-index.ndjson"), indexLines.join("\n") + "\n");
		indexLines.length = 0;
	}

	const onChunk = (err, chunk) => {
		const wallClockMs = Date.now();
		if (err) {
			manifest.packets.errors++;
			appendIndex({ seq: seq++, wallClockMs, error: String(err) });
			return;
		}
		if (!chunk || chunk.byteLength === 0) return;
		const frameCount = chunk.byteLength / BYTES_PER_FRAME;
		if (frameCount !== EXPECTED_FRAMES_PER_CHUNK) manifest.packets.gaps++;
		capturedStream.write(chunk);
		appendIndex({ seq: seq++, wallClockMs, frameStart: frameIndex, frameCount, byteOffset, byteLength: chunk.byteLength });
		frameIndex += frameCount;
		byteOffset += chunk.byteLength;
		manifest.packets.count++;
		manifest.packets.bytes += chunk.byteLength;
	};

	const sessionId = addon.startEndpointMinusSelf(process.pid, deviceId ?? null, onChunk);
	if (!sessionId) {
		flushIndex();
		bail(6, "startEndpointMinusSelf returned a falsy session id — addon refused to start capture");
		return;
	}
	manifest.sessionId = sessionId;
	writeManifest();

	// ── Status polling: watch for "running" (alignment achieved) and "failed" ────────────────
	let alignedAtMs = null;
	let sawFailure = null;
	const statusSamples = [];
	const statusTimer = setInterval(() => {
		let status;
		try {
			status = addon.getSubtractionStatus(sessionId);
		} catch (e) {
			appendIndex({ seq: seq++, wallClockMs: Date.now(), statusError: String(e) });
			return;
		}
		if (!status) return;
		const entry = { wallClockMs: Date.now(), ...status };
		fs.appendFileSync(path.join(outDir, "status-log.ndjson"), JSON.stringify(entry) + "\n");
		statusSamples.push(entry);
		if (status.state === "running" && alignedAtMs === null) alignedAtMs = Date.now();
		if (status.state === "failed") sawFailure = status.reason || "addon reported state=failed";
	}, pollIntervalMs);

	// ── Own-audio playback: hidden window, real Web Audio, deterministic + bounded ───────────
	const { SIGNAL_SOURCE } = await import(path.join(__dirname, "endpoint-minus-self-signal.mjs"));
	const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: true, backgroundThrottling: false } });
	await win.loadURL("data:text/html,<html><body></body></html>");
	await win.webContents.executeJavaScript(SIGNAL_SOURCE);

	const calibFrames = Math.round(calibration.seconds * sampleRate);
	const holdoutFrames = Math.round(holdout.seconds * sampleRate);
	await win.webContents.executeJavaScript(`
		const ctx = new AudioContext({ sampleRate: ${sampleRate} });
		const calib = generateBroadbandStereo(${calibration.seedL}, ${calibration.seedR}, ${calibFrames}, ${calibration.peakAmplitude});
		const held = generateBroadbandStereo(${holdout.seedL}, ${holdout.seedR}, ${holdoutFrames}, ${holdout.peakAmplitude});
		const calibBuf = ctx.createBuffer(2, ${calibFrames}, ${sampleRate});
		calibBuf.copyToChannel(calib.left, 0);
		calibBuf.copyToChannel(calib.right, 1);
		const heldBuf = ctx.createBuffer(2, ${holdoutFrames}, ${sampleRate});
		heldBuf.copyToChannel(held.left, 0);
		heldBuf.copyToChannel(held.right, 1);
		const calibSource = ctx.createBufferSource();
		calibSource.buffer = calibBuf;
		calibSource.connect(ctx.destination);
		const holdSource = ctx.createBufferSource();
		holdSource.buffer = heldBuf;
		holdSource.connect(ctx.destination);
		window.__endpointMinusSelfArm = () => {
			const t0 = ctx.currentTime;
			calibSource.start(t0);
			holdSource.start(t0 + ${calibration.seconds});
			return t0;
		};
		void 0;
	`);

	const barrierDelayMs = Math.max(0, schedule.selfBarrierEpochMs + leadInSeconds * 1000 - Date.now());
	await new Promise((resolve) => setTimeout(resolve, barrierDelayMs));

	manifest.timings.selfAudioStartAtEpochMs = Date.now();
	await win.webContents.executeJavaScript("window.__endpointMinusSelfArm()");
	manifest.timings.calibrationEndAtEpochMs = manifest.timings.selfAudioStartAtEpochMs + calibration.seconds * 1000;
	manifest.timings.holdoutStartAtEpochMs = manifest.timings.calibrationEndAtEpochMs;
	manifest.timings.holdoutEndAtEpochMs = manifest.timings.holdoutStartAtEpochMs + holdout.seconds * 1000;
	writeManifest();

	// Wait for alignment to be reached before the calibration segment is over, with a bounded
	// grace deadline. Never silently proceed past this as if alignment happened.
	const alignDeadlineMs = manifest.timings.calibrationEndAtEpochMs + alignTimeoutSeconds * 1000;
	while (alignedAtMs === null && sawFailure === null && Date.now() < alignDeadlineMs) {
		await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, 100)));
	}
	if (sawFailure) {
		clearInterval(statusTimer);
		flushIndex();
		capturedStream.end();
		try {
			addon.stopSession(sessionId);
		} catch {
			// best-effort
		}
		bail(7, `addon reported subtraction failure: ${sawFailure}`);
		return;
	}
	if (alignedAtMs === null) {
		clearInterval(statusTimer);
		flushIndex();
		capturedStream.end();
		try {
			addon.stopSession(sessionId);
		} catch {
			// best-effort
		}
		bail(7, `addon never reported state="running" within ${alignTimeoutSeconds}s of the calibration segment ending — cannot certify subtraction, this is not a pass`);
		return;
	}
	manifest.alignedAtMs = alignedAtMs;
	writeManifest();

	// Wait out the hold-out segment plus settle time to catch trailing packets.
	const remainingMs = manifest.timings.holdoutEndAtEpochMs - Date.now() + 400;
	if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs));

	// Collect a final generation's worth of offset samples for scoreOffsetStability, restricted to
	// samples from the SAME generation the run aligned in (a generation change is an expected
	// reset, not jitter, and must not be folded into the same stability check).
	const runningGeneration = statusSamples.find((s) => s.state === "running")?.generation;
	manifest.offsetFramesSamples = statusSamples.filter((s) => s.state === "running" && s.generation === runningGeneration).map((s) => s.offsetFrames);
	manifest.statusSampleCount = statusSamples.length;

	clearInterval(statusTimer);
	flushIndex();
	capturedStream.end();
	try {
		addon.stopSession(sessionId);
	} catch (e) {
		manifest.stopSessionError = String(e);
	}
	writeManifest();
	setTimeout(() => app.exit(0), 100);
}

const watchdogMs = (schedule.watchdogSeconds ?? 120) * 1000;
setTimeout(() => bail(8, `watchdog: self process exceeded its ${watchdogMs}ms deadline`), watchdogMs).unref();

app.on("window-all-closed", () => {});
