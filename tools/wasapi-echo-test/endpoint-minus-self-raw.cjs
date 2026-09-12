// Independent observation taps, NOT the paired engine's internal buffers. Never mix,
// normalize, shift, or subtract these samples. Each stream has its own frame origin.
const fs = require("node:fs");
const path = require("node:path");

function startRawDiagnostics({ addon, rootPid, selfPid = rootPid, deviceId, outDir }) {
	for (const name of ["startRenderEndpointLoopback", "startIncludeProcessTree", "getCaptureStats", "stopSession"]) {
		if (typeof addon[name] !== "function") throw new Error(`raw diagnostics require ${name}`);
	}
	const manifestPath = path.join(outDir, "raw-manifest.json");
	const statsPath = path.join(outDir, "raw-stats.ndjson");
	const files = [manifestPath, statsPath];
	for (const name of ["endpoint", "self"]) files.push(path.join(outDir, `raw-${name}.f32`), path.join(outDir, `raw-${name}-index.ndjson`));
	for (const file of files) if (fs.existsSync(file)) throw new Error(`raw evidence already exists: ${file}`);

	const manifest = { rootPid, selfPid, deviceId: deviceId ?? null, sampleRate: 48000, channels: 2, independentSessions: true, startedAt: Date.now(), endedAt: null, fatalError: null, streams: {} };
	const handles = [];
	let closed = false;
	let statsFd;
	function open(file) {
		const fd = fs.openSync(file, "wx");
		handles.push(fd);
		return fd;
	}
	function save() {
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
	}
	function poll() {
		if (closed) return;
		for (const [name, stream] of Object.entries(manifest.streams)) {
			if (!stream.sessionId) continue;
			try {
				stream.lastStats = addon.getCaptureStats(stream.sessionId) ?? null;
				fs.writeSync(statsFd, JSON.stringify({ wallClockMs: Date.now(), name, framesWritten: stream.frames, stats: stream.lastStats }) + "\n");
			} catch (error) {
				stream.errors.push(String(error));
			}
		}
	}
	function close() {
		if (closed) return;
		poll();
		closed = true;
		for (const stream of Object.values(manifest.streams)) {
			if (!stream.sessionId) continue;
			try {
				addon.stopSession(stream.sessionId);
			} catch (error) {
				stream.errors.push(`stop: ${error}`);
			}
		}
		for (const fd of handles) fs.closeSync(fd);
		manifest.endedAt = Date.now();
		save();
	}
	try {
		// Claim evidence path before starting any sessions.
		open(manifestPath);
		statsFd = open(statsPath);
		for (const name of ["endpoint", "self"]) {
			const dataFd = open(path.join(outDir, `raw-${name}.f32`));
			const indexFd = open(path.join(outDir, `raw-${name}-index.ndjson`));
			const stream = (manifest.streams[name] = { sessionId: null, frames: 0, chunks: 0, nonstandardChunks: 0, errors: [], lastStats: null });
			const callback = (error, chunk) => {
				if (closed) return;
				if (error) {
					stream.errors.push(String(error));
					return;
				}
				if (!chunk?.byteLength) return;
				if (chunk.byteLength % 8 !== 0) {
					stream.errors.push(`invalid stereo f32 frame bytes: ${chunk.byteLength}`);
					return;
				}
				try {
					const frameCount = chunk.byteLength / 8;
					const entry = { wallClockMs: Date.now(), frameStart: stream.frames, frameCount, byteOffset: stream.frames * 8, byteLength: chunk.byteLength };
					fs.writeSync(dataFd, chunk);
					fs.writeSync(indexFd, JSON.stringify(entry) + "\n");
					stream.frames += frameCount;
					stream.chunks++;
					if (frameCount !== 480) stream.nonstandardChunks++;
				} catch (e) {
					stream.errors.push(String(e));
				}
			};
			stream.sessionId = name === "endpoint" ? addon.startRenderEndpointLoopback(deviceId ?? null, callback) : addon.startIncludeProcessTree(selfPid, callback);
			if (!stream.sessionId) throw new Error(`raw ${name} capture refused to start`);
		}
		save();
		return { poll, close };
	} catch (error) {
		manifest.fatalError = String(error);
		close();
		throw error;
	}
}

module.exports = { startRawDiagnostics };
