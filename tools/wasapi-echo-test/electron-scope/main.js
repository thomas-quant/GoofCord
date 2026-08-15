// Does ELECTRON's Chromium honour restrictOwnAudio?
//
// Brave 151 reports the constraint supported and then ignores it, even with
// --enable-features=RestrictOwnAudio. Brave is not the build that matters: GoofCord ships
// Electron, which is plain upstream Chromium. Electron 41.3.0 = Chromium 146, and the feature
// shipped in 141, so it should be there.
//
// This needs no picker and no human: Electron's setDisplayMediaRequestHandler auto-grants, which
// is also what GoofCord itself does, so this measures the real product path.
//
//   node/electron main.js [--enable-rot]     --enable-rot appends the Chromium feature switch
const { app, BrowserWindow, desktopCapturer, session, ipcMain } = require("electron");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const ENABLE_ROT = process.argv.includes("--enable-rot");
// The renderer's process.argv is NOT the app's argv, so flags must be handed over explicitly.
const REVERSE = process.argv.includes("--reverse");
if (ENABLE_ROT) app.commandLine.appendSwitch("enable-features", "RestrictOwnAudio");

const VLC = "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe";
const TONE_DIR = "E:\\backup\\code\\personal\\GoofCord\\tools\\wasapi-echo-test";
const SPEAKERS = "{0.0.0.00000000}.{5a31bb14-b764-4610-bd44-e44fdae8b935}";
const VAC = "{0.0.0.00000000}.{7036a79c-9355-46d6-bbb8-c4ce358323c9}";

const ps = (script) => {
	try {
		return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
};
// WMI so the players are parented to WmiPrvSE, never to us.
const playTone = (dev, wav) =>
	ps(
		`$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='"${VLC}" --intf dummy --no-video --play-and-exit --aout=mmdevice --mmdevice-audio-device="${dev}" "${TONE_DIR}\\${wav}"'}; Write-Output $r.ProcessId`,
	).split(/\s+/).pop();
const killTones = () => ps("Get-Process vlc -ErrorAction SilentlyContinue | Stop-Process -Force");

ipcMain.on("log", (_e, m) => console.log("  " + m));
// Restart the players for every pass. The tone files are finite, and a pass that straddles the
// end of one reads as attenuation that has nothing to do with the constraint under test.
ipcMain.on("tones", () => {
	killTones();
	playTone(VAC, "tone-997.wav");
	playTone(SPEAKERS, "tone-440.wav");
});
ipcMain.on("done", (_e, results) => {
	killTones();
	console.log("\n=== RESULTS (electron " + process.versions.electron + " / chromium " + process.versions.chrome + ") ===");
	console.log("--enable-features=RestrictOwnAudio: " + (ENABLE_ROT ? "YES" : "no"));
	for (const r of results) {
		console.log(`\n[${r.pass}]`);
		console.log(`  requested restrictOwnAudio : ${r.requested}`);
		console.log(`  getSettings().restrictOwnAudio : ${r.reported}`);
		if (r.error) { console.log(`  ERROR: ${r.error}`); continue; }
		console.log(`  captured ${r.seconds.toFixed(2)}s`);
		for (const t of r.tones) console.log(`    ${String(t.hz).padStart(5)} Hz  ${t.db.toFixed(1).padStart(8)} dB   ${t.label}`);
	}
	console.log("");
	setTimeout(() => app.quit(), 200);
});

app.whenReady().then(async () => {
	console.log(`supported-constraints probe starting (rot switch: ${ENABLE_ROT})`);
	killTones();
	console.log("tones (997->VAC, 440->Speakers) restart per pass, out-of-tree");

	session.defaultSession.setDisplayMediaRequestHandler(
		async (_request, callback) => {
			const sources = await desktopCapturer.getSources({ types: ["screen"] });
			// 'loopback' = Chromium system-audio loopback, the same thing GoofCord's own handler asks for
			callback({ video: sources[0], audio: "loopback" });
		},
		{ useSystemPicker: false },
	);

	const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
	win.webContents.on("did-fail-load", (_e, code, desc) => console.log(`  did-fail-load ${code} ${desc}`));
	win.loadFile(path.join(__dirname, "index.html"), { query: { reverse: REVERSE ? "1" : "0" } });
	// Never hang a terminal again: hard stop well past the two 6s passes.
	setTimeout(() => { console.log("  WATCHDOG: no result after 45s, quitting"); killTones(); app.quit(); }, 45000);
});

app.on("window-all-closed", () => app.quit());
