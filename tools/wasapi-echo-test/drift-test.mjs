#!/usr/bin/env node
// Do endpoint loopback and process loopback share a clock?
//
// If they do, aligning the two is a fixed offset you measure once. If they drift, any
// subtraction needs continuous re-alignment — the adaptive machinery that was ruled out.
//
// HOW THIS MEASURES, AND WHY THE OBVIOUS WAY DOES NOT WORK
//
// Counting chunk arrivals cannot answer this. The addon pushes chunks NonBlocking and silently
// discards them on QueueFull, so under back-pressure it sheds data and a straight-line fit reads
// each gap as a slope. That artifact produced 232, 245, 281 and 629 ppm of imaginary "drift"
// across four earlier runs.
//
// Instead this polls getCaptureStats(): DevicePosition (frames since stream start) and
// QPCPosition (performance counter at which the engine recorded that frame). Both come from the
// engine's own accounting via IAudioCaptureClient::GetBuffer, so they stay correct even when the
// queue drops chunks. Regressing one against the other gives the stream's true rate.
//
// Any leg reporting dropped chunks, discontinuities or timestamp errors is called out rather
// than quietly fitted.
//
// All legs run CONCURRENTLY (keyed sessions), so they see identical conditions.
//
// Usage: node drift-test.mjs [seconds]

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const local = join(here, "addon-under-test.node");
const addonPath = existsSync(local) ? local : resolve(here, "../../node_modules/wasapi-loopback/prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node");
const addon = createRequire(import.meta.url)(addonPath);

const SECONDS = Number(process.argv[2] ?? 60);
const POLL_MS = 200;
const BOGUS_PID = 999999; // excludes nothing -> plain global process loopback
const VLC = "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe";

