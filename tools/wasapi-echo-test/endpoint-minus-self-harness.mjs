#!/usr/bin/env node
// Deterministic integration validation harness for the addon's endpoint-minus-self API:
//   startEndpointMinusSelf(rootPid, deviceId, errorFirstBufferCallback): sessionId
//   getSubtractionStatus(sessionId): { state, reason, offsetFrames, bufferedFrames, generation }
//   stopSession(sessionId)
//
// What this actually exercises, end to end:
//   1. spawns a real Electron process (endpoint-minus-self-other-audio.cjs) that plays a known,
//      independently seeded stereo signal — the "other app" a correct subtraction must preserve;
//   2. spawns a second real Electron process (endpoint-minus-self-electron-main.cjs) that loads
//      the real addon from --addon, starts a real capture session against it, and plays its OWN
//      deterministic own-process audio in two back-to-back segments: a calibration segment (during
//      which nothing else is playing, so a strict "did the addon actually cancel its own known
//      signal" check is possible), then a disjoint hold-out segment (never seen by the addon
//      before, overlapping with the other process's signal);
//   3. captures the addon's real output stream from the paired native session and the addon's real
//      getSubtractionStatus() polling stream;
//   4. offline, in THIS process, scores the raw capture against the known references — never
//      feeding any offline alignment/gain back into the addon or into what gets reported as its
//      output.
//
// Everything this run produces is written under --out and nowhere else. There is no microphone
// use, no killing of pre-existing processes, and no global audio/device/volume changes.
//
// See endpoint-minus-self-README.md for the full limitations list (device-conversion vs digital
// source, why this is a deterministic-DSP gate and not a statistical claim, etc).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { scoreCapture } from "./endpoint-minus-self-report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

function argValue(flag, fallback) {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : fallback;
}
function argNumber(flag, fallback) {
	const v = argValue(flag, undefined);
	return v === undefined ? fallback : Number(v);
}

const outDir = argValue("--out", undefined);
if (!outDir) {
	console.error("Usage: node endpoint-minus-self-harness.mjs --out <dir> [--addon <path>] [--device-id <id>] [options]");
	console.error("See endpoint-minus-self-README.md for the full option list and what this does and does not prove.");
	process.exit(2);
}

const localAddon = join(here, "addon-under-test.node");
const defaultAddon = existsSync(localAddon) ? localAddon : resolve(here, "../../node_modules/wasapi-loopback/prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node");
const addonPath = resolve(argValue("--addon", defaultAddon));
const deviceId = argValue("--device-id", "");

const config = {
	sampleRate: 48000,
	spawnLeadMs: argNumber("--spawn-lead-ms", 4000),
	leadInSeconds: argNumber("--lead-in-seconds", 0.5),
	// The real addon's lock procedure needs a 250ms search window plus a held-out per-channel
	// verification that can take up to ~10s to reach a tight-enough confidence interval even with
	// no interference (see native/wasapi-loopback/SUBTRACTION.md on branch feat/endpoint-minus-self,
	// "Held-out verification" / "Timeout"), and its own internal fault threshold is 20s of no lock.
	// These defaults give it real room instead of the harness itself becoming the bottleneck.
	calibrationSeconds: argNumber("--calibration-seconds", 8),
	holdoutSeconds: argNumber("--holdout-seconds", 4),
	otherMarginSeconds: argNumber("--other-margin-seconds", 1.5),
	alignTimeoutSeconds: argNumber("--align-timeout-seconds", 30),
	pollIntervalMs: argNumber("--poll-interval-ms", 50),
	watchdogSeconds: argNumber("--watchdog-seconds", 120),
	trimMs: argNumber("--trim-ms", 250),
	peakAmplitude: argNumber("--peak-amplitude", 0.2),
	maxLagFrames: argNumber("--max-lag-frames", 512),
	// Fixed by default so runs are reproducible; override only to probe a different seed.
	seeds: {
		calibrationL: argNumber("--seed-calibration-l", 0xc0ffee),
		calibrationR: argNumber("--seed-calibration-r", 0xbada55),
		holdoutL: argNumber("--seed-holdout-l", 0xfacefeed),
		holdoutR: argNumber("--seed-holdout-r", 0x5eed5eed),
		otherL: argNumber("--seed-other-l", 0x1337c0de),
		otherR: argNumber("--seed-other-r", 0x2468ace0),
	},
};

mkdirSync(outDir, { recursive: true });

const startAtEpochMs = Date.now() + config.spawnLeadMs;
const schedule = {
	sampleRate: config.sampleRate,
	selfBarrierEpochMs: startAtEpochMs,
	leadInSeconds: config.leadInSeconds,
	alignTimeoutSeconds: config.alignTimeoutSeconds,
	pollIntervalMs: config.pollIntervalMs,
	watchdogSeconds: config.watchdogSeconds,
	calibration: { seconds: config.calibrationSeconds, seedL: config.seeds.calibrationL, seedR: config.seeds.calibrationR, peakAmplitude: config.peakAmplitude },
	holdout: { seconds: config.holdoutSeconds, seedL: config.seeds.holdoutL, seedR: config.seeds.holdoutR, peakAmplitude: config.peakAmplitude },
	other: {
		seedL: config.seeds.otherL,
		seedR: config.seeds.otherR,
		peakAmplitude: config.peakAmplitude,
		seconds: config.holdoutSeconds + config.otherMarginSeconds,
		// Deliberately aligned to when the SELF process's disjoint hold-out segment starts, so the
		// "other app" only needs to be preserved during the window that is actually scored for it.
		startAtEpochMs: startAtEpochMs + config.leadInSeconds * 1000 + config.calibrationSeconds * 1000,
	},
};
const schedulePath = join(outDir, "schedule.json");
writeFileSync(schedulePath, JSON.stringify(schedule, null, 2));

