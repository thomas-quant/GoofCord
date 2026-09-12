import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { startRawDiagnostics } = require("./endpoint-minus-self-raw.cjs");

function fixture(t, failSelf = false, expectedSelfPid = 123) {
	const outDir = mkdtempSync(join(tmpdir(), "wasapi-raw-"));
	t.after(() => rmSync(outDir, { recursive: true, force: true }));
	const callbacks = {};
	const stopped = [];
	const addon = {
		startRenderEndpointLoopback(device, callback) {
			assert.equal(device, "selected-endpoint");
			callbacks.endpoint = callback;
			return 11;
		},
		startIncludeProcessTree(pid, callback) {
			assert.equal(pid, expectedSelfPid);
			callbacks.self = callback;
			return failSelf ? 0 : 12;
		},
		getCaptureStats(id) {
			return { running: true, deliveredChunks: id, droppedChunks: 0 };
		},
		stopSession(id) {
			stopped.push(id);
		},
	};
	return { outDir, addon, callbacks, stopped };
}

function start(f) {
	return startRawDiagnostics({ addon: f.addon, rootPid: 123, deviceId: "selected-endpoint", outDir: f.outDir });
}

test("raw diagnostics preserve callback bytes and independent frame indexes", (t) => {
	const f = fixture(t);
	const raw = start(f);
	const a = Buffer.alloc(480 * 8);
	a.writeFloatLE(0.125, 0);
	a.writeFloatLE(-0.25, 4);
	const b = Buffer.alloc(240 * 8, 0);
	f.callbacks.endpoint(null, a);
	f.callbacks.endpoint(null, b);
	f.callbacks.self(null, b);
	raw.poll();
	raw.close();
	raw.close();
	// Late callback after teardown must not append to a closed recording.
	f.callbacks.endpoint(null, a);
	assert.deepEqual(readFileSync(join(f.outDir, "raw-endpoint.f32")), Buffer.concat([a, b]));
	assert.deepEqual(readFileSync(join(f.outDir, "raw-self.f32")), b);
	const index = readFileSync(join(f.outDir, "raw-endpoint-index.ndjson"), "utf8").trim().split("\n").map(JSON.parse);
	assert.deepEqual(
		index.map(({ frameStart, frameCount }) => [frameStart, frameCount]),
		[
			[0, 480],
			[480, 240],
		],
	);
	const manifest = JSON.parse(readFileSync(join(f.outDir, "raw-manifest.json")));
	assert.equal(manifest.streams.endpoint.frames, 720);
	assert.equal(manifest.streams.self.frames, 240);
	assert.equal(manifest.streams.endpoint.nonstandardChunks, 1);
	assert.equal(manifest.streams.endpoint.lastStats.deliveredChunks, 11);
	assert.deepEqual(f.stopped, [11, 12]);
});

test("raw diagnostics record an explicit child target without claiming whole-tree coverage", (t) => {
	const f = fixture(t, false, 456);
	const raw = startRawDiagnostics({ addon: f.addon, rootPid: 123, selfPid: 456, deviceId: "selected-endpoint", outDir: f.outDir });
	raw.close();
	const manifest = JSON.parse(readFileSync(join(f.outDir, "raw-manifest.json")));
	assert.equal(manifest.rootPid, 123);
	assert.equal(manifest.selfPid, 456);
});

test("raw diagnostics retain callback failures and reject malformed stereo frames", (t) => {
	const f = fixture(t);
	const raw = start(f);
	f.callbacks.self(new Error("capture lost"));
	f.callbacks.endpoint(null, Buffer.alloc(3));
	raw.close();
	const manifest = JSON.parse(readFileSync(join(f.outDir, "raw-manifest.json")));
	assert.match(manifest.streams.self.errors[0], /capture lost/);
	assert.match(manifest.streams.endpoint.errors[0], /frame/);
	assert.equal(readFileSync(join(f.outDir, "raw-endpoint.f32")).length, 0);
});

test("raw startup refusal tears down only the successfully started session", (t) => {
	const f = fixture(t, true);
	assert.throws(() => start(f), /self.*refused/i);
	assert.deepEqual(f.stopped, [11]);
	const manifest = JSON.parse(readFileSync(join(f.outDir, "raw-manifest.json")));
	assert.match(manifest.fatalError, /self.*refused/i);
});

test("diagnostic harness rejects an existing recording before writing its schedule", (t) => {
	const f = fixture(t);
	writeFileSync(join(f.outDir, "captured.f32"), Buffer.from([1, 2, 3]));
	const script = fileURLToPath(new URL("./endpoint-minus-self-harness.mjs", import.meta.url));
	const result = spawnSync(process.execPath, [script, "--diagnostic-raw", "--out", f.outDir, "--electron", join(f.outDir, "not-electron")], { encoding: "utf8" });
	assert.equal(result.status, 2);
	assert.match(result.stderr, /already contains.*evidence/);
	assert.equal(existsSync(join(f.outDir, "schedule.json")), false);
	assert.deepEqual(readFileSync(join(f.outDir, "captured.f32")), Buffer.from([1, 2, 3]));
});

test("raw diagnostics refuse to overwrite an earlier recording", (t) => {
	const f = fixture(t);
	const raw = start(f);
	f.callbacks.endpoint(null, Buffer.alloc(8, 1));
	raw.close();
	const before = readFileSync(join(f.outDir, "raw-endpoint.f32"));
	assert.throws(() => start(f), /exist/i);
	assert.deepEqual(readFileSync(join(f.outDir, "raw-endpoint.f32")), before);
});
