#!/usr/bin/env node
// Do endpoint loopback and process loopback share a clock?
//
// If they do, aligning them is a fixed offset you can read once. If they drift, any subtraction
// needs a tracker, which is the adaptive machinery that was ruled out. That is the whole question,
// and it is answerable with two integers: frames delivered, and when.
//
// Each capture is regressed against process.hrtime.bigint() (QPC-backed on Windows) to get its
// true sample rate. Regressing the SLOPE over hundreds of packets averages out buffer jitter far
// better than comparing endpoints, which is why this runs for a minute rather than a second.
//
// The tone goes to CABLE Input. With Listen-to-this-device off that reaches no speakers, so the
// run is silent to the operator while both capture types still see it.
//
// Usage: node drift-test.mjs [secondsPerLeg]

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
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_FRAME = 4 * CHANNELS; // f32 stereo
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

const endpoints = addon.listRenderEndpoints();
const vac = endpoints.find((e) => /^CABLE Input/.test(e.name));
const spk = endpoints.find((e) => e.isDefault) ?? endpoints.find((e) => /Speakers/.test(e.name));
// A second PHYSICAL endpoint on an unrelated crystal. The virtual cable cannot serve as the
// control: it is software-timed, its per-segment slope swings +-100 ppm, and its "clock
// difference" wandered 3.5 -> 10.8 ppm between runs. That is jitter, not a resolvable offset.
// Must be a DIFFERENT codec. "Realtek Digital Output" is S/PDIF on the same chip as Speakers and
// shares its crystal, so it reads ~1 ppm and proves nothing. NVIDIA HDMI is a separate clock.
const alt = endpoints.find((e) => /NVIDIA/i.test(e.name)) ?? endpoints.find((e) => e.id !== spk.id && !/CABLE|Realtek/.test(e.name));
if (!vac || !spk) {
	console.error("need both CABLE Input and a default endpoint");
	process.exit(2);
}

function playTone(dev, wav) {
	const cmd = `"${VLC}" --intf dummy --no-video --play-and-exit --aout=mmdevice --mmdevice-audio-device="${dev}" "${join(here, wav).replace(/\//g, "\\")}"`;
	return ps(`$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${psQuote(cmd)}}; Write-Output $r.ProcessId`).split(/\s+/).pop();
}

// Ordinary least squares slope of cumulative frames against seconds.
function slope(pts) {
	const n = pts.length;
	let sx = 0, sy = 0;
	for (const [x, y] of pts) { sx += x; sy += y; }
	const mx = sx / n, my = sy / n;
	let num = 0, den = 0;
	for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) * (x - mx); }
	const m = num / den;
	const b = my - m * mx;
	let ss = 0, tot = 0;
	for (const [x, y] of pts) { const r = y - (m * x + b); ss += r * r; tot += (y - my) * (y - my); }
	return { rate: m, r2: 1 - ss / tot, residRms: Math.sqrt(ss / n) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function leg(name, start) {
	const pts = [];
	let frames = 0;
	let chunks = 0;
	const t0 = process.hrtime.bigint();
	const handle = start((err, chunk) => {
		if (err || !chunk) return;
		chunks++;
		frames += chunk.byteLength / BYTES_PER_FRAME;
		pts.push([Number(process.hrtime.bigint() - t0) / 1e9, frames]);
	});
	if (handle === false || handle === null || handle === undefined) throw new Error(`${name}: start returned ${String(handle)}`);
	await sleep(SECONDS * 1000);
	addon.stop();
	await sleep(300);
	if (pts.length < 50) throw new Error(`${name}: only ${pts.length} packets — no audio flowing?`);
	// Drop the first 2s: stream startup is not representative of steady-state cadence.
	// Trim BOTH ends. stop() truncates the final packet accounting, which lands as a -6000 ppm
	// last segment and a phantom "gap" in every leg.
	const tEnd = pts[pts.length - 1][0];
	const steady = pts.filter((p) => p[0] > 2 && p[0] < tEnd - 2);
	const s = slope(steady);
	const ppm = ((s.rate - SAMPLE_RATE) / SAMPLE_RATE) * 1e6;

	// A single dropped packet steps cumulative frames and a straight-line fit reads that step as a
	// slope. Over ~48s one 480-frame packet is ~230 ppm — indistinguishable from real drift unless
	// you look per-segment. Real drift is present in EVERY segment; a glitch sits in one.
	const SEG = 8;
	const t0s = steady[0][0], t1s = steady[steady.length - 1][0];
	const segs = [];
	for (let i = 0; i < SEG; i++) {
		const lo = t0s + ((t1s - t0s) * i) / SEG, hi = t0s + ((t1s - t0s) * (i + 1)) / SEG;
		const w = steady.filter((p) => p[0] >= lo && p[0] < hi);
		if (w.length > 20) segs.push(((slope(w).rate - SAMPLE_RATE) / SAMPLE_RATE) * 1e6);
	}
	const sorted = [...segs].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)];
	// Robust spread: MAD -> sigma, then standard error of the median across segments.
	const mad = [...segs.map((v) => Math.abs(v - median))].sort((a, b) => a - b)[Math.floor(segs.length / 2)];
	const sigma = mad * 1.4826;
	const stderr = sigma / Math.sqrt(segs.length);

	// Explicit gap detection from inter-packet spacing.
	const dts = [];
	for (let i = 1; i < steady.length; i++) dts.push(steady[i][0] - steady[i - 1][0]);
	const medDt = [...dts].sort((a, b) => a - b)[Math.floor(dts.length / 2)];
	const gaps = dts.filter((d) => d > medDt * 2.5).length;

	console.log(
		`${name.padEnd(22)} ${chunks} pkts  rate=${s.rate.toFixed(3)}  ols=${ppm >= 0 ? "+" : ""}${ppm.toFixed(1)}ppm  ` +
			`MEDIAN=${median >= 0 ? "+" : ""}${median.toFixed(1)}+-${stderr.toFixed(1)}ppm  resid=${s.residRms.toFixed(0)}  gaps=${gaps}`,
	);
	console.log(`    per-segment ppm: ${segs.map((v) => (v >= 0 ? "+" : "") + v.toFixed(1)).join("  ")}`);
	return { name, ...s, ppm, median, stderr, gaps, rate: SAMPLE_RATE * (1 + median / 1e6) };
}

