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

import { createRequire } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const local = join(here, "addon-under-test.node");
const addonPath = existsSync(local) ? local : resolve(here, "../../node_modules/wasapi-loopback/prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node");
const addon = createRequire(import.meta.url)(addonPath);

const PHASE = Number(process.argv[2] ?? 6);
const SAMPLE_RATE = 48000;
const CHANNELS = 2;

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

// Discard the first 300ms of each phase so a slow instruction-read doesn't bleed across.
const GUARD = 300;
for (const m of marks) {
	const bufs = chunks.filter((c) => c.t >= m.from + GUARD && c.t < m.to).map((c) => c.buf);
	m.stats = stats(toFloat(bufs));
	console.log(`${m.name.padEnd(12)} ${m.stats.seconds.toFixed(2)}s  peak=${m.stats.peak.toFixed(4)}  rms=${m.stats.rms.toFixed(6)}  ${m.stats.dbfs === -Infinity ? " -inf" : m.stats.dbfs.toFixed(1)} dBFS`);
}

writeWav(join(here, "out-whole-screen.wav"), all);
console.log(`\nwrote out-whole-screen.wav (${allS.seconds.toFixed(1)}s) — listen to the middle third for your voice.`);

const [silence, voice, audio] = marks.map((m) => m.stats);
const floor = Math.max(silence.rms, 1e-7);
const voiceOverFloor = voice.rms / floor;
const audioOverFloor = audio.rms / floor;

console.log("\n=== VERDICT ===\n");
console.log(`voice / silence = ${voiceOverFloor.toFixed(1)}x   (${(20 * Math.log10(voiceOverFloor)).toFixed(1)} dB above floor)`);
console.log(`audio / silence = ${audioOverFloor.toFixed(1)}x   (${(20 * Math.log10(audioOverFloor)).toFixed(1)} dB above floor)\n`);

if (audioOverFloor < 3) {
	console.log("INCONCLUSIVE — phase 3 barely rose above the floor, so desktop audio was not");
	console.log("actually captured. Play something audible and re-run; without that there is no");
	console.log("working baseline to judge phase 2 against.");
} else if (voiceOverFloor > 4) {
	console.log("CONFIRMED: your MIC reaches the whole-screen capture.");
	console.log("Phase 2 had no desktop audio playing, yet the capture rose well above the noise");
	console.log("floor — the only source was your voice, routed back out through the virtual cable.");
	console.log("");
	console.log("This is the echo. EXCLUDE-self cannot fix it: there is one TargetProcessId and it");
	console.log("is spent on us. Per-app INCLUDE is the fix.");
} else {
	console.log("NOT REPRODUCED: your mic did NOT measurably reach the capture.");
	console.log("Phase 2 stayed at the phase-1 noise floor while phase 3 clearly did not, so");
	console.log("EXCLUDE-self is capturing desktop audio WITHOUT the mic bleed.");
	console.log("");
	console.log("If viewers still hear you twice, the cause is NOT the capture mode and the");
	console.log("diagnosis needs to restart from the routing.");
}
console.log("");
process.exit(0);
