#!/usr/bin/env node
// Is "everything minus one process" EXACT when built from two captures on the same engine?
//
// The VAC echo survives #211 because process loopback is device-agnostic: EXCLUDE-self still
// takes the process that renders the mic into CABLE Input. Neither native primitive filters
// both a device and a process, and endpoint-bound EXCLUDE was falsified. What is left is
// subtraction with a reference — but only if the reference is a bit-for-bit copy on the same
// clock, so the subtraction is arithmetic, not an adaptive canceller.
//
// Two candidate pairings, measured in ONE concurrent run:
//
//   pp:  A = process loopback EXCLUDE(bogus)   [everything]        minus  B1 = INCLUDE(vlc->cable)
//        Both taps are the same per-stream pre-mix copy in the same engine. Null on 997 Hz.
//
//   ep:  C = endpoint loopback (default device) [what you hear]    minus  B2 = INCLUDE(vlc->spk)
//        Endpoint tap is post-mix / post-volume / post-APO; process tap is pre-mix. This is the
//        Discord-shaped variant (device-scoped capture minus an in-engine reference). Null on
//        440 Hz.
//
// Tones are played by VLC launched out of our tree via WMI so INCLUDE binds to a real foreign
// process. Alignment: coarse integer lag from the engine's own DevicePosition/QPCPosition
// pairs, refined by a small correlation search, then a fractional sweep so a sub-sample
// resampler-phase mismatch shows up as "null only reaches N dB with a fractional shift".
//
// PASS for a pairing: tone null >= 60 dB with gain ~1.0 at an integer lag, and the OTHER tone
// untouched in the residual.
//
// Usage: node subtract-test.mjs [seconds] [--quiet]   (--quiet: -60 dBFS speaker tone)

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const local = join(here, "addon-under-test.node");
const addonPath = existsSync(local) ? local : resolve(here, "../../node_modules/wasapi-loopback/prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node");
const addon = createRequire(import.meta.url)(addonPath);

const SECONDS = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 8);
const QUIET = process.argv.includes("--quiet");
const SPK_WAV = process.argv.find((a) => a.startsWith("--wav="))?.slice(6) ?? (QUIET ? "tone-quiet-spk.wav" : "tone-440.wav");
const SR = 48000;
const CH = 2;
const BOGUS_PID = 999999;
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
	Number(
		ps(
			`$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${psQuote(
				`"${VLC}" --intf dummy --no-video --play-and-exit --aout=mmdevice --mmdevice-audio-device="${dev}" "${join(here, wav).replace(/\//g, "\\")}"`,
			)}}; Write-Output $r.ProcessId`,
		)
			.split(/\s+/)
			.pop(),
	);

const endpoints = addon.listRenderEndpoints();
const SPK_RE = process.argv.find((a) => a.startsWith("--spk="))?.slice(6);
const spk = SPK_RE ? endpoints.find((e) => new RegExp(SPK_RE, "i").test(e.name)) : (endpoints.find((e) => e.isDefault) ?? endpoints.find((e) => /Speakers/.test(e.name)));
const vac = endpoints.find((e) => /^CABLE Input/.test(e.name));
if (!spk || !vac) {
	console.error("need a default endpoint and CABLE Input");
	process.exit(2);
}

// ── analysis helpers ────────────────────────────────────────────────────────────────
function goertzel(x, hz, from = 0, to = x.length) {
	const k = (2 * Math.PI * hz) / SR;
	const c = 2 * Math.cos(k);
	let s1 = 0, s2 = 0;
	for (let i = from; i < to; i++) {
		const s = x[i] + c * s1 - s2;
		s2 = s1;
		s1 = s;
	}
	const mag = Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / ((to - from) / 2);
	return mag > 0 ? 20 * Math.log10(mag) : -Infinity;
}
const dB = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
function rms(x, from = 0, to = x.length) {
	let s = 0;
	for (let i = from; i < to; i++) s += x[i] * x[i];
	return Math.sqrt(s / Math.max(1, to - from));
}
function toMono(chunks) {
	const buf = Buffer.concat(chunks);
	const n = Math.floor(buf.byteLength / 4 / CH);
	const m = new Float32Array(n);
	for (let i = 0; i < n; i++) m[i] = (buf.readFloatLE(i * CH * 4) + buf.readFloatLE((i * CH + 1) * 4)) / 2;
	return m;
}
// residual r[i] = a[i] - g * b[i + lag]  (lag may be fractional: linear interpolation)
function residual(a, b, lag, g) {
	const n = a.length;
	const r = new Float32Array(n);
	const li = Math.floor(lag), lf = lag - li;
	for (let i = 0; i < n; i++) {
		const j = i + li;
		let bv = 0;
		if (j >= 0 && j + 1 < b.length) bv = b[j] * (1 - lf) + b[j + 1] * lf;
		r[i] = a[i] - g * bv;
	}
	return r;
}
// least-squares gain of b (shifted) onto a over [from,to)
function lsGain(a, b, lag, from, to) {
	let num = 0, den = 0;
	const li = Math.floor(lag), lf = lag - li;
	for (let i = from; i < to; i++) {
		const j = i + li;
		if (j < 0 || j + 1 >= b.length) continue;
		const bv = b[j] * (1 - lf) + b[j + 1] * lf;
		num += a[i] * bv;
		den += bv * bv;
	}
	return den > 0 ? num / den : 0;
}
function corrAt(a, b, lag, from, to) {
	let s = 0;
	for (let i = from; i < to; i++) {
		const j = i + lag;
		if (j >= 0 && j < b.length) s += a[i] * b[j];
	}
	return s;
}

