#!/usr/bin/env node
// WHOLE-SCREEN screenshare audio capture — what is actually in it?
//
// Whole-screen share captures "everything except our own process tree" (EXCLUDE-self).
// That is a denylist, and AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS has exactly ONE
// TargetProcessId — spent excluding ourselves. So if a transparent virtual audio cable
// loops your mic back out to the speakers, that audio is NOT ours, and the capture takes
// it. Viewers then hear you twice.
//
// This runs a 3-phase protocol against a live EXCLUDE-self capture and decides:
//
//   1. SILENCE     — no desktop audio, no talking.   Baseline noise floor.
//   2. VOICE ONLY  — talk, but play nothing.         >> THE VERDICT PHASE <<
//   3. AUDIO ONLY  — play something, do not talk.    Proves capture works at all.
//
// If phase 2 has real energy, your mic reaches the capture and whole-screen share echoes.
// If phase 2 is at the phase-1 noise floor, the mic does NOT reach it and the echo comes
// from somewhere else entirely.
//
// Usage:  node whole-screen-test.mjs [secondsPerPhase]

import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const local = join(here, "addon-under-test.node");
const addonPath = existsSync(local) ? local : resolve(here, "../../node_modules/wasapi-loopback/prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node");
const addon = createRequire(import.meta.url)(addonPath);

const FORCE = process.argv.includes("--force");
const PHASE = Number(process.argv.find((a) => /^\d+$/.test(a) && a !== process.argv[1]) ?? 6);
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const MIN_PHASE = 5;
const GUARD = 300; // ms discarded at each phase start so a slow instruction-read doesn't bleed across
const SPEECH_LO = 300;
const SPEECH_HI = 3400;

if (!Number.isFinite(PHASE) || PHASE < MIN_PHASE) {
	if (!FORCE) {
		console.error(`\nRefusing to run ${PHASE}s phases. Minimum is ${MIN_PHASE}s.`);
		console.error(`After the ${GUARD}ms guard a 2s phase leaves 1.7s -- a handful of syllables, which`);
		console.error("is how the 2026-07-28 run ended up with three statistically identical phases.");
		console.error("Pass --force if you really mean it.\n");
		process.exit(2);
	}
	console.warn(`\n!! ${PHASE}s phases (--force). Expect an inconclusive result.\n`);
}

// Works with the shipped addon (`start`) and the newer one (`startExcludeProcessTree`).
const startExclude = typeof addon.startExcludeProcessTree === "function" ? addon.startExcludeProcessTree : addon.start;
const stopAll = typeof addon.stopAll === "function" ? addon.stopAll : addon.stop;
if (typeof startExclude !== "function" || typeof stopAll !== "function") {
	console.error(`addon at ${addonPath} exposes: ${Object.keys(addon).join(", ")}`);
	console.error("No usable EXCLUDE-self entry point. Aborting.");
	process.exit(2);
}

const PHASES = [
	{ name: "SILENCE", instruction: "Play NOTHING. Say NOTHING. Just wait." },
	{ name: "VOICE ONLY", instruction: ">>> TALK CONTINUOUSLY. Play no audio. <<<" },
	{ name: "AUDIO ONLY", instruction: "Play music/video. Do NOT talk." },
];

// ── capture ──────────────────────────────────────────────────────────────────────────
const chunks = []; // { t: msSinceStart, buf }
let t0 = 0;
let calls = 0;

function onChunk(err, chunk) {
	if (err || !chunk) return;
	calls++;
	chunks.push({ t: Date.now() - t0, buf: Buffer.from(chunk) });
}

function toFloat(bufs) {
	const buf = Buffer.concat(bufs);
	const n = Math.floor(buf.byteLength / 4);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
	return out;
}

function stats(f32) {
	let peak = 0;
	let sumSq = 0;
	for (let i = 0; i < f32.length; i++) {
		const v = f32[i];
		const a = v < 0 ? -v : v;
		if (a > peak) peak = a;
		sumSq += v * v;
	}
	const rms = f32.length ? Math.sqrt(sumSq / f32.length) : 0;
	return { n: f32.length, seconds: f32.length / (SAMPLE_RATE * CHANNELS), peak, rms, dbfs: rms > 0 ? 20 * Math.log10(rms) : -Infinity };
}