console.log(`\naddon: ${addonPath}`);
console.log(`physical endpoint: ${spk.name}`);
console.log(`virtual endpoint : ${vac.name}`);
console.log(`legs: ${SECONDS}s each\n`);

killTones();
// Loud tone into the cable (inaudible, Listen is off) and a -60 dBFS tone to the speakers. The
// speaker tone only has to keep that render stream alive so endpoint loopback delivers packets --
// it is never measured, so it can sit far below anything you would notice.
const p1 = playTone(vac.id, "tone-997-long.wav");
const p2 = playTone(spk.id, "tone-quiet-spk.wav");
const p3 = alt ? playTone(alt.id, "tone-quiet-spk.wav") : null;
console.log(`alt physical endpoint: ${alt ? alt.name : "(none found)"}`);
console.log(`vlc pids ${p1}, ${p2}${p3 ? ", " + p3 : ""} — settling...\n`);
await sleep(3000);

try {
	const legs = [];
	legs.push(await leg("endpoint(Speakers)", (cb) => addon.startRenderEndpointExcludeProcessTree(spk.id, BOGUS_PID, cb)));
	legs.push(await leg("endpoint(CABLE In)", (cb) => addon.startRenderEndpointExcludeProcessTree(vac.id, BOGUS_PID, cb)));
	legs.push(await leg("process(global)", (cb) => addon.start(BOGUS_PID, cb)));
	let altLeg = null;
	if (alt) {
		try {
			altLeg = await leg(`endpoint(${alt.name.slice(0, 10)})`, (cb) => addon.startRenderEndpointExcludeProcessTree(alt.id, BOGUS_PID, cb));
		} catch (e) {
			console.log(`    alt endpoint leg failed: ${e.message}`);
		}
	}

	const [spkLeg, vacLeg, procLeg] = legs;
	const ppmBetween = (a, b) => ((a.rate - b.rate) / SAMPLE_RATE) * 1e6;

	console.log("\n=== PAIRWISE (ppm) ===\n");
	for (const [a, b] of [[spkLeg, procLeg], [vacLeg, procLeg], [spkLeg, vacLeg]]) {
		const d = ppmBetween(a, b);
		console.log(`  ${a.name.padEnd(20)} - ${b.name.padEnd(20)} = ${d >= 0 ? "+" : ""}${d.toFixed(2)} ppm   (${Math.abs((d * SAMPLE_RATE) / 1e6).toFixed(3)} frames/s slip)`);
	}

	// NOTE: rate is now the MEDIAN-of-segments rate, which is robust to dropped packets.
	// Positive control: hardware crystal vs software-clocked virtual device SHOULD differ. If this
	// reads ~0 too, the method cannot see drift at all and no zero anywhere else means anything.
	if (altLeg) {
		const d = ppmBetween(spkLeg, altLeg);
		console.log(`  ${spkLeg.name.padEnd(20)} - ${altLeg.name.padEnd(20)} = ${d >= 0 ? "+" : ""}${d.toFixed(2)} ppm   <-- HARDWARE control`);
	}
	// Control must be two independent hardware crystals, not hardware-vs-virtual.
	const control = altLeg ? Math.abs(ppmBetween(spkLeg, altLeg)) : Math.abs(ppmBetween(spkLeg, vacLeg));
	const answer = ppmBetween(spkLeg, procLeg);
	console.log("\n=== VERDICT ===\n");
	const unc = Math.hypot(spkLeg.stderr, procLeg.stderr, altLeg ? altLeg.stderr : 0);
	console.log(`  measurement resolution (combined stderr): +-${unc.toFixed(2)} ppm`);
	console.log(`  positive control (${altLeg ? "Realtek vs " + altLeg.name : "NONE — no independent crystal found"}): ${control.toFixed(2)} ppm`);
	if (!altLeg || control < 3 * unc) {
		console.log("  !! CONTROL FAILED — two supposedly independent crystals are indistinguishable,");
		console.log("  !! so this method cannot resolve a real clock difference. The null below means nothing.");
	} else {
		console.log(`  control is ${(control / unc).toFixed(1)}x the resolution, so a null is meaningful.\n`);
		if (Math.abs(answer) < 3 * unc) {
			console.log(`  SAME CLOCK DOMAIN: endpoint(physical) vs process loopback = ${answer.toFixed(2)} +-${unc.toFixed(2)} ppm.`);
			console.log("  Alignment is a fixed offset; a one-shot delay+gain can hold on this axis.");
		} else {
			console.log(`  DIFFERENT CLOCK DOMAINS: ${answer.toFixed(2)} +-${unc.toFixed(2)} ppm = ${Math.abs((answer * SAMPLE_RATE) / 1e6).toFixed(2)} frames/s.`);
			console.log("  A fixed offset walks, so subtraction needs continuous re-alignment.");
		}
	}
	console.log("");
} finally {
	killTones();
}
