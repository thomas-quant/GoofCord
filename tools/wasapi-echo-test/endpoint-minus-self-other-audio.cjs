// Second, independent Electron process: plays a known deterministic stereo signal that has
// NOTHING to do with the process under test (endpoint-minus-self-electron-main.cjs). Its job is
// to be the "other app" that a correct subtraction must preserve.
//
// No microphone, no desktopCapturer, no killing of pre-existing processes, no global audio/volume
// changes: this only opens a hidden window and asks Web Audio to render a buffer through whatever
// the OS default output device already is.
//
// Usage: electron endpoint-minus-self-other-audio.cjs --schedule <schedule.json> --out <dir>
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

function argValue(flag) {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const schedulePath = argValue("--schedule");
const outDir = argValue("--out");
if (!schedulePath || !outDir) {
	console.error("Usage: electron endpoint-minus-self-other-audio.cjs --schedule <schedule.json> --out <dir>");
	process.exit(2);
}

const schedule = JSON.parse(fs.readFileSync(schedulePath, "utf8"));
const { sampleRate, other } = schedule;
const frameCount = Math.round(other.seconds * sampleRate);

const manifest = { role: "other-audio", pid: process.pid, sampleRate, frameCount, seedL: other.seedL, seedR: other.seedR, peakAmplitude: other.peakAmplitude, startedAt: null, endedAt: null, error: null };

function writeManifest() {
	fs.writeFileSync(path.join(outDir, "other-manifest.json"), JSON.stringify(manifest, null, 2));
}

let win;
app.whenReady().then(async () => {
	try {
		// Dynamic import: the shared generator is an ESM module (see endpoint-minus-self-signal.mjs
		// for why it must stay plain, toString()-able source) but this harness process is CJS.
		const { SIGNAL_SOURCE, generateBroadbandStereo } = await import("./endpoint-minus-self-signal.mjs");

		// Save the ground-truth reference BEFORE playback even starts. This is the "independently
		// identifiable content" the design calls for: known ahead of time, not reconstructed after
		// the fact from whatever happened to get captured.
		const reference = generateBroadbandStereo(other.seedL, other.seedR, frameCount, other.peakAmplitude);
		fs.writeFileSync(path.join(outDir, "other-reference-left.f32"), Buffer.from(reference.left.buffer));
		fs.writeFileSync(path.join(outDir, "other-reference-right.f32"), Buffer.from(reference.right.buffer));
		writeManifest();

		win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: true, backgroundThrottling: false } });
		await win.loadURL("data:text/html,<html><body></body></html>");
		await win.webContents.executeJavaScript(SIGNAL_SOURCE);
		await win.webContents.executeJavaScript(`
			window.__endpointMinusSelfOther = { ended: false };
			const ctx = new AudioContext({ sampleRate: ${sampleRate} });
			const stereo = generateBroadbandStereo(${other.seedL}, ${other.seedR}, ${frameCount}, ${other.peakAmplitude});
			const buffer = ctx.createBuffer(2, ${frameCount}, ${sampleRate});
			buffer.copyToChannel(stereo.left, 0);
			buffer.copyToChannel(stereo.right, 1);
			const source = ctx.createBufferSource();
			source.buffer = buffer;
			source.connect(ctx.destination);
			source.onended = () => { window.__endpointMinusSelfOther.ended = true; };
			window.__endpointMinusSelfStart = (whenCtxTime) => { source.start(whenCtxTime); return ctx.currentTime; };
			window.__endpointMinusSelfCtx = ctx;
			void 0;
		`);

		// Armed and waiting on the barrier time from schedule.json — tell the parent NOW so it
		// knows this leg is genuinely ready, rather than only finding out (via timeout) once this
		// signal was supposed to already be playing. other.startAtEpochMs is deliberately set (by
		// the harness) to the moment the SELF process's disjoint hold-out segment begins, so this
		// "other app" signal only overlaps the window that is actually scored for preservation.
		console.log("READY");

		const delayMs = Math.max(0, other.startAtEpochMs - Date.now());
		await new Promise((resolve) => setTimeout(resolve, delayMs));

		manifest.startedAt = Date.now();
		writeManifest();
		await win.webContents.executeJavaScript("window.__endpointMinusSelfStart(0)");

		// Bounded wait: the buffer is finite (frameCount samples), so this always ends on its own.
		const durationMs = (frameCount / sampleRate) * 1000;
		await new Promise((resolve) => setTimeout(resolve, durationMs + 500));
		manifest.endedAt = Date.now();
		writeManifest();
		app.exit(0);
	} catch (error) {
		manifest.error = String((error && error.stack) || error);
		writeManifest();
		console.error("endpoint-minus-self-other-audio failed:", error);
		app.exit(1);
	}
});

setTimeout(
	() => {
		manifest.error = manifest.error || "watchdog: other-audio process exceeded its deadline";
		writeManifest();
		app.exit(1);
	},
	(frameCount / sampleRate) * 1000 + 20000,
).unref();

app.on("window-all-closed", () => {});