const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
const ps = (s) => {
	try {
		return execFileSync("powershell.exe", ["-NoProfile", "-Command", s], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
};
const killTones = () => ps("Get-Process vlc -ErrorAction SilentlyContinue | Stop-Process -Force");
const playTone = (dev, wav) =>
	ps(
		`$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${psQuote(
			`"${VLC}" --intf dummy --no-video --play-and-exit --aout=mmdevice --mmdevice-audio-device="${dev}" "${join(here, wav).replace(/\//g, "\\")}"`,
		)}}; Write-Output $r.ProcessId`,
	).split(/\s+/).pop();

const endpoints = addon.listRenderEndpoints();
const spk = endpoints.find((e) => e.isDefault) ?? endpoints.find((e) => /Speakers/.test(e.name));
const vac = endpoints.find((e) => /^CABLE Input/.test(e.name));
const hdmi = endpoints.find((e) => /NVIDIA/i.test(e.name));
if (!spk || !vac) {
	console.error("need a default endpoint and CABLE Input");
	process.exit(2);
}

// Least-squares slope of frames against seconds.
function slope(pts) {
	const n = pts.length;
	let sx = 0, sy = 0;
	for (const [x, y] of pts) { sx += x; sy += y; }
	const mx = sx / n, my = sy / n;
	let num = 0, den = 0, ssTot = 0;
	for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) * (x - mx); ssTot += (y - my) * (y - my); }
	const m = num / den, b = my - m * mx;
	let ss = 0;
	for (const [x, y] of pts) { const r = y - (m * x + b); ss += r * r; }
	return { rate: m, r2: 1 - ss / ssTot, residRms: Math.sqrt(ss / n) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sink = () => {};

console.log(`\naddon: ${addonPath}`);
console.log(`legs run concurrently for ${SECONDS}s, polling every ${POLL_MS}ms\n`);

killTones();
playTone(vac.id, "tone-997-long.wav");
playTone(spk.id, "tone-quiet-spk.wav");
if (hdmi) playTone(hdmi.id, "tone-quiet-spk.wav");
await sleep(2500);

const legs = [
	{ name: `endpoint(${spk.name.slice(0, 12)})`, id: addon.startRenderEndpointLoopback(spk.id, sink) },
	{ name: "process(global)", id: addon.startExcludeProcessTree(BOGUS_PID, sink) },
	{ name: `endpoint(${vac.name.slice(0, 12)})`, id: addon.startRenderEndpointLoopback(vac.id, sink) },
];
if (hdmi) legs.push({ name: `endpoint(${hdmi.name.slice(0, 12)})`, id: addon.startRenderEndpointLoopback(hdmi.id, sink) });

for (const l of legs) {
	console.log(`  ${l.name.padEnd(26)} session ${l.id}${l.id ? "" : "  <-- FAILED TO START"}`);
	l.pts = [];
}
console.log("");
const live = legs.filter((l) => l.id);
if (live.length < 2) { addon.stopAll(); killTones(); console.error("need at least 2 live sessions"); process.exit(3); }

const t0 = Date.now();
while (Date.now() - t0 < SECONDS * 1000) {
	await sleep(POLL_MS);
	for (const l of live) {
		const s = addon.getCaptureStats(l.id);
		if (!s || !s.qpcPosition100ns) continue;
		l.last = s;
		// x = QPC seconds, y = frames. Both from the same GetBuffer call, so they are a matched pair.
		l.pts.push([s.qpcPosition100ns * 1e-7, s.devicePosition]);
	}
	if ((Date.now() - t0) % 10000 < POLL_MS) process.stdout.write(`\r  ${((Date.now() - t0) / 1000).toFixed(0)}s...   `);
}
console.log("\r                     ");
addon.stopAll();
killTones();

console.log("=== LEGS ===\n");
for (const l of live) {
	if (l.pts.length < 20) { console.log(`${l.name.padEnd(26)} only ${l.pts.length} samples — skipped`); continue; }
	// Deduplicate: polling faster than the engine's period repeats the same packet.
	const uniq = l.pts.filter((p, i) => i === 0 || p[0] !== l.pts[i - 1][0]);
	l.fit = slope(uniq);
	l.ppm = ((l.fit.rate - 48000) / 48000) * 1e6;
	const s = l.last;
	l.clean = s.droppedChunks === 0 && s.discontinuities === 0 && s.timestampErrors === 0;
	console.log(
		`${l.name.padEnd(26)} rate=${l.fit.rate.toFixed(3)} Hz  ${l.ppm >= 0 ? "+" : ""}${l.ppm.toFixed(2)} ppm  ` +
			`r2=${l.fit.r2.toFixed(9)}  n=${uniq.length}`,
	);
	console.log(
		`${" ".repeat(26)} packets=${s.packets}  dropped=${s.droppedChunks}  discont=${s.discontinuities}  tsErr=${s.timestampErrors}` +
			`${l.clean ? "  [clean]" : "  [!! TIMING SUSPECT]"}`,
	);
}

const fitted = live.filter((l) => l.fit);
const byName = (re) => fitted.find((l) => re.test(l.name));
const spkLeg = byName(/Speakers|endpoint\(/);
const procLeg = byName(/process/);
const hdmiLeg = hdmi ? fitted.find((l) => /NVIDIA|PL2470/i.test(l.name)) : null;

console.log("\n=== PAIRWISE (ppm) ===\n");
for (const a of fitted) for (const b of fitted) {
	if (a === b || fitted.indexOf(a) > fitted.indexOf(b)) continue;
	console.log(`  ${a.name.padEnd(26)} - ${b.name.padEnd(26)} = ${(a.ppm - b.ppm >= 0 ? "+" : "") + (a.ppm - b.ppm).toFixed(2)}`);
}

console.log("\n=== VERDICT ===\n");
const suspect = fitted.filter((l) => !l.clean).map((l) => l.name);
if (suspect.length) console.log(`  !! timing suspect on: ${suspect.join(", ")} — treat the numbers below with care\n`);
if (hdmiLeg && spkLeg && hdmiLeg !== spkLeg) {
	const control = Math.abs(spkLeg.ppm - hdmiLeg.ppm);
	console.log(`  positive control (two independent crystals: ${spkLeg.name} vs ${hdmiLeg.name}) = ${control.toFixed(2)} ppm`);
	if (control < 1) {
		console.log("  !! CONTROL FAILED — independent crystals indistinguishable; a null below means nothing.");
	} else {
		console.log(`  control separates, so a null is meaningful.\n`);
	}
}
if (spkLeg && procLeg) {
	const d = spkLeg.ppm - procLeg.ppm;
	console.log(`  endpoint vs process loopback = ${d >= 0 ? "+" : ""}${d.toFixed(2)} ppm  (${Math.abs((d * 48000) / 1e6).toFixed(3)} frames/s)`);
}
console.log("");