// ── signal shape ─────────────────────────────────────────────────────────────────────
// Level alone is a weak discriminator on a rig whose floor is mains hum. These three
// describe what the signal IS: which band it lives in, whether it is mono, whether it is
// pitched. A mic fanned out through a virtual cable is speech-band + mono + voiced.

function channels(f32) {
	const n = Math.floor(f32.length / CHANNELS);
	const l = new Float32Array(n);
	const r = new Float32Array(n);
	const mono = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		l[i] = f32[i * CHANNELS];
		r[i] = f32[i * CHANNELS + 1];
		mono[i] = (l[i] + r[i]) / 2;
	}
	return { l, r, mono };
}

// RBJ cookbook biquads, direct form I.
function coeffs(kind, f0, q) {
	const w = (2 * Math.PI * f0) / SAMPLE_RATE;
	const cw = Math.cos(w);
	const alpha = Math.sin(w) / (2 * q);
	const a0 = 1 + alpha;
	const [b0, b1, b2] = kind === "hp" ? [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2] : [(1 - cw) / 2, 1 - cw, (1 - cw) / 2];
	return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
}

function filter(x, c) {
	const y = new Float32Array(x.length);
	let x1 = 0;
	let x2 = 0;
	let y1 = 0;
	let y2 = 0;
	for (let i = 0; i < x.length; i++) {
		const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
		x2 = x1;
		x1 = x[i];
		y2 = y1;
		y1 = v;
		y[i] = v;
	}
	return y;
}

// Two cascaded 2nd-order sections per edge: 24 dB/oct, so a 50 Hz floor lands ~56 dB down
// by 300 Hz instead of dominating the number we are about to divide by.
function band(x, lo, hi) {
	let y = x;
	for (let i = 0; i < 2; i++) y = filter(y, coeffs("hp", lo, 0.707));
	for (let i = 0; i < 2; i++) y = filter(y, coeffs("lp", hi, 0.707));
	return y;
}

function rms(x) {
	let s = 0;
	for (let i = 0; i < x.length; i++) s += x[i] * x[i];
	return x.length ? Math.sqrt(s / x.length) : 0;
}

function correlation(l, r) {
	let lr = 0;
	let ll = 0;
	let rr = 0;
	for (let i = 0; i < l.length; i++) {
		lr += l[i] * r[i];
		ll += l[i] * l[i];
		rr += r[i] * r[i];
	}
	const d = Math.sqrt(ll * rr);
	return d > 0 ? lr / d : 0;
}

// Fraction of 50ms frames with a strong autocorrelation peak in the 70-400 Hz pitch range.
// Decimated 4x (the signal is already band-limited to 1200 Hz, so nothing aliases) to keep
// the O(n*lags) search cheap.
function voiced(mono) {
	const pitchBand = band(mono, 70, 1200);
	const D = 4;
	const sr = SAMPLE_RATE / D;
	const x = new Float32Array(Math.floor(pitchBand.length / D));
	for (let i = 0; i < x.length; i++) x[i] = pitchBand[i * D];
	const W = Math.floor(sr * 0.05);
	const minLag = Math.floor(sr / 400);
	const maxLag = Math.floor(sr / 70);
	const f0s = [];
	let frames = 0;
	let hits = 0;
	for (let k = 0; k + W <= x.length; k += W) {
		const f = x.subarray(k, k + W);
		let e0 = 0;
		for (let i = 0; i < W; i++) e0 += f[i] * f[i];
		if (e0 <= 0) continue;
		frames++;
		let best = 0;
		let bestLag = 0;
		// Only accept a peak once the autocorrelation has actually dipped. Without this a
		// strong sub-70Hz component -- mains hum, which is this rig's entire noise floor --
		// never completes a period inside the search range, so its slowly-decaying lobe pins
		// the maximum to minLag and every hum frame reports as voiced at exactly 400 Hz.
		let dipped = false;
		for (let lag = minLag; lag <= maxLag && lag < W; lag++) {
			let a = 0;
			for (let i = 0; i + lag < W; i++) a += f[i] * f[i + lag];
			const norm = a / e0;
			if (norm < 0.2) dipped = true;
			if (dipped && norm > best) {
				best = norm;
				bestLag = lag;
			}
		}
		if (!bestLag) continue;
		if (best > 0.4) {
			hits++;
			f0s.push(sr / bestLag);
		}
	}
	f0s.sort((a, b) => a - b);
	return { fraction: frames ? hits / frames : 0, medianF0: f0s.length ? f0s[Math.floor(f0s.length / 2)] : null };
}