// ── capture ─────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log(`\naddon: ${addonPath}\nrun: ${SECONDS}s, four concurrent sessions\n`);

killTones();
const pidVac = playTone(vac.id, "tone-997-long.wav");
const pidSpk = playTone(spk.id, SPK_WAV);
console.log(`vlc 997 -> ${vac.name}  pid ${pidVac}\nvlc 440 -> ${spk.name}  pid ${pidSpk}  (${SPK_WAV})`);
await sleep(2500);

const mk = (name, id) => ({ name, id, chunks: [], polls: [] });
const legs = {
	A: mk("A  process EXCLUDE(bogus)", 0),
	B1: mk("B1 process INCLUDE(vlc->cable)", 0),
	C: mk("C  endpoint loopback(default)", 0),
	B2: mk("B2 process INCLUDE(vlc->spk)", 0),
};
const sinkFor = (leg) => (err, chunk) => {
	if (!err && chunk) leg.chunks.push(Buffer.from(chunk));
};
legs.A.id = addon.startExcludeProcessTree(BOGUS_PID, sinkFor(legs.A));
legs.B1.id = addon.startIncludeProcessTree(pidVac, sinkFor(legs.B1));
legs.C.id = addon.startRenderEndpointLoopback(spk.id, sinkFor(legs.C));
legs.B2.id = addon.startIncludeProcessTree(pidSpk, sinkFor(legs.B2));
for (const l of Object.values(legs)) console.log(`  ${l.name.padEnd(34)} session ${l.id || "FAILED"}`);
if (Object.values(legs).some((l) => !l.id)) {
	addon.stopAll();
	killTones();
	console.error("\na session failed to start");
	process.exit(3);
}

const t0 = Date.now();
while (Date.now() - t0 < SECONDS * 1000) {
	await sleep(100);
	for (const l of Object.values(legs)) {
		const s = addon.getCaptureStats(l.id);
		if (s && s.qpcPosition100Ns) l.polls.push({ ...s, frames: l.chunks.length * 480, t: Date.now() });
	}
}
addon.stopAll();
killTones();

// ── alignment + report ──────────────────────────────────────────────────────────────
for (const [k, l] of Object.entries(legs)) {
	l.mono = toMono(l.chunks);
	if (process.argv.includes("--dump")) writeFileSync(join(here, `subtract-${k}.f32`), Buffer.from(l.mono.buffer));
	const s = l.polls[l.polls.length - 1] ?? {};
	l.clean = (s.droppedChunks ?? 1) === 0 && (s.discontinuities ?? 1) === 0 && (s.timestampErrors ?? 1) === 0;
	console.log(
		`\n${l.name}\n  ${(l.mono.length / SR).toFixed(2)}s  chunks=${l.chunks.length} packets=${s.packets} dropped=${s.droppedChunks} discont=${s.discontinuities} tsErr=${s.timestampErrors}` +
			`${l.clean ? "  [clean]" : "  [!! TIMING SUSPECT]"}\n  rms=${dB(rms(l.mono)).toFixed(1)} dBFS  997=${goertzel(l.mono, 997).toFixed(1)}  440=${goertzel(l.mono, 440).toFixed(1)}  1500=${goertzel(l.mono, 1500).toFixed(1)} dB`,
	);
}

// Coarse lag from the engine's own timestamps: buffer index i of leg X corresponds to
// QPC time  qpc_X + (i - devPos_X) / SR  (valid while no chunks were dropped).
// For a in A and b in B, sample b[j] aligns with a[i] when times match:
//   j = i + (devPosB - devPosA) - (qpcB - qpcA) * SR / 1e7
function coarseLag(a, b) {
	const pa = a.polls[a.polls.length - 1], pb = b.polls[b.polls.length - 1];
	if (!pa || !pb) return 0;
	return Math.round(pb.devicePosition - pa.devicePosition - ((pb.qpcPosition100Ns - pa.qpcPosition100Ns) * SR) / 1e7);
}

