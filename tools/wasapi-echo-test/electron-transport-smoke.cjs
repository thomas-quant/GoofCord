// Real Electron/DOM smoke test for the packaged-source WASAPI transport. No microphones,
// desktop capture, speakers, Discord login, or native WASAPI activation are used.
// Usage: electron electron-transport-smoke.cjs <transport-source.js> <result.json>
// transport-source.js is the TypeScript-transpiled wasapiTransportMainWorldSource string,
// emitted by prepare-transport-smoke.mjs (not a GoofCord application build).
const { app, BrowserWindow, ipcMain, MessageChannelMain } = require("electron");
const fs = require("node:fs");

const sourcePath = process.argv[2];
const resultPath = process.argv[3];
if (!sourcePath || !resultPath) throw new Error("Expected transport-source.js and result.json paths");
const result = { electron: process.versions.electron, chromium: process.versions.chrome, checks: [], stops: [], errors: [] };
const channels = new Map();
let win;
let finished = false;

function finish(error) {
	if (finished) return;
	finished = true;
	if (error) result.errors.push(String(error.stack || error));
	for (const channel of channels.values()) channel.close();
	result.passed = result.errors.length === 0;
	fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
	app.exit(result.passed ? 0 : 1);
}

ipcMain.on("smoke:stop", (_event, id) => result.stops.push(id));
app.on("render-process-gone", (_event, _webContents, details) => finish(new Error(JSON.stringify(details))));
app.whenReady().then(async () => {
	try {
		win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: true, backgroundThrottling: false } });
		win.webContents.on("console-message", (_event, level, message) => {
			if (level >= 3) result.errors.push(message);
		});
		await win.loadURL("data:text/html,<html><body><canvas id='video' width='32' height='32'></canvas></body></html>");
		await win.webContents.executeJavaScript(`
			window.smoke = { streams: [], ready: false, hold: false, resolveCapture: null };
			const ipc = require('electron').ipcRenderer;
			window.goofcord = { stopWasapiLoopback: id => { ipc.send('smoke:stop', id); return Promise.resolve(); } };
			window.addEventListener('unhandledrejection', e => { console.error('Unhandled rejection: ' + e.reason); });
			window.addEventListener('message', e => { if (e.data === 'goofcord:wasapi-ready') window.smoke.ready = true; });
			ipc.on('wasapi:pcm-port', (event, data) => window.postMessage({type:'goofcord:wasapi-pcm-port', captureId:data.captureId}, '*', event.ports));
			Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
				getDisplayMedia: async () => {
					const stream = document.getElementById('video').captureStream(5);
					window.smoke.streams.push(stream);
					if (window.smoke.hold) await new Promise(resolve => { window.smoke.resolveCapture = resolve; });
					return stream;
				}
			} });
		`);
		await win.webContents.executeJavaScript(fs.readFileSync(sourcePath, "utf8"));
		await new Promise(r => setTimeout(r, 50));
		async function check(name, expression) {
			const actual = await win.webContents.executeJavaScript(`(async () => (${expression}))()`);
			if (!actual) throw new Error(`${name}: ${JSON.stringify(actual)}`);
			result.checks.push(name);
		}
		await check("page readiness handshake", "window.smoke.ready");
		async function offer(captureId) {
			const { port1, port2 } = new MessageChannelMain();
			channels.set(captureId, port1);
			const ready = new Promise((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error(`No ready ack for ${captureId}`)), 3000);
				port1.on("message", ({ data }) => {
					if (data.type === "ready" && data.captureId === captureId) { clearTimeout(timeout); resolve(); }
				});
			});
			port1.start();
			win.webContents.postMessage("wasapi:pcm-port", { captureId }, [port2]);
			await ready;
			for (let i = 0; i < 4; i++) port1.postMessage({ index: 0, pcm: new Float32Array(960).buffer });
			return port1;
		}

		// A share with no offered native capture must remain audio-less.
		await check("no native audio before capture", "(await navigator.mediaDevices.getDisplayMedia()).getAudioTracks().length === 0");
		await win.webContents.executeJavaScript("window.smoke.streams.at(-1).getTracks().forEach(t => t.stop())");
		for (const id of [1, 2]) {
			await win.webContents.executeJavaScript("window.smoke.hold = true; window.smoke.next = navigator.mediaDevices.getDisplayMedia(); void 0;");
			await offer(id);
			await win.webContents.executeJavaScript("window.smoke.resolveCapture(); window.smoke.hold = false;");
			await check(`fresh audio track for capture ${id}`, `(async () => {
				const stream = await window.smoke.next;
				const track = stream.getAudioTracks()[0];
				if (!track || track.readyState !== 'live') return false;
				if (window.smoke.previousTrack === track) return false;
				window.smoke.previousTrack = track;
				stream.getVideoTracks()[0].stop();
				return true;
			})()`);
			await new Promise(r => setTimeout(r, 100));
			if (!result.stops.includes(id)) throw new Error(`Track.stop() did not stop capture ${id}`);
			await check(`audio track stopped for capture ${id}`, "window.smoke.previousTrack.readyState === 'ended'");
		}
		await check("audio-none share after two capture cycles", "(await navigator.mediaDevices.getDisplayMedia()).getAudioTracks().length === 0");

		await win.webContents.executeJavaScript("window.smoke.hold = true; window.smoke.next = navigator.mediaDevices.getDisplayMedia(); void 0;");
		const port = await offer(3);
		port.postMessage({ type: "stopped", captureId: 3 });
		await new Promise(r => setTimeout(r, 100));
		await win.webContents.executeJavaScript("window.smoke.resolveCapture(); window.smoke.hold = false;");
		await check("main cancellation never injects stale audio", "(await window.smoke.next).getAudioTracks().length === 0");
		await new Promise(r => setTimeout(r, 100));
		finish();
	} catch (error) { finish(error); }
});
setTimeout(() => finish(new Error("Smoke test watchdog expired")), 20000).unref();