function describe(f32) {
	const { l, r, mono } = channels(f32);
	const wide = stats(f32);
	const speech = rms(band(mono, SPEECH_LO, SPEECH_HI));
	const v = voiced(mono);
	return {
		seconds: wide.seconds,
		peak: wide.peak,
		wideRms: wide.rms,
		wideDbfs: wide.dbfs,
		speechRms: speech,
		speechDbfs: speech > 0 ? 20 * Math.log10(speech) : -Infinity,
		correlation: correlation(l, r),
		voicedFraction: v.fraction,
		medianF0: v.medianF0,
	};
}

function writeWav(path, f32) {
	const n = f32.length;
	const data = Buffer.alloc(n * 2);
	for (let i = 0; i < n; i++) {
		const v = Math.max(-1, Math.min(1, f32[i]));
		data.writeInt16LE(Math.round(v * 32767), i * 2);
	}
	const h = Buffer.alloc(44);
	h.write("RIFF", 0);
	h.writeUInt32LE(36 + data.length, 4);
	h.write("WAVE", 8);
	h.write("fmt ", 12);
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(CHANNELS, 22);
	h.writeUInt32LE(SAMPLE_RATE, 24);
	h.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28);
	h.writeUInt16LE(CHANNELS * 2, 32);
	h.writeUInt16LE(16, 34);
	h.write("data", 36);
	h.writeUInt32LE(data.length, 40);
	writeFileSync(path, Buffer.concat([h, data]));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function countdown(label, seconds) {
	for (let s = seconds; s > 0; s--) {
		process.stdout.write(`\r  ${label}  ${s}s remaining   `);
		await sleep(1000);
	}
	process.stdout.write(`\r  ${label}  done.              \n`);
}

// ── run ──────────────────────────────────────────────────────────────────────────────
console.log(`\naddon:    ${addonPath}`);
console.log(`self pid: ${process.pid}`);
console.log(`mode:     EXCLUDE-self process tree  (== what whole-screen share does)\n`);

t0 = Date.now();
const sessionId = startExclude(process.pid, onChunk);

// `start` returns a bool; `startExcludeProcessTree` returns a session id. Both are falsy on failure.
if (!sessionId) {
	console.error("!! EXCLUDE-self activation FAILED. Whole-screen capture is broken at the API level.");
	console.error("!! (Process loopback needs Windows 10 2004 / build 19041+.)");
	process.exit(3);
}
console.log(`capture live (${typeof sessionId === "number" ? `session ${sessionId}` : "ok"}).\n`);

const marks = [];
for (const p of PHASES) {
	console.log(`── PHASE ${PHASES.indexOf(p) + 1}: ${p.name} ──`);
	console.log(`   ${p.instruction}`);
	const from = Date.now() - t0;
	await countdown(p.name, PHASE);
	marks.push({ ...p, from, to: Date.now() - t0 });
	console.log("");
}

stopAll();
await sleep(200);

// ── analyse ──────────────────────────────────────────────────────────────────────────
console.log("=== RESULTS ===\n");
const all = toFloat(chunks.map((c) => c.buf));
const allS = stats(all);
console.log(`total captured: ${allS.seconds.toFixed(2)}s in ${calls} chunks (expected ~${(PHASES.length * PHASE).toFixed(0)}s)\n`);

const db = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1).padStart(6) : "  -inf");

for (const m of marks) {
	const bufs = chunks.filter((c) => c.t >= m.from + GUARD && c.t < m.to).map((c) => c.buf);
	m.pcm = toFloat(bufs);
	m.stats = describe(m.pcm);
	writeWav(join(here, `out-phase${marks.indexOf(m) + 1}-${m.name.toLowerCase().replace(/\W+/g, "-")}.wav`), m.pcm);
}

