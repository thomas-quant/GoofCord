#!/usr/bin/env node
// Is our capture DEVICE-AGNOSTIC? — the VAC question, settled without a second person.
//
// Process loopback (what #211 ships) attaches to a process tree and takes its render
// streams wherever they are going. Endpoint loopback attaches to one output device and
// takes whatever lands on it. Those are different scopes, and the difference is invisible
// until a virtual cable puts audio on a device you are not looking at.
//
// Two tones, two devices, out of our process tree:
//
//   997 Hz -> CABLE Input (the VAC)      << the tone that should expose the difference
//   440 Hz -> Speakers    (the default)  << the control: proves capture works at all
//
// Then capture the same 5 seconds two ways and Goertzel both frequencies out of each:
//
//   --mode=process    global EXCLUDE-self process loopback   (what GoofCord does today)
//   --mode=endpoint   plain loopback on one output device    (what an endpoint capture sees)
//
// If 997 is present under process and absent under endpoint, the capture scope IS the
// echo mechanism: the VAC is only reachable by a device-agnostic capture.
//
// VLC is launched via WMI Win32_Process.Create, NOT as our child — anything we spawn lands
// inside the tree we are excluding and would be filtered out for the wrong reason.
//
// Usage: node device-scope-test.mjs --mode=process|endpoint [--endpoint=<id>] [seconds]

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const local = join(here, "addon-under-test.node");
const addonPath = existsSync(local) ? local : resolve(here, "../../node_modules/wasapi-loopback/prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node");
const addon = createRequire(import.meta.url)(addonPath);

const VLC = "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe";
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const arg = (n, d) =>
	process.argv
		.find((a) => a.startsWith(`--${n}=`))
		?.split("=")
		.slice(1)
		.join("=") ?? d;
const MODE = arg("mode", "process");
const SECONDS = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 5);

const endpoints = addon.listRenderEndpoints();
const find = (re) => endpoints.find((e) => re.test(e.name));
const vac = find(/^CABLE Input/);
const speakers = endpoints.find((e) => e.isDefault) ?? find(/Speakers/);
if (!vac || !speakers) {
	console.error(
		"Need both a 'CABLE Input' endpoint and a default endpoint. Found:",
		endpoints.map((e) => e.name),
	);
	process.exit(2);
}

// --only=<hz> plays a single tone. Playing both at once cannot distinguish "the VAC is
// bridged into the speakers" from "one of the two players ignored its device argument".
const ONLY = arg("only", null);
const TONES = [
	{ hz: 997, file: join(here, "tone-997.wav"), device: vac, label: "VAC" },
	{ hz: 440, file: join(here, "tone-440.wav"), device: speakers, label: "default" },
];

// ── out-of-tree playback ─────────────────────────────────────────────────────────────
// PowerShell single-quoted literal: only ' needs escaping, and the command line is full of
// double quotes (VLC path, device id) that must survive verbatim.
const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;

function spawnOutOfTree(cmdline) {
	const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${psQuote(cmdline)}}; Write-Output $r.ProcessId`;
	const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
	return Number(out.trim().split(/\s+/).pop());
}
const kill = (pid) => {
	try {
		execFileSync("powershell.exe", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]);
	} catch {}
};

// ── measurement ──────────────────────────────────────────────────────────────────────
function goertzel(x, hz) {
	const k = (2 * Math.PI * hz) / SAMPLE_RATE;
	const c = 2 * Math.cos(k);
	let s1 = 0;
	let s2 = 0;
	for (let i = 0; i < x.length; i++) {
		const s = x[i] + c * s1 - s2;
		s2 = s1;
		s1 = s;
	}
	// magnitude of the bin, normalised to an equivalent sine amplitude
	const mag = Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / (x.length / 2);
	return mag > 0 ? 20 * Math.log10(mag) : -Infinity;
}

const chunks = [];
const onChunk = (err, chunk) => {
	if (!err && chunk) chunks.push(Buffer.from(chunk));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── run ──────────────────────────────────────────────────────────────────────────────
console.log(`\naddon:  ${addonPath}`);
console.log(`pid:    ${process.pid}`);
console.log(`mode:   ${MODE}`);
for (const t of TONES) console.log(`tone:   ${t.hz} Hz -> ${t.device.name}  [${t.label}]`);

const players = [];
for (const t of TONES.filter((t) => !ONLY || String(t.hz) === ONLY)) {
	players.push(spawnOutOfTree(`"${VLC}" --intf dummy --no-video --qt-start-minimized --play-and-exit --aout=mmdevice --mmdevice-audio-device="${t.device.id}" "${t.file}"`));
}
console.log(`\nvlc pids: ${players.join(", ")} (out of tree)${ONLY ? `  -- ONLY ${ONLY} Hz playing` : ""}`);
await sleep(2500); // let both streams actually open

let handle;
if (MODE === "endpoint") {
	const id = arg("endpoint", speakers.id);
	console.log(`capturing endpoint: ${endpoints.find((e) => e.id === id)?.name ?? id}`);
	// NOTE: the process filter on this entry point is inert (falsified 2026-07-13), so this
	// is plain endpoint loopback — which is exactly the scope we want to measure here.
	handle = addon.startRenderEndpointExcludeProcessTree(id, process.pid, onChunk);
} else {
	handle = addon.start(process.pid, onChunk);
}
// The two start entry points do NOT agree on what success looks like: start() returns a
// bool, the endpoint ones return an HRESULT, and S_OK is 0 -- falsy. Only a hard failure
// value counts as failure here; whether audio actually arrived is judged by chunk count.
const failed = handle === false || handle === null || handle === undefined;
if (failed) {
	console.error(`!! capture failed to start (returned ${String(handle)})`);
	for (const p of players) kill(p);
	process.exit(3);
}

await sleep(SECONDS * 1000);
addon.stop();
await sleep(200);
for (const p of players) kill(p);

// ── report ───────────────────────────────────────────────────────────────────────────
const buf = Buffer.concat(chunks);
const n = Math.floor(buf.byteLength / 4 / CHANNELS);
const mono = new Float32Array(n);
for (let i = 0; i < n; i++) mono[i] = (buf.readFloatLE(i * CHANNELS * 4) + buf.readFloatLE((i * CHANNELS + 1) * 4)) / 2;

let sumSq = 0;
for (let i = 0; i < n; i++) sumSq += mono[i] * mono[i];
const rms = n ? Math.sqrt(sumSq / n) : 0;

console.log(`\ncaptured ${(n / SAMPLE_RATE).toFixed(2)}s in ${chunks.length} chunks   rms=${rms > 0 ? (20 * Math.log10(rms)).toFixed(1) : "-inf"} dBFS\n`);
for (const t of TONES) console.log(`  ${t.hz} Hz [${t.label.padEnd(7)} ${t.device.name}]  ${goertzel(mono, t.hz).toFixed(1)} dB`);
console.log(`  (noise reference: 1500 Hz, nothing plays there)  ${goertzel(mono, 1500).toFixed(1)} dB`);
console.log("");