function pairing(label, A, B, toneHz, otherHz) {
	console.log(`\n=== ${label}: ${A.name.trim()}  minus  ${B.name.trim()} ===`);
	const a = A.mono, b = B.mono;
	const from = SR * 2, to = Math.min(a.length, b.length) - SR; // skip start-up and the tail
	if (to - from < SR) {
		console.log("  not enough overlap");
		return null;
	}
	const coarse = coarseLag(A, B);
	// Integer lag by brute-force correlation over +-4800 frames (100 ms) on a 2 s window.
	// The QPC-derived value is printed for comparison only: the endpoint leg's position/QPC
	// origin is not comparable to the process-loopback legs', so it cannot seed the search.
	let bestLag = 0, bestC = -Infinity;
	const wFrom = from, wTo = from + 2 * SR;
	for (let lag = -4800; lag <= 4800; lag++) {
		const c = corrAt(a, b, lag, wFrom, wTo);
		if (c > bestC) { bestC = c; bestLag = lag; }
	}
	const gInt = lsGain(a, b, bestLag, from, to);
	const rInt = residual(a, b, bestLag, gInt);
	const toneA = goertzel(a, toneHz, from, to);
	const nullInt = toneA - goertzel(rInt, toneHz, from, to);
	// fractional sweep around the best integer lag
	let bestFrac = bestLag, bestNull = nullInt, bestG = gInt;
	for (let f = -1; f <= 1; f += 0.05) {
		const lag = bestLag + f;
		const g = lsGain(a, b, lag, from, to);
		const r = residual(a, b, lag, g);
		const nl = toneA - goertzel(r, toneHz, from, to);
		if (nl > bestNull) { bestNull = nl; bestFrac = lag; bestG = g; }
	}
	const rBest = residual(a, b, bestFrac, bestG);
	console.log(`  coarse lag from QPC   = ${coarse} frames`);
	console.log(`  best integer lag      = ${bestLag} frames   gain=${gInt.toFixed(5)}   ${toneHz} Hz null = ${nullInt.toFixed(1)} dB`);
	console.log(`  best fractional lag   = ${bestFrac.toFixed(2)} frames   gain=${bestG.toFixed(5)}   ${toneHz} Hz null = ${bestNull.toFixed(1)} dB`);
	console.log(`  residual: ${toneHz}=${goertzel(rBest, toneHz, from, to).toFixed(1)}  ${otherHz}=${goertzel(rBest, otherHz, from, to).toFixed(1)} (in A: ${goertzel(a, otherHz, from, to).toFixed(1)})  1500=${goertzel(rBest, 1500, from, to).toFixed(1)}  rms=${dB(rms(rBest, from, to)).toFixed(1)} dBFS`);
	// Stability: null per 10 s segment at the SAME lag/gain. A drifting clock degrades later segments.
	const segs = [];
	for (let s0 = from; s0 + 10 * SR <= to; s0 += 10 * SR) {
		const nl = goertzel(a, toneHz, s0, s0 + 10 * SR) - goertzel(rBest, toneHz, s0, s0 + 10 * SR);
		const bbs = dB(rms(a, s0, s0 + 10 * SR)) - dB(rms(rBest, s0, s0 + 10 * SR));
		segs.push(`${nl.toFixed(0)}/${bbs.toFixed(0)}`);
	}
	console.log(`  per-10s segments (tone null / broadband dB): ${segs.join("  ")}`);
	const verdict = nullInt >= 60 && Math.abs(gInt - 1) < 0.01 ? "EXACT (integer lag, unity gain)" : bestNull >= 60 ? "EXACT ONLY WITH FRACTIONAL SHIFT / GAIN" : bestNull >= 30 ? "PARTIAL — not a bit-copy" : "NO NULL";
	const bb = dB(rms(a, from, to)) - dB(rms(rBest, from, to));
	console.log(`  broadband: A rms=${dB(rms(a, from, to)).toFixed(1)}  residual rms=${dB(rms(rBest, from, to)).toFixed(1)}  -> ${bb.toFixed(1)} dB reduction`);
	console.log(`  spot nulls @ best lag: ${[200, 1000, 3000, 8000].map((hz) => `${hz}=${(goertzel(a, hz, from, to) - goertzel(rBest, hz, from, to)).toFixed(1)}`).join("  ")} dB`);
	console.log(`  verdict: ${verdict}`);
	return { label, coarse, bestLag, gInt, nullInt, bestFrac, bestG, bestNull, toneA };
}

const out = {
	when: new Date().toISOString(),
	seconds: SECONDS,
	legs: Object.fromEntries(Object.entries(legs).map(([k, l]) => [k, { name: l.name, clean: l.clean, last: l.polls[l.polls.length - 1] }])),
	pp: pairing("pp", legs.A, legs.B1, 997, 440),
	ep: pairing("ep", legs.C, legs.B2, 440, 997),
	// control: the cable tone must be ABSENT from the endpoint capture (Listen off) or PRESENT (Listen on)
	listenBridge: goertzel(legs.C.mono, 997) - goertzel(legs.C.mono, 1500),
};
console.log(`\ncable tone in endpoint capture, over noise: ${out.listenBridge.toFixed(1)} dB  (${out.listenBridge > 20 ? "Listen bridge ON — mic reaches the speakers mix" : "Listen bridge OFF"})\n`);
writeFileSync(join(here, "subtract-run.json"), JSON.stringify(out, null, 1));