const electronBin = join(repoRoot, "node_modules", ".bin", "electron");
if (!existsSync(electronBin)) {
	console.error(`electron binary not found at ${electronBin} — run bun install at the repo root first.`);
	process.exit(2);
}

// Electron refuses to start as root without --no-sandbox (Chromium's sandbox needs a real,
// non-root user namespace). Only added when actually running as root, so a normal desktop
// invocation keeps Chromium's sandbox on.
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

function spawnLeg(name, script, args) {
	const electronArgs = runningAsRoot ? ["--no-sandbox", script, ...args] : [script, ...args];
	const child = spawn(electronBin, electronArgs, { cwd: here, stdio: ["ignore", "pipe", "pipe"] });
	let readyResolve;
	const ready = new Promise((resolve) => {
		readyResolve = resolve;
	});
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		for (const line of chunk.split("\n")) {
			if (!line) continue;
			console.log(`[${name}] ${line}`);
			if (line.trim() === "READY") readyResolve();
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		for (const line of chunk.split("\n")) if (line) console.error(`[${name}] ${line}`);
	});
	const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
	return { child, ready, exited };
}

console.log(`endpoint-minus-self-harness: addon=${addonPath} deviceId=${deviceId || "(default)"} out=${outDir}`);

const other = spawnLeg("other", join(here, "endpoint-minus-self-other-audio.cjs"), ["--schedule", schedulePath, "--out", outDir]);
const self_ = spawnLeg("self", join(here, "endpoint-minus-self-electron-main.cjs"), ["--addon", addonPath, "--device-id", deviceId, "--schedule", schedulePath, "--out", outDir]);

const overallWatchdogMs = config.spawnLeadMs + (config.leadInSeconds + config.calibrationSeconds + config.holdoutSeconds + config.otherMarginSeconds) * 1000 + config.watchdogSeconds * 1000;
const watchdog = setTimeout(() => {
	console.error("endpoint-minus-self-harness: overall watchdog expired — killing both legs");
	other.child.kill();
	self_.child.kill();
}, overallWatchdogMs);
watchdog.unref();

const [otherReadyOrTimeout] = await Promise.allSettled([Promise.race([other.ready, other.exited])]);
if (otherReadyOrTimeout.status === "fulfilled" && otherReadyOrTimeout.value && "code" in otherReadyOrTimeout.value) {
	console.error(`endpoint-minus-self-harness: other-audio leg exited before signalling ready (code=${otherReadyOrTimeout.value.code})`);
}

const [otherResult, selfResult] = await Promise.all([other.exited, self_.exited]);
clearTimeout(watchdog);

function readJsonIfExists(path) {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

const selfManifest = readJsonIfExists(join(outDir, "self-manifest.json"));
const otherManifest = readJsonIfExists(join(outDir, "other-manifest.json"));

const report = { addonPath, deviceId: deviceId || null, outDir, schedule, otherResult, selfResult, selfManifest, otherManifest, gates: {}, verdict: "UNKNOWN", limitations: [] };

function finish(verdict, exitCode, extraLimitations = []) {
	report.verdict = verdict;
	report.limitations.push(
		"Own/other audio is generated digitally in Web Audio and only becomes a WASAPI-loopback-observable signal after passing through the OS render/mix/device pipeline (resampling, mixing, endpoint effects); scoring therefore uses correlation/gain bounds, never byte-exact equality against the digital source.",
		"This validates the addon against synthetic Electron-rendered content on whatever output device Electron and the addon each resolve as default/given; it is not a substitute for a check against arbitrary real third-party applications or every physical device.",
		"Pass/fail gates here are fixed deterministic DSP thresholds (dB residual, normalized correlation, frame jitter) chosen ahead of time, not statistical significance tests over repeated trials.",
		"Any gain reported by the scorer (e.g. scorePreservation's estimated linear gain) is a read-only diagnostic of how faithfully the signal survived the pipeline; it is never fitted-and-applied to alter the addon's actual output before scoring.",
		...extraLimitations,
	);
	writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
	console.log(`\n=== VERDICT: ${verdict} ===`);
	if (report.gates && Object.keys(report.gates).length > 0) {
		for (const [name, gate] of Object.entries(report.gates)) console.log(`  ${gate.pass ? "PASS" : "FAIL"}  ${name}`);
	}
	console.log(`Full report: ${join(outDir, "report.json")}`);
	process.exit(exitCode);
}

if (!selfManifest) {
	finish("HARNESS_ERROR", 1, ["self process produced no manifest at all — it likely crashed before writing anything; see stderr above and captured stdio."]);
}
if (selfManifest.skipped) {
	finish(`SKIPPED (${selfManifest.skipReason})`, selfResult.code ?? 3, ["This host/environment cannot run the real endpoint-minus-self addon path (see self-manifest.json skipReason). This is not a pass: no DSP gate was evaluated."]);
}
if (selfManifest.fatalError) {
	finish(`FAILED (harness-level: ${selfManifest.fatalError})`, selfResult.code || 1);
}
if (!otherManifest || otherManifest.error) {
	finish(`FAILED (other-audio leg: ${otherManifest?.error ?? "no manifest"})`, 1);
}

// ── Assemble the real capture and score it against the known references ─────────────────────
const scored = scoreCapture({ outDir, schedule, config, selfManifest });
report.gates = scored.gates;
report.windowing = scored.windowing;
finish(scored.pass ? "PASS" : "FAIL", scored.pass ? 0 : 1, scored.limitations);