console.log("phase          dur   wideband   speech(300-3400)   L/R corr   voiced   medianF0");
for (const m of marks) {
	const t = m.stats;
	console.log(`${m.name.padEnd(12)} ${t.seconds.toFixed(2)}s   ${db(t.wideRms)} dB        ${db(t.speechRms)} dB      ` + `${(t.correlation >= 0 ? "+" : "") + t.correlation.toFixed(3)}     ${(100 * t.voicedFraction).toFixed(0).padStart(3)}%   ` + `${t.medianF0 ? `${t.medianF0.toFixed(0)} Hz` : "  --"}`);
}

writeWav(join(here, "out-whole-screen.wav"), all);
writeFileSync(
	join(here, "whole-screen-run.json"),
	JSON.stringify(
		{
			addonPath,
			pid: process.pid,
			secondsPerPhase: PHASE,
			guardMs: GUARD,
			totalSeconds: allS.seconds,
			chunkCount: calls,
			chunkTimesMs: chunks.map((c) => c.t),
			phases: marks.map((m) => ({ name: m.name, fromMs: m.from, toMs: m.to, ...m.stats })),
		},
		null,
		2,
	),
);
console.log(`\nwrote out-whole-screen.wav (${allS.seconds.toFixed(1)}s), one wav per phase, and whole-screen-run.json.`);

const [silence, voice, audio] = marks.map((m) => m.stats);
const floor = Math.max(silence.speechRms, 1e-7);
const voiceOverFloor = voice.speechRms / floor;
const audioOverFloor = audio.speechRms / floor;

console.log("\n=== VERDICT ===\n");
console.log(`voice / silence = ${voiceOverFloor.toFixed(1)}x   (${(20 * Math.log10(voiceOverFloor)).toFixed(1)} dB above floor, speech band)`);
console.log(`audio / silence = ${audioOverFloor.toFixed(1)}x   (${(20 * Math.log10(audioOverFloor)).toFixed(1)} dB above floor, speech band)\n`);

// Order matters: a contaminated baseline poisons both ratios, so check it before reading them.
if (silence.voicedFraction > 0.25) {
	console.log("BASELINE CONTAMINATED — phase 1 was supposed to be silent but is already pitched");
	console.log(`(${(100 * silence.voicedFraction).toFixed(0)}% voiced frames, median F0 ${silence.medianF0?.toFixed(0)} Hz). Every ratio below divides by`);
	console.log("that, so nothing here separates 'the mic reaches the capture' from 'someone was");
	console.log("talking through the baseline'. Re-run: phase 1 genuinely silent, no typing near");
	console.log("the mic, nothing playing.");
} else if (audioOverFloor < 3) {
	console.log("INCONCLUSIVE — phase 3 barely rose above the floor, so desktop audio was not");
	console.log("actually captured. Play something LOUD and re-run; without that there is no");
	console.log("working baseline to judge phase 2 against.");
} else if (voiceOverFloor > 4) {
	console.log("CONFIRMED: your MIC reaches the whole-screen capture.");
	console.log("Phase 2 had no desktop audio playing, yet the speech band rose well above the");
	console.log("noise floor — the only source was your voice, routed back out through the cable.");
	if (voice.correlation > 0.9) console.log(`Phase 2 is also mono (L/R ${voice.correlation.toFixed(3)}), which is what a single mic fanned to both channels looks like.`);
	console.log("");
	console.log("This is the echo. EXCLUDE-self cannot fix it: there is one TargetProcessId and it");
	console.log("is spent on us. Per-app INCLUDE is the fix.");
} else {
	console.log("NOT REPRODUCED: your mic did NOT measurably reach the capture.");
	console.log("Phase 2 stayed at the phase-1 floor in the speech band while phase 3 clearly did");
	console.log("not, so EXCLUDE-self is capturing desktop audio WITHOUT the mic bleed.");
	console.log("");
	console.log("If viewers still hear you twice, the cause is NOT the capture mode and the");
	console.log("diagnosis needs to restart from the routing.");
}
console.log("");
process.exit(0);
